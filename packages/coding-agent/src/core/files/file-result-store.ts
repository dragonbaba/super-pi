import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionManager } from "../session-manager.ts";
import { mutationRequestHash, nativeItemRequestHash } from "./file-invocation.ts";
import { validMutationOutcome } from "./change-receipts.ts";
import { isAbsolute } from "node:path";
import {
  FILE_RESULT_ENTRY, FILE_MUTATION_CALL_ENTRY, FILE_RESULT_PAGE_BYTES, FILE_RESULT_PAGE_RECORDS, FILE_RESULT_PAYLOAD_BYTES,
  boundedResultId, boundedFileEntryId, fileResultReference, parseFileResultEnvelope, parseFileResultPayload, parseFileResultReference,
  resultEnvelopeHash, sameResultBinding, validResultBinding, safeFileResultPath,
  type FileResultBinding, type FileResultEnvelope, type FileResultPayload,
} from "./file-result-protocol.ts";
import { FILE_RESULT_PAGE_HEADER_BYTES, FILE_RESULT_RECORD_WRAPPER_BYTES, FILE_RESULT_CURSOR_CHARACTERS } from "./file-operation-limits.mjs";
import { SHA256_PATTERN } from "./regex.ts";
import { validateNativeInvocation } from "./file-operation-input.ts";
import { validateBatchInput } from "./file-batch-protocol.ts";
import { fileSourceArguments } from "./file-source-arguments.ts";
import { Value } from "typebox/value";
import { NativeWriteParameters, PublicEditParameters, SandboxWriteParameters, SandboxEditParameters, validatePublicEditInput } from "./file-parameters.ts";
import { validateWriteContent } from "./revision-mutations.ts";
import { buildManifestLevels, manifestProof, manifestLeafHash, verifyManifestProof, appendReverseManifest, validManifestFrontier } from "./file-manifest-proof.ts";

export type FileResultSession = Pick<SessionManager, "getSessionId" | "getLeafId" | "getEntry" | "getEntryCount"
  | "getHistoryGeneration" | "getContextGeneration" | "isHistoryConsistent">;
export type AppendFileResultEntry = (kind: string, data: FileResultEnvelope) => string;
interface ResultCursor {
  version: 3; root: string; session: string; history: number; context: number;
  entryId: string; hash: string; sequence: number;
  succeeded: number; failed: number; partial: number; unknown: number; cancelled: number;
  preparedNext: number; manifestFrontier: Array<string | null>;
}
export interface FileResultPageRow { entryId: string; sequence: number; hash: string; record: FileResultPayload; }
export interface FileResultPage {
  version: 3; resultRef: string; records: FileResultPageRow[]; nextCursor: string | null;
  callComplete: boolean; pageComplete: boolean; coverageComplete: boolean; itemCount: number;
  incompleteItem?: { index: number; status: "state_unknown"; stateChanged: "unknown"; requiresVerification: true };
}
const CURSOR_KEYS: ReadonlySet<string> = new Set(["version", "root", "session", "history", "context", "entryId", "hash", "sequence", "succeeded", "failed", "partial", "unknown", "cancelled", "preparedNext", "manifestFrontier"]);
const COUNT_FIELDS = ["succeeded", "failed", "partial", "unknown", "cancelled"] as const;
const CONTENT_HASH_FIELDS = ["sha256", "previousSha256", "snapshot"] as const;

/** One invocation owns only counters, IDs and one pinned append callback. */
export class FileResultWriter {
  readonly binding: Readonly<FileResultBinding>;
  private appendEntry: AppendFileResultEntry | undefined;
  private session: FileResultSession | undefined;
  private previousId: string | null = null;
  private previousHash: string | null = null;
  private sequence = 0;
  private prepared = 0;
  private started = 0;
  private activeIndex = -1;
  private activePreparation = "";
  private activeIntent = "";
  private readyState = false;
  private closed = false;
  private poisoned = false;
  private succeeded = 0;
  private failed = 0;
  private partial = 0;
  private unknown = 0;
  private cancelled = 0;
  private serializedBytes = 0;
  private preparedHashes: string[] = [];
  private manifestLevels: string[][] = [];
  private readyId = "";
  private readyHash = "";
  private readyGeneration = -1;

