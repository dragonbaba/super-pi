import { basename, dirname, resolve } from "node:path";
import { lstat, type FileHandle } from "node:fs/promises";
import { capturePathIdentity, captureTreeIdentity, sameIdentity, prepareTree, revalidateTree, executeTree, hashIdentity, writeIdentityTo, boundedReason,
  type TreePreparation } from "./file-tree-core.mjs";
import { validateNativeInvocation, nativeItemInput, type NativeFileItemInput, type NativeFileOperation } from "./file-operation-input.ts";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";
import { assertIndependent } from "./file-path-conflicts.ts";
import { commitPreparedFile, commitFailure, FileCommitError, type FileCommitPlan, type FileCommitStream, type FileCommitHooks, type FileCommitReceipt } from "./file-commit.ts";
import { selectCommitMetadata } from "./file-commit-metadata.ts";
import type { PathIdentity, MutationStatus } from "./native-file-core.ts";
import { prepareFileCreation, verifyCreationAncestor, executeFileCreationDirectories, FileCreationFailure, directoryKey,
  type FileCreationPlan, type CreatedDirectory } from "./file-creation.ts";

export interface NativeTreePlan {
  operation: NativeFileOperation; cwd: string; input: Readonly<NativeFileItemInput>;
  source: PathIdentity; sourceParent: PathIdentity; tree: TreePreparation;
  destination?: string; destinationParent?: PathIdentity; destinationIdentity?: PathIdentity;
  sourceHash?: string; overwriteCommit?: FileCommitPlan;
  deferredCopyHash?: true;
  creation?: FileCreationPlan;
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
    const destination = resolve(cwd, input.destination!);
    try { plan.destinationParent = await capturePathIdentity(dirname(destination)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      plan.creation = await prepareFileCreation(destination, true, Infinity);
      if (!plan.creation) throw new Error("[STALE_STATE] Missing destination changed during preparation.");
    }
    if (plan.destinationParent && !plan.destinationParent.directory) throw new Error("[unsupported] Destination parent must be a directory.");
    plan.destination = plan.creation?.canonicalTarget ?? resolve(plan.destinationParent!.canonical, basename(input.destination!));
    const destinationProtection = await protectedTarget(cwd, plan.destination);
    if (plan.creation?.directories.length && destinationProtection.protectedRoots.includes("workspace_escape")) throw new Error("[POLICY_BLOCKED] Missing destination parents must be inside the workspace.");
    protectedPaths.push(destinationProtection);
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
      plan.overwriteCommit = { target: plan.destinationIdentity, parent: plan.destinationParent!,
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
export async function revalidateNativeTreePlan(plan: NativeTreePlan, assertCurrent?: () => void, signal?: AbortSignal, includeTree = true, sharedDirectories?: Map<string, PathIdentity>): Promise<void> {
  signal?.throwIfAborted(); assertCurrent?.();
  await assertProtected(plan);
  if (!sameIdentity(plan.sourceParent, await capturePathIdentity(plan.sourceParent.path), false)
    || plan.destinationParent && !sameIdentity(plan.destinationParent, await capturePathIdentity(plan.destinationParent.path), false)) throw new Error("[STALE_STATE] Prepared operation parent changed.");
  if (plan.destination) {
    if (plan.destinationIdentity) {
      if (!sameIdentity(plan.destinationIdentity, await capturePathIdentity(plan.destination))) throw new Error("[STALE_STATE] Prepared overwrite destination changed.");
    } else await absent(plan.destination);
  }
  if (plan.creation) {
    await verifyCreationAncestor(plan.creation);
    for (const path of plan.creation.directories) {
      const shared = sharedDirectories?.get(directoryKey(path));
      if (shared) {
        if (!sameIdentity(shared, await capturePathIdentity(path), false)) throw new Error("[STALE_STATE] Shared created destination parent changed.");
      } else await absent(path);
    }
  }
  if (includeTree) await revalidateTree(plan.tree, assertCurrent, signal);
  signal?.throwIfAborted(); assertCurrent?.();
}

/** File I/O setup owns one stable stream/commit callback set, released in execute's finally. */
class NativeTreeExecution implements FileCommitStream {
  private plan: NativeTreePlan | undefined;
  private authority: (() => void) | undefined;
  private signal: AbortSignal | undefined;
  private sharedDirectories: Map<string, PathIdentity> | undefined;
  private readonly ownsDirectories: boolean;
  readonly byteLength: number;
  readonly sha256: string;
  constructor(plan: NativeTreePlan, authority: () => void, signal?: AbortSignal, sharedDirectories?: Map<string, PathIdentity>) {
    this.plan = plan; this.authority = authority; this.signal = signal;
    this.sharedDirectories = sharedDirectories ?? (plan.creation ? new Map() : undefined); this.ownsDirectories = !!plan.creation && !sharedDirectories;
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
    let created: CreatedDirectory[] | undefined;
    try {
      await revalidateNativeTreePlan(plan, this.current, this.signal, false, this.sharedDirectories);
      if (plan.deferredCopyHash) throw new Error("[STALE_STATE] Copy content preparation requires the current invocation grant.");
      if (plan.overwriteCommit) {
        await revalidateTree(plan.tree, this.current, this.signal);
        const commit = await commitPreparedFile(plan.overwriteCommit, this, { assertPathAllowed: this.assertPath, assertCurrent: this.current, beforeCommit: this.beforeCommit, signal: this.signal });
        return { ...base, status: "succeeded", stateChanged: true, ok: true, commit, sha256: this.sha256,
          previousSha256: plan.overwriteCommit.previousSha256, files: 1, bytes: this.byteLength, directories: 0, skippedLinks: 0, coverageComplete: true };
      }
      let destinationParent = plan.destinationParent;
      if (plan.creation) {
        created = await executeFileCreationDirectories(plan.creation, this.assertPath, this.signal, this.sharedDirectories, this.current);
        await revalidateNativeTreePlan(plan, this.current, this.signal, false, this.sharedDirectories);
        destinationParent = await capturePathIdentity(dirname(plan.destination!));
        if (!destinationParent.directory || directoryKey(destinationParent.canonical) !== directoryKey(dirname(plan.destination!))) throw new Error("[STALE_STATE] Created destination parent changed.");
      }
      const result = await executeTree(plan.tree, plan.operation, plan.sourceParent, plan.destination, destinationParent, this.current, this.signal);
      if (created?.length && result.stateChanged === false) { result.stateChanged = true; result.status = "partial"; result.requiresVerification = true; }
      return { ...base, ...result, ok: result.status === "succeeded", cause: result.reason,
        creation: created ? { createdDirectories: created, bytes: 0 } : undefined,
        sourceIdentity: { device: plan.source.device, inode: plan.source.inode } };
    } catch (error) {
      if (error instanceof FileCommitError) return { ...base, ...commitFailure(error) };
      if (error instanceof FileCreationFailure) return { ...base, ok: false, status: error.facts.status as MutationStatus,
        stateChanged: error.facts.stateChanged as boolean | "unknown", requiresVerification: error.facts.requiresVerification === true,
        creation: { createdDirectories: error.facts.createdDirectories, bytes: 0 }, cause: boundedReason(String(error.facts.cause)) };
      const changed = !!created?.length;
      return { ...base, ok: false, status: changed ? "partial" : this.signal?.aborted ? "cancelled" : "failed_no_change", stateChanged: changed,
        requiresVerification: changed || undefined, creation: created ? { createdDirectories: created, bytes: 0 } : undefined,
        cause: boundedReason(error instanceof Error ? error.message : String(error)) };
    } finally { this.plan = undefined; this.authority = undefined; this.signal = undefined; if (this.ownsDirectories) this.sharedDirectories?.clear(); this.sharedDirectories = undefined; }
  }
}
export async function executeNativeTreePlan(plan: NativeTreePlan, assertCurrent: () => void, signal?: AbortSignal, sharedDirectories?: Map<string, PathIdentity>): Promise<NativeTreeReceipt> {
  return new NativeTreeExecution(plan, assertCurrent, signal, sharedDirectories).execute();
}
