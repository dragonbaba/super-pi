import { isAbsolute } from "node:path";
import { mutationRequestHash } from "./file-invocation.ts";
import { SHA256_PATTERN, UNSAFE_RECEIPT_PATH_PATTERN } from "./regex.ts";

export const MAX_RESTORE_ENTRIES = 512;

export const MAX_STRUCTURED_MUTATION_RECEIPTS = 512;

export function isBoundedMutationEntryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export interface SessionEntryShape {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

export interface ToolResultMessageShape {
  role?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

export interface LegacyStructuredMutationReceipt {
  receiptVersion: 1;
  entryId: string;
  timestamp: string;
  toolCallId: string;
  operation: "edit" | "write";
  target: string;
  stateChanged: true;
  previousSha256?: string;
  sha256: string;
  replacements?: number;
  created?: true;
}

export interface NativeStructuredMutationReceipt {
  receiptVersion: 2;
  entryId: string;
  timestamp: string;
  toolCallId: string;
  itemId: string;
  operation: "delete" | "move" | "write" | "edit";
  target: string;
  destination?: string;
  status: "succeeded" | "failed_no_change" | "partial" | "cancelled" | "state_unknown" | "not_started";
  stateChanged: boolean | "unknown";
  requiresVerification?: true;
  historyConflict?: true;
}

export type StructuredMutationReceipt = LegacyStructuredMutationReceipt | NativeStructuredMutationReceipt;

export function safeReceiptPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !UNSAFE_RECEIPT_PATH_PATTERN.test(value);
}

export function validMutationOutcome(status: unknown, stateChanged: unknown): boolean {
  return status === "state_unknown" ? stateChanged === "unknown"
    : status === "succeeded" || status === "partial" ? stateChanged === true
    : (status === "failed_no_change" || status === "cancelled" || status === "not_started") && stateChanged === false;
}

function appendNativeReceipt(items: Map<string, NativeStructuredMutationReceipt>, entry: any, data: any, toolCallId: unknown, itemId: unknown, intent: boolean): boolean {
  if (typeof toolCallId !== "string" || !toolCallId.length || toolCallId.length > 256 || typeof itemId !== "string" || !itemId.length || itemId.length > 280) return false;
  const previous = items.get(itemId);
  if (previous && data && (previous.toolCallId !== toolCallId || previous.operation !== data.operation || previous.target !== data.target || previous.destination !== data.destination)) {
    previous.historyConflict = true;
    return false;
  }
  if (!data || (data.operation !== "delete" && data.operation !== "move" && data.operation !== "write" && data.operation !== "edit") || !safeReceiptPath(data.target)
    || (data.operation === "move" && !safeReceiptPath(data.destination))) return false;
  const status = intent ? "state_unknown" : data.status;
  const stateChanged = intent ? "unknown" : data.stateChanged;
  if (status !== "state_unknown" && status !== "succeeded" && status !== "partial" && status !== "failed_no_change" && status !== "cancelled" && status !== "not_started") return false;
  if ((status === "state_unknown" && stateChanged !== "unknown") || ((status === "succeeded" || status === "partial") && stateChanged !== true)
    || ((status === "failed_no_change" || status === "cancelled" || status === "not_started") && stateChanged !== false)) return false;
  items.set(itemId, { receiptVersion: 2, entryId: entry.id, timestamp: entry.timestamp, toolCallId, itemId,
    operation: data.operation, target: data.target, destination: data.destination, status, stateChanged, historyConflict: previous?.historyConflict,
    ...(status === "state_unknown" || status === "partial" || data.requiresVerification === true || data.commit?.retainedTemporary || data.receipt?.commit?.retainedTemporary ? { requiresVerification: true as const } : {}) });
  if (items.size > MAX_STRUCTURED_MUTATION_RECEIPTS) items.delete(items.keys().next().value!);
  const index = Number(itemId.slice(toolCallId.length + 1));
  return Number.isInteger(index) && index >= 0 && index < 16 && itemId === `${toolCallId}:${index}`;
}

function markConflictingAggregate(conflicts: Set<string>, toolCallId: unknown): void {
  if (typeof toolCallId === "string" && toolCallId.length <= 256) conflicts.add(toolCallId);
}

export function collectNativeReceipts(branch: readonly unknown[]): Map<string, NativeStructuredMutationReceipt> {
  const items = new Map<string, NativeStructuredMutationReceipt>();
  // At most one call per bounded entry. Retain ambiguity across later valid
  // mirrors as well as earlier outcomes; malformed records are never evidence.
  const conflicts = new Set<string>();
  for (let index = Math.max(0, branch.length - MAX_STRUCTURED_MUTATION_RECEIPTS); index < branch.length; index++) {
    const entry = branch[index] as any;
    if (typeof entry?.id !== "string" || typeof entry.timestamp !== "string") {
      if (entry?.type === "custom" && entry.customType === "file-mutation-progress-v2" && (entry.data?.phase === "intent" || entry.data?.phase === "result")) markConflictingAggregate(conflicts, entry.data.toolCallId);
      if (entry?.message?.role === "toolResult") markConflictingAggregate(conflicts, entry.message.toolCallId);
      continue;
    }
    if (entry.type === "custom" && entry.customType === "file-mutation-progress-v2") {
      const data = entry.data;
      if (data?.phase === "intent" || data?.phase === "result") {
        if (data.phase === "result" && data.mutationReceiptVersion !== 2
          || !appendNativeReceipt(items, entry, data, data.toolCallId, data.itemId, data.phase === "intent")) markConflictingAggregate(conflicts, data.toolCallId);
      }
      continue;
    }
    const message = entry.type === "message" && entry.message?.role === "toolResult" ? entry.message : undefined;
    const data = message?.details;
    if (typeof message?.toolCallId !== "string" || message.toolCallId.length < 1 || message.toolCallId.length > 256) continue;
    if (data?.mutationReceiptVersion !== 2) continue;
    if (message?.toolName !== data?.operation) { markConflictingAggregate(conflicts, message?.toolCallId); continue; }
    if (message.toolName === "file_batch" && data.operation === "file_batch" && !data.preview && Array.isArray(data.items) && data.items.length > 0 && data.items.length <= 16) {
      for (const previous of items.values()) if (previous.toolCallId === message.toolCallId) {
        const position = Number(previous.itemId.slice(message.toolCallId.length + 1));
        if (data.items[position]?.itemId !== previous.itemId) { markConflictingAggregate(conflicts, message.toolCallId); break; }
      }
      for (let index = 0; index < data.items.length; index++) {
        const item = data.items[index];
        if (item?.itemId === `${message.toolCallId}:${index}` && validMutationOutcome(item.status, item.stateChanged)
          && (item.operation === "write" || item.operation === "edit" || item.operation === "delete" || item.operation === "move")
          && safeReceiptPath(item.target) && (item.operation !== "move" || safeReceiptPath(item.destination))) {
          if (!appendNativeReceipt(items, entry, item, message.toolCallId, item.itemId, false)) markConflictingAggregate(conflicts, message.toolCallId);
        } else markConflictingAggregate(conflicts, message.toolCallId);
      }
    } else if (message.toolName === "file_batch") markConflictingAggregate(conflicts, message.toolCallId);
    else if (!appendNativeReceipt(items, entry, data, message.toolCallId, `${message.toolCallId}:0`, false)) markConflictingAggregate(conflicts, message.toolCallId);
  }
  for (const item of items.values()) if (conflicts.has(item.toolCallId)) item.historyConflict = true;
  return items;
}

/** Read only the bounded tail through existing indexed entries; never materialize a whole Session branch per result. */
export function recentMutationEntries(session: { getLeafId(): string | null; getEntry(id: string): { parentId: string | null } | undefined }): readonly unknown[] {
  const entries: unknown[] = [];
  let id = session.getLeafId();
  while (id && entries.length < MAX_RESTORE_ENTRIES) {
    if (!isBoundedMutationEntryId(id)) throw new Error("Session entry ID exceeds recovery bounds; history cannot be inspected safely.");
    const entry = session.getEntry(id);
    if (!entry) break;
    entries.push(entry); id = entry.parentId;
  }
  entries.reverse();
  return entries;
}

/** Pair bounded durable intents with this actual call, never with arbitrary result targets. */
export function boundBatchIntents(branch: readonly unknown[], input: any, toolCallId: string, preparedRequestHash?: string): Map<string, { operation: string; target: string; destination?: string; directories?: unknown }> {
  const intents = new Map<string, { operation: string; target: string; destination?: string; directories?: unknown }>();
  if (!Array.isArray(input?.operations) || input.operations.length > 16) return intents;
  const hash = preparedRequestHash ?? mutationRequestHash("file_batch", input);
  for (let i = Math.max(0, branch.length - MAX_RESTORE_ENTRIES); i < branch.length; i++) {
    const entry = branch[i] as any, data = entry?.data;
    if (entry?.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || data?.toolCallId !== toolCallId) continue;
    if (data.phase === "prepared" && data.requestHash === hash && Array.isArray(data.items) && data.items.length === input.operations.length) {
      for (let n = 0; n < data.items.length; n++) {
        const item = data.items[n];
        if (item?.itemId !== `${toolCallId}:${n}` || item.operation !== input.operations[n]?.operation || !safeReceiptPath(item.target) || !isAbsolute(item.target)
          || (item.operation === "move" && (!safeReceiptPath(item.destination) || !isAbsolute(item.destination)))) continue;
        intents.set(item.itemId, { operation: item.operation, target: item.target, destination: item.destination, directories: item.directories });
      }
      continue;
    }
    if (data.phase !== "intent" || (data.requestHash !== undefined && data.requestHash !== hash) || !safeReceiptPath(data.target) || !isAbsolute(data.target)) continue;
    for (let n = 0; n < input.operations.length; n++) {
      if (data.itemId !== `${toolCallId}:${n}` || data.operation !== input.operations[n]?.operation) continue;
      if (data.operation === "move" && (!safeReceiptPath(data.destination) || !isAbsolute(data.destination))) continue;
      intents.set(data.itemId, { operation: data.operation, target: data.target, destination: data.destination });
    }
  }
  return intents;
}

export function collectStructuredMutationReceipts(branch: readonly unknown[]): StructuredMutationReceipt[] {
  const receipts: StructuredMutationReceipt[] = [];
  const nativeReceipts = collectNativeReceipts(branch);
  const start = Math.max(0, branch.length - MAX_STRUCTURED_MUTATION_RECEIPTS);
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index] as SessionEntryShape;
    const custom = entry as any;
    if (custom?.type === "custom" && custom.customType === "file-mutation-progress-v2") {
      const itemId = custom.data?.itemId;
      const receipt = typeof itemId === "string" && itemId.length <= 280 ? nativeReceipts.get(itemId) : undefined;
      if (receipt && receipt.entryId === custom.id) receipts.push(receipt);
      continue;
    }
    if (entry?.type !== "message"
      || typeof entry.id !== "string"
      || typeof entry.timestamp !== "string"
      || !entry.message
      || typeof entry.message !== "object") continue;
    const message = entry.message as ToolResultMessageShape;
    if (typeof message.toolCallId !== "string" || message.toolCallId.length < 1 || message.toolCallId.length > 256) continue;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const batch = message.details as any;
      if (message.toolName === "file_batch" && Array.isArray(batch?.items) && batch.items.length <= 16) {
        for (const item of batch.items) {
          const itemId = item?.itemId;
          const receipt = typeof itemId === "string" && itemId.length <= 280 ? nativeReceipts.get(itemId) : undefined;
          if (receipt && receipt.entryId === entry.id) receipts.push(receipt);
        }
        continue;
      }
      const receipt = nativeReceipts.get(`${message.toolCallId}:0`);
      if (receipt?.entryId === entry.id) { receipts.push(receipt); continue; }
    }
    if (message.role !== "toolResult"
      || (message.isError === true && message.toolName !== "file_batch")
      || typeof message.toolCallId !== "string"
      || (message.toolName !== "edit" && message.toolName !== "write")
      || !message.details
      || typeof message.details !== "object") continue;
    const details = message.details as Record<string, unknown>;
    if (nativeReceipts.has(`${message.toolCallId}:0`)) continue;
    const target = details.target;
    const sha256 = details.sha256;
    const previousSha256 = details.previousSha256;
    if (details.mutationReceiptVersion !== 1
      || details.ok !== true
      || details.category !== "success"
      || details.operation !== message.toolName
      || details.stateChanged !== true
      || typeof target !== "string"
      || target.length < 1
      || target.length > 4096
      || UNSAFE_RECEIPT_PATH_PATTERN.test(target)
      || typeof sha256 !== "string"
      || !SHA256_PATTERN.test(sha256)) continue;
    if (message.toolName === "edit") {
      const replacements = details.replacements;
      if (typeof previousSha256 !== "string"
        || !SHA256_PATTERN.test(previousSha256)
        || !Number.isSafeInteger(replacements)
        || (replacements as number) < 1
        || (replacements as number) > 20) continue;
      receipts.push({
        receiptVersion: 1,
        entryId: entry.id,
        timestamp: entry.timestamp,
        toolCallId: message.toolCallId,
        operation: "edit",
        target,
        stateChanged: true,
        previousSha256,
        sha256,
        replacements: replacements as number,
      });
      continue;
    }
    if (details.created === true) {
      if (previousSha256 !== undefined) continue;
      receipts.push({
        receiptVersion: 1,
        entryId: entry.id,
        timestamp: entry.timestamp,
        toolCallId: message.toolCallId,
        operation: "write",
        target,
        stateChanged: true,
        sha256,
        created: true,
      });
      continue;
    }
    if (typeof previousSha256 !== "string" || !SHA256_PATTERN.test(previousSha256)) continue;
    receipts.push({
      receiptVersion: 1,
      entryId: entry.id,
      timestamp: entry.timestamp,
      toolCallId: message.toolCallId,
      operation: "write",
      target,
      stateChanged: true,
      previousSha256,
      sha256,
    });
  }
  if (receipts.length > MAX_STRUCTURED_MUTATION_RECEIPTS) receipts.splice(0, receipts.length - MAX_STRUCTURED_MUTATION_RECEIPTS);
  return receipts;
}
