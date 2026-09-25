import { isAbsolute } from "node:path";
import { mutationRequestHash } from "../resource-lifecycle-guard/permission-contract.ts";
import type { MutationWriteGuard } from "./core.ts";
import { READ_RESULT_ANNOTATION_PATTERN, SHA256_PATTERN, UNSAFE_RECEIPT_PATH_PATTERN } from "./regex.ts";
import { restoreSnapshotReadText } from "./snapshot-line-protocol.ts";

const MAX_RESTORE_ENTRIES = 512;
const MAX_PENDING_TOOL_CALLS = 128;
const RESTORED_TURN_GENERATION = -1;
export const MAX_STRUCTURED_MUTATION_RECEIPTS = 512;

interface StoredToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface SessionEntryShape {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

interface ToolResultMessageShape {
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
}
export type StructuredMutationReceipt = LegacyStructuredMutationReceipt | NativeStructuredMutationReceipt;

function safeReceiptPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !UNSAFE_RECEIPT_PATH_PATTERN.test(value);
}

export function validMutationOutcome(status: unknown, stateChanged: unknown): boolean {
  return status === "state_unknown" ? stateChanged === "unknown"
    : status === "succeeded" || status === "partial" ? stateChanged === true
    : (status === "failed_no_change" || status === "cancelled" || status === "not_started") && stateChanged === false;
}

function appendNativeReceipt(items: Map<string, NativeStructuredMutationReceipt>, entry: any, data: any, toolCallId: unknown, itemId: unknown, intent: boolean): void {
  if (!data || (data.operation !== "delete" && data.operation !== "move" && data.operation !== "write" && data.operation !== "edit") || !safeReceiptPath(data.target)
    || (data.operation === "move" && !safeReceiptPath(data.destination))) return;
  if (typeof toolCallId !== "string" || toolCallId.length > 256 || typeof itemId !== "string" || itemId.length > 280) return;
  const status = intent ? "state_unknown" : data.status;
  const stateChanged = intent ? "unknown" : data.stateChanged;
  if (status !== "state_unknown" && status !== "succeeded" && status !== "partial" && status !== "failed_no_change" && status !== "cancelled" && status !== "not_started") return;
  if ((status === "state_unknown" && stateChanged !== "unknown") || ((status === "succeeded" || status === "partial") && stateChanged !== true)
    || ((status === "failed_no_change" || status === "cancelled" || status === "not_started") && stateChanged !== false)) return;
  const previous = items.get(itemId);
  if (previous && (previous.toolCallId !== toolCallId || previous.operation !== data.operation || previous.target !== data.target || previous.destination !== data.destination)) return;
  items.set(itemId, { receiptVersion: 2, entryId: entry.id, timestamp: entry.timestamp, toolCallId, itemId,
    operation: data.operation, target: data.target, destination: data.destination, status, stateChanged,
    ...(status === "state_unknown" || status === "partial" ? { requiresVerification: true as const } : {}) });
  if (items.size > MAX_STRUCTURED_MUTATION_RECEIPTS) items.delete(items.keys().next().value!);
}

function collectNativeReceipts(branch: readonly unknown[]): Map<string, NativeStructuredMutationReceipt> {
  const items = new Map<string, NativeStructuredMutationReceipt>();
  for (let index = Math.max(0, branch.length - MAX_STRUCTURED_MUTATION_RECEIPTS); index < branch.length; index++) {
    const entry = branch[index] as any;
    if (typeof entry?.id !== "string" || typeof entry.timestamp !== "string") continue;
    if (entry.type === "custom" && entry.customType === "file-mutation-progress-v2") {
      const data = entry.data;
      if (data?.phase === "intent" || data?.mutationReceiptVersion === 2) appendNativeReceipt(items, entry, data, data?.toolCallId, data?.itemId, data?.phase === "intent");
      continue;
    }
    const message = entry.type === "message" && entry.message?.role === "toolResult" ? entry.message : undefined;
    const data = message?.details;
    if (data?.mutationReceiptVersion !== 2 || message?.toolName !== data?.operation) continue;
    if (message.toolName === "file_batch" && data.operation === "file_batch" && !data.preview && Array.isArray(data.items) && data.items.length <= 16) {
      for (let index = 0; index < data.items.length; index++) {
        const item = data.items[index];
        if (item?.itemId === `${message.toolCallId}:${index}`) appendNativeReceipt(items, entry, item, message.toolCallId, item.itemId, false);
      }
    } else appendNativeReceipt(items, entry, data, message.toolCallId, `${message.toolCallId}:0`, false);
  }
  return items;
}