  constructor(binding: FileResultBinding, appendEntry: AppendFileResultEntry, session: FileResultSession) {
    if (!validResultBinding(binding)) throw new Error("[FILE_RESULT_INVALID] Invalid call binding.");
    this.binding = Object.freeze({ ...binding }); this.appendEntry = appendEntry; this.session = session;
  }
  prepare(index: number, item: Omit<FileResultPayload, "phase">): string {
    if (this.readyState || index !== this.prepared || index >= this.binding.itemCount) throw new Error("[FILE_RESULT_ORDER] Preparation order mismatch.");
    const id = this.append({ ...item, phase: "prepared", index, itemId: `${this.binding.toolCallId}:${index}` }); this.preparedHashes.push(manifestLeafHash(id, this.previousHash!)); this.prepared++; return id;
  }
  ready(generation = 0): string {
    if (this.readyState || this.prepared !== this.binding.itemCount || !Number.isSafeInteger(generation) || generation < 0) throw new Error("[FILE_RESULT_ORDER] All items must be prepared first with a current generation.");
    this.manifestLevels = buildManifestLevels(this.preparedHashes);
    const id = this.append({ phase: "ready", prepared: this.prepared, manifestHash: this.previousHash,
      manifestRoot: this.manifestLevels[this.manifestLevels.length - 1][0], generation });
    this.readyState = true; this.readyId = id; this.readyHash = this.previousHash!; this.readyGeneration = generation; return id;
  }
  intent(index: number, preparedId: string, generation = this.readyGeneration): string {
    if (!this.readyState || this.activeIndex !== -1 || index !== this.started || index >= this.binding.itemCount || !boundedResultId(preparedId)) {
      throw new Error("[FILE_RESULT_ORDER] Invalid or overlapping item intent.");
    }
    const entry = this.session?.getEntry(preparedId);
    if (entry?.type !== "custom" || entry.customType !== FILE_RESULT_ENTRY) throw new Error("[FILE_RESULT_ORDER] Missing published preparation.");
    const prepared = parseFileResultEnvelope(entry.data), payload = parseFileResultPayload(prepared);
    if (!sameResultBinding(this.binding, prepared) || prepared.sequence !== index || payload.phase !== "prepared" || payload.index !== index
      || generation !== this.readyGeneration || manifestLeafHash(preparedId, prepared.hash) !== this.preparedHashes[index]) throw new Error("[FILE_RESULT_ORDER] Intent is bound to another preparation or permission generation.");
    const id = this.append({ phase: "intent", index, itemId: `${this.binding.toolCallId}:${index}`, preparedId, readyId: this.readyId, readyHash: this.readyHash, generation, manifestProof: manifestProof(this.manifestLevels, index) });
    this.activeIndex = index; this.activePreparation = preparedId; this.activeIntent = id; this.started++; return id;
  }
  commit(metadata: Omit<FileResultPayload, "phase">): string {
    if (this.activeIndex < 0) throw new Error("[FILE_RESULT_ORDER] Commit requires an active intent.");
    return this.append({ ...metadata, phase: "commit", index: this.activeIndex, itemId: `${this.binding.toolCallId}:${this.activeIndex}`, preparedId: this.activePreparation, intentId: this.activeIntent, readyId: this.readyId, readyHash: this.readyHash });
  }
  result(index: number, receipt: Omit<FileResultPayload, "phase">): string {
    if (index !== this.activeIndex || !validMutationOutcome(receipt.status, receipt.stateChanged) || receipt.status === "not_started"
      || (receipt.status === "partial" || receipt.status === "state_unknown") && receipt.requiresVerification !== true) throw new Error("[FILE_RESULT_ORDER] Invalid item outcome.");
    const id = this.append({ ...receipt, phase: "result", index, itemId: `${this.binding.toolCallId}:${index}`, preparedId: this.activePreparation, intentId: this.activeIntent, readyId: this.readyId, readyHash: this.readyHash });
    switch (receipt.status) {
      case "succeeded": this.succeeded++; break;
      case "partial": this.partial++; break;
      case "state_unknown": this.unknown++; break;
      case "cancelled": this.cancelled++; break;
      default: this.failed++; break;
    }
    this.activeIndex = -1; this.activePreparation = ""; this.activeIntent = ""; return id;
  }
  finish(reason?: string): string {
    if (!this.readyState || this.activeIndex !== -1) throw new Error("[FILE_RESULT_ORDER] An active item requires an explicit outcome.");
    this.append({ phase: "complete", succeeded: this.succeeded, failed: this.failed, partial: this.partial, unknown: this.unknown,
      cancelled: this.cancelled, notStarted: this.binding.itemCount - this.started, nextIndex: this.started, reason, readyId: this.readyId, readyHash: this.readyHash });
    const ref = this.reference(); this.closed = true; this.appendEntry = undefined; this.session = undefined; this.releaseManifest(); return ref;
  }
  reference(): string {
    if (!this.previousId || !this.previousHash) throw new Error("[FILE_RESULT_INVALID] No published result record.");
    return fileResultReference(this.previousId, this.binding, this.previousHash);
  }
  get manifestReadyHash(): string {
    if (!this.readyState || !this.readyHash) throw new Error("[FILE_RESULT_ORDER] Ready has not been published.");
    return this.readyHash;
  }
  get diagnostics() {
    let retainedManifestHashes = this.manifestLevels.length ? 0 : this.preparedHashes.length;
    for (const level of this.manifestLevels) retainedManifestHashes += level.length;
    return { records: this.sequence, serializedBytes: this.serializedBytes, retainedPayloads: 0,
      appendCallbackRetained: this.appendEntry !== undefined, sessionRetained: this.session !== undefined, poisoned: this.poisoned, retainedManifestHashes };
  }
  private releaseManifest(): void { this.preparedHashes = []; this.manifestLevels = []; }
  dispose(): void { this.closed = true; this.appendEntry = undefined; this.session = undefined; this.activePreparation = ""; this.activeIntent = ""; this.releaseManifest(); }
  private append(payload: FileResultPayload): string {
    if (this.closed || this.poisoned || !this.appendEntry) throw new Error("[FILE_RESULT_CLOSED] Journal owner is unavailable.");
    try {
      const serialized = JSON.stringify(payload), bytes = Buffer.byteLength(serialized);
      if (bytes > FILE_RESULT_PAYLOAD_BYTES) throw new Error("[FILE_RESULT_BUDGET] Projected metadata exceeds the record byte budget.");
      const binding = this.binding;
      const data: FileResultEnvelope = { version: 3, callEntryId: binding.callEntryId, toolCallId: binding.toolCallId,
        operation: binding.operation, requestHash: binding.requestHash, itemCount: binding.itemCount, sequence: this.sequence,
        previousId: this.previousId, previousHash: this.previousHash, payload: serialized, payloadBytes: bytes, hash: "" };
      data.hash = resultEnvelopeHash(data);
      const id = this.appendEntry(FILE_RESULT_ENTRY, data);
      if (!boundedFileEntryId(id)) throw new Error("[FILE_RESULT_INVALID] Native append did not return a published entry ID.");
      this.previousId = id; this.previousHash = data.hash; this.sequence++; this.serializedBytes += bytes; return id;
    } catch (error) { this.poisoned = true; this.appendEntry = undefined; this.session = undefined; this.releaseManifest(); throw error; }
  }
}

