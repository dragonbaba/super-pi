/**
 * Markdown memory sync command — /memory > 同步搜索索引 reconciles the SQLite
 * search mirror with authoritative Markdown memory files.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from "@super-pi/coding-agent";
import { DatabaseManager } from '../store/db.js';
import {
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
} from '../store/sqlite-memory-store.js';
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from '../constants.js';
import { AGENT_ROOT } from '../paths.js';
import { withMarkdownMutationLock } from '../store/markdown-mutation-lock.js';
import { scanContent } from '../store/content-scanner.js';
import type { AtomicLockCoordinator } from '../store/atomic-lock-coordinator.js';
import { readRawMemoryFile } from '../store/raw-memory.js';

export const PROJECT_ID_PATTERN = /--[a-f0-9]{24}$/;

export interface BackfillCounters {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  removed: number;
  warnings: string[];
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

function scanProjectDirs(agentRoot: string, projectsMemoryDir = "projects-memory"): Array<{ name: string; memoryFile: string | null }> {
  const projectsRoot = path.resolve(agentRoot, projectsMemoryDir);
  const projects: Array<{ name: string; memoryFile: string | null }> = [];

  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      if (!PROJECT_ID_PATTERN.test(name) || !isSafeProjectName(name, projectsRoot)) continue;
      const memoryFile = resolveAuthoritativeMemoryFile(projectsRoot, name);
      const failureFile = resolveAuthoritativeProjectFile(projectsRoot, name, "failures.md");
      if (memoryFile && fs.existsSync(memoryFile) || failureFile && fs.existsSync(failureFile)) projects.push({ name, memoryFile });
    }
  }

  return projects;
}

function realpathIfPresent(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(filePath);
    throw error;
  }
}

export function resolveAuthoritativeProjectFile(root: string, projectName: string, fileName: string): string | null {
  const canonicalRoot = realpathIfPresent(root);
  if (!isSafeProjectName(projectName, path.resolve(root))) return null;
  if (path.basename(fileName) !== fileName || (fileName !== MEMORY_FILE && fileName !== "failures.md")) return null;

  const projectDir = path.join(root, projectName);
  let projectStat: fs.Stats;
  try {
    projectStat = fs.lstatSync(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return path.join(canonicalRoot, projectName, fileName);
    }
    throw error;
  }
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return null;

  const canonicalProjectDir = fs.realpathSync(projectDir);
  if (path.dirname(canonicalProjectDir) !== canonicalRoot) return null;

  const projectFile = path.join(projectDir, fileName);
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(projectFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return path.join(canonicalProjectDir, fileName);
    }
    throw error;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;

  const canonicalProjectFile = fs.realpathSync(projectFile);
  if (path.dirname(canonicalProjectFile) !== canonicalProjectDir || path.basename(canonicalProjectFile) !== fileName) {
    return null;
  }
  return canonicalProjectFile;
}

function backfillCounters(): BackfillCounters {
  return { filesScanned: 0, entriesScanned: 0, imported: 0, skipped: 0, removed: 0, warnings: [] };
}

async function reconcileFile(dbManager: DatabaseManager, counters: BackfillCounters, filePath: string | null,
  target: 'memory' | 'user' | 'failure', project: string | null = null, coordinator?: AtomicLockCoordinator,
): Promise<void> {
  const reconcile = async () => {
    if (filePath && fs.existsSync(filePath)) counters.filesScanned++;
    let entries: string[];
    if (filePath && coordinator) {
      const raw = await readRawMemoryFile(filePath);
      entries = raw ? raw.bytes.toString('utf8').split(ENTRY_DELIMITER).map(entry => entry.trim()).filter(Boolean) : [];
    } else entries = filePath ? readEntries(filePath) : [];
    counters.entriesScanned += entries.length;
    const safeEntries: string[] = [];
    for (const entry of entries) {
      const blocked = scanContent(entry);
      if (blocked) counters.warnings.push(`${path.basename(project ?? 'global')}/${target}: ${blocked}`);
      else safeEntries.push(entry);
    }
    try {
      const result = target === 'failure' && project === null
        ? reconcileMarkdownFailureScopes(dbManager, safeEntries, false)
        : reconcileMarkdownMemoryScope(dbManager, safeEntries, target, project);
      counters.imported += result.inserted; counters.skipped += result.existing; counters.removed += result.removed;
    } catch (error) {
      counters.warnings.push(`${path.basename(project ?? 'global')}/${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (filePath) await withMarkdownMutationLock(filePath, reconcile, { coordinator });
  else await reconcile();
}

/** Explicit cleanup reconciles only affected files, using its own connection. */
export async function reconcileProjectMarkdownFiles(dbManager: DatabaseManager, projectsRoot: string, project: string,
  targets: readonly ('memory' | 'failure')[], coordinator: AtomicLockCoordinator,
): Promise<BackfillCounters> {
  if (!PROJECT_ID_PATTERN.test(project)) throw new Error('Not a canonical project identity');
  const counters = backfillCounters();
  for (const target of targets) {
    const filePath = resolveAuthoritativeProjectFile(projectsRoot, project, target === 'memory' ? MEMORY_FILE : 'failures.md');
    await reconcileFile(dbManager, counters, filePath, target, project, coordinator);
  }
  return counters;
}

