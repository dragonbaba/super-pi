import { MAX_RESTORE_ENTRIES, safeReceiptPath, validMutationOutcome, collectNativeReceipts, boundBatchIntents, type SessionEntryShape, type ToolResultMessageShape } from "@super-pi/coding-agent/internal/files/change-receipts";
export * from "@super-pi/coding-agent/internal/files/change-receipts";
import { dirname, isAbsolute } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import { resolveToolPath } from "./core.ts";
import type { MutationWriteGuard } from "./core.ts";
import { READ_RESULT_ANNOTATION_PATTERN, SHA256_PATTERN, UNSAFE_RECEIPT_PATH_PATTERN } from "./regex.ts";
import { restoreSnapshotReadText } from "./snapshot-line-protocol.ts";
const MAX_PENDING_TOOL_CALLS = 128;
const RESTORED_TURN_GENERATION = -1;
/** Admitted Codemode read: host binding plus the read's position in the persisted parent result. */
export const CODEMODE_READ_EVIDENCE_ENTRY = "codemode-read-evidence-v1";
const MAX_CODEMODE_READ_BLOCKS = 256;
const CODEMODE_CALL_ENTRY = "codemode-tool-call-v1";
const CODEMODE_RESULT_ENTRY = "codemode-tool-result-v1";
/** Nested mutations restore like native ones; nested reads are restored only through admitted read markers. */
const NESTED_RESTORED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "file_batch"]);
const NO_STORED_INPUT: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;

interface StoredToolCall {
  name: string;
  input: Record<string, unknown>;
}

