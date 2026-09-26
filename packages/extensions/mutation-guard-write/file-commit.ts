import { createHash, randomBytes } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { capturePathIdentity, sameIdentity, type PathIdentity } from "./native-file-core.ts";

export interface CommitMetadata {
  strategy: "staged_replace" | "protected_in_place";
  reason?: string;
  /** These are fixed by the preselected platform capability, never fallback routes. */
  protectTemporary?(handle: FileHandle, path: string): Promise<void>;
  prepareTemporary(handle: FileHandle, path: string): Promise<void>;
  assertCurrent(handle: FileHandle): void | Promise<void>;
  assertPostimage?(handle: FileHandle): void | Promise<void>;
  removeTemporary?(path: string, expected: { device: string; inode: string }): Promise<void>;
  replace(temporary: string, target: string, validation: PublicationValidation): Promise<void>;
  replacementFailureMayChangeState: boolean;
}

export interface FileCommitPlan {
  target: PathIdentity;
  parent: PathIdentity;
  previousSha256: string;
  metadata: CommitMetadata;
}

export interface FileCommitHooks {
  assertPathAllowed(): Promise<string>;
  assertCurrent?(): void;
  beforeCommit?(): void | Promise<void>;
  afterCommit?(): void | Promise<void>;
  signal?: AbortSignal;
}

export interface FileCommitReceipt {
  strategy: CommitMetadata["strategy"];
  compatibilityReason?: string;
  outcome: "not_committed" | "committed" | "unknown";
  fileSynced: boolean;
  directorySynced: false;
  retainedTemporary?: string;
  cleanupReason?: string;
}

export class FileCommitError extends Error {
  readonly receipt: FileCommitReceipt;
  constructor(cause: unknown, receipt: FileCommitReceipt) {
    super(`${cause instanceof Error ? cause.message : String(cause)}${receipt.retainedTemporary ? `; temporary retained: ${receipt.retainedTemporary} (${receipt.cleanupReason})` : ""}`);
    this.name = "FileCommitError";
    this.receipt = receipt;
  }
}

/** Completion formatting only; no filesystem/native work in render or progress loops. */
export function commitSummary(receipt: FileCommitReceipt): string {
  const strategy = receipt.strategy === "staged_replace" ? "Staged replacement" : `Protected in-place compatibility: ${receipt.compatibilityReason}`;
  return `${strategy}; ${receipt.outcome}; file sync ${receipt.fileSynced ? "completed" : "not confirmed"}; directory durability not confirmed.${receipt.retainedTemporary ? ` Retained temporary: ${receipt.retainedTemporary} (${receipt.cleanupReason}).` : ""}`;
}

export function commitFailure(error: FileCommitError) {
  const stateChanged = error.receipt.outcome === "unknown" ? "unknown" as const : error.receipt.outcome === "committed";
  return { ok: false, category: stateChanged === false ? "COMMIT_FAILED" : "PARTIAL_MUTATION", stateChanged,
    status: stateChanged === "unknown" ? "state_unknown" : stateChanged ? "partial" : "failed_no_change",
    requiresVerification: stateChanged !== false || Boolean(error.receipt.retainedTemporary), commit: error.receipt, cause: error.message };
}

interface OwnedTemporary { path: string; device: string; inode: string }

export interface PublicationValidation {
  target: PathIdentity;
  parent: PathIdentity;
  temporary: OwnedTemporary;
  previousSha256: string;
  candidateSha256: string;
  candidateBytes: number;
}

function sameObject(info: Awaited<ReturnType<FileHandle["stat"]>>, expected: { device: string; inode: string }): boolean {
  return info.isFile() && String(info.dev) === expected.device && String(info.ino) === expected.inode;
}

/** Bounded buffer and exact expected byte count; no full-file allocation or unbounded growth read. */
async function hashOpened(handle: FileHandle, expectedBytes: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error("[STALE_STATE] Unsupported file size.");
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position <= expectedBytes) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes + 1 - position), position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > expectedBytes) throw new Error("[STALE_STATE] File grew during commit verification.");
    digest.update(buffer.subarray(0, bytesRead));
  }
  if (position !== expectedBytes) throw new Error("[STALE_STATE] File shrank during commit verification.");
  return digest.digest("hex");
}

