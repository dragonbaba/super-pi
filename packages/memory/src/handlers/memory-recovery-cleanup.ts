import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MEMORY_FILE, USER_FILE } from "../constants.js";
import type { MemoryStore } from "../store/memory-store.js";
import { pruneRecoveryArtifactTree } from "../store/recovery-artifact-governance.js";

export const MEMORY_CLEANUP_MAX_PROJECT_DIRS = 256;
export const MEMORY_CLEANUP_MAX_TARGETS = 64;
const FAILURE_FILE = "failures.md";
const GLOBAL_TARGET_FILES = [MEMORY_FILE, USER_FILE, FAILURE_FILE] as const;

export interface MemoryRecoveryCleanupOptions {
  store: MemoryStore;
  globalDir: string;
  projectsRoot: string;
  maxProjectDirs?: number;
  maxTargets?: number;
}

export interface MemoryRecoveryCleanupResult {
  projectDirsScanned: number;
  targetsPruned: number;
  targetsFailed: number;
  projectLimitReached: boolean;
  targetLimitReached: boolean;
  aggregateRemoved: number;
  aggregateRemovedBytes: number;
  aggregateFailed: number;
}

function hasRecoveryArtifacts(names: readonly string[], targetName: string): boolean {
  const recoveryPrefix = `.${targetName}.recovery-`;
  const retiredPrefix = `.${targetName}.retired-`;
  const conflictPrefix = `.${targetName}.conflict-local-`;
  for (const name of names) {
    if (name.startsWith(recoveryPrefix)
      || name.startsWith(retiredPrefix)
      || name.startsWith(conflictPrefix)) return true;
  }
  return false;
}

async function readNames(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}

async function pruneTarget(
  store: MemoryStore,
  targetPath: string,
  result: MemoryRecoveryCleanupResult,
): Promise<void> {
  try {
    await store.pruneRecoveryArtifactsForFile(targetPath);
    result.targetsPruned++;
  } catch {
    result.targetsFailed++;
  }
}

/**
 * Explicitly sweep only the global memory directory and immediate project-memory
 * directories. Directory and target caps keep command work deterministic;
 * artifact processing remains sequential under each target's mutation lock.
 */
export async function runMemoryRecoveryCleanup(
  options: MemoryRecoveryCleanupOptions,
): Promise<MemoryRecoveryCleanupResult> {
  const maxProjectDirs = Math.max(0, options.maxProjectDirs ?? MEMORY_CLEANUP_MAX_PROJECT_DIRS);
  const maxTargets = Math.max(0, options.maxTargets ?? MEMORY_CLEANUP_MAX_TARGETS);
  const result: MemoryRecoveryCleanupResult = {
    projectDirsScanned: 0,
    targetsPruned: 0,
    targetsFailed: 0,
    projectLimitReached: false,
    targetLimitReached: false,
    aggregateRemoved: 0,
    aggregateRemovedBytes: 0,
    aggregateFailed: 0,
  };

  const globalNames = await readNames(options.globalDir);
  for (const targetName of GLOBAL_TARGET_FILES) {
    if (!hasRecoveryArtifacts(globalNames, targetName)) continue;
    if (result.targetsPruned + result.targetsFailed >= maxTargets) {
      result.targetLimitReached = true;
      break;
    }
    await pruneTarget(options.store, path.join(options.globalDir, targetName), result);
  }

  let projectsDirectory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {
    projectsDirectory = await fs.opendir(options.projectsRoot);
  } catch {
    // A new installation may not have project memory yet.
  }

  if (projectsDirectory) {
    try {
      for await (const entry of projectsDirectory) {
        if (!entry.isDirectory()) continue;
        if (result.projectDirsScanned >= maxProjectDirs) {
          result.projectLimitReached = true;
          break;
        }
        result.projectDirsScanned++;

        const projectDir = path.join(options.projectsRoot, entry.name);
        const names = await readNames(projectDir);
        if (!hasRecoveryArtifacts(names, MEMORY_FILE)) continue;
        if (result.targetsPruned + result.targetsFailed >= maxTargets) {
          result.targetLimitReached = true;
          break;
        }
        await pruneTarget(options.store, path.join(projectDir, MEMORY_FILE), result);
      }
    } finally {
      try { await projectsDirectory.close(); } catch { /* async iteration may already close it */ }
    }
  }

  const aggregate = await pruneRecoveryArtifactTree(
    options.globalDir,
    options.projectsRoot,
    Date.now(),
    maxProjectDirs,
  );
  result.aggregateRemoved = aggregate.removed;
  result.aggregateRemovedBytes = aggregate.removedBytes;
  result.aggregateFailed = aggregate.failed;
  if (aggregate.projectLimitReached) result.projectLimitReached = true;
  return result;
}