export async function recordBatchMutationEvidence(guard: MutationWriteGuard, cwd: string, input: any, details: any, toolCallId: string, generation: number, branch: readonly unknown[] = []): Promise<void> {
  if (!Array.isArray(input?.operations) || !Array.isArray(details?.items) || details.preview || details.items.length > 16 || input.operations.length !== details.items.length) return;
  const intents = boundBatchIntents(branch, input, toolCallId);
  for (let index = 0; index < details.items.length; index++) {
    const item = details.items[index], operation = input.operations[index];
    if (item?.itemId !== `${toolCallId}:${index}` || item.operation !== operation?.operation || typeof operation.path !== "string") continue;
    if (!validMutationOutcome(item.status, item.stateChanged)) continue;
    const intent = intents.get(item.itemId);
    if (!intent || item.target !== intent.target || item.destination !== intent.destination) continue;
    const receipt = item.receipt;
    if (item.status === "succeeded" && (item.operation === "edit" || item.operation === "write") && typeof receipt?.sha256 === "string" && SHA256_PATTERN.test(receipt.sha256)) {
      try { await guard.recordMutationSnapshot(cwd, intent.target, receipt.sha256, item.itemId, generation, intent.target); }
      catch { guard.invalidateCanonicalPath(intent.target); }
    } else if (item.stateChanged !== false || item.requiresVerification === true || receipt?.requiresVerification === true || receipt?.commit?.retainedTemporary) {
      guard.invalidateCanonicalPath(intent.target);
      if (intent.destination) guard.invalidateCanonicalPath(intent.destination);
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

function nestedOwnId(data: any, id: unknown): boolean {
  return data?.version === 1 && typeof data.parentToolCallId === "string" && typeof id === "string"
    && id.length <= 256 && id.startsWith(data.parentToolCallId + ":nested:");
}

/** Durable nested Codemode call receipt, paired exactly like a protocol tool call. */
function collectNestedToolCall(entry: any, pending: Map<string, StoredToolCall>): boolean {
  if (entry?.type !== "custom" || entry.customType !== CODEMODE_CALL_ENTRY) return false;
  const call = entry.data?.call;
  if (nestedOwnId(entry.data, call?.id) && call.type === "toolCall" && NESTED_RESTORED_TOOLS.has(call.name)
    && call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)) {
    rememberToolCall(pending, call.id, { name: call.name, input: call.arguments });
  }
  return true;
}

function nestedToolResult(entry: any): ToolResultMessageShape | undefined {
  if (entry?.type !== "custom" || entry.customType !== CODEMODE_RESULT_ENTRY) return undefined;
  const result = entry.data?.result;
  return result?.role === "toolResult" && nestedOwnId(entry.data, result.toolCallId) && NESTED_RESTORED_TOOLS.has(result.toolName)
    ? result : undefined;
}
export function readEvidenceRange(input: { offset?: unknown; limit?: unknown }, details: any, text: string):
  { startLine: number; endLine: number; complete: boolean } | undefined {
  const window = details?.window;
  if (window !== undefined) {
    if (!window || window.binary || !Number.isSafeInteger(window.startLine) || !Number.isSafeInteger(window.nextLine)
      || window.startLine < 1 || window.nextLine < window.startLine || typeof window.done !== "boolean"
      || typeof window.partial !== "boolean" || typeof window.startsPartial !== "boolean"
      || !Number.isSafeInteger(window.startByte) || window.startByte < 0) return undefined;
    const startLine = window.startLine + (window.startsPartial ? 1 : 0);
    const endLine = window.nextLine - (window.partial || !window.done || text.endsWith("\n") ? 1 : 0);
    if (endLine < startLine) return undefined;
    return { startLine, endLine, complete: window.startByte === 0 && window.done && !window.partial && !window.startsPartial };
  }
  const startLine = typeof input.offset === "number" && Number.isFinite(input.offset) ? Math.max(1, Math.floor(input.offset)) : 1;
  const endLine = typeof input.limit === "number" && Number.isFinite(input.limit) ? startLine + Math.max(0, Math.floor(input.limit)) - 1 : Number.MAX_SAFE_INTEGER;
  return { startLine, endLine, complete: input.offset === undefined && input.limit === undefined };
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
  let text = restoreSnapshotReadText(primary.text);
  const window = (detailsValue as any)?.window;
  if (window !== undefined) {
    if (!readEvidenceRange({}, detailsValue, text)) return undefined;
    if (window.startsPartial) {
      const prefix = `[Continuation starts partway through line ${window.startLine}; this is a partial-line suffix.]\n`;
      if (!text.startsWith(prefix)) return undefined;
      text = text.slice(prefix.length);
    }
    if (window.cursor !== undefined) {
      if (typeof window.cursor !== "string" || window.cursor.length > 8192) return undefined;
      const suffix = `\n\n[${window.partial ? `Line ${window.nextLine} is partial` : `Read through line ${window.nextLine - 1}`}; more file content remains. Continue with the same path and cursor=${window.cursor}.]`;
      if (!text.endsWith(suffix)) return undefined;
      text = text.slice(0, -suffix.length);
    }
    if (window.startsPartial) { const end = text.indexOf("\n"); if (end < 0) return undefined; text = text.slice(end + 1); }
    if (window.partial) { const end = text.lastIndexOf("\n"); if (end < 0) return undefined; text = text.slice(0, end + 1); }
  }
  return text;
}
async function legacyReadTarget(cwd: string, path: string): Promise<string | undefined> {
  const lexical = resolveToolPath(cwd, path);
  const target = await realpath(lexical), identity = await stat(target, { bigint: true });
  let probe = lexical, checked = false;
  for (let count = 0; count < 256; count++) {
    const info = await lstat(probe, { bigint: true });
    if (info.isSymbolicLink()) return undefined;
    const parent = dirname(probe);
    if (parent === probe) { checked = true; break; }
    probe = parent;
  }
  if (!checked) return undefined;
  const current = await stat(lexical, { bigint: true });
  return identity.dev === current.dev && identity.ino === current.ino ? target : undefined;
}

async function restoreRead(
  guard: MutationWriteGuard,
  cwd: string,
  call: StoredToolCall,
  message: ToolResultMessageShape,
  toolCallId: string,
): Promise<void> {
  const text = primaryReadResultText(message.content, message.details);
  if (text === undefined) return;
  const binding = (message.details as any)?.mutationReadEvidence;
  let target: string | undefined, offset: unknown, limit: unknown;
  if (binding !== undefined) {
    // The transcript retains raw provider arguments; this paired producer receipt
    // records validated/offset-repaired arguments that actually produced the read.
    if (binding?.version !== 2 || binding.rejected || binding.toolCallId !== toolCallId
      || !safeReceiptPath(binding.path) || !safeReceiptPath(binding.target) || !isAbsolute(binding.target)
      || (binding.offset !== undefined && (typeof binding.offset !== "number" || !Number.isFinite(binding.offset)))
      || (binding.limit !== undefined && (typeof binding.limit !== "number" || !Number.isFinite(binding.limit)))) return;
    target = binding.target; offset = binding.offset; limit = binding.limit;
  } else {
    if (typeof call.input.path !== "string") return;
    target = await legacyReadTarget(cwd, call.input.path);
    offset = call.input.offset; limit = call.input.limit;
  }
  if (!target) return;
  const range = readEvidenceRange({ offset, limit }, message.details, text);
  if (range) await guard.recordRead(cwd, target, text, range.startLine, range.endLine, toolCallId, RESTORED_TURN_GENERATION, range.complete, target);
}

/**
 * Nested reads have no protocol message. The text comes from the parent Codemode result in
 * the same branch at the admitted position; the binding is checked exactly as for a native read.
 */
async function restoreCodemodeRead(
  guard: MutationWriteGuard,
  cwd: string,
  branch: readonly unknown[],
  index: number,
  start: number,
  data: any,
): Promise<void> {
  const parentId = data?.parentToolCallId, toolCallId = data?.toolCallId, first = data?.parentContentIndex, count = data?.blocks;
  if (data?.version !== 1 || typeof parentId !== "string" || parentId.length < 1 || parentId.length > 256
    || typeof toolCallId !== "string" || toolCallId.length > 256 || !toolCallId.startsWith(parentId + ":nested:")
    || !Number.isSafeInteger(first) || first < 1 || !Number.isSafeInteger(count) || count < 1 || count > MAX_CODEMODE_READ_BLOCKS) return;
  for (let position = index - 1; position >= start; position--) {
    const entry = branch[position] as SessionEntryShape;
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as ToolResultMessageShape;
    if (message.role !== "toolResult" || message.toolCallId !== parentId) continue;
    if (message.toolName !== "codemode" || !Array.isArray(message.content) || first + count > message.content.length) return;
    await restoreRead(guard, cwd, { name: "read", input: NO_STORED_INPUT }, { role: "toolResult", toolCallId, toolName: "read",
      content: message.content.slice(first, first + count),
      details: { window: data.window, truncation: data.truncation, mutationReadEvidence: data.binding } }, toolCallId);
    return;
  }
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
    if (collectNestedToolCall(entry, pending)) continue;
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    collectAssistantToolCalls(entry.message as ToolResultMessageShape, pending);
  }
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index] as SessionEntryShape;
    const custom = entry as any;
    if (custom?.type === "custom" && custom.customType === CODEMODE_READ_EVIDENCE_ENTRY) {
      // The parent result may sit just before the retained tail; search the bounded pairing prefix too.
      try { await restoreCodemodeRead(guard, cwd, branch, index, pairingStart, custom.data); }
      catch { /* Fail closed like every restored receipt. */ }
      continue;
    }
    if (custom?.type === "custom" && custom.customType === "file-mutation-progress-v2") {
      const data = custom.data;
      const itemId = data?.itemId ?? (typeof data?.toolCallId === "string" && data.toolCallId.length <= 256 ? `${data.toolCallId}:0` : undefined);
      const completion = typeof itemId === "string" && itemId.length <= 280 ? nativeReceipts.get(itemId) : undefined;
      if ((completion?.stateChanged !== false || completion.requiresVerification === true)
        && (data?.phase === "intent" || data?.stateChanged !== false || completion?.requiresVerification === true) && safeReceiptPath(data?.target)) {
        guard.invalidateCanonicalPath(data.target);
        if (safeReceiptPath(data.destination)) guard.invalidateCanonicalPath(data.destination);
      }
      continue;
    }
    if (collectNestedToolCall(entry, pending)) continue;
    let message = nestedToolResult(entry);
    if (!message) {
      if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
      message = entry.message as ToolResultMessageShape;
      if (collectAssistantToolCalls(message, pending)) continue;
    }
    if (message.role !== "toolResult"
      || (message.isError === true && message.toolName !== "file_batch")
      || typeof message.toolCallId !== "string"
      || message.toolCallId.length < 1 || message.toolCallId.length > 256
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