async function assertPrepared(plan: FileCommitPlan, hooks: FileCommitHooks, handle: FileHandle): Promise<void> {
  hooks.signal?.throwIfAborted(); hooks.assertCurrent?.();
  if (await hooks.assertPathAllowed() !== plan.target.canonical
    || await realpath(plan.parent.path) !== plan.parent.canonical
    || !sameIdentity(plan.parent, await capturePathIdentity(plan.parent.path), false)
    || !sameIdentity(plan.target, await capturePathIdentity(plan.target.path))
    || !sameObject(await handle.stat({ bigint: true }), plan.target)) throw new Error("[STALE_STATE] Prepared target or parent identity changed.");
  await plan.metadata.assertCurrent(handle);
  // Permission/metadata callbacks may await. Content must be checked after them.
  if (await hashOpened(handle, Number(plan.target.size), hooks.signal) !== plan.previousSha256) throw new Error("[STALE_STATE] Prepared content changed.");
  hooks.assertCurrent?.(); hooks.signal?.throwIfAborted();
}

async function assertTemporary(temporary: OwnedTemporary, plan: FileCommitPlan): Promise<void> {
  if (!sameIdentity(plan.parent, await capturePathIdentity(plan.parent.path), false)) throw new Error("[STALE_STATE] Temporary parent identity changed.");
  const info = await lstat(temporary.path, { bigint: true });
  if (info.isSymbolicLink() || !sameObject(info, temporary) || info.nlink !== 1n) throw new Error("[STALE_STATE] Temporary file identity changed.");
}

async function verifyTemporary(temporary: OwnedTemporary, plan: FileCommitPlan, bytes: number, expectedHash: string): Promise<void> {
  await assertTemporary(temporary, plan);
  const handle = await open(temporary.path, "r");
  try {
    if (!sameObject(await handle.stat({ bigint: true }), temporary) || await hashOpened(handle, bytes) !== expectedHash) throw new Error("[STALE_STATE] Staged content changed before commit.");
  } finally { await handle.close(); }
}

async function cleanupTemporary(temporary: OwnedTemporary, plan: FileCommitPlan, receipt: FileCommitReceipt): Promise<void> {
  let parentVerified = false;
  try {
    if (!sameIdentity(plan.parent, await capturePathIdentity(plan.parent.path), false)) throw new Error("[STALE_STATE] Temporary parent identity changed.");
    parentVerified = true;
    await assertTemporary(temporary, plan);
    if (!plan.metadata.removeTemporary) throw new Error("Platform has no verified-object deletion primitive; retained rather than unlinking a potentially replaced name.");
    await plan.metadata.removeTemporary(temporary.path, temporary);
  } catch (error) {
    if (parentVerified && (error as NodeJS.ErrnoException).code === "ENOENT") {
      try { if (sameIdentity(plan.parent, await capturePathIdentity(plan.parent.path), false)) return; } catch { /* Missing parent does not establish missing temporary. */ }
    }
    receipt.retainedTemporary = temporary.path;
    receipt.cleanupReason = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  }
}

