import { link, lstat, open, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";
import { UNSAFE_NATIVE_PATH_PATTERN, NATIVE_ERROR_CATEGORY_PATTERN } from "./regex.ts";

export type NativeOperation = "delete" | "move";
export interface NativeInput { path: string; destination?: string; purpose?: string }
export interface PathIdentity {
  path: string;
  canonical: string;
  device: string;
  inode: string;
  size: string;
  mtime: string;
  ctime: string;
  mode: string;
  links: string;
  directory: boolean;
}
export interface NativePlan {
  operation: NativeOperation;
  cwd: string;
  source: PathIdentity;
  sourceParent: PathIdentity;
  destination?: string;
  destinationParent?: PathIdentity;
  protectedPaths: readonly { canonicalTarget: string; protectedRoots: readonly string[] }[];
}
export type MutationStatus = "succeeded" | "failed_no_change" | "partial" | "not_started" | "cancelled" | "state_unknown";
export interface NativeReceipt {
  mutationReceiptVersion: 2;
  operation: NativeOperation;
  target: string;
  destination?: string;
  status: MutationStatus;
  stateChanged: boolean | "unknown";
  ok: boolean;
  category: string;
  sourceIdentity?: { device: string; inode: string };
  requiresVerification?: true;
  cause?: string;
}

export function validateNativeInput(operation: NativeOperation, value: unknown): asserts value is NativeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[TOOL_ARGS_INVALID] Expected an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!("value" in Object.getOwnPropertyDescriptor(input, key)!)) throw new Error("[TOOL_ARGS_INVALID] Accessor fields are unsupported.");
    if (key !== "path" && key !== "purpose" && !(operation === "move" && key === "destination")) throw new Error(`[TOOL_ARGS_INVALID] Unexpected ${key}.`);
  }
  for (const key of operation === "move" ? ["path", "destination"] : ["path"]) {
    const path = input[key];
    if (typeof path !== "string" || !path.trim() || path.length > 4096 || UNSAFE_NATIVE_PATH_PATTERN.test(path)) throw new Error(`[TOOL_ARGS_INVALID] ${key} must be one literal path (1-4096 characters).`);
  }
  if (input.purpose !== undefined && (typeof input.purpose !== "string" || input.purpose.length > 800)) throw new Error("[TOOL_ARGS_INVALID] Invalid purpose.");
}

export async function capturePathIdentity(path: string): Promise<PathIdentity> {
  const canonical = await realpath(path);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("[unsupported] Links, reparse points and special files are unsupported.");
  return Object.freeze({ path, canonical, device: String(info.dev), inode: String(info.ino),
    size: String(info.size), mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), mode: String(info.mode), links: String(info.nlink), directory: info.isDirectory() });
}

export function sameIdentity(a: PathIdentity, b: PathIdentity, metadata = true): boolean {
  return a.canonical === b.canonical && a.device === b.device && a.inode === b.inode && a.directory === b.directory && a.mode === b.mode
    && (!metadata || (a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && a.links === b.links));
}

async function assertAbsent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("[destination_exists] Move does not overwrite an existing destination.");
}

export async function prepareNativeOperation(cwd: string, operation: NativeOperation, input: unknown): Promise<NativePlan> {
  validateNativeInput(operation, input);
  const path = resolve(cwd, input.path);
  const destinationInput = input.destination;
  const sourceParent = await capturePathIdentity(dirname(path));
  const source = await capturePathIdentity(path);
  if (operation === "move" && source.directory) throw new Error("[unsupported] Move supports ordinary files only.");
  if (source.directory) {
    const directory = await opendir(source.path);
    try { if (await directory.read()) throw new Error("[directory_not_empty] Recursive deletion is unsupported."); }
    finally { await directory.close(); }
  }
  let destination: string | undefined;
  let destinationParent: PathIdentity | undefined;
  if (operation === "move") {
    destinationParent = await capturePathIdentity(dirname(resolve(cwd, destinationInput!)));
    destination = resolve(destinationParent.canonical, basename(destinationInput!));
    if (!destinationParent.directory) throw new Error("[unsupported] Destination parent is not a directory.");
    if (source.device !== destinationParent.device) throw new Error("[cross_device] Cross-filesystem move is unsupported.");
    await assertAbsent(destination);
  }
  const protectedPaths = [];
  for (const target of destination ? [source.canonical, sourceParent.canonical, destination, destinationParent!.canonical] : [source.canonical, sourceParent.canonical]) {
    const assessment = await assessProtectedMutationPath(cwd, target);
    if (!assessment.canonicalTarget) throw new Error("[POLICY_BLOCKED] Unverifiable path.");
    protectedPaths.push(Object.freeze({ canonicalTarget: assessment.canonicalTarget, protectedRoots: Object.freeze(assessment.violations) }));
  }
  return Object.freeze({ operation, cwd, source, sourceParent, destination, destinationParent, protectedPaths: Object.freeze(protectedPaths) });
}

