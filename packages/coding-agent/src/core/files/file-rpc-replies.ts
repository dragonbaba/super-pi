import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { validMutationOutcome } from "./change-receipts.ts";
import { validateManifestArtifact, type ManifestArtifact, type OwnedManifestFile } from "./file-manifest-artifact.mjs";
import type { FileRpcEnvelope, FileRpcChunk, EncodedFileRpc } from "./file-rpc-chunks.ts";
import type { FileWorkerInput, FileWorkerRequest, PreparedFileWorkerManifest, ValidatedFileWorkerContent } from "./file-worker-plan.mjs";
import type { FileReceipt } from "./file-service.ts";
import { FILE_RESULT_REASON_BYTES, FILE_RESULT_FAILURE_SAMPLES } from "./file-operation-limits.mjs";
import { SHA256_PATTERN } from "./regex.ts";
import { directoryKey } from "./file-creation-core.mjs";

const REPLY_FIELDS = new Set(["version", "rpc", "id", "callId", "requestHash", "generation", "itemCount", "start", "phase", "wireHash", "ok", "items", "error", "noEffects"]);
const PREPARED_FIELDS = new Set(["index", "manifest"]), VALIDATED_FIELDS = new Set(["index", "validated"]), CONTENT_FIELDS = new Set(["sourceSha256", "previousSha256"]);
const EXECUTED_FIELDS = new Set(["index", "readyHash", "intentId", "receipt"]);
const RECEIPT_FIELDS = new Set(["mutationReceiptVersion", "operation", "target", "destination", "status", "stateChanged", "ok", "requiresVerification", "reason", "stopInvocation",
  "bytes", "files", "directories", "skippedLinks", "coverageComplete", "sha256", "previousSha256", "snapshot", "created", "category", "commit", "creation", "createdParents"]);
