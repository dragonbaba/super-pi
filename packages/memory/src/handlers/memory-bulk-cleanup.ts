import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectInfo } from "../project.js";
import type { MemoryConfig } from "../types.js";
import { MemoryStore } from "../store/memory-store.js";
import type { DatabaseManager } from "../store/db.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import { readRawMemoryFile, type RawMemoryEntry, type RawMemorySnapshot } from "../store/raw-memory.js";
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from "../constants.js";
import { PROJECT_ID_PATTERN, resolveAuthoritativeProjectFile, reconcileProjectMarkdownFiles } from "./sync-markdown-memories.js";

export type BulkMemoryScope = "user" | "global" | "project" | "global-failure" | "project-failure" | "all-projects";
type Target = "memory" | "user" | "failure";
export interface BulkMemoryOptions {
  store: MemoryStore; projectStore: MemoryStore | null; project: ProjectInfo;
  globalDir: string; projectsRoot: string; config: MemoryConfig; dbManager: DatabaseManager;
}
export interface BulkMemoryFile {
  target: Target; project: string | null; source: string; snapshot: RawMemorySnapshot;
}
export interface BulkMemoryRow { file: BulkMemoryFile; entry: RawMemoryEntry; }
export interface BulkMemoryList { files: BulkMemoryFile[]; rows: BulkMemoryRow[]; legacyDirectories: number; warnings: string[]; }
export interface BulkMemoryReport { deleted: number; characters: number; changedFiles: number; skippedFiles: number; warnings: string[]; }

function oldestFirst(left: BulkMemoryRow, right: BulkMemoryRow): number {
  const a = left.entry.modified, b = right.entry.modified;
  if (a !== b) return a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  return left.file.snapshot.path < right.file.snapshot.path ? -1 : left.file.snapshot.path > right.file.snapshot.path ? 1 : left.entry.ordinal - right.entry.ordinal;
}