export async function revalidateNativePlan(plan: NativePlan): Promise<void> {
  for (const approved of plan.protectedPaths) {
    const current = await assessProtectedMutationPath(plan.cwd, approved.canonicalTarget);
    if (current.canonicalTarget !== approved.canonicalTarget || current.violations.join("\0") !== approved.protectedRoots.join("\0")) throw new Error("[POLICY_BLOCKED] Protected path assessment changed.");
  }
  await revalidateNativeIdentity(plan);
}

async function revalidateNativeIdentity(plan: NativePlan): Promise<void> {
  if (!sameIdentity(plan.sourceParent, await capturePathIdentity(plan.sourceParent.path), false)
    ) throw new Error("[STALE_STATE] Source parent changed after preparation.");
  if (plan.destinationParent) {
    if (!sameIdentity(plan.destinationParent, await capturePathIdentity(plan.destinationParent.path), false)) throw new Error("[STALE_STATE] Destination parent changed.");
    await assertAbsent(plan.destination!);
  }
  if (!sameIdentity(plan.source, await capturePathIdentity(plan.source.path))) throw new Error("[STALE_STATE] Source changed after preparation.");
}

/** Bounded streaming hash only when prior evidence exists; metadata operations never load a file into model context. */
export async function hashNativeSource(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await file.close(); }
}

export function nativeFailure(plan: NativePlan, error: unknown, status: MutationStatus = "failed_no_change"): NativeReceipt {
  let cause = error instanceof Error ? error.message : String(error);
  let structuredCategory: string | undefined;
  try { const parsed = JSON.parse(cause); if (typeof parsed?.category === "string") { structuredCategory = parsed.category; cause = typeof parsed.cause === "string" ? parsed.cause : parsed.category; } } catch { /* Bracket/OS errors need no JSON payload. */ }
  return { mutationReceiptVersion: 2, operation: plan.operation, target: plan.source.canonical, destination: plan.destination,
    status, stateChanged: status === "state_unknown" ? "unknown" : status === "partial", ok: false,
    category: structuredCategory ?? (error as NodeJS.ErrnoException)?.code ?? (NATIVE_ERROR_CATEGORY_PATTERN.exec(cause)?.[1] ?? "operation_failed"),
    cause: cause.slice(0, 1200), ...(status === "partial" || status === "state_unknown" ? { requiresVerification: true as const } : {}) };
}

/** Exclusive link guarantees no replacement on Linux and Windows; unlink is a separate, fallible step. */
export async function executeNativePlan(plan: NativePlan, assertAuthority: () => void, signal?: AbortSignal): Promise<NativeReceipt> {
  let linked = false;
  let attempted = false;
  try {
    signal?.throwIfAborted();
    await revalidateNativePlan(plan);
    assertAuthority();
    await revalidateNativeIdentity(plan);
    assertAuthority();
    signal?.throwIfAborted();
    if (plan.operation === "move") {
      attempted = true;
      await link(plan.source.path, plan.destination!);
      linked = true;
      if (!sameIdentity(plan.sourceParent, await capturePathIdentity(plan.sourceParent.path), false)
        || !sameIdentity(plan.destinationParent!, await capturePathIdentity(plan.destinationParent!.path), false)) throw new Error("[STALE_STATE] Verify both names: identity changed after exclusive link.");
      signal?.throwIfAborted();
      assertAuthority();
      const destination = await capturePathIdentity(plan.destination!);
      const source = await capturePathIdentity(plan.source.path);
      if (!sameIdentity(plan.source, source, false) || source.size !== plan.source.size || source.mtime !== plan.source.mtime
        || destination.device !== source.device || destination.inode !== source.inode) throw new Error("[STALE_STATE] Verify both names: identity changed before source unlink.");
      assertAuthority();
      await unlink(plan.source.path);
    } else {
      attempted = true;
      if (plan.source.directory) await rmdir(plan.source.path);
      else await unlink(plan.source.path);
    }
    return { mutationReceiptVersion: 2, operation: plan.operation, target: plan.source.canonical, destination: plan.destination,
      status: "succeeded", stateChanged: true, ok: true, category: "success", sourceIdentity: { device: plan.source.device, inode: plan.source.inode } };
  } catch (error) {
    const knownFailure = ["EEXIST", "ENOENT", "EACCES", "EPERM", "EBUSY", "ENOTEMPTY", "EXDEV", "ENOTDIR", "EISDIR", "EMLINK", "ENOSPC", "EROFS", "ENOTSUP"].includes((error as NodeJS.ErrnoException)?.code ?? "");
    return nativeFailure(plan, error, linked ? "partial" : attempted && !knownFailure ? "state_unknown" : signal?.aborted ? "cancelled" : "failed_no_change");
  }
}