function assertAncestor(session: FileResultSession, descendant: string | null, ancestor: string): void {
  let current = descendant, remaining = session.getEntryCount() + 1;
  while (current && remaining-- > 0) {
    if (!boundedResultId(current)) break;
    if (current === ancestor) return;
    current = session.getEntry(current)?.parentId ?? null;
  }
  throw new Error("[FILE_RESULT_BRANCH] Record is not on the selected session branch.");
}
function assertSourceCall(session: FileResultSession, binding: FileResultBinding, verifyHash: boolean): any {
  const entry = session.getEntry(binding.callEntryId);
  let call: any;
  if (entry?.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) if (block.type === "toolCall" && block.id === binding.toolCallId) {
      if (call) throw new Error("[FILE_RESULT_INVALID] Duplicate source call.");
      call = block;
    }
  } else if (entry?.type === "custom" && entry.customType === FILE_MUTATION_CALL_ENTRY) {
    const data = entry.data as any;
    if (data?.version === 3 && data.origin === "host-operation" && data.call?.id === binding.toolCallId) call = data.call;
  } else if (entry?.type === "custom" && entry.customType === "codemode-tool-call-v1") {
    const data = entry.data as any;
    if (data?.version === 1 && typeof data.parentToolCallId === "string" && data.call?.id === binding.toolCallId
      && binding.toolCallId.startsWith(data.parentToolCallId + ":nested:")) call = data.call;
  }
  if (call && verifyHash) {
    const args = fileSourceArguments(call.name, call.arguments);
    if (args !== call.arguments) call = { ...call, arguments: args };
  }
  if (!call || call.name !== binding.operation || verifyHash && mutationRequestHash(call.name, call.arguments) !== binding.requestHash) {
    throw new Error("[FILE_RESULT_INVALID] Original call or request hash does not match.");
  }
  if (verifyHash && (call.name === "delete" || call.name === "move" || call.name === "copy")) validateNativeInvocation(call.name, call.arguments);
  if (verifyHash && call.name === "file_batch") validateBatchInput(call.arguments, "history");
  if (verifyHash && call.name === "write") {
    const sandbox = typeof call.arguments?.snapshot === "string" && SHA256_PATTERN.test(call.arguments.snapshot);
    if (!Value.Check(sandbox ? SandboxWriteParameters : NativeWriteParameters, call.arguments)) throw new Error("[FILE_RESULT_INVALID] Invalid original write parameters.");
    validateWriteContent(call.arguments.content);
  } else if (verifyHash && call.name === "edit") {
    const sandbox = typeof call.arguments?.snapshot === "string" && SHA256_PATTERN.test(call.arguments.snapshot);
    if (!Value.Check(sandbox ? SandboxEditParameters : PublicEditParameters, call.arguments)) throw new Error("[FILE_RESULT_INVALID] Invalid original edit parameters.");
    if (!sandbox) validatePublicEditInput(call.arguments);
  }
  if (call.arguments?.dryRun === true) throw new Error("[FILE_RESULT_INVALID] A dryRun cannot publish an execution journal.");
  const input = call.arguments;
  const count = binding.operation === "file_batch" ? input?.operations?.length
    : binding.operation === "delete" && Array.isArray(input?.paths) ? input.paths.length
    : Array.isArray(input?.items) ? input.items.length : 1;
  if (count !== binding.itemCount) throw new Error("[FILE_RESULT_INVALID] Prepared item count does not match the original call.");
  return call;
}

