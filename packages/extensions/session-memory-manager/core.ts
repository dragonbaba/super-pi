import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { assertSessionIdNotLeased, assertSessionNotLeased, withSessionLeaseLock } from "./lease.ts";
import { unknownSessionText } from "./ui-text.ts";

export type ManagedSession = {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: Date;
  messageCount: number;
};

export type SessionFileRow = { session_id: string; path: string };
export type OrphanSessionRow = { session_id: string; project: string | null; message_count: number };
type CountRow = { count: number };
type TableInfoRow = { name: string };
type ColumnInfoRow = { name: string };
type VersionRow = { user_version: number };
type ExactSessionFileRow = { session_id: string; path: string };
type SessionIndexStateRow = { exact_mapping: number; mapping_count: number; session_count: number; message_count: number };

const REQUIRED_COLUMNS = new Map([
  ["sessions", new Set(["id"])],
  ["messages", new Set(["session_id"])],
  ["session_files", new Set(["session_id", "path"])],
]);
const MAX_SUPPORTED_USER_VERSION = 1;
export const SESSION_TRASH_MAX_COUNT = 10;
export const SESSION_TRASH_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TRASH_DELETE_BATCH_MAX = 16;
const SESSION_TRASH_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_.+\.jsonl$/i;

export type SessionTrashEntry = {
  name: string;
  filePath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
};

export type SessionTrashStatus = {
  totalFiles: number;
  totalBytes: number;
  oldestMtimeMs: number | null;
  managedFiles: number;
  ignoredFiles: number;
  cleanupCandidates: SessionTrashEntry[];
  cleanupCandidateBytes: number;
  deletionBatch: SessionTrashEntry[];
};

export type SessionTrashDeleteResult = { files: number; bytes: number };

function normalizedPath(filePath: string): string {
  const value = resolve(filePath);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function canonicalPath(filePath: string): string {
  try {
    const value = realpathSync.native(filePath);
    return process.platform === "win32" ? value.toLowerCase() : value;
  } catch {
    return normalizedPath(filePath);
  }
}

export function sameFile(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && canonicalPath(left) === canonicalPath(right));
}

function sqliteError(error: unknown): string {
  return error instanceof Error ? error.message : unknownSessionText(error);
}

export function validateHermesDatabase(db: DatabaseSync, databasePath: string): void {
  const version = db.prepare("PRAGMA user_version").get() as unknown as VersionRow | undefined;
  if (!version || !Number.isInteger(version.user_version) || version.user_version < 0 || version.user_version > MAX_SUPPORTED_USER_VERSION) {
    throw new Error(`不支持的 Hermes 数据库版本（user_version=${version?.user_version ?? "unknown"}）：${databasePath}`);
  }

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as TableInfoRow[])
      .map((row) => row.name),
  );
  for (const [table, required] of REQUIRED_COLUMNS) {
    if (!tables.has(table)) throw new Error(`Hermes 数据库缺少必需表 ${table}：${databasePath}`);
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfoRow[]).map((row) => row.name),
    );
    for (const column of required) {
      if (!columns.has(column)) throw new Error(`Hermes 数据库表 ${table} 缺少字段 ${column}：${databasePath}`);
    }
  }
}

export function withHermesDatabase<T>(databasePath: string, operation: (db: DatabaseSync) => T): T {
  if (!existsSync(databasePath)) throw new Error(`Hermes Session 数据库不存在：${databasePath}`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath);
  } catch (error) {
    throw new Error(`无法打开 Hermes Session 数据库 ${databasePath}：${sqliteError(error)}`);
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA wal_autocheckpoint = 256");
    db.exec("PRAGMA journal_size_limit = 2097152");
    validateHermesDatabase(db, databasePath);
    return operation(db);
  } catch (error) {
    if (error instanceof Error && error.message.includes(databasePath)) throw error;
    throw new Error(`Hermes Session 数据库操作失败 ${databasePath}：${sqliteError(error)}`);
  } finally {
    try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* another live Pi may own a writer */ }
    db.close();
  }
}