const COMMIT_FIELDS = new Set(["strategy", "outcome", "fileSynced", "directorySynced", "retainedTemporary", "cleanupReason", "compatibilityReason"]);
const CREATION_FIELDS = new Set(["bytes", "addedLines", "createdDirectoryCount", "createdDirectories", "createdDirectoriesOmitted"]);
const CANDIDATE_NAME = /^\.superpi-write-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
function need(value: unknown, message: string): asserts value { if (!value) throw new Error("[FILE_RPC_INVALID] " + message); }
function fields(value: unknown, allowed: ReadonlySet<string>): asserts value is Record<string, any> {
  need(value && typeof value === "object" && !Array.isArray(value), "Expected structured reply facts");
  for (const key of Object.keys(value)) need(allowed.has(key), "Unexpected reply fact");
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function reason(value: unknown): boolean { return value === undefined || typeof value === "string" && Buffer.byteLength(value) <= FILE_RESULT_REASON_BYTES; }

/** Bind the reply to the exact serialized send, not a reconstructed body. */
export function fileRpcReplyItems(raw: unknown, envelope: FileRpcEnvelope, itemCount: number, chunk: FileRpcChunk, phase: string, encoded: EncodedFileRpc): readonly unknown[] {
  fields(raw, REPLY_FIELDS);
  need(raw.version === 3 && raw.rpc === "file-mutation-v3" && raw.id === envelope.id && raw.callId === envelope.callId && raw.requestHash === envelope.requestHash
    && raw.generation === envelope.generation && raw.itemCount === itemCount && raw.start === chunk.start && raw.phase === phase
    && raw.wireHash === createHash("sha256").update(encoded.serialized).digest("hex") && typeof raw.ok === "boolean", "Reply belongs to another request, generation or global range");
  if (!raw.ok) {
    need(reason(raw.error) && typeof raw.error === "string" && typeof raw.noEffects === "boolean"
      && (phase === "execute" || raw.noEffects === true), "Invalid failed preparation/transport acknowledgement");
    throw new Error(`[FILE_RPC_${phase.toUpperCase()}] ${raw.error}`);
  }
  need(raw.error === undefined && raw.noEffects === undefined && Array.isArray(raw.items) && raw.items.length === chunk.end - chunk.start, "Reply has missing, duplicated or surplus item acknowledgements");
  for (let offset = 0; offset < raw.items.length; offset++) need(raw.items[offset]?.index === chunk.start + offset, "Reply item indexes are out of order or duplicated");
  return raw.items;
}
export function fileRpcPreparedManifest(row: unknown, owned: OwnedManifestFile): Readonly<ManifestArtifact> {
  fields(row, PREPARED_FIELDS);
  const artifact = validateManifestArtifact(row.manifest, owned.name);
  need(artifact.device === owned.device && artifact.inode === owned.inode, "Preparation replaced the host-assigned artifact object");
  return Object.freeze(artifact);
}
export function fileRpcValidatedContent(row: unknown, prepared: PreparedFileWorkerManifest, preview: boolean): Readonly<ValidatedFileWorkerContent> {
  fields(row, VALIDATED_FIELDS); fields(row.validated, CONTENT_FIELDS);
  need(row.index === prepared.header.index, "Content validation belongs to another global item");
  const value = row.validated;
  if (prepared.header.destinationIdentity && !preview) need(typeof value.sourceSha256 === "string" && SHA256_PATTERN.test(value.sourceSha256)
    && typeof value.previousSha256 === "string" && SHA256_PATTERN.test(value.previousSha256), "Missing verified overwrite preimages");
  else need(value.sourceSha256 === undefined && value.previousSha256 === undefined, "Unexpected content authority in metadata-only validation");
  return Object.freeze(value);
}
export function fileRpcExecutedReceipt(row: unknown, envelope: FileWorkerRequest, input: FileWorkerInput, prepared: PreparedFileWorkerManifest,
  validated: ValidatedFileWorkerContent | undefined, readyHash: string, intentId: string): FileReceipt & { createdParents?: ManifestArtifact } {
  fields(row, EXECUTED_FIELDS);
  need(row.readyHash === readyHash && row.intentId === intentId, "Reply does not acknowledge this item's published intent/ready binding");
  const receipt = row.receipt; fields(receipt, RECEIPT_FIELDS);
  const header = prepared.header;
  need(row.index === header.index, "Effect acknowledgement belongs to another global item");
  need(receipt.mutationReceiptVersion === 3 && receipt.operation === input.operation && receipt.target === header.target && receipt.destination === header.destination
    && validMutationOutcome(receipt.status, receipt.stateChanged) && receipt.status !== "not_started" && receipt.ok === (receipt.status === "succeeded")
    && (receipt.status !== "partial" && receipt.status !== "state_unknown" || receipt.requiresVerification === true)
    && (receipt.requiresVerification === undefined || typeof receipt.requiresVerification === "boolean") && reason(receipt.reason), "Inconsistent operation, target or effect outcome");
  for (const key of ["bytes", "files", "directories", "skippedLinks"] as const) need(receipt[key] === undefined || count(receipt[key]), "Invalid effect counters");
  for (const key of ["sha256", "previousSha256", "snapshot"] as const) need(receipt[key] === undefined || typeof receipt[key] === "string" && SHA256_PATTERN.test(receipt[key]), "Invalid content fingerprint");
  need(receipt.coverageComplete === undefined || typeof receipt.coverageComplete === "boolean", "Invalid coverage marker");
  need(receipt.stopInvocation === undefined || typeof receipt.stopInvocation === "boolean", "Invalid stop marker");
  need(receipt.created === undefined || typeof receipt.created === "boolean", "Invalid creation marker");
  need(receipt.category === undefined || typeof receipt.category === "string" && Buffer.byteLength(receipt.category) <= FILE_RESULT_REASON_BYTES, "Invalid failure category");
  if (receipt.commit !== undefined) {
    fields(receipt.commit, COMMIT_FIELDS); const commit = receipt.commit;
    need(commit.strategy === "staged_replace" && (commit.outcome === "not_committed" || commit.outcome === "committed" || commit.outcome === "unknown")
      && typeof commit.fileSynced === "boolean" && commit.directorySynced === false && (commit.outcome !== "committed" || commit.fileSynced)
      && reason(commit.cleanupReason) && reason(commit.compatibilityReason), "Invalid controlled publication facts");
    if (commit.retainedTemporary !== undefined) need(typeof commit.retainedTemporary === "string" && CANDIDATE_NAME.test(basename(commit.retainedTemporary))
      && directoryKey(dirname(commit.retainedTemporary)) === directoryKey(dirname(header.destination ?? header.target))
      && commit.outcome !== "committed" && receipt.requiresVerification === true, "Retained candidate is outside its publication parent");
  }
  if (receipt.creation !== undefined) {
    fields(receipt.creation, CREATION_FIELDS); const creation = receipt.creation;
    need(prepared.creation && count(creation.createdDirectoryCount) && creation.createdDirectoryCount <= prepared.creation.directories.length
      && Array.isArray(creation.createdDirectories) && creation.createdDirectories.length <= FILE_RESULT_FAILURE_SAMPLES
      && creation.createdDirectories.length <= creation.createdDirectoryCount && count(creation.createdDirectoriesOmitted)
      && creation.createdDirectoriesOmitted === creation.createdDirectoryCount - creation.createdDirectories.length && count(creation.bytes)
      && (creation.addedLines === undefined || count(creation.addedLines)) && (creation.createdDirectoryCount === 0 || receipt.stateChanged !== false), "Invalid bounded creation facts");
  }
  if (receipt.createdParents !== undefined) validateManifestArtifact(receipt.createdParents, `${envelope.id}-${envelope.itemCount + row.index}.manifest`);
  need(receipt.snapshot === undefined || (input.operation === "write" || input.operation === "edit") && receipt.status === "succeeded", "Failure or non-text operation cannot issue a successor snapshot");
  if (receipt.status === "succeeded") {
    if (header.text) {
      need(receipt.sha256 === header.text.nextSha256 && receipt.snapshot === header.text.nextSha256 && receipt.bytes === header.text.bytes, "Verified text successor differs from preparation");
      if (header.text.exists) need(receipt.previousSha256 === header.text.previousSha256 && receipt.commit?.outcome === "committed", "Text overwrite lost its publication/preimage facts");
      else need(receipt.created === true && receipt.creation && (prepared.creation!.directories.length === 0 || receipt.createdParents), "Exclusive creation lost its parent outcome inventory");
    } else if (header.destinationIdentity) need(receipt.sha256 === validated?.sourceSha256 && receipt.previousSha256 === validated?.previousSha256
      && receipt.commit?.outcome === "committed", "Copy overwrite differs from its globally validated content");
    else {
      const tree = prepared.tree!;
      need(receipt.bytes === tree.bytes && receipt.directories === tree.directories && receipt.skippedLinks === tree.skippedLinks
        && receipt.files === (input.operation === "delete" ? tree.unlinkFiles ?? tree.files : tree.files), "Successful tree coverage differs from its complete inventory");
      if (input.operation === "copy" && !header.source!.directory) need(typeof receipt.sha256 === "string", "Successful file copy lacks its verified destination digest");
    }
  }
  return receipt as FileReceipt & { createdParents?: ManifestArtifact };
}
