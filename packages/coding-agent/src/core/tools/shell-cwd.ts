import { realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Private in-process handoff across source/dist extension loaders; never serialized.
const CWD_BINDING = Symbol.for("super-pi.shell-cwd-binding");
// Weak backend identity registry, not an authorization/path cache. No history or scans.
const localBackends = new WeakMap<object, Function>();
export function registerLocalShellBackend<T extends { exec: Function }>(backend: T): T { localBackends.set(backend, backend.exec); return backend; }
export function isLocalShellBackend(backend: { exec: Function }): boolean { return localBackends.get(backend) === backend.exec; }

/** Invocation-owned directory facts. No cache, handle, timer or model-visible token. */
export class ShellCwdBinding {
  #authority?: () => void;
  #released = false;
  readonly requested: string;
  readonly canonical: string;
  readonly #device: bigint;
  readonly #inode: bigint;
  constructor(requested: string, canonical: string, device: bigint, inode: bigint) {
    this.requested = requested; this.canonical = canonical; this.#device = device; this.#inode = inode; Object.freeze(this);
  }
  get isReleased(): boolean { return this.#released; }
  setAuthority(authority: () => void): void { this.#authority = authority; }
  readonly beforeSpawn = (cwd: string): void => {
    if (this.#released || cwd !== this.canonical) throw new Error("[SHELL_CWD_CHANGED] Execution directory changed.");
    this.#authority?.();
    // Metadata only, at the actual spawn boundary; no awaited work follows this check.
    let canonical: string, directory;
    try { canonical = realpathSync.native(this.requested); directory = statSync(canonical, { bigint: true }); }
    catch (cause) { throw new Error("[SHELL_CWD_CHANGED] Directory lookup failed after authorization; request fresh approval.", { cause }); }
    if (canonical !== this.canonical || !directory.isDirectory() || directory.dev !== this.#device || directory.ino !== this.#inode) {
      throw new Error("[SHELL_CWD_CHANGED] Directory identity changed after authorization; request fresh approval.");
    }
  };
  release(): void { this.#released = true; this.#authority = undefined; }
}

export function getShellCwdBinding(input: unknown): ShellCwdBinding | undefined {
  return input && typeof input === "object" ? (input as Record<symbol, ShellCwdBinding>)[CWD_BINDING] : undefined;
}
export function attachShellCwdBinding(input: object, binding: ShellCwdBinding): void {
  Object.defineProperty(input, CWD_BINDING, { value: binding, configurable: true });
}
export async function prepareShellCwd(input: { cwd?: unknown }, sessionCwd: string): Promise<ShellCwdBinding | undefined> {
  if (input.cwd === undefined) return undefined;
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4096 || input.cwd.includes("\0")) throw new Error("[SHELL_CWD_INVALID] cwd must be a nonempty literal directory path.");
  // No shell/home/MSYS expansion: filesystem paths are interpreted by the local backend.
  const requested = resolve(sessionCwd, input.cwd);
  const existing = getShellCwdBinding(input);
  if (existing && !existing.isReleased) {
    if (existing.requested !== requested) throw new Error("[SHELL_CWD_CHANGED] cwd changed after preparation.");
    return existing;
  }
  const canonical = await realpath(requested);
  const directory = await stat(canonical, { bigint: true });
  if (!directory.isDirectory()) throw new Error("[SHELL_CWD_INVALID] cwd is not a directory.");
  const binding = new ShellCwdBinding(requested, canonical, directory.dev, directory.ino);
  attachShellCwdBinding(input, binding);
  return binding;
}