function resolveAuthoritativeMemoryFile(root: string, projectName: string): string | null {
  return resolveAuthoritativeProjectFile(root, projectName, MEMORY_FILE);
}

function isSafeProjectName(name: string, projectsRoot: string): boolean {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return false;
  }
  const projectDir = path.resolve(projectsRoot, name);
  return path.dirname(projectDir) === projectsRoot && path.basename(projectDir) === name;
}

export async function syncMarkdownMemoriesToSqlite(
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
): Promise<BackfillCounters & { projectCount: number }> {
  const counters = backfillCounters();

  const globalMemoryFile = path.join(globalDir, MEMORY_FILE);
  const globalUserFile = path.join(globalDir, USER_FILE);
  const globalFailureFile = path.join(globalDir, 'failures.md');

  await reconcileFile(dbManager, counters, globalMemoryFile, 'memory');
  await reconcileFile(dbManager, counters, globalUserFile, 'user');
  await reconcileFile(dbManager, counters, globalFailureFile, 'failure');

  const projects = scanProjectDirs(agentRoot, projectsMemoryDir);
  const projectFiles = new Map(projects.map((project) => [project.name, project.memoryFile]));
  const mirroredProjects = dbManager.getDb().prepare(`
    SELECT DISTINCT project
    FROM memories
    WHERE project IS NOT NULL AND target IN ('memory', 'failure')
  `).all() as Array<{ project: string }>;
  const projectNames = new Set([
    ...projectFiles.keys(),
    ...mirroredProjects.map(({ project }) => project),
  ]);
  const projectsRoot = path.resolve(agentRoot, projectsMemoryDir ?? 'projects-memory');
  for (const projectName of projectNames) {
    const currentIdentity = PROJECT_ID_PATTERN.test(projectName);
    const memoryFile = currentIdentity
      ? projectFiles.get(projectName) ?? resolveAuthoritativeMemoryFile(projectsRoot, projectName)
      : null;
    await reconcileFile(dbManager, counters, memoryFile, 'memory', projectName);
    const failureFile = currentIdentity ? resolveAuthoritativeProjectFile(projectsRoot, projectName, "failures.md") : null;
    await reconcileFile(dbManager, counters, failureFile, 'failure', projectName);
  }

  return { ...counters, projectCount: projectNames.size };
}

export function createSyncMarkdownMemoriesHandler(
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
): Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] {
  return async (_args, ctx: ExtensionCommandContext) => {
    ctx.ui.notify('🔄 Reconciling the SQLite search mirror with Markdown memories...', 'info');

    try {
      const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, projectsMemoryDir, agentRoot);

      let output = `\n✅ Markdown → SQLite sync complete!\n\n`;
      output += `📊 Results:\n`;
      output += `├─ Files scanned: ${counters.filesScanned}\n`;
      output += `├─ Entries scanned: ${counters.entriesScanned}\n`;
      output += `├─ Imported into SQLite: ${counters.imported}\n`;
      output += `├─ Skipped as duplicates: ${counters.skipped}\n`;
      output += `└─ Removed orphaned rows: ${counters.removed}\n`;

      if (counters.projectCount > 0) {
        output += `\n📁 Project memories scanned: ${counters.projectCount}\n`;
      }

      if (counters.warnings.length > 0) {
        output += `\n⚠️ Warnings (${counters.warnings.length}):\n`;
        for (const warning of counters.warnings.slice(0, 5)) {
          output += `├─ ${warning}\n`;
        }
        if (counters.warnings.length > 5) {
          output += `└─ ... and ${counters.warnings.length - 5} more\n`;
        }
      }

      output += `\n💡 Re-running this command is safe — existing SQLite rows are de-duplicated.`;
      ctx.ui.notify(output, 'info');
    } catch (err) {
      ctx.ui.notify(`❌ Markdown sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };
}