/** One commit core for snapshot/exact/overwrite. Caller owns the sorted mutation queue and evidence. */
export async function commitPreparedFile(plan: FileCommitPlan, content: Uint8Array, hooks: FileCommitHooks): Promise<FileCommitReceipt> {
  const receipt: FileCommitReceipt = { strategy: plan.metadata.strategy, compatibilityReason: plan.metadata.reason,
    outcome: "not_committed", fileSynced: false, directorySynced: false };
  let source: FileHandle | undefined, staged: FileHandle | undefined, temporary: OwnedTemporary | undefined;
  let createdPath: string | undefined, publishedObject: { device: string; inode: string } | undefined;
  const expectedHash = createHash("sha256").update(content).digest("hex");
  let failure: unknown, failed = false;
  try {
    hooks.signal?.throwIfAborted(); hooks.assertCurrent?.();
    if (plan.target.directory || plan.parent.canonical !== dirname(plan.target.canonical)) throw new Error("[STALE_STATE] Invalid prepared commit target.");
    source = await open(plan.target.canonical, plan.metadata.strategy === "protected_in_place" ? "r+" : "r");
    await assertPrepared(plan, hooks, source);
    if (plan.metadata.strategy === "staged_replace") {
      const path = join(plan.parent.canonical, `.pi-file-commit-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
      staged = await open(path, "wx", 0o600);
      createdPath = path;
      const info = await staged.stat({ bigint: true });
      temporary = { path, device: String(info.dev), inode: String(info.ino) };
      await assertTemporary(temporary, plan);
      await plan.metadata.protectTemporary?.(staged, path);
      await staged.writeFile(content);
      await staged.sync(); receipt.fileSynced = true;
      await hooks.beforeCommit?.();
      await assertPrepared(plan, hooks, source);
      // Keep candidate bytes private through writing and all source callbacks.
      // Apply publish metadata only after those checks, then sync metadata too.
      await plan.metadata.prepareTemporary(staged, path);
      await staged.sync();
      await staged.close(); staged = undefined;
      // Windows replacement can refuse our still-open target. Close the verified
      // read handle before the final synchronous authority/signal gate; no retry.
      await source.close(); source = undefined;
      await verifyTemporary(temporary, plan, content.byteLength, expectedHash);
      // No asynchronous callback between final authority/signal gate and publication.
      hooks.assertCurrent?.(); hooks.signal?.throwIfAborted();
      try { await plan.metadata.replace(path, plan.target.canonical, { target: plan.target, parent: plan.parent,
        temporary, previousSha256: plan.previousSha256, candidateSha256: expectedHash, candidateBytes: content.byteLength }); }
      catch (error) {
        if (plan.metadata.replacementFailureMayChangeState) {
          receipt.outcome = "unknown";
          if ((error as { commitOutcome?: string }).commitOutcome === "not_committed") {
            // A documented error code alone cannot establish the observed state.
            let unchanged: FileHandle | undefined;
            try {
              unchanged = await open(plan.target.canonical, "r");
              if (sameIdentity(plan.target, await capturePathIdentity(plan.target.path))
                && sameObject(await unchanged.stat({ bigint: true }), plan.target)
                && await hashOpened(unchanged, Number(plan.target.size)) === plan.previousSha256) {
                await plan.metadata.assertCurrent(unchanged);
                receipt.outcome = "not_committed";
              }
            } catch { /* Failed observation leaves an unknown outcome. */ }
            finally { if (unchanged) await unchanged.close(); }
          }
        }
        throw error;
      }
      receipt.outcome = "committed";
      publishedObject = temporary;
      temporary = undefined;
      createdPath = undefined;
    } else {
      await hooks.beforeCommit?.();
      await assertPrepared(plan, hooks, source);
      hooks.assertCurrent?.(); hooks.signal?.throwIfAborted();
      receipt.outcome = "unknown"; // The first write can partially change the pinned object.
      let written = 0;
      while (written < content.byteLength) {
        const next = await source.write(content, written, content.byteLength - written, written);
        if (next.bytesWritten <= 0) throw new Error("In-place write made no progress.");
        written += next.bytesWritten;
      }
      await source.truncate(content.byteLength);
      await source.sync(); receipt.fileSynced = true;
      receipt.outcome = "committed";
      publishedObject = plan.target;
    }
    await hooks.afterCommit?.();
    // Postcommit cancellation is a committed outcome, never a no-change failure.
    hooks.signal?.throwIfAborted(); hooks.assertCurrent?.();
    const post = await open(plan.target.canonical, "r");
    try {
      if (!sameObject(await post.stat({ bigint: true }), publishedObject!) || await hashOpened(post, content.byteLength) !== expectedHash) throw new Error("Postcommit object/content verification failed.");
      await plan.metadata.assertPostimage?.(post);
    } finally { await post.close(); }
  } catch (error) { failure = error; failed = true; }
  finally {
    // Re-restrict only a proved owned, unpublished object. Never chmod a name
    // that may have become the published target or someone else's replacement.
    if (temporary && receipt.outcome === "not_committed" && plan.metadata.protectTemporary) {
      let recovery: FileHandle | undefined;
      try {
        await assertTemporary(temporary, plan);
        recovery = await open(temporary.path, "r");
        if (!sameObject(await recovery.stat({ bigint: true }), temporary)) throw new Error("Temporary identity changed before privacy restoration.");
        await plan.metadata.protectTemporary(recovery, temporary.path);
      } catch (error) {
        failure = new Error(`${failure instanceof Error ? failure.message : String(failure)}; temporary privacy not confirmed: ${error instanceof Error ? error.message : String(error)}`);
        failed = true;
      } finally { if (recovery) try { await recovery.close(); } catch (error) { failure ??= error; failed = true; } }
    }
    if (staged) try { await staged.close(); } catch (error) { failure ??= error; failed = true; }
    if (source) try { await source.close(); } catch (error) { failure ??= error; failed = true; }
    if (temporary && receipt.outcome === "unknown") {
      receipt.retainedTemporary = temporary.path;
      receipt.cleanupReason = "Publication outcome is unknown; temporary retained for explicit recovery observation. Its publication permissions may already be applied; privacy was not altered while object placement is uncertain.";
    } else if (temporary) await cleanupTemporary(temporary, plan, receipt);
    else if (createdPath) { receipt.retainedTemporary = createdPath; receipt.cleanupReason = "Created object identity was not captured; ownership could not be proved."; }
  }
  if (failed) throw new FileCommitError(failure, receipt);
  return receipt;
}