/** Only an explicit menu action scans project directories; no root-path inference. */
export async function listBulkMemory(options: BulkMemoryOptions, scope: BulkMemoryScope): Promise<BulkMemoryList> {
  const result: BulkMemoryList = { files: [], rows: [], legacyDirectories: 0, warnings: [] };
  const add = async (filePath: string | null, target: Target, project: string | null, source: string) => {
    if (!filePath) return;
    try {
      const raw = await readRawMemoryFile(filePath);
      if (!raw || !raw.snapshot.entries.length) return;
      const file: BulkMemoryFile = { target, project, source, snapshot: raw.snapshot };
      result.files.push(file);
      for (const entry of raw.snapshot.entries) {
        // Preserve legacy project-tagged failures in the global-only scope.
        if (scope === "global-failure" && entry.project !== null) continue;
        result.rows.push({ file, entry });
      }
    } catch (error) { result.warnings.push(`${filePath}：${error instanceof Error ? error.message : String(error)}`); }
  };
  if (scope === "all-projects") {
    let root;
    try { root = await fs.lstat(options.projectsRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("项目记忆根目录是链接或不是目录，未读取任何项目");
    const names = await fs.readdir(options.projectsRoot);
    for (const name of names) {
      const directory = path.join(options.projectsRoot, name);
      let state;
      try { state = await fs.lstat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!state.isDirectory() || state.isSymbolicLink()) continue;
      if (!PROJECT_ID_PATTERN.test(name)) { result.legacyDirectories++; continue; }
      await add(resolveAuthoritativeProjectFile(options.projectsRoot, name, MEMORY_FILE), "memory", name, name);
      await add(resolveAuthoritativeProjectFile(options.projectsRoot, name, "failures.md"), "failure", name, name);
    }
  } else if (scope === "project" || scope === "project-failure") {
    if (!options.projectStore || !options.project.memoryDir || !options.project.name) throw new Error("当前没有项目记忆范围");
    const target = scope === "project" ? "memory" : "failure";
    await add(path.join(options.project.memoryDir, target === "memory" ? MEMORY_FILE : "failures.md"), target, options.project.name, "当前项目");
  } else {
    const target = scope === "user" ? "user" : scope === "global" ? "memory" : "failure";
    await add(path.join(options.globalDir, target === "user" ? USER_FILE : target === "memory" ? MEMORY_FILE : "failures.md"), target, null, target === "user" ? "用户偏好" : "全局");
  }
  result.rows.sort(oldestFirst);
  return result;
}

export function summarizeBulkSelection(rows: readonly BulkMemoryRow[]): { count: number; files: Array<{ file: BulkMemoryFile; count: number; characters: number }>; characters: number } {
  const grouped = new Map<BulkMemoryFile, Set<number>>();
  for (const row of rows) {
    let selected = grouped.get(row.file);
    if (!selected) { selected = new Set(); grouped.set(row.file, selected); }
    selected.add(row.entry.ordinal);
  }
  const files: Array<{ file: BulkMemoryFile; count: number; characters: number }> = [];
  let count = 0, characters = 0;
  for (const [file, selected] of grouped) {
    let removed = 0;
    for (const ordinal of selected) removed += file.snapshot.entries[ordinal]!.chars;
    removed += ENTRY_DELIMITER.length * Math.max(0, selected.size - (selected.size === file.snapshot.entries.length ? 1 : 0));
    files.push({ file, count: selected.size, characters: removed }); count += selected.size; characters += removed;
  }
  return { count, files, characters };
}

/** Each confirmed command owns at most the global and projects coordinator.
 * Transient stores release caches without closing an active owner's shared DB. */
export async function executeBulkMemoryCleanup(options: BulkMemoryOptions, rows: readonly BulkMemoryRow[]): Promise<BulkMemoryReport> {
  const report: BulkMemoryReport = { deleted: 0, characters: 0, changedFiles: 0, skippedFiles: 0, warnings: [] };
  const selected = new Map<BulkMemoryFile, RawMemoryEntry[]>(), coordinators = new Map<string, AtomicLockCoordinator>();
  for (const row of rows) {
    let entries = selected.get(row.file);
    if (!entries) { entries = []; selected.set(row.file, entries); }
    entries.push(row.entry);
  }
  try {
    for (const [file, entries] of selected) {
      const active = file.project === null ? options.store : file.project === options.project.name ? options.projectStore : null;
      const store = active ?? new MemoryStore({ ...options.config, memoryDir: path.dirname(file.snapshot.path) });
      const coordinatorPath = path.join(path.dirname(path.dirname(file.snapshot.path)), ".pi-hermes-locks.sqlite");
      let coordinator = coordinators.get(coordinatorPath);
      if (!coordinator) { coordinator = new AtomicLockCoordinator(coordinatorPath); coordinators.set(coordinatorPath, coordinator); }
      try {
        const result = await store.removeRawEntries(file.target, file.snapshot, entries, coordinator);
        report.deleted += result.deleted; report.characters += result.characters; report.changedFiles++;
        if (result.warning) report.warnings.push(`${file.snapshot.path}：搜索索引或内存刷新未同步：${result.warning}`);
        if (!active && file.project !== null && (file.target === "memory" || file.target === "failure")) {
          try {
            const sync = await reconcileProjectMarkdownFiles(options.dbManager, options.projectsRoot, file.project, [file.target], coordinator);
            for (const warning of sync.warnings) report.warnings.push(`${file.snapshot.path}：搜索索引未同步：${warning}`);
          } catch (error) { report.warnings.push(`${file.snapshot.path}：搜索索引未同步：${error instanceof Error ? error.message : String(error)}`); }
        }
      } catch (error) {
        report.skippedFiles++; report.warnings.push(`${file.snapshot.path}：跳过文件：${error instanceof Error ? error.message : String(error)}`);
      } finally { if (!active) store.close({ closeSharedCoordinators: false }); }
    }
  } finally {
    for (const coordinator of coordinators.values()) coordinator.close();
    selected.clear(); coordinators.clear();
  }
  return report;
}