function journalNode(session: FileResultSession, binding: FileResultEnvelope, id: unknown): FileResultEnvelope {
  if (!boundedResultId(id)) throw new Error("[FILE_RESULT_INVALID] Missing paired journal reference.");
  const entry = session.getEntry(id);
  if (entry?.type !== "custom" || entry.customType !== FILE_RESULT_ENTRY) throw new Error("[FILE_RESULT_INVALID] Missing paired journal entry.");
  const data = parseFileResultEnvelope(entry.data);
  if (!sameResultBinding(binding, data) || data.sequence >= binding.sequence) throw new Error("[FILE_RESULT_INVALID] Invalid paired journal binding/order.");
  return data;
}
function assertIntentMembership(intent: FileResultPayload, prepared: FileResultEnvelope, readyId: string, readyHash: string, ready: FileResultPayload): void {
  if (intent.readyId !== readyId || intent.readyHash !== readyHash || intent.generation !== ready.generation
    || !boundedFileEntryId(intent.preparedId) || !verifyManifestProof(manifestLeafHash(intent.preparedId, prepared.hash), intent.index!, prepared.itemCount,
      intent.manifestProof, ready.manifestRoot)) throw new Error("[FILE_RESULT_INVALID] Intent does not belong to the ready manifest or permission generation.");
}
function assertRecord(session: FileResultSession, data: FileResultEnvelope, record: FileResultPayload, call: any,
  readyId?: string, readyHash?: string, ready?: FileResultPayload): void {
  const fail = "[FILE_RESULT_INVALID] Inconsistent journal phase, item or preparation.";
  if (record.index !== undefined && record.itemId !== `${data.toolCallId}:${record.index}`) throw new Error(fail);
  if (record.phase === "prepared") {
    const input = call.name === "file_batch" ? call.arguments.operations[data.sequence] : call.arguments;
    const operation = call.name === "file_batch" ? input?.operation : call.name;
    const requestHash = call.name === "delete" || call.name === "copy" || call.name === "move"
      ? nativeItemRequestHash(call.name, input, data.sequence) : mutationRequestHash(operation, input);
    if (record.index !== data.sequence || data.sequence >= data.itemCount || record.operation !== operation
      || record.inputHash !== requestHash
      || !safeFileResultPath(record.target) || !isAbsolute(record.target)
      || (operation === "move" || operation === "copy") && (!safeFileResultPath(record.destination) || !isAbsolute(record.destination))) throw new Error(fail);
    if (data.sequence > 0) {
      const previous = journalNode(session, data, data.previousId);
      const previousRecord = parseFileResultPayload(previous);
      if (previous.hash !== data.previousHash || previousRecord.phase !== "prepared" || previousRecord.index !== record.index - 1) throw new Error(fail);
    }
    return;
  }
  const previous = journalNode(session, data, data.previousId);
  const previousRecord = parseFileResultPayload(previous);
  if (previous.hash !== data.previousHash || previous.sequence !== data.sequence - 1) throw new Error(fail);
  if (record.phase === "ready") {
    if (data.sequence !== data.itemCount || record.prepared !== data.itemCount || record.manifestHash !== data.previousHash
      || previousRecord.phase !== "prepared" || previousRecord.index !== data.itemCount - 1
      || !Number.isSafeInteger(record.generation) || (record.generation as number) < 0
      || typeof record.manifestRoot !== "string" || !SHA256_PATTERN.test(record.manifestRoot)) throw new Error(fail);
    return;
  }
  if (!readyId || !readyHash || !ready || record.readyId !== readyId || record.readyHash !== readyHash) throw new Error(fail);
  if (record.phase === "complete") {
    const count = record.nextIndex;
    if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > data.itemCount
      || record.notStarted !== data.itemCount - (count as number)
      || (count === 0 ? previousRecord.phase !== "ready" : previousRecord.phase !== "result" || previousRecord.index !== (count as number) - 1)) throw new Error(fail);
    let total = 0;
    for (const key of COUNT_FIELDS) {
      const value = record[key];
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(fail);
      total += value as number;
    }
    if (total !== count) throw new Error(fail);
    return;
  }
  if (!Number.isInteger(record.index)) throw new Error(fail);
  const prepared = journalNode(session, data, record.preparedId);
  const preparation = parseFileResultPayload(prepared);
  if (preparation.phase !== "prepared" || preparation.index !== record.index || prepared.sequence !== record.index) throw new Error(fail);
  // The prepared row is checked against the original input even when it falls on a later page.
  assertRecord(session, prepared, preparation, call);
  if (record.phase === "intent") {
    assertIntentMembership(record, prepared, readyId, readyHash, ready);
    if (record.index === 0 ? data.previousId !== readyId || previousRecord.phase !== "ready"
      : previousRecord.phase !== "result" || previousRecord.index !== record.index! - 1 || previousRecord.readyId !== readyId || previousRecord.readyHash !== readyHash) throw new Error(fail);
    return;
  }
  const intent = journalNode(session, data, record.intentId);
  const intention = parseFileResultPayload(intent);
  if (intention.phase !== "intent" || intention.index !== record.index || intention.preparedId !== record.preparedId) throw new Error(fail);
  assertIntentMembership(intention, prepared, readyId, readyHash, ready);
  if (record.operation !== preparation.operation || record.target !== preparation.target || record.destination !== preparation.destination
    || !validMutationOutcome(record.status, record.stateChanged) || record.status === "not_started") throw new Error(fail);
  for (const key of CONTENT_HASH_FIELDS) if (record[key] !== undefined && (typeof record[key] !== "string" || !SHA256_PATTERN.test(record[key] as string))) throw new Error(fail);
  if (record.snapshot !== undefined && (record.status !== "succeeded" || record.requiresVerification === true || record.snapshot !== record.sha256)
    || record.revision !== undefined && (record.status !== "succeeded" || record.requiresVerification === true || record.revisionContinuation !== "available")) throw new Error(fail);
  if (record.phase === "commit") {
    if (data.previousId !== record.intentId) throw new Error(fail);
    return;
  }
  if ((previousRecord.phase !== "intent" && previousRecord.phase !== "commit") || previousRecord.index !== record.index
    || (previousRecord.phase === "intent" ? data.previousId !== record.intentId
      : previousRecord.intentId !== record.intentId || previous.previousId !== record.intentId || previous.previousHash !== intent.hash || previous.sequence !== intent.sequence + 1)
    || !validMutationOutcome(record.status, record.stateChanged) || record.status === "not_started"
    || record.operation !== preparation.operation || record.target !== preparation.target || record.destination !== preparation.destination
    || (record.status === "partial" || record.status === "state_unknown") && record.requiresVerification !== true) throw new Error(fail);
  if (record.status === "succeeded" && previousRecord.phase === "commit"
    && (previousRecord.status !== "succeeded" || previousRecord.stateChanged !== true || record.sha256 !== previousRecord.sha256)) throw new Error(fail);
  if (record.status === "succeeded" && (record.operation === "write" || record.operation === "edit")
    && (previousRecord.phase !== "commit" || typeof record.sha256 !== "string")) throw new Error(fail);
}
function parseCursor(raw: string): ResultCursor {
  if (raw.length > FILE_RESULT_CURSOR_CHARACTERS) throw new Error("[FILE_RESULT_CURSOR] Cursor exceeds its metadata budget.");
  const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ResultCursor;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[FILE_RESULT_CURSOR] Invalid cursor.");
  const keys = Object.keys(value);
  if (keys.length !== CURSOR_KEYS.size) throw new Error("[FILE_RESULT_CURSOR] Missing cursor field.");
  for (const key of keys) if (!CURSOR_KEYS.has(key)) throw new Error("[FILE_RESULT_CURSOR] Unexpected cursor field.");
  if (value.version !== 3 || !boundedFileEntryId(value.entryId) || typeof value.session !== "string" || !SHA256_PATTERN.test(value.session)
    || !Number.isSafeInteger(value.history) || !Number.isSafeInteger(value.context) || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || value.history < 0 || value.context < 0 || typeof value.root !== "string" || !SHA256_PATTERN.test(value.root)
    || typeof value.hash !== "string" || !SHA256_PATTERN.test(value.hash)) throw new Error("[FILE_RESULT_CURSOR] Invalid cursor fields.");
  for (const key of COUNT_FIELDS) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("[FILE_RESULT_CURSOR] Invalid cursor count.");
  if (!Number.isSafeInteger(value.preparedNext) || value.preparedNext < -1 || !validManifestFrontier(value.manifestFrontier)) throw new Error("[FILE_RESULT_CURSOR] Invalid prepared manifest cursor.");
  return value;
}

