import type { MutationWriteGuard } from "./core.ts";
import { READ_RESULT_ANNOTATION_PATTERN, SHA256_PATTERN } from "./regex.ts";
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

export interface StructuredMutationReceipt {
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
  const start = Math.max(0, branch.length - MAX_STRUCTURED_MUTATION_RECEIPTS);
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index] as SessionEntryShape;
    if (entry?.type !== "message"
      || typeof entry.id !== "string"
      || typeof entry.timestamp !== "string"
      || !entry.message
      || typeof entry.message !== "object") continue;
    const message = entry.message as ToolResultMessageShape;
    if (message.role !== "toolResult"
      || message.isError === true
      || typeof message.toolCallId !== "string"
      || (message.toolName !== "edit" && message.toolName !== "write")
      || !message.details
      || typeof message.details !== "object") continue;
    const details = message.details as Record<string, unknown>;
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
      || /[\u0000\r\n]/u.test(target)
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
  return receipts;
}

export async function restoreMutationEvidenceFromBranch(
  guard: MutationWriteGuard,
  cwd: string,
  branch: readonly unknown[],
): Promise<void> {
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
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as ToolResultMessageShape;
    if (collectAssistantToolCalls(message, pending)) continue;
    if (message.role !== "toolResult"
      || message.isError === true
      || typeof message.toolCallId !== "string"
      || typeof message.toolName !== "string") continue;
    const call = pending.get(message.toolCallId);
    pending.delete(message.toolCallId);
    if (!call || call.name !== message.toolName) continue;
    try {
      if (message.toolName === "read") {
        await restoreRead(guard, cwd, call, message, message.toolCallId);
      } else if (message.toolName === "edit" || message.toolName === "write") {
        await restoreMutation(guard, cwd, call, message, message.toolCallId);
      }
    } catch {
      // Each restored receipt is independently fail-closed; stale or missing files are skipped.
    }
  }
}
