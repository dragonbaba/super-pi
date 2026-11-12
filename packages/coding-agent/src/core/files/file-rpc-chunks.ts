import { createHash } from "node:crypto";
import { FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES, FILE_RPC_REPLY_HEADER_BYTES, FILE_RPC_ITEM_METADATA_BYTES, FILE_RPC_CONTROL_BYTES } from "./file-operation-limits.mjs";

export interface FileRpcEnvelope {
  id: string; mode: string; workspaces: readonly string[]; operation: string; exchange: string;
  maxWriteBytes: number; callId: string; requestHash: string; generation: number;
  workspaceIdentities: readonly string[];
}
export interface FileRpcChunk { readonly start: number; readonly end: number; readonly requestBytes: number; readonly requestHash: string; }
export interface FileRpcPlan { readonly chunks: readonly FileRpcChunk[]; readonly itemCount: number; readonly maxRequestBytes: number; readonly replyReservationBytes: number; }

// Preparation returns fixed identity/digest descriptors; full inventories stay
// in temporary artifacts. The fixed envelope is separately reserved.
// These bounds limit an internal transport page, never the public invocation's item count.
export const FILE_RPC_PREPARED_ITEM_BYTES = FILE_RPC_ITEM_METADATA_BYTES;
export interface EncodedFileRpc { readonly serialized: string; readonly bytes: number; readonly hash: string; readonly baseBytes: number; }
export interface FileRpcControl { readonly prepared?: readonly unknown[]; readonly readyHash?: string; readonly intentId?: string; readonly preview?: boolean; }
const START = ',"start":', ITEMS = ',"items":[', VALIDATE_END = '],"phase":"validate"}';
function requestHeader(envelope: FileRpcEnvelope, count: number): string {
  return JSON.stringify({ ...envelope, version: 3, rpc: "file-mutation-v3", itemCount: count });
}
function chunkHash(header: string, start: number) {
  return createHash("sha256").update(header.slice(0, -1)).update(START).update(String(start)).update(ITEMS);
}
function baseBytes(headerBytes: number, start: number): number { return headerBytes - 1 + START.length + String(start).length + ITEMS.length + VALIDATE_END.length; }

function serializedRequest(envelope: FileRpcEnvelope, input: readonly unknown[], start: number, end: number, phase: "prepare" | "validate" | "execute", control?: FileRpcControl): EncodedFileRpc {
  const header = requestHeader(envelope, input.length);
  const parts = [header.slice(0, -1), START, String(start), ITEMS], hash = chunkHash(header, start);
  for (let index = start; index < end; index++) {
    if (index > start) { parts.push(","); hash.update(","); }
    const item = JSON.stringify(input[index]); parts.push(item); hash.update(item);
  }
  hash.update("]}");
  parts.push('],"phase":', JSON.stringify(phase));
  let controlBytes = 0;
  if (control !== undefined) {
    const serializedControl = JSON.stringify(control); controlBytes = Buffer.byteLength(serializedControl) + ',"control":'.length;
    if (controlBytes > FILE_RPC_CONTROL_BYTES + (end - start) * FILE_RPC_ITEM_METADATA_BYTES) throw new Error("[FILE_RPC_BUDGET] Control facts exceed their preflight reservation.");
    parts.push(',"control":', serializedControl);
  }
  parts.push("}");
  const serialized = parts.join("");
  const bytes = Buffer.byteLength(serialized);
  return { serialized, bytes, baseBytes: bytes - controlBytes, hash: hash.digest("hex") };
}

