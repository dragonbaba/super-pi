import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withMarkdownMutationLock } from "./markdown-mutation-lock.js";

export const RECOVERY_DIRECTORY_MAX_COUNT = 32;
export const RECOVERY_DIRECTORY_MAX_BYTES = 16 * 1024 * 1024;
export const RECOVERY_GLOBAL_MAX_COUNT = 128;
export const RECOVERY_GLOBAL_MAX_BYTES = 64 * 1024 * 1024;
export const RECOVERY_AGGREGATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RECOVERY_GLOBAL_MAX_PROJECT_DIRS = 256;

const GENERATED_ARTIFACT_NAME_PATTERN = /^\.(MEMORY\.md|USER\.md|failures\.md)\.(recovery|retired|conflict-[a-z0-9_-]+)-(\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

type RecoveryArtifact = {
  filePath: string;
  targetPath: string;
  state: Stats;
};

export type RecoveryArtifactGovernanceResult = {
  scanned: number;
  removed: number;
  removedBytes: number;
  changedDuringSweep: number;
  failed: number;
  retainedCount: number;
  retainedBytes: number;
};

export type RecoveryArtifactTreeResult = RecoveryArtifactGovernanceResult & {
  directoriesScanned: number;
  projectLimitReached: boolean;
};

function newestFirst(left: RecoveryArtifact, right: RecoveryArtifact): number {
  if (right.state.mtimeMs !== left.state.mtimeMs) return right.state.mtimeMs - left.state.mtimeMs;
  return left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0;
}

function emptyResult(): RecoveryArtifactGovernanceResult {
  return {
    scanned: 0,
    removed: 0,
    removedBytes: 0,
    changedDuringSweep: 0,
    failed: 0,
    retainedCount: 0,
    retainedBytes: 0,
  };
}

function isSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function scanDirectory(directory: string): Promise<RecoveryArtifact[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }

  const artifacts: RecoveryArtifact[] = [];
  for (const name of names) {
    const match = GENERATED_ARTIFACT_NAME_PATTERN.exec(name);
    if (!match) continue;
    const filePath = path.join(directory, name);
    try {
      const state = await fs.lstat(filePath);
      if (!state.isSymbolicLink() && state.isFile()) {
        artifacts.push({ filePath, targetPath: path.join(directory, match[1]), state });
      }
    } catch {
      // A concurrent owner may have completed its own bounded sweep.
    }
  }
  return artifacts;
}

async function unlinkUnchanged(item: RecoveryArtifact, result: RecoveryArtifactGovernanceResult): Promise<void> {
  try {
    const current = await fs.lstat(item.filePath);
    if (current.isSymbolicLink() || !current.isFile() || !isSameIdentity(current, item.state)) {
      result.changedDuringSweep++;
      return;
    }
    await fs.unlink(item.filePath);
    result.removed++;
    result.removedBytes += item.state.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed++;
  }
}

async function unlinkTargetBatch(
  targetPath: string,
  items: readonly RecoveryArtifact[],
  result: RecoveryArtifactGovernanceResult,
): Promise<void> {
  try {
    await withMarkdownMutationLock(targetPath, async () => {
      for (const item of items) await unlinkUnchanged(item, result);
    }, { staleMs: 0 });
  } catch {
    result.failed += items.length;
  }
}

async function applyBudget(
  artifacts: RecoveryArtifact[],
  maxCount: number,
  maxBytes: number,
  now: number,
): Promise<RecoveryArtifactGovernanceResult> {
  const result = emptyResult();
  result.scanned = artifacts.length;
  artifacts.sort(newestFirst);
  const cutoff = now - RECOVERY_AGGREGATE_MAX_AGE_MS;
  let retainedCount = 0;
  let retainedBytes = 0;
  const removalsByTarget = new Map<string, RecoveryArtifact[]>();

  for (const item of artifacts) {
    const withinAge = item.state.mtimeMs >= cutoff;
    const withinCount = retainedCount < maxCount;
    const withinBytes = retainedBytes + item.state.size <= maxBytes;
    if (withinAge && withinCount && withinBytes) {
      retainedCount++;
      retainedBytes += item.state.size;
      continue;
    }
    let removals = removalsByTarget.get(item.targetPath);
    if (!removals) {
      removals = [];
      removalsByTarget.set(item.targetPath, removals);
    }
    removals.push(item);
  }
  for (const [targetPath, items] of removalsByTarget) {
    await unlinkTargetBatch(targetPath, items, result);
  }

  result.retainedCount = retainedCount;
  result.retainedBytes = retainedBytes;
  return result;
}

function mergeResult(
  destination: RecoveryArtifactGovernanceResult,
  source: RecoveryArtifactGovernanceResult,
): void {
  destination.scanned += source.scanned;
  destination.removed += source.removed;
  destination.removedBytes += source.removedBytes;
  destination.changedDuringSweep += source.changedDuringSweep;
  destination.failed += source.failed;
  destination.retainedCount = source.retainedCount;
  destination.retainedBytes = source.retainedBytes;
}

/**
 * Enforce an aggregate budget across all canonical memory targets in one
 * global or project memory directory. Only exact generated artifact names,
 * ordinary files, and unchanged file identities can be removed.
 */
export async function pruneRecoveryArtifactDirectory(
  directory: string,
  now = Date.now(),
): Promise<RecoveryArtifactGovernanceResult> {
  return applyBudget(
    await scanDirectory(directory),
    RECOVERY_DIRECTORY_MAX_COUNT,
    RECOVERY_DIRECTORY_MAX_BYTES,
    now,
  );
}

/**
 * First bounds every immediate global/project directory, then applies one
 * global cap across the surviving artifacts. Project symlinks and deeper user
 * directories are never traversed.
 */
export async function pruneRecoveryArtifactTree(
  globalDir: string,
  projectsRoot: string,
  now = Date.now(),
  maxProjectDirs = RECOVERY_GLOBAL_MAX_PROJECT_DIRS,
): Promise<RecoveryArtifactTreeResult> {
  const aggregate = emptyResult() as RecoveryArtifactTreeResult;
  aggregate.directoriesScanned = 0;
  aggregate.projectLimitReached = false;
  const directories: string[] = [globalDir];

  let projectsDirectory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {
    projectsDirectory = await fs.opendir(projectsRoot);
    for await (const entry of projectsDirectory) {
      if (!entry.isDirectory()) continue;
      if (directories.length - 1 >= Math.max(0, maxProjectDirs)) {
        aggregate.projectLimitReached = true;
        break;
      }
      directories.push(path.join(projectsRoot, entry.name));
    }
  } catch {
    // The projects root is optional on a new installation.
  } finally {
    if (projectsDirectory) {
      try { await projectsDirectory.close(); } catch { /* iteration may have closed it */ }
    }
  }

  for (const directory of directories) {
    const directoryResult = await pruneRecoveryArtifactDirectory(directory, now);
    mergeResult(aggregate, directoryResult);
    aggregate.directoriesScanned++;
  }

  const survivors: RecoveryArtifact[] = [];
  for (const directory of directories) {
    const entries = await scanDirectory(directory);
    for (const entry of entries) survivors.push(entry);
  }
  const globalResult = await applyBudget(
    survivors,
    RECOVERY_GLOBAL_MAX_COUNT,
    RECOVERY_GLOBAL_MAX_BYTES,
    now,
  );
  mergeResult(aggregate, globalResult);
  return aggregate;
}
