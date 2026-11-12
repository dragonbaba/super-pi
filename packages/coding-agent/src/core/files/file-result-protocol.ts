import { createHash } from "node:crypto";
import { Type } from "typebox";
import { SHA256_PATTERN, UNSAFE_RECEIPT_PATH_PATTERN } from "./regex.ts";
import { FILE_RESULT_PAGE_BYTES, FILE_RESULT_PAGE_RECORDS, FILE_RESULT_PAYLOAD_BYTES, FILE_RESULT_REFERENCE_CHARACTERS, FILE_RESULT_CURSOR_CHARACTERS } from "./file-operation-limits.mjs";

export const FILE_RESULT_ENTRY = "file-mutation-progress-v3";
export const FILE_MUTATION_CALL_ENTRY = "file-mutation-call-v3";
export { FILE_RESULT_PAGE_BYTES, FILE_RESULT_PAGE_RECORDS, FILE_RESULT_PAYLOAD_BYTES };
export const FileResultParameters = Type.Object({
  ref: Type.String({ minLength: 1, maxLength: FILE_RESULT_REFERENCE_CHARACTERS, description: "Durable resultRef from a file mutation in this session branch; never a filesystem path or a Codemode result.ref." }),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: FILE_RESULT_CURSOR_CHARACTERS })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FILE_RESULT_PAGE_RECORDS, description: "Page records only; execution target count is unrestricted." })),
}, { additionalProperties: false });

export type FileResultOperation = "edit" | "write" | "copy" | "delete" | "move" | "file_batch";
export type FileResultPhase = "prepared" | "ready" | "intent" | "commit" | "result" | "complete";
export interface FileResultBinding {
  callEntryId: string;
  toolCallId: string;
  operation: FileResultOperation;
  requestHash: string;
  itemCount: number;
}
export interface FileResultPayload {
  phase: FileResultPhase;
  index?: number;
  itemId?: string;
  operation?: FileResultOperation;
  target?: string;
  destination?: string;
  status?: string;
  stateChanged?: boolean | "unknown";
  requiresVerification?: boolean;
  [field: string]: unknown;
}
export interface FileResultEnvelope extends FileResultBinding {
  version: 3;
  sequence: number;
  previousId: string | null;
  previousHash: string | null;
  payload: string;
  payloadBytes: number;
  hash: string;
}
export interface FileResultReference { version: 3; entryId: string; hash: string; callEntryId: string; toolCallId: string; }
const PHASES: ReadonlySet<string> = new Set(["prepared", "ready", "intent", "commit", "result", "complete"]);
const OPERATIONS: ReadonlySet<string> = new Set(["edit", "write", "copy", "delete", "move", "file_batch"]);
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["version", "callEntryId", "toolCallId", "operation", "requestHash", "itemCount", "sequence", "previousId", "previousHash", "payload", "payloadBytes", "hash"]);
const REFERENCE_KEYS: ReadonlySet<string> = new Set(["version", "entryId", "hash", "callEntryId", "toolCallId"]);
const REF_PREFIX = "file-result-v3:";
// v3 source/journal entries are newly published by SessionManager.generateId, including its UUID fallback.
const ENTRY_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

export function boundedResultId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
export function boundedFileEntryId(value: unknown): value is string { return typeof value === "string" && ENTRY_ID.test(value); }
/** Canonical paths may include cwd beyond the public relative-path length. Their
 * bound is the v3 record budget; historical v1/v2 path bounds stay unchanged. */
