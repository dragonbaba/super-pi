/**
 * Project detection — determines whether the current working directory
 * represents a project and resolves its name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { resolveProjectsRoot } from "./paths.js";

export interface ProjectInfo {
  /** Stable storage/search identity, or null outside a project. */
  name: string | null;
  /** Path to the project-scoped memory directory, or null. */
  memoryDir: string | null;
  displayName: string | null;
  root: string | null;
  /** Unassigned old basename locations; never loaded automatically. */
  legacyMemoryDirs: string[];
}

export interface ProjectSkillInfo extends ProjectInfo {
  /** Path to the project-scoped skills directory, or null. */
  skillsDir: string | null;
}

/**
 * Resolve the repository root shared by every linked worktree of `dir`'s repo.
 *
 * Mirrors what `git rev-parse --git-common-dir` reports, without spawning git:
 * a linked worktree's `.git` is a file pointing at
 * `<main>/.git/worktrees/<name>`, and that directory carries a `commondir`
 * file pointing back at the shared `<main>/.git`. Returns null outside a
 * repository, or for a bare/detached layout with no obvious working root.
 */
function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);

  while (true) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }

    if (stat?.isDirectory()) return current;

    if (stat?.isFile()) {
      const commonDir = resolveWorktreeCommonDir(current, dotGit);
      if (!commonDir) return current;
      return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorktreeCommonDir(worktreeRoot: string, dotGitFile: string): string | null {
  let pointer: string;
  try {
    pointer = fs.readFileSync(dotGitFile, "utf-8");
  } catch {
    return null;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;

  const gitDir = path.resolve(worktreeRoot, match[1].trim());
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch {
    // Not a linked worktree, or an older layout without `commondir`.
  }

  // `<main>/.git/worktrees/<name>` — two levels up is the shared git dir.
  const parent = path.dirname(gitDir);
  return path.basename(parent) === "worktrees" ? path.dirname(parent) : null;
}

const REPO_ROOT_CACHE_MAX_ENTRIES = 128;
const repoRootCache = new Map<string, string | null>();

function findGitRepoRootCached(resolved: string): string | null {
  const cached = repoRootCache.get(resolved);
  if (cached !== undefined) {
    // Map iteration order is the recency list; refresh without allocating a
    // wrapper node or per-lookup closure.
    repoRootCache.delete(resolved);
    repoRootCache.set(resolved, cached);
    return cached;
  }

  const repoRoot = findGitRepoRoot(resolved);
  if (repoRootCache.size >= REPO_ROOT_CACHE_MAX_ENTRIES) {
    const oldest = repoRootCache.keys().next();
    if (!oldest.done) repoRootCache.delete(oldest.value);
  }
  repoRootCache.set(resolved, repoRoot);
  return repoRoot;
}

function canonicalDirectory(directory: string): string {
  try { return fs.realpathSync.native(directory); } catch { return path.resolve(directory); }
}

function identityPath(directory: string): string {
  return process.platform === "win32" ? directory.toLowerCase() : directory;
}

/** Same repository/worktree shares one identity; same basename elsewhere does not. */
export function detectProject(projectsMemoryDir = "projects-memory", cwd?: string): ProjectInfo {
  const dir = cwd ?? process.cwd();
  const resolved = canonicalDirectory(dir);
  const root = canonicalDirectory(findGitRepoRootCached(resolved) ?? resolved);
  if (identityPath(root) === identityPath(canonicalDirectory(os.homedir())) || root === path.parse(root).root) {
    return { name: null, memoryDir: null, displayName: null, root: null, legacyMemoryDirs: [] };
  }
  const displayName = path.basename(root);
  const projectsRoot = resolveProjectsRoot(projectsMemoryDir);
  const digest = createHash("sha256").update(identityPath(root)).digest("hex").slice(0, 24);
  const prefix = identityPath(displayName).slice(0, 80);
  const name = `${prefix}--${digest}`;
  const legacyNames = new Set([displayName, path.basename(resolved)]);
  return {
    name,
    memoryDir: path.join(projectsRoot, name),
    displayName,
    root,
    legacyMemoryDirs: [...legacyNames].map((legacy) => path.join(projectsRoot, legacy)),
  };
}

export function detectProjectSkills(projectsMemoryDir = "projects-memory", cwd?: string): ProjectSkillInfo {
  const project = detectProject(projectsMemoryDir, cwd);
  return {
    ...project,
    skillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
  };
}
