import { createHash, randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertPermissionMode, type SessionPermissionMode } from "./permission-mode.ts";
import type { SessionManager } from "./session-manager.ts";

export interface SessionExecutionProfile { mode: SessionPermissionMode; directories: readonly string[]; }
export const WORKSPACE_TOOL_NAMES = ["read", "ls", "find", "grep", "write", "edit", "delete", "move", "file_batch", "bash", "powershell"] as const;
export const MAX_SESSION_DIRECTORIES = 16;

export function containsDirectory(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
}

/** Invoked at the user-command/restore boundary, never inferred from shell source. */
export function sessionDirectories(cwd: string, values: readonly string[], requireExisting = true): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_SESSION_DIRECTORIES) throw new Error("At most 16 additional working directories are supported");
  const primary = realpathSync(cwd), directories: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) throw new Error("Invalid working directory");
    const target = requireExisting ? realpathSync(resolve(cwd, value)) : resolve(cwd, value);
    if (process.platform === "win32" && target.startsWith("\\\\")) throw new Error("Working directories must use local drive paths");
    if (requireExisting && !lstatSync(target).isDirectory() || dirname(target) === target) throw new Error("Expected a directory below a filesystem root: " + target);
    if (containsDirectory(primary, target) || containsDirectory(target, primary)) throw new Error("Working directories must not overlap: " + target);
    for (const previous of directories) if (containsDirectory(previous, target) || containsDirectory(target, previous)) throw new Error("Working directories must not overlap: " + target);
    directories.push(target);
  }
  return Object.freeze(directories);
}

function binding(manager: SessionManager) {
  const file = manager.getSessionFile();
  if (!manager.isPersisted() || !file) return undefined;
  return { file: resolve(file), session: manager.getSessionId(), cwd: realpathSync(manager.getCwd()), machine: hostname(), user: userInfo().username };
}
function recordPath(agentDir: string, file: string): string {
  return join(agentDir, "session-execution", createHash("sha256").update(file).digest("hex") + ".json");
}

/** Authority is host-local and bound to one session and cwd, never read from imported transcript entries. */
export function loadSessionExecutionProfile(agentDir: string, manager: SessionManager): SessionExecutionProfile | undefined {
  const expected = binding(manager);
  if (!expected) return undefined;
  const file = recordPath(agentDir, expected.file);
  let value;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || realpathSync(file) !== resolve(file)) throw new Error("Invalid local session execution record");
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (value.version !== 1 || value.file !== expected.file || value.session !== expected.session || value.cwd !== expected.cwd
    || value.machine !== expected.machine || value.user !== expected.user) return undefined;
  assertPermissionMode(value.mode);
  return { mode: value.mode, directories: sessionDirectories(expected.cwd, value.directories, false) };
}

export function saveSessionExecutionProfile(agentDir: string, manager: SessionManager, profile: SessionExecutionProfile): void {
  const identity = binding(manager);
  if (!identity) return;
  assertPermissionMode(profile.mode);
  const directories = sessionDirectories(identity.cwd, profile.directories, false), file = recordPath(agentDir, identity.file), parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== resolve(parent)) throw new Error("Redirected session execution store");
  const temporary = join(parent, randomBytes(16).toString("hex") + ".tmp");
  writeFileSync(temporary, JSON.stringify({ version: 1, ...identity, mode: profile.mode, directories }), { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, file); }
  catch (error) { unlinkSync(temporary); throw error; }
}
