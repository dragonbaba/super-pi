import { basename, dirname, resolve } from "node:path";
import { lstat, type FileHandle } from "node:fs/promises";
import { capturePathIdentity, captureDestinationParent, captureTreeIdentity, sameIdentity, prepareTree, revalidateTree, executeTree, hashIdentity, writeIdentityTo, boundedReason,
  type TreePreparation } from "./file-tree-core.mjs";
import { validateNativeInvocation, nativeItemInput, type NativeFileItemInput, type NativeFileOperation } from "./file-operation-input.ts";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";
import { assertIndependent } from "./file-path-conflicts.ts";
import { commitPreparedFile, commitFailure, FileCommitError, type FileCommitPlan, type FileCommitStream, type FileCommitHooks, type FileCommitReceipt } from "./file-commit.ts";
import { selectCommitMetadata } from "./file-commit-metadata.ts";
import type { PathIdentity, MutationStatus } from "./native-file-core.ts";

export interface NativeTreePlan {
  operation: NativeFileOperation; cwd: string; input: Readonly<NativeFileItemInput>;
  source: PathIdentity; sourceParent: PathIdentity; tree: TreePreparation;
  destination?: string; destinationParent?: PathIdentity; destinationIdentity?: PathIdentity;
  sourceHash?: string; overwriteCommit?: FileCommitPlan;
  deferredCopyHash?: true;
  protectedPaths: readonly { canonicalTarget: string; protectedRoots: readonly string[]; followLeaf?: boolean }[];
}
export interface NativeTreeReceipt {
  mutationReceiptVersion: 3; operation: NativeFileOperation; target: string; destination?: string;
  status: MutationStatus; stateChanged: boolean | "unknown"; ok: boolean; requiresVerification?: boolean;
  commit?: FileCommitReceipt;
  [key: string]: unknown;
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("[destination_exists] Destination already exists; directories are never merged or overwritten.");
}
async function protectedTarget(cwd: string, path: string, reading = false, followLeaf = true) {
  const assessment = await assessProtectedMutationPath(cwd, path, followLeaf);
  if (!assessment.canonicalTarget) throw new Error("[POLICY_BLOCKED] Protected or unverifiable mutation target.");
  for (const violation of assessment.violations) if (violation !== "workspace_escape" && !(reading && violation === "workspace_root")) throw new Error("[POLICY_BLOCKED] Protected or unverifiable mutation target.");
  return Object.freeze({ canonicalTarget: assessment.canonicalTarget, protectedRoots: Object.freeze(assessment.violations), followLeaf });
}