/** One session owner, one cached branch-membership proof; no result/page cache. */
export class FileResultReader {
  private session: FileResultSession | undefined;
  private proofEntry = "";
  private proofSession = "";
  private proofHistory = -1;
  private proofContext = -1;
  private proofRequestHash = "";
  private proofCall: any;
  private proofLeaf: string | null = null;
  private proofReadyId = "";
  private proofReadyHash = "";
  private returnedRecords = 0;
  private pages = 0;
  private cursorKey: Buffer | undefined = randomBytes(32);
  constructor(session: FileResultSession) { this.session = session; }
  read(resultRef: string, cursor?: string, limit = 64): FileResultPage {
    const session = this.session;
    if (!session || !session.isHistoryConsistent()) throw new Error("[FILE_RESULT_CLOSED] Session history is unavailable.");
    if (!Number.isInteger(limit) || limit < 1 || limit > FILE_RESULT_PAGE_RECORDS) throw new Error("[FILE_RESULT_CURSOR] Invalid page size.");
    const reference = parseFileResultReference(resultRef);
    resultRef = fileResultReference(reference.entryId, reference, reference.hash);
    const sessionId = createHash("sha256").update(session.getSessionId()).digest("hex"), history = session.getHistoryGeneration(), context = session.getContextGeneration();
    const leaf = session.getLeafId();
    if (this.proofEntry !== reference.entryId || this.proofSession !== sessionId || this.proofHistory !== history || this.proofContext !== context) {
      assertAncestor(session, leaf, reference.entryId);
      this.proofEntry = reference.entryId; this.proofSession = sessionId; this.proofHistory = history; this.proofContext = context;
      this.proofRequestHash = "";
      this.proofCall = undefined;
      this.proofLeaf = null;
      this.proofReadyId = ""; this.proofReadyHash = "";
    }
    const rootEntry = session.getEntry(reference.entryId);
    if (rootEntry?.type !== "custom" || rootEntry.customType !== FILE_RESULT_ENTRY) throw new Error("[FILE_RESULT_INVALID] Missing result anchor.");
    const anchor = parseFileResultEnvelope(rootEntry.data);
    if (anchor.hash !== reference.hash || anchor.callEntryId !== reference.callEntryId || anchor.toolCallId !== reference.toolCallId) throw new Error("[FILE_RESULT_INVALID] Result anchor mismatch.");
    if (this.proofLeaf !== leaf) {
      let current = leaf, remaining = session.getEntryCount() + 1;
      const stop = this.proofLeaf ?? reference.entryId;
      while (current !== stop && current && remaining-- > 0) {
        const entry = session.getEntry(current);
        if (entry?.type === "custom" && entry.customType === FILE_RESULT_ENTRY) {
          const later = entry.data as Partial<FileResultBinding>;
          if (later?.callEntryId === anchor.callEntryId && later.toolCallId === anchor.toolCallId) throw new Error("[FILE_RESULT_INVALID] Result anchor is superseded by later call activity.");
        }
        current = entry?.parentId ?? null;
      }
      if (current !== stop) throw new Error("[FILE_RESULT_BRANCH] Selected branch no longer contains the proof boundary.");
      this.proofLeaf = leaf;
    }
    const call = this.proofCall ??= assertSourceCall(session, anchor, true);
    this.proofRequestHash = anchor.requestHash;
    if (call.name !== anchor.operation || call.id !== anchor.toolCallId) throw new Error("[FILE_RESULT_INVALID] Original call identity changed.");
    const rootPayload = parseFileResultPayload(anchor);
    let readyId: string | undefined, readyHash: string | undefined, ready: FileResultPayload | undefined;
    if (rootPayload.phase !== "prepared") {
      readyId = rootPayload.phase === "ready" ? reference.entryId : rootPayload.readyId as string;
      const readyData = readyId === reference.entryId ? anchor : journalNode(session, anchor, readyId);
      ready = parseFileResultPayload(readyData); readyHash = readyData.hash;
      if (ready.phase !== "ready" || rootPayload.phase !== "ready" && rootPayload.readyHash !== readyHash) throw new Error("[FILE_RESULT_INVALID] Missing or mismatched ready manifest.");
      assertRecord(session, readyData, ready, call);
      if (this.proofReadyId !== readyId || this.proofReadyHash !== readyHash) {
        assertAncestor(session, reference.entryId, readyId!); this.proofReadyId = readyId!; this.proofReadyHash = readyHash;
      }
    }
    let entryId: string | null = reference.entryId, expectedHash: string | null = anchor.hash, sequence = anchor.sequence;
    let succeeded = 0, failed = 0, partial = 0, unknown = 0, cancelled = 0;
    let preparedNext = ready ? anchor.itemCount - 1 : anchor.sequence, manifestFrontier: Array<string | null> = [];
    if (cursor) {
      const separator = cursor.indexOf(".");
      const encoded = cursor.slice(0, separator), signature = cursor.slice(separator + 1);
      if (separator < 1 || cursor.length > FILE_RESULT_CURSOR_CHARACTERS || !this.cursorKey || !SHA256_PATTERN.test(signature)) throw new Error("[FILE_RESULT_CURSOR] Invalid owner cursor.");
      const digest = createHmac("sha256", this.cursorKey).update(encoded).digest();
      if (!timingSafeEqual(digest, Buffer.from(signature, "hex"))) throw new Error("[FILE_RESULT_CURSOR] Cursor was altered or belongs to another owner.");
      const position = parseCursor(encoded);
      if (position.root !== reference.hash || position.session !== sessionId || position.history !== history || position.context !== context
        || position.sequence > anchor.sequence || position.preparedNext >= anchor.itemCount) throw new Error("[FILE_RESULT_CURSOR] Cursor belongs to another result or session generation.");
      entryId = position.entryId; expectedHash = position.hash; sequence = position.sequence;
      succeeded = position.succeeded; failed = position.failed; partial = position.partial; unknown = position.unknown; cancelled = position.cancelled;
      preparedNext = position.preparedNext; manifestFrontier = position.manifestFrontier;
    }
    const rows: FileResultPageRow[] = [];
    let budget = FILE_RESULT_PAGE_HEADER_BYTES;
    while (entryId && rows.length < limit) {
      const entry = session.getEntry(entryId);
      if (entry?.type !== "custom" || entry.customType !== FILE_RESULT_ENTRY) throw new Error("[FILE_RESULT_INVALID] Journal chain is incomplete.");
      const data = parseFileResultEnvelope(entry.data);
      if (!sameResultBinding(anchor, data) || data.hash !== expectedHash || data.sequence !== sequence) throw new Error("[FILE_RESULT_INVALID] Journal chain identity mismatch.");
      if (budget + data.payloadBytes + FILE_RESULT_RECORD_WRAPPER_BYTES > FILE_RESULT_PAGE_BYTES) break;
      const record = parseFileResultPayload(data);
      assertRecord(session, data, record, call, readyId, readyHash, ready);
      if (record.phase === "ready" && entry.id !== readyId) throw new Error("[FILE_RESULT_INVALID] Conflicting ready manifests.");
      if (record.phase === "prepared") {
        if (record.index !== preparedNext--) throw new Error("[FILE_RESULT_INVALID] Prepared manifest order is incomplete.");
        if (ready) {
          const root = appendReverseManifest(manifestFrontier, manifestLeafHash(entry.id, data.hash), record.index!, anchor.itemCount);
          if (record.index === 0 && root !== ready.manifestRoot) throw new Error("[FILE_RESULT_INVALID] Prepared manifest digest mismatch.");
        }
      }
      if (record.phase === "result") switch (record.status) {
        case "succeeded": succeeded++; break;
        case "failed_no_change": failed++; break;
        case "partial": partial++; break;
        case "state_unknown": unknown++; break;
        case "cancelled": cancelled++; break;
      }
      if (data.previousId) assertAncestor(session, entry.parentId, data.previousId);
      else assertAncestor(session, entry.parentId, data.callEntryId);
      rows.push({ entryId: entry.id, sequence, hash: data.hash, record });
      this.returnedRecords++; budget += data.payloadBytes + FILE_RESULT_RECORD_WRAPPER_BYTES;
      entryId = data.previousId; expectedHash = data.previousHash; sequence--;
    }
    if (!rows.length && entryId) throw new Error("[FILE_RESULT_BUDGET] A journal record cannot fit in a bounded page.");
    if (!entryId && (sequence !== -1 || preparedNext !== -1 || rootPayload.phase === "complete" && (rootPayload.succeeded !== succeeded || rootPayload.failed !== failed
      || rootPayload.partial !== partial || rootPayload.unknown !== unknown || rootPayload.cancelled !== cancelled))) throw new Error("[FILE_RESULT_INVALID] Complete counts do not match the journal chain.");
    const position = entryId ? Buffer.from(JSON.stringify({ version: 3, root: reference.hash, session: sessionId, history, context,
      entryId, hash: expectedHash!, sequence, succeeded, failed, partial, unknown, cancelled, preparedNext, manifestFrontier } satisfies ResultCursor)).toString("base64url") : null;
    const nextCursor = position ? position + "." + createHmac("sha256", this.cursorKey!).update(position).digest("hex") : null;
    this.pages++;
    return { version: 3, resultRef, records: rows, nextCursor, callComplete: rootPayload.phase === "complete", pageComplete: nextCursor === null,
      coverageComplete: nextCursor === null && rootPayload.phase === "complete", itemCount: anchor.itemCount,
      incompleteItem: rootPayload.phase === "intent" || rootPayload.phase === "commit"
        ? { index: rootPayload.index!, status: "state_unknown", stateChanged: "unknown", requiresVerification: true } : undefined };
  }
  get diagnostics() { return { pages: this.pages, returnedRecords: this.returnedRecords, retainedPages: 0,
    sourceCallRetained: this.proofCall !== undefined, sessionRetained: this.session !== undefined }; }
  /** Already authenticated by read(); one source-call slot per reader owner. */
  get sourceCall(): any { return this.proofCall; }
  dispose(): void { this.session = undefined; this.proofRequestHash = ""; this.proofEntry = ""; this.proofSession = ""; this.proofLeaf = null;
    this.proofReadyId = ""; this.proofReadyHash = ""; this.proofCall = undefined; this.cursorKey?.fill(0); this.cursorKey = undefined; }
}