function removeExactIndexedSession(db: DatabaseSync, sessionId: string, filePath: string): void {
  const result = db.prepare("DELETE FROM session_files WHERE session_id = ? AND path = ?").run(sessionId, filePath);
  if (Number(result.changes) !== 1) {
    throw new Error(`Session 索引映射已变化，已取消操作：${sessionId}`);
  }
  const remaining = db.prepare("SELECT 1 FROM session_files WHERE session_id = ? LIMIT 1").get(sessionId);
  if (!remaining) {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
}

function assertExactMapping(db: DatabaseSync, sessionId: string, filePath: string): void {
  const row = db.prepare("SELECT session_id, path FROM session_files WHERE session_id = ? AND path = ?")
    .get(sessionId, filePath) as unknown as ExactSessionFileRow | undefined;
  if (!row) throw new Error(`Session 索引映射已变化，已取消操作：${sessionId}`);
}

function classifySessionIndexForDelete(db: DatabaseSync, sessionId: string, filePath: string): "indexed" | "unindexed" {
  const state = db.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM session_files WHERE session_id = ? AND path = ?) AS exact_mapping,
      (SELECT COUNT(*) FROM session_files WHERE session_id = ?) AS mapping_count,
      (SELECT COUNT(*) FROM sessions WHERE id = ?) AS session_count,
      (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS message_count
  `).get(sessionId, filePath, sessionId, sessionId, sessionId) as unknown as SessionIndexStateRow;
  if (state.exact_mapping === 1) return "indexed";
  if (state.mapping_count === 0 && state.session_count === 0 && state.message_count === 0) return "unindexed";
  throw new Error(`Session 索引映射已变化，已取消操作：${sessionId}`);
}

function pathIsMissing(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw new Error(`无法确认 Session 文件状态 ${filePath}：${sqliteError(error)}`);
  }
}

export function listStaleIndexedSessions(databasePath: string, protectedFile?: string): SessionFileRow[] {
  return withHermesDatabase(databasePath, (db) => {
    const rows = db.prepare("SELECT session_id, path FROM session_files ORDER BY session_id, path").all() as unknown as SessionFileRow[];
    return rows.filter((row) => !sameFile(row.path, protectedFile) && pathIsMissing(row.path));
  });
}

export function cleanStaleIndex(
  databasePath: string,
  rows: SessionFileRow[],
  getCurrentFile: () => string | undefined = () => undefined,
): number {
  if (rows.length === 0) return 0;
  return withHermesDatabase(databasePath, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        assertExactMapping(db, row.session_id, row.path);
        if (sameFile(row.path, getCurrentFile())) throw new Error("Session 已成为当前会话，已取消清理");
        if (!pathIsMissing(row.path)) throw new Error(`Session 文件已重新出现，已取消清理：${row.path}`);
        removeExactIndexedSession(db, row.session_id, row.path);
      }
      db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* close will make a final best effort */ }
      throw error;
    }
  });
}

export function listOrphanIndexedSessions(databasePath: string): OrphanSessionRow[] {
  return withHermesDatabase(databasePath, (db) => db.prepare(`
    SELECT s.id AS session_id, s.project, COUNT(m.session_id) AS message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE NOT EXISTS (SELECT 1 FROM session_files sf WHERE sf.session_id = s.id)
    GROUP BY s.id, s.project
    ORDER BY s.project, s.id
  `).all() as unknown as OrphanSessionRow[]);
}

export function cleanOrphanIndex(
  databasePath: string,
  rows: OrphanSessionRow[],
  leaseDir?: string,
  getCurrentSessionId: () => string | undefined = () => undefined,
): number {
  if (rows.length === 0) return 0;
  return withSessionLeaseLock(leaseDir, () => withHermesDatabase(databasePath, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (row.session_id === getCurrentSessionId()) throw new Error(`Session ${row.session_id} 已成为当前会话，已取消清理`);
        assertSessionIdNotLeased(leaseDir, row.session_id);
        const session = db.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(row.session_id);
        if (!session) throw new Error(`Session 孤儿记录已变化，已取消清理：${row.session_id}`);
        const mapping = db.prepare("SELECT 1 FROM session_files WHERE session_id = ? LIMIT 1").get(row.session_id);
        if (mapping) throw new Error(`Session 已重新获得文件映射，已取消清理：${row.session_id}`);
        db.prepare("DELETE FROM messages WHERE session_id = ?").run(row.session_id);
        const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
        if (Number(result.changes) !== 1) throw new Error(`Session 孤儿记录已变化，已取消清理：${row.session_id}`);
      }
      db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* close will make a final best effort */ }
      throw error;
    }
  }));
}

export function databaseCounts(databasePath: string): { sessions: number; messages: number; files: number } {
  return withHermesDatabase(databasePath, (db) => ({
    sessions: (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as unknown as CountRow).count,
    messages: (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as unknown as CountRow).count,
    files: (db.prepare("SELECT COUNT(*) AS count FROM session_files").get() as unknown as CountRow).count,
  }));
}

function newestTrashFirst(left: SessionTrashEntry, right: SessionTrashEntry): number {
  if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function oldestTrashFirst(left: SessionTrashEntry, right: SessionTrashEntry): number {
  if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs - right.mtimeMs;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function sameTrashIdentity(entry: SessionTrashEntry, state: Stats): boolean {
  return entry.dev === state.dev
    && entry.ino === state.ino
    && entry.size === state.size
    && entry.mtimeMs === state.mtimeMs;
}

export function inspectSessionTrash(trashDir: string, now = Date.now()): SessionTrashStatus {
  const status: SessionTrashStatus = {
    totalFiles: 0,
    totalBytes: 0,
    oldestMtimeMs: null,
    managedFiles: 0,
    ignoredFiles: 0,
    cleanupCandidates: [],
    cleanupCandidateBytes: 0,
    deletionBatch: [],
  };
  let directoryEntries: Dirent<string>[];
  try {
    directoryEntries = readdirSync(trashDir, { withFileTypes: true, encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return status;
    throw error;
  }

  const managed: SessionTrashEntry[] = [];
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isFile()) continue;
    const filePath = join(trashDir, directoryEntry.name);
    const state = lstatSync(filePath);
    if (state.isSymbolicLink() || !state.isFile()) continue;
    status.totalFiles++;
    status.totalBytes += state.size;
    if (status.oldestMtimeMs === null || state.mtimeMs < status.oldestMtimeMs) {
      status.oldestMtimeMs = state.mtimeMs;
    }
    if (!SESSION_TRASH_NAME_PATTERN.test(directoryEntry.name)) {
      status.ignoredFiles++;
      continue;
    }
    status.managedFiles++;
    managed.push({
      name: directoryEntry.name,
      filePath,
      size: state.size,
      mtimeMs: state.mtimeMs,
      dev: state.dev,
      ino: state.ino,
    });
  }

  managed.sort(newestTrashFirst);
  const ageCutoff = now - SESSION_TRASH_MAX_AGE_MS;
  let retainedCount = 0;
  let retainedBytes = 0;
  for (const entry of managed) {
    const withinAge = entry.mtimeMs >= ageCutoff;
    const withinCount = retainedCount < SESSION_TRASH_MAX_COUNT;
    const withinBytes = retainedBytes + entry.size <= SESSION_TRASH_MAX_BYTES;
    if (withinAge && withinCount && withinBytes) {
      retainedCount++;
      retainedBytes += entry.size;
      continue;
    }
    status.cleanupCandidates.push(entry);
    status.cleanupCandidateBytes += entry.size;
  }
  status.cleanupCandidates.sort(oldestTrashFirst);
  const batchLength = Math.min(status.cleanupCandidates.length, SESSION_TRASH_DELETE_BATCH_MAX);
  for (let index = 0; index < batchLength; index++) {
    status.deletionBatch.push(status.cleanupCandidates[index]);
  }
  return status;
}

export function deleteSessionTrashCandidates(
  trashDir: string,
  candidates: readonly SessionTrashEntry[],
  leaseDir?: string,
): SessionTrashDeleteResult {
  return withSessionLeaseLock(leaseDir, () => {
    const result: SessionTrashDeleteResult = { files: 0, bytes: 0 };
    const normalizedTrashDir = normalizedPath(trashDir);
    for (const candidate of candidates) {
      if (normalizedPath(dirname(candidate.filePath)) !== normalizedTrashDir
        || basename(candidate.filePath) !== candidate.name
        || !SESSION_TRASH_NAME_PATTERN.test(candidate.name)) {
        throw new Error(`Session 回收站候选路径无效，已取消永久删除：${candidate.filePath}`);
      }
      const state = lstatSync(candidate.filePath);
      if (state.isSymbolicLink() || !state.isFile() || !sameTrashIdentity(candidate, state)) {
        throw new Error(`Session 回收站文件身份已变化，已取消永久删除：${candidate.filePath}`);
      }
    }
    for (const candidate of candidates) {
      const state = lstatSync(candidate.filePath);
      if (state.isSymbolicLink() || !state.isFile() || !sameTrashIdentity(candidate, state)) {
        throw new Error(`Session 回收站文件身份已变化，已取消永久删除：${candidate.filePath}`);
      }
      unlinkSync(candidate.filePath);
      result.files++;
      result.bytes += candidate.size;
    }
    return result;
  });
}

function assertDeletableFile(filePath: string): void {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`拒绝删除链接或非普通 Session 文件：${filePath}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "r+");
  } catch (error) {
    throw new Error(`Session 文件可能正被占用或不可写，已取消删除 ${filePath}：${sqliteError(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function trashSession(
  session: ManagedSession,
  getCurrentFile: (() => string | undefined) | string | undefined,
  databasePath: string,
  trashDir: string,
  leaseDir?: string,
): string {
  let currentFile: () => string | undefined;
  if (typeof getCurrentFile === "function") currentFile = getCurrentFile;
  else {
    const fixedCurrentFile = getCurrentFile;
    currentFile = () => fixedCurrentFile;
  }
  if (sameFile(session.path, currentFile())) {
    throw new Error("不能删除当前正在使用的 Session；请先 /new 或切换到其他 Session");
  }
  assertSessionNotLeased(leaseDir, session.path);
  assertDeletableFile(session.path);
  mkdirSync(trashDir, { recursive: true });
  const destination = join(
    trashDir,
    `${new Date().toISOString().replaceAll(":", "-")}_${session.id}_${randomUUID()}_${basename(session.path)}`,
  );
  if (normalizedPath(dirname(destination)) !== normalizedPath(trashDir)) throw new Error("无效的 Session 回收路径");

  return withSessionLeaseLock(leaseDir, () => withHermesDatabase(databasePath, (db) => {
    db.exec("BEGIN IMMEDIATE");
    let moved = false;
    try {
      // Recheck after waiting for the lease and database locks, immediately before the move.
      // A disk-only Session is valid when explicit indexing has never been run;
      // any partial or differently mapped index state remains fail-closed.
      const indexState = classifySessionIndexForDelete(db, session.id, session.path);
      if (sameFile(session.path, currentFile())) throw new Error("Session 已成为当前会话，已取消删除");
      assertSessionNotLeased(leaseDir, session.path);
      assertDeletableFile(session.path);
      try {
        renameSync(session.path, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
          throw new Error(`Session 文件正被占用或无权移动，未删除索引：${session.path}`);
        }
        throw error;
      }
      moved = true;
      if (indexState === "indexed") removeExactIndexedSession(db, session.id, session.path);
      db.exec("COMMIT");
      return destination;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* database close will retry rollback */ }
      if (moved) {
        try {
          renameSync(destination, session.path);
          moved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `删除失败，且无法将 Session 文件补偿恢复到 ${session.path}；文件仍位于 ${destination}`,
          );
        }
      }
      throw error;
    }
  }));
}