export function safeFileResultPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= FILE_RESULT_PAYLOAD_BYTES && !UNSAFE_RECEIPT_PATH_PATTERN.test(value);
}
export function validResultBinding(value: FileResultBinding): boolean {
  return boundedFileEntryId(value.callEntryId) && boundedResultId(value.toolCallId) && OPERATIONS.has(value.operation)
    && typeof value.requestHash === "string" && SHA256_PATTERN.test(value.requestHash)
    && Number.isSafeInteger(value.itemCount) && value.itemCount > 0;
}
export function sameResultBinding(left: FileResultBinding, right: FileResultBinding): boolean {
  return left.callEntryId === right.callEntryId && left.toolCallId === right.toolCallId && left.operation === right.operation
    && left.requestHash === right.requestHash && left.itemCount === right.itemCount;
}
function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value))); hash.update(":"); hash.update(value);
}
export function resultEnvelopeHash(value: Omit<FileResultEnvelope, "hash">): string {
  const hash = createHash("sha256");
  hashField(hash, value.callEntryId); hashField(hash, value.toolCallId); hashField(hash, value.operation);
  hashField(hash, value.requestHash); hashField(hash, String(value.itemCount)); hashField(hash, String(value.sequence));
  hashField(hash, value.previousId ?? ""); hashField(hash, value.previousHash ?? ""); hashField(hash, String(value.payloadBytes)); hashField(hash, value.payload);
  return hash.digest("hex");
}
export function parseFileResultEnvelope(raw: unknown): FileResultEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("[FILE_RESULT_INVALID] Invalid journal envelope.");
  const value = raw as FileResultEnvelope;
  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_KEYS.size) throw new Error("[FILE_RESULT_INVALID] Missing journal field.");
  for (const key of keys) if (!ENVELOPE_KEYS.has(key)) throw new Error("[FILE_RESULT_INVALID] Unexpected journal field.");
  if (value.version !== 3 || !validResultBinding(value) || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || (value.sequence === 0 ? value.previousId !== null || value.previousHash !== null
      : !boundedFileEntryId(value.previousId) || typeof value.previousHash !== "string" || !SHA256_PATTERN.test(value.previousHash))
    || typeof value.payload !== "string" || !Number.isSafeInteger(value.payloadBytes) || value.payloadBytes < 0
    || value.payloadBytes > FILE_RESULT_PAYLOAD_BYTES || Buffer.byteLength(value.payload) !== value.payloadBytes
    || typeof value.hash !== "string" || !SHA256_PATTERN.test(value.hash) || resultEnvelopeHash(value) !== value.hash) {
    throw new Error("[FILE_RESULT_INVALID] Journal identity, size or digest mismatch.");
  }
  return value;
}
export function parseFileResultPayload(value: FileResultEnvelope): FileResultPayload {
  const payload = JSON.parse(value.payload) as FileResultPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !PHASES.has(payload.phase)
    || payload.index !== undefined && (!Number.isSafeInteger(payload.index) || payload.index < 0 || payload.index >= value.itemCount)) {
    throw new Error("[FILE_RESULT_INVALID] Invalid journal payload.");
  }
  return payload;
}
export function fileResultReference(entryId: string, value: Pick<FileResultBinding, "callEntryId" | "toolCallId">, hash: string): string {
  if (!boundedFileEntryId(entryId) || !boundedFileEntryId(value.callEntryId) || !boundedResultId(value.toolCallId) || !SHA256_PATTERN.test(hash)) throw new Error("[FILE_RESULT_INVALID] Invalid published entry ID or call binding.");
  const reference: FileResultReference = { version: 3, entryId, hash, callEntryId: value.callEntryId, toolCallId: value.toolCallId };
  return REF_PREFIX + Buffer.from(JSON.stringify(reference)).toString("base64url");
}
export function parseFileResultReference(raw: unknown): FileResultReference {
  if (typeof raw !== "string" || raw.length > FILE_RESULT_REFERENCE_CHARACTERS || !raw.startsWith(REF_PREFIX)) throw new Error("[FILE_RESULT_INVALID] Expected a session resultRef.");
  const reference = JSON.parse(Buffer.from(raw.slice(REF_PREFIX.length), "base64url").toString("utf8")) as FileResultReference;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("[FILE_RESULT_INVALID] Invalid resultRef.");
  const keys = Object.keys(reference);
  if (keys.length !== REFERENCE_KEYS.size) throw new Error("[FILE_RESULT_INVALID] Missing resultRef field.");
  for (const key of keys) if (!REFERENCE_KEYS.has(key)) throw new Error("[FILE_RESULT_INVALID] Unexpected resultRef field.");
  if (reference.version !== 3 || !boundedFileEntryId(reference.entryId) || !boundedFileEntryId(reference.callEntryId) || !boundedResultId(reference.toolCallId)
    || typeof reference.hash !== "string" || !SHA256_PATTERN.test(reference.hash)) throw new Error("[FILE_RESULT_INVALID] Invalid resultRef identity.");
  return reference;
}