/** One top-level item's immutable baseline. The outer invocation authorizes and revalidates every item together. */
export async function prepareNativeTreeOperation(cwd: string, operation: NativeFileOperation, raw: unknown, assertCurrent?: () => void, signal?: AbortSignal, hashContent = true): Promise<NativeTreePlan> {
  validateNativeInvocation(operation, raw);
  if (raw.items !== undefined || raw.paths !== undefined) throw new Error("[TOOL_ARGS_INVALID] Internal tree preparation expects a scalar item.");
  signal?.throwIfAborted(); assertCurrent?.();
  const input = Object.freeze(nativeItemInput(operation, raw, 0)), path = resolve(cwd, input.path);
  const sourceParent = await capturePathIdentity(dirname(path)), source = operation === "delete" ? await captureTreeIdentity(path) : await capturePathIdentity(path);
  const protectedPaths = [await protectedTarget(cwd, source.canonical, operation === "copy", !("symbolicLink" in source))];
  const tree = await prepareTree(source, operation, input.recursive, assertCurrent, signal);
  const plan: NativeTreePlan = { operation, cwd, input, source, sourceParent, tree, protectedPaths };
  if (operation !== "delete") {
    plan.destinationParent = await captureDestinationParent(resolve(cwd, input.destination!));
    if (!plan.destinationParent.directory) throw new Error("[unsupported] Destination parent must be a directory.");
    plan.destination = resolve(plan.destinationParent.canonical, basename(input.destination!));
    protectedPaths.push(await protectedTarget(cwd, plan.destination));
    if (operation === "copy" && input.overwrite === true && !source.directory) {
      try { plan.destinationIdentity = await capturePathIdentity(plan.destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await absent(plan.destination); }
      if (plan.destinationIdentity?.directory) throw new Error("[destination_exists] Copy overwrite only accepts an existing ordinary file.");
      if (plan.destinationIdentity) plan.destination = plan.destinationIdentity.canonical;
    } else await absent(plan.destination);
    assertIndependent([{ itemId: "prepared", target: source.canonical, identity: source, paths: [source.canonical, plan.destination], native: plan }]);
    if (plan.destinationIdentity) {
      if (hashContent) plan.sourceHash = await hashIdentity(source, assertCurrent, signal);
      else plan.deferredCopyHash = true;
      plan.overwriteCommit = { target: plan.destinationIdentity, parent: plan.destinationParent,
        previousSha256: hashContent ? await hashIdentity(plan.destinationIdentity, assertCurrent, signal) : "", metadata: await selectCommitMetadata(plan.destinationIdentity) };
    }
  }
  signal?.throwIfAborted(); assertCurrent?.();
  Object.freeze(protectedPaths); return Object.freeze(plan);
}
/** Content hashing follows the one grant. Metadata-only preflight cannot read a
 * copy source's bytes while a read-role ask is still pending. */
export async function finalizeNativeTreePlan(plan: NativeTreePlan, assertCurrent: () => void, signal?: AbortSignal): Promise<NativeTreePlan> {
  if (!plan.deferredCopyHash) return plan;
  await revalidateNativeTreePlan(plan, assertCurrent, signal);
  const sourceHash = await hashIdentity(plan.source, assertCurrent, signal);
  const previousSha256 = await hashIdentity(plan.destinationIdentity!, assertCurrent, signal);
  return Object.freeze({ ...plan, sourceHash, overwriteCommit: { ...plan.overwriteCommit!, previousSha256 }, deferredCopyHash: undefined });
}
async function assertProtected(plan: NativeTreePlan): Promise<void> {
  for (const expected of plan.protectedPaths) {
    const assessment = await assessProtectedMutationPath(plan.cwd, expected.canonicalTarget, expected.followLeaf);
    if (assessment.canonicalTarget !== expected.canonicalTarget || assessment.violations.length !== expected.protectedRoots.length) throw new Error("[POLICY_BLOCKED] Prepared path protection changed.");
    for (let index = 0; index < assessment.violations.length; index++) if (assessment.violations[index] !== expected.protectedRoots[index]) throw new Error("[POLICY_BLOCKED] Prepared path protection changed.");
  }
}
export async function revalidateNativeTreePlan(plan: NativeTreePlan, assertCurrent?: () => void, signal?: AbortSignal, includeTree = true): Promise<void> {
  signal?.throwIfAborted(); assertCurrent?.();
  await assertProtected(plan);
  if (!sameIdentity(plan.sourceParent, await capturePathIdentity(plan.sourceParent.path), false)
    || plan.destinationParent && !sameIdentity(plan.destinationParent, await capturePathIdentity(plan.destinationParent.path), false)) throw new Error("[STALE_STATE] Prepared operation parent changed.");
  if (plan.destination) {
    if (plan.destinationIdentity) {
      if (!sameIdentity(plan.destinationIdentity, await capturePathIdentity(plan.destination))) throw new Error("[STALE_STATE] Prepared overwrite destination changed.");
    } else await absent(plan.destination);
  }
  if (includeTree) await revalidateTree(plan.tree, assertCurrent, signal);
  signal?.throwIfAborted(); assertCurrent?.();
}

/** File I/O setup owns one stable stream/commit callback set, released in execute's finally. */
class NativeTreeExecution implements FileCommitStream {
  private plan: NativeTreePlan | undefined;
  private authority: (() => void) | undefined;
  private signal: AbortSignal | undefined;
  readonly byteLength: number;
  readonly sha256: string;
  constructor(plan: NativeTreePlan, authority: () => void, signal?: AbortSignal) {
    this.plan = plan; this.authority = authority; this.signal = signal;
    this.byteLength = Number(plan.source.size); this.sha256 = plan.sourceHash ?? "";
  }
  readonly current = (): void => { this.signal?.throwIfAborted(); this.authority?.(); if (!this.plan) throw new Error("[STALE_STATE] Released tree execution."); };
  readonly assertPath = async (): Promise<string> => { this.current(); await assertProtected(this.plan!); this.current(); return this.plan!.destination!; };
  readonly beforeCommit = async (): Promise<void> => {
    this.current(); if (!sameIdentity(this.plan!.source, await capturePathIdentity(this.plan!.source.path))) throw new Error("[STALE_STATE] Copy source changed before publication."); this.current();
  };
  async writeTo(handle: FileHandle, _hooks: FileCommitHooks): Promise<void> {
    const digest = await writeIdentityTo(this.plan!.source, handle, this.current, this.signal);
    if (digest !== this.sha256) throw new Error("[STALE_STATE] Copy bytes no longer match the prepared source digest.");
  }
  async execute(): Promise<NativeTreeReceipt> {
    const plan = this.plan!;
    const base = { mutationReceiptVersion: 3 as const, operation: plan.operation, target: plan.source.canonical, destination: plan.destination };
    try {
      await revalidateNativeTreePlan(plan, this.current, this.signal, false);
      if (plan.deferredCopyHash) throw new Error("[STALE_STATE] Copy content preparation requires the current invocation grant.");
      if (plan.overwriteCommit) {
        await revalidateTree(plan.tree, this.current, this.signal);
        const commit = await commitPreparedFile(plan.overwriteCommit, this, { assertPathAllowed: this.assertPath, assertCurrent: this.current, beforeCommit: this.beforeCommit, signal: this.signal });
        return { ...base, status: "succeeded", stateChanged: true, ok: true, commit, sha256: this.sha256,
          previousSha256: plan.overwriteCommit.previousSha256, files: 1, bytes: this.byteLength, directories: 0, skippedLinks: 0, coverageComplete: true };
      }
      const result = await executeTree(plan.tree, plan.operation, plan.sourceParent, plan.destination, plan.destinationParent, this.current, this.signal);
      return { ...base, ...result, ok: result.status === "succeeded", cause: result.reason,
        sourceIdentity: { device: plan.source.device, inode: plan.source.inode } };
    } catch (error) {
      if (error instanceof FileCommitError) return { ...base, ...commitFailure(error) };
      return { ...base, ok: false, status: this.signal?.aborted ? "cancelled" : "failed_no_change", stateChanged: false,
        cause: boundedReason(error instanceof Error ? error.message : String(error)) };
    } finally { this.plan = undefined; this.authority = undefined; this.signal = undefined; }
  }
}
export async function executeNativeTreePlan(plan: NativeTreePlan, assertCurrent: () => void, signal?: AbortSignal): Promise<NativeTreeReceipt> {
  return new NativeTreeExecution(plan, assertCurrent, signal).execute();
}
