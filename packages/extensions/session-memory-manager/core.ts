import {
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertSessionIdNotLeased, assertSessionNotLeased, readSessionOccupancy, withSessionLeaseLock } from "./lease.ts";
import { unknownSessionText } from "./ui-text.ts";

export type ManagedSession = {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  modified: Date;
  messageCount: number;
};

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

export type DeletionFailure = { path: string; error: string };
export type SessionTrashDeleteResult = { files: number; bytes: number; failures: DeletionFailure[] };
export type SessionDeleteResult = { deleted: string[]; failures: DeletionFailure[] };

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

export function occupiedSessionPaths(sessions: readonly ManagedSession[], currentFile: string | undefined, leaseDir: string): Set<string> {
  const occupancy = readSessionOccupancy(leaseDir);
  const current = currentFile ? canonicalPath(currentFile) : undefined;
  const occupied = new Set<string>();
  for (const session of sessions) {
    const file = canonicalPath(session.path);
    if (file === current || occupancy.paths.has(file) || occupancy.ids.has(session.id)) occupied.add(session.path);
  }
  return occupied;
}

export function deleteSessions(sessions: readonly ManagedSession[], getCurrentFile: () => string | undefined, leaseDir: string): SessionDeleteResult {
  const result: SessionDeleteResult = { deleted: [], failures: [] };
  for (const session of sessions) {
    try {
      withSessionLeaseLock(leaseDir, () => {
        if (sameFile(session.path, getCurrentFile())) throw new Error("当前会话正在使用中");
        assertSessionNotLeased(leaseDir, session.path);
        assertSessionIdNotLeased(leaseDir, session.id);
        const state = lstatSync(session.path);
        if (!state.isFile() || state.isSymbolicLink()) throw new Error("不是普通 Session 文件");
        unlinkSync(session.path);
      });
      result.deleted.push(session.path);
    } catch (error) {
      result.failures.push({ path: session.path, error: error instanceof Error ? error.message : unknownSessionText(error) });
    }
  }
  return result;
}

export function deleteSessionTrashCandidates(trashDir: string, candidates: readonly SessionTrashEntry[], leaseDir?: string): SessionTrashDeleteResult {
  const result: SessionTrashDeleteResult = { files: 0, bytes: 0, failures: [] };
  const normalizedTrashDir = normalizedPath(trashDir);
  for (const candidate of candidates) {
    try {
      withSessionLeaseLock(leaseDir, () => {
        if (normalizedPath(dirname(candidate.filePath)) !== normalizedTrashDir
          || basename(candidate.filePath) !== candidate.name || !SESSION_TRASH_NAME_PATTERN.test(candidate.name)) {
          throw new Error("回收文件候选路径无效");
        }
        assertSessionNotLeased(leaseDir, candidate.filePath);
        assertSessionIdNotLeased(leaseDir, candidate.name.split("_", 2)[1]!);
        const state = lstatSync(candidate.filePath);
        if (state.isSymbolicLink() || !state.isFile() || !sameTrashIdentity(candidate, state)) throw new Error("回收文件身份已变化");
        unlinkSync(candidate.filePath);
      });
      result.files++;
      result.bytes += candidate.size;
    } catch (error) {
      result.failures.push({ path: candidate.filePath, error: error instanceof Error ? error.message : unknownSessionText(error) });
    }
  }
  return result;
}