/** Full-call transport preflight. Retains only ranges/digests, not serialized bodies or result arrays. */
export function planFileRpc(envelope: FileRpcEnvelope, input: readonly unknown[]): FileRpcPlan {
  if (!input.length) throw new Error("[FILE_RPC_INVALID] A mutation needs at least one item.");
  const chunks: FileRpcChunk[] = [];
  const header = requestHeader(envelope, input.length), headerBytes = Buffer.byteLength(header);
  let start = 0, bytes = baseBytes(headerBytes, 0), hash = chunkHash(header, 0), maxRequestBytes = 0, replyReservationBytes = 0;
  for (let index = 0; index < input.length; index++) {
    // Only a bounded item is serialized for preflight; complete request strings are built once at their send boundary.
    const item = JSON.stringify(input[index]), itemBytes = Buffer.byteLength(item);
    let count = index - start + 1, candidateBytes = bytes + itemBytes + (count > 1 ? 1 : 0);
    if (FILE_RPC_REPLY_HEADER_BYTES + count * FILE_RPC_PREPARED_ITEM_BYTES > FILE_RPC_REPLY_BYTES
      || candidateBytes + FILE_RPC_CONTROL_BYTES + count * FILE_RPC_ITEM_METADATA_BYTES > FILE_RPC_REQUEST_BYTES) {
      if (index === start) throw new Error(`[FILE_RPC_BUDGET] Item ${index} cannot fit the complete request/reply envelope; no items executed.`);
      chunks.push(Object.freeze({ start, end: index, requestBytes: bytes, requestHash: hash.update("]}").digest("hex") }));
      maxRequestBytes = Math.max(maxRequestBytes, bytes); replyReservationBytes = Math.max(replyReservationBytes, FILE_RPC_REPLY_HEADER_BYTES + (count - 1) * FILE_RPC_PREPARED_ITEM_BYTES);
      start = index; count = 1; bytes = baseBytes(headerBytes, index); hash = chunkHash(header, index); candidateBytes = bytes + itemBytes;
      if (candidateBytes + FILE_RPC_CONTROL_BYTES + FILE_RPC_ITEM_METADATA_BYTES > FILE_RPC_REQUEST_BYTES) throw new Error(`[FILE_RPC_BUDGET] Item ${index} cannot fit the complete request/reply envelope; no items executed.`);
    }
    if (count > 1) hash.update(","); hash.update(item); bytes = candidateBytes;
  }
  chunks.push(Object.freeze({ start, end: input.length, requestBytes: bytes, requestHash: hash.update("]}").digest("hex") }));
  maxRequestBytes = Math.max(maxRequestBytes, bytes); replyReservationBytes = Math.max(replyReservationBytes, FILE_RPC_REPLY_HEADER_BYTES + (input.length - start) * FILE_RPC_PREPARED_ITEM_BYTES);
  return Object.freeze({ chunks: Object.freeze(chunks), itemCount: input.length, maxRequestBytes, replyReservationBytes });
}

/** Reuse this exact string for the RPC write and its byte counter; no second full serialization for diagnostics. */
export function serializeFileRpc(envelope: FileRpcEnvelope, input: readonly unknown[], chunk: FileRpcChunk, phase: "prepare" | "validate" | "execute", control?: FileRpcControl): EncodedFileRpc {
  if (phase === "execute" && chunk.end - chunk.start !== 1) throw new Error("[FILE_RPC_ORDER] Each effect request requires exactly one published intent.");
  const encoded = serializedRequest(envelope, input, chunk.start, chunk.end, phase, control);
  if (encoded.baseBytes !== chunk.requestBytes - (phase === "validate" ? 0 : 1) || encoded.hash !== chunk.requestHash || encoded.bytes > FILE_RPC_REQUEST_BYTES) throw new Error("[FILE_RPC_INVALID] Prepared transport manifest changed.");
  return encoded;
}

/** Each effect request follows exactly one durable intent; preparation still uses byte-bounded multi-item chunks. */
export function fileRpcItemChunk(envelope: FileRpcEnvelope, input: readonly unknown[], index: number): FileRpcChunk {
  if (!Number.isInteger(index) || index < 0 || index >= input.length) throw new Error("[FILE_RPC_INVALID] Invalid global item index.");
  const header = requestHeader(envelope, input.length), item = JSON.stringify(input[index]);
  const bytes = baseBytes(Buffer.byteLength(header), index) + Buffer.byteLength(item);
  if (bytes + FILE_RPC_CONTROL_BYTES + FILE_RPC_ITEM_METADATA_BYTES > FILE_RPC_REQUEST_BYTES) throw new Error("[FILE_RPC_BUDGET] Item cannot fit its effect envelope.");
  return { start: index, end: index + 1, requestBytes: bytes, requestHash: chunkHash(header, index).update(item).update("]}").digest("hex") };
}