/** Read only the bounded tail through existing indexed entries; never materialize a whole Session branch per result. */
export function recentMutationEntries(session: { getLeafId(): string | null; getEntry(id: string): { parentId: string | null } | undefined }): readonly unknown[] {
  const entries: unknown[] = [];
  let id = session.getLeafId();
  while (id && entries.length < MAX_RESTORE_ENTRIES) {
    const entry = session.getEntry(id);
    if (!entry) break;
    entries.push(entry); id = entry.parentId;
  }
  entries.reverse();
  return entries;
}

/** Pair bounded durable intents with this actual call, never with arbitrary result targets. */
export function boundBatchIntents(branch: readonly unknown[], input: any, toolCallId: string): Map<string, { operation: string; target: string; destination?: string }> {
  const intents = new Map<string, { operation: string; target: string; destination?: string }>();
  if (!Array.isArray(input?.operations) || input.operations.length > 16) return intents;
  const hash = mutationRequestHash("file_batch", input);
  for (let i = Math.max(0, branch.length - MAX_RESTORE_ENTRIES); i < branch.length; i++) {
    const entry = branch[i] as any, data = entry?.data;
    if (entry?.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || data?.toolCallId !== toolCallId) continue;
    if (data.phase === "prepared" && data.requestHash === hash && Array.isArray(data.items) && data.items.length === input.operations.length) {
      for (let n = 0; n < data.items.length; n++) {
        const item = data.items[n];
        if (item?.itemId !== `${toolCallId}:${n}` || item.operation !== input.operations[n]?.operation || !safeReceiptPath(item.target) || !isAbsolute(item.target)
          || (item.operation === "move" && (!safeReceiptPath(item.destination) || !isAbsolute(item.destination)))) continue;
        intents.set(item.itemId, { operation: item.operation, target: item.target, destination: item.destination });
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

export async function recordBatchMutationEvidence(guard: MutationWriteGuard, cwd: string, input: any, details: any, toolCallId: string, generation: number, branch: readonly unknown[] = []): Promise<void> {
  if (!Array.isArray(input?.operations) || !Array.isArray(details?.items) || details.preview || details.items.length > 16 || input.operations.length !== details.items.length) return;
  const intents = boundBatchIntents(branch, input, toolCallId);
  for (let index = 0; index < details.items.length; index++) {
    const item = details.items[index], operation = input.operations[index];
    if (item?.itemId !== `${toolCallId}:${index}` || item.operation !== operation?.operation || typeof operation.path !== "string") continue;
    if (!validMutationOutcome(item.status, item.stateChanged)) continue;
    const receipt = item.receipt;
    if (item.status === "succeeded" && (item.operation === "edit" || item.operation === "write") && typeof receipt?.sha256 === "string" && SHA256_PATTERN.test(receipt.sha256)) {
      try { await guard.recordMutationSnapshot(cwd, operation.path, receipt.sha256, item.itemId, generation); }
      catch { await guard.invalidate(cwd, operation.path); }
    } else if (item.stateChanged !== false) {
      if (item.operation === "delete" || item.operation === "move") {
        const intent = intents.get(item.itemId);
        if (!intent || item.target !== intent.target || item.destination !== intent.destination) continue;
        guard.invalidateCanonicalPath(intent.target);
        if (intent.destination) guard.invalidateCanonicalPath(intent.destination);
      } else await guard.invalidate(cwd, operation.path);
    }
  }
}

function rememberToolCall(pending: Map<string, StoredToolCall>, id: string, call: StoredToolCall): void {
  pending.delete(id);
  pending.set(id, call);
  while (pending.size > MAX_PENDING_TOOL_CALLS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

function collectAssistantToolCalls(message: ToolResultMessageShape, pending: Map<string, StoredToolCall>): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  for (const rawPart of message.content) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (part.type !== "toolCall"
      || typeof part.id !== "string"
      || typeof part.name !== "string"
      || !part.arguments
      || typeof part.arguments !== "object"
      || Array.isArray(part.arguments)) continue;
    rememberToolCall(pending, part.id, { name: part.name, input: part.arguments as Record<string, unknown> });
  }
  return true;
}
export function primaryReadResultText(content: unknown, detailsValue: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const primary = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (primary?.type !== "text" || typeof primary.text !== "string") return undefined;
  const details = detailsValue as { truncation?: { truncated?: unknown } } | undefined;
  if (details?.truncation?.truncated === true) return undefined;
  for (let index = 1; index < content.length; index++) {
    const annotation = content[index] as { type?: unknown; text?: unknown } | undefined;
    if (annotation?.type !== "text"
      || typeof annotation.text !== "string"
      || !READ_RESULT_ANNOTATION_PATTERN.test(annotation.text)) return undefined;
  }
  return restoreSnapshotReadText(primary.text);
}
async function restoreRead(
  guard: MutationWriteGuard,
  cwd: string,
  call: StoredToolCall,
  message: ToolResultMessageShape,
  toolCallId: string,
): Promise<void> {
  const path = call.input.path;
  if (typeof path !== "string") return;
  const text = primaryReadResultText(message.content, message.details);
  if (text === undefined) return;
  const offset = call.input.offset;
  const limit = call.input.limit;
  const startLine = typeof offset === "number" && Number.isFinite(offset)
    ? Math.max(1, Math.floor(offset))
    : 1;
  const endLine = typeof limit === "number" && Number.isFinite(limit)
    ? startLine + Math.max(0, Math.floor(limit)) - 1
    : Number.MAX_SAFE_INTEGER;
  await guard.recordRead(
    cwd,
    path,
    text,
    startLine,
    endLine,
    toolCallId,
    RESTORED_TURN_GENERATION,
    offset === undefined && limit === undefined,
  );
}

async function restoreMutation(
  guard: MutationWriteGuard,
  cwd: string,
  call: StoredToolCall,
  message: ToolResultMessageShape,
  toolCallId: string,
): Promise<void> {
  const path = call.input.path;
  if (typeof path !== "string") return;
  const details = message.details as { sha256?: unknown; ok?: unknown } | undefined;
  if (details?.ok !== true || typeof details.sha256 !== "string") {
    await guard.invalidate(cwd, path);
    return;
  }
  try {
    await guard.recordMutationSnapshot(cwd, path, details.sha256, toolCallId, RESTORED_TURN_GENERATION);
  } catch {
    await guard.invalidate(cwd, path);
  }
}

export function collectStructuredMutationReceipts(branch: readonly unknown[]): StructuredMutationReceipt[] {
  const receipts: StructuredMutationReceipt[] = [];
  const nativeReceipts = collectNativeReceipts(branch);
  const start = Math.max(0, branch.length - MAX_STRUCTURED_MUTATION_RECEIPTS);
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index] as SessionEntryShape;
    const custom = entry as any;
    if (custom?.type === "custom" && custom.customType === "file-mutation-progress-v2") {
      const receipt = nativeReceipts.get(custom.data?.itemId);
      if (receipt && receipt.entryId === custom.id) receipts.push(receipt);
      continue;
    }
    if (entry?.type !== "message"
      || typeof entry.id !== "string"
      || typeof entry.timestamp !== "string"
      || !entry.message
      || typeof entry.message !== "object") continue;
    const message = entry.message as ToolResultMessageShape;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const batch = message.details as any;
      if (message.toolName === "file_batch" && Array.isArray(batch?.items) && batch.items.length <= 16) {
        for (const item of batch.items) { const receipt = nativeReceipts.get(item?.itemId); if (receipt && receipt.entryId === entry.id) receipts.push(receipt); }
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

export async function restoreMutationEvidenceFromBranch(
  guard: MutationWriteGuard,
  cwd: string,
  branch: readonly unknown[],
): Promise<void> {
  const nativeReceipts = collectNativeReceipts(branch);
  const pending = new Map<string, StoredToolCall>();
  const start = Math.max(0, branch.length - MAX_RESTORE_ENTRIES);
  const pairingStart = Math.max(0, start - MAX_PENDING_TOOL_CALLS);
  for (let index = pairingStart; index < start; index++) {
    const entry = branch[index] as SessionEntryShape;
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    collectAssistantToolCalls(entry.message as ToolResultMessageShape, pending);
  }
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index] as SessionEntryShape;
    const custom = entry as any;
    if (custom?.type === "custom" && custom.customType === "file-mutation-progress-v2") {
      const data = custom.data;
      const completion = nativeReceipts.get(data?.itemId ?? `${data?.toolCallId}:0`);
      if (completion?.stateChanged !== false && (data?.phase === "intent" || data?.stateChanged !== false) && safeReceiptPath(data?.target)) {
        guard.invalidateCanonicalPath(data.target);
        if (safeReceiptPath(data.destination)) guard.invalidateCanonicalPath(data.destination);
      }
      continue;
    }
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as ToolResultMessageShape;
    if (collectAssistantToolCalls(message, pending)) continue;
    if (message.role !== "toolResult"
      || (message.isError === true && message.toolName !== "file_batch")
      || typeof message.toolCallId !== "string"
      || typeof message.toolName !== "string") continue;
    const call = pending.get(message.toolCallId);
    pending.delete(message.toolCallId);
    if (!call || call.name !== message.toolName) continue;
    try {
      if (message.toolName === "file_batch") {
        await recordBatchMutationEvidence(guard, cwd, call.input, message.details, message.toolCallId, RESTORED_TURN_GENERATION, branch);
      } else if (message.toolName === "read") {
        await restoreRead(guard, cwd, call, message, message.toolCallId);
      } else if (message.toolName === "edit" || message.toolName === "write") {
        await restoreMutation(guard, cwd, call, message, message.toolCallId);
      }
    } catch {
      // Each restored receipt is independently fail-closed; stale or missing files are skipped.
    }
  }
}
