import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep, dirname, basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { Key, matchesKey, truncateToWidth, graphemeWidth, type TUI } from "@super-pi/tui";
import { resolveToolPath, MAX_EDIT_REPLACEMENTS, MAX_EDIT_SCOPE_BYTES, MAX_TURN_MUTATION_BYTES } from "./core.ts";
import { capturePathIdentity, sameIdentity, type PathIdentity } from "./native-file-core.ts";
import { boundBatchIntents, collectStructuredMutationReceipts, recentMutationEntries } from "./session-evidence.ts";
import { batchExpandedSummary, verificationSummary, displayMetadata } from "./change-preview.ts";
import { mutationRequestHash } from "../resource-lifecycle-guard/permission-contract.ts";
import { parseSnapshotLineReference } from "./snapshot-line-protocol.ts";
import { SHA256_PATTERN as SHA256, CHANGE_ID_CONTROL_PATTERN, OBSERVATION_UNSIGNED_INTEGER_PATTERN, OBSERVATION_SIGNED_INTEGER_PATTERN, RETAINED_COMMIT_NAME_PATTERN } from "./regex.ts";

export const CHANGE_VERIFICATION_ENTRY = "file-change-verification-v1";
const MAX_CHANGES = 128;
const MAX_VERIFY_BYTES = 32 * 1024 * 1024;
const CHANGE_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const OBSERVATION_SCOPE = "Filesystem observation only; not a semantic/test result, proof of earlier side effects, or permission to replay.";
const MAX_RECOVERY_ARGUMENT_BYTES = 4 * 1024 * 1024;

/** Fixed fields only: no recursive traversal of arbitrary imported objects. */
function takeRecoveryString(budget: { bytes: number }, value: unknown, limit: number): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.length > limit || value.length > budget.bytes) return false;
  const bytes = Buffer.byteLength(value);
  if (bytes > limit || bytes > budget.bytes) return false;
  budget.bytes -= bytes;
  return true;
}

function boundedRecoveryOperation(name: string, input: any, budget: { bytes: number }): boolean {
  if (!input || typeof input !== "object" || typeof input.path !== "string" || !input.path.length
    || !takeRecoveryString(budget, input.path, 4096) || !takeRecoveryString(budget, input.purpose, 800)) return false;
  if (name === "delete" || name === "move") return takeRecoveryString(budget, input.destination, 4096);
  if (name === "write") return typeof input.content === "string" && takeRecoveryString(budget, input.content, MAX_TURN_MUTATION_BYTES);
  if (name !== "edit" || !takeRecoveryString(budget, input.snapshot, 128) || !Array.isArray(input.edits)
    || input.edits.length < 1 || input.edits.length > MAX_EDIT_REPLACEMENTS) return false;
  const before = budget.bytes;
  for (const edit of input.edits) {
    if (!edit || typeof edit !== "object" || !takeRecoveryString(budget, edit.oldText, MAX_EDIT_SCOPE_BYTES)
      || !takeRecoveryString(budget, edit.newText, MAX_EDIT_SCOPE_BYTES) || !takeRecoveryString(budget, edit.kind, 32)
      || !takeRecoveryString(budget, edit.start, MAX_EDIT_SCOPE_BYTES) || !takeRecoveryString(budget, edit.end, MAX_EDIT_SCOPE_BYTES)
      || edit.expectedLine !== undefined && (!Number.isSafeInteger(edit.expectedLine) || edit.expectedLine <= 0)) return false;
    if (edit.newLines !== undefined) {
      if (!Array.isArray(edit.newLines) || edit.newLines.length > MAX_EDIT_SCOPE_BYTES + 1) return false;
      for (const line of edit.newLines) {
        if (--budget.bytes < 0 || typeof line !== "string" || !takeRecoveryString(budget, line, MAX_EDIT_SCOPE_BYTES)) return false;
      }
    }
    if (before - budget.bytes > MAX_EDIT_SCOPE_BYTES) return false;
  }
  return true;
}

function boundedRecoveryArguments(call: any, budget: { bytes: number }): boolean {
  if (call.name !== "file_batch") return boundedRecoveryOperation(call.name, call.arguments, budget);
  const input = call.arguments;
  if (!input || typeof input !== "object" || !takeRecoveryString(budget, input.path, 4096)
    || !takeRecoveryString(budget, input.purpose, 800) || !Array.isArray(input.operations)
    || input.operations.length < 1 || input.operations.length > 16) return false;
  for (const item of input.operations) {
    if (!item || typeof item !== "object" || !takeRecoveryString(budget, item.mode, 32)
      || !boundedRecoveryOperation(item.operation, item, budget)) return false;
  }
  return true;
}

export interface ChangeRecord {
  entryId: string; toolCallId: string; itemId: string; operation: string;
  target: string; destination?: string; status: string; preview: boolean;
  original?: any; item?: any; postimage?: string; sourceIdentity?: { device: string; inode: string };
  receipt?: any;
  reason?: string;
  unavailable?: string;
  batchSize?: number;
  requiresVerification?: true;
}

function terminalOutcome(entry: any, callId: string, itemId: string, index: number): any {
  if (entry.type === "custom" && entry.customType === "file-mutation-progress-v2" && entry.data?.toolCallId === callId
    && entry.data.itemId === itemId && entry.data.phase === "result") return entry.data;
  if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === callId) {
    const data = entry.message.details;
    return entry.message.toolName === "file_batch" ? data?.items?.[index] : data;
  }
}

function hasEarlierTerminal(entries: readonly any[], end: number, callId: string, itemId: string, index: number): boolean {
  for (let n = 0; n < end; n++) if (terminalOutcome(entries[n], callId, itemId, index)) return true;
  return false;
}

/** null means ambiguous; undefined means absent. Neither borrows another request's entry. */
function uniqueProgress(entries: readonly any[], callId: string, phase: string, itemId?: string): any {
  let found: any;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || entry.data?.toolCallId !== callId
      || entry.data.phase !== phase || itemId !== undefined && entry.data.itemId !== itemId) continue;
    if (found) return null;
    found = entry;
  }
  return found;
}

const DIRECTORY_IDENTITY_FIELDS = ["path", "canonical", "device", "inode", "size", "mtime", "ctime", "mode", "links", "directory"] as const;
const COMMIT_RECEIPT_FIELDS = ["strategy", "outcome", "compatibilityReason", "fileSynced", "directorySynced", "retainedTemporary", "cleanupReason"] as const;

function sameCommitReceipt(left: any, right: any): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  for (const field of COMMIT_RECEIPT_FIELDS) {
    const value = left[field];
    if (value !== right[field] || typeof value === "string" && value.length > (field === "retainedTemporary" ? 4096 : 1024)
      || value !== undefined && typeof value !== "string" && typeof value !== "boolean") return false;
  }
  return (left.strategy === "staged_replace" || left.strategy === "protected_in_place")
    && (left.outcome === "not_committed" || left.outcome === "committed" || left.outcome === "unknown")
    && typeof left.fileSynced === "boolean" && left.directorySynced === false;
}

function sameCreatedDirectories(left: any, right: any): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length > 32 || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (!a || !b || typeof a.path !== "string" || a.path.length > 4096 || a.path !== b.path || a.status !== b.status) return false;
    if (a.identity === undefined && b.identity === undefined && a.status === "retained") continue;
    if (!a.identity || !b.identity || typeof a.identity !== "object" || typeof b.identity !== "object") return false;
    for (const field of DIRECTORY_IDENTITY_FIELDS) {
      const value = a.identity[field];
      if (value !== b.identity[field] || (field === "directory" ? typeof value !== "boolean" : typeof value !== "string" || value.length === 0 || value.length > 4096)) return false;
    }
  }
  return true;
}

function samePlannedDirectories(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length > 32 || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const path = left[index];
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || path.includes("\0") || path !== right[index]) return false;
  }
  return true;
}

function conflictingTerminal(entries: readonly any[], selected: any, callId: string, itemId: string, index: number, outcome: any, details: any): boolean {
  let previous = false;
  for (const entry of entries) {
    if (entry.id === selected.id) break;
    const terminal = terminalOutcome(entry, callId, itemId, index);
    if (!terminal) continue;
    // The one normal mirror is a durable custom result followed by the matching
    // aggregate tool result. A later custom terminal cannot borrow an old intent.
    if (previous || entry.type !== "custom" || selected.type !== "message"
      || terminal.status !== outcome.status || terminal.stateChanged !== outcome.stateChanged
      || terminal.operation !== outcome.operation || terminal.target !== outcome.target || terminal.destination !== outcome.destination
      || !sameCommitReceipt(terminal.commit ?? terminal.receipt?.commit, details?.commit)
      || !sameCreatedDirectories(terminal.creation?.createdDirectories ?? terminal.createdDirectories, details?.creation?.createdDirectories ?? details?.createdDirectories)) return true;
    previous = true;
  }
  return false;
}

function uniqueBatchPreparation(entries: readonly any[], call: any) {
  let prepared: any, position = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || entry.data?.toolCallId !== call.id) continue;
    if (entry.data.phase !== "prepared") {
      const item = entry.data.itemId;
      if (typeof item !== "string" || item.length > 280) return undefined;
      const number = Number(item.slice(call.id.length + 1));
      if (!["intent", "commit_prepared", "result"].includes(entry.data.phase) || !Number.isSafeInteger(number) || number < 0
        || number >= (call.arguments?.operations?.length ?? 0) || item !== `${call.id}:${number}`) return undefined;
      continue;
    }
    if (prepared) return undefined; // Even a malformed competing preparation is ambiguous.
    prepared = entry; position = index;
  }
  if (!prepared) return undefined;
  for (let n = 0; n < position; n++) {
    const entry = entries[n];
    if (entry.data?.toolCallId === call.id && entry.data?.itemId !== undefined
      || entry.message?.role === "toolResult" && entry.message.toolCallId === call.id) return undefined;
  }
  const targets = boundBatchIntents([prepared], call.arguments, call.id, call.requestHash);
  if (!Array.isArray(call.arguments?.operations) || targets.size !== call.arguments.operations.length) return undefined;
  return { prepared, position, targets };
}

function laterBatchActivity(entries: readonly any[], callId: string, index: number): boolean {
  for (const entry of entries) {
    const data = entry.data;
    if (data?.toolCallId === callId && data.itemId !== undefined) {
      if (typeof data.itemId !== "string" || data.itemId.length > 280) return true;
      const suffix = data.itemId.slice(callId.length + 1);
      const number = Number(suffix);
      if (!Number.isSafeInteger(number) || number < 0 || data.itemId !== `${callId}:${number}` || number > index) return true;
    }
    const message = entry.message;
    if (message?.role === "toolResult" && message.toolCallId === callId && Array.isArray(message.details?.items)) {
      if (message.details.items.length > 16) return true;
      for (let n = index + 1; n < message.details.items.length; n++) if (message.details.items[n]?.status !== "not_started") return true;
    }
  }
  return false;
}

function boundRecoveryItem(entries: readonly any[], call: any, index: number, status: string) {
  const preparation = uniqueBatchPreparation(entries, call);
  if (!preparation) return undefined;
  const itemId = `${call.id}:${index}`, prepared = preparation.targets.get(itemId);
  if (!prepared) return undefined;
  const intentEntry = uniqueProgress(entries, call.id, "intent", itemId);
  if (intentEntry === null) return undefined;
  if (intentEntry) {
    const intent = intentEntry.data;
    if (hasEarlierTerminal(entries, entries.indexOf(intentEntry), call.id, itemId, index)) return undefined;
    if (intent.requestHash !== preparation.prepared.data.requestHash || intent.operation !== prepared.operation
      || intent.target !== prepared.target || intent.destination !== prepared.destination || status === "not_started") return undefined;
  } else if (!["cancelled", "not_started"].includes(status)) return undefined;
  const commit = uniqueProgress(entries, call.id, "commit_prepared", itemId);
  if (commit === null) return undefined;
  if (commit) {
    const position = entries.indexOf(commit);
    if (!intentEntry || position <= entries.indexOf(intentEntry) || commit.data.operation !== prepared.operation || commit.data.target !== prepared.target
      || !["staged_replace", "protected_in_place"].includes(commit.data.strategy)
      || hasEarlierTerminal(entries, position, call.id, itemId, index)) return undefined;
  }
  // Entered items persist intent before revalidation. Cancellation before item
  // entry and remaining not-started items have preparation but no intent.
  if (status !== "succeeded" && laterBatchActivity(entries, call.id, index)) return undefined;
  return prepared;
}

function sameLegacyWriteMirror(selected: any, entry: any): boolean {
  const source = selected?.data, message = entry.message, data = message?.details;
  return selected?.type === "custom" && source?.phase === "result" && source.status === "succeeded" && source.stateChanged === true
    && source.operation === "write"
    && message.toolName === "write" && message.isError !== true && data?.mutationReceiptVersion === 1 && data.ok === true
    && data.category === "success" && data.operation === "write" && data.stateChanged === true && data.created === source.created
    && data.target === source.target && typeof data.sha256 === "string" && SHA256.test(data.sha256) && data.sha256 === source.sha256
    && (source.created === true && source.commit === undefined && data.commit === undefined
      || source.created === undefined && typeof source.previousSha256 === "string" && SHA256.test(source.previousSha256)
      && source.previousSha256 === data.previousSha256 && source.commit?.outcome === "committed" && sameCommitReceipt(source.commit, data.commit))
    && data.creation?.bytes === source.creation?.bytes && data.creation?.addedLines === source.creation?.addedLines
    && sameCreatedDirectories(data.creation?.createdDirectories, source.creation?.createdDirectories);
}

function hasLaterMutationActivity(branch: readonly any[], start: number, callId: string, itemId: string, selected: any, batch: boolean): boolean {
  let legacyMirror = false;
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === callId) {
      // The existing write producer emits one v2 durable result plus one v1
      // aggregate. Its exact successful mirror includes commit metadata on N2.
      if (legacyMirror || !sameLegacyWriteMirror(selected, entry)) return true;
      legacyMirror = true;
    }
    if (entry.type === "custom" && entry.customType === "file-mutation-progress-v2" && entry.data?.toolCallId === callId) {
      // Intent-only recovery may have the one subsequently validated commit
      // preparation. This is not a terminal and never enables an automatic retry.
      if (batch && selected.data?.phase === "intent" && entry.data.phase === "commit_prepared" && entry.data.itemId === itemId) continue;
      if (!batch || entry.data.phase !== "intent" && entry.data.phase !== "commit_prepared" && entry.data.phase !== "result" || entry.data.itemId === itemId) return true;
    }
  }
  return false;
}

/** Inspect the complete standalone prefix, including progress before its selected intent. */
function validStandalonePrefix(entries: readonly any[], selected: any, call: any, target: string, destination?: string): boolean {
  let phase = 0;
  const requestHash = call.requestHash;
  for (const entry of entries) {
    if (entry === selected && entry.data?.phase !== "intent") return true;
    if (entry.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || entry.data?.toolCallId !== call.id) continue;
    const data = entry.data;
    if (data.itemId !== `${call.id}:0` || data.operation !== call.name || data.target !== target || data.destination !== destination) return false;
    if (data.phase === "origin") {
      if (phase !== 0 || call.name !== "write" && call.name !== "edit" || data.requestHash !== requestHash) return false;
      phase = 1;
    } else if (data.phase === "intent") {
      if (phase > 1 || (call.name === "write" || call.name === "edit") && phase !== 1 || data.requestHash !== requestHash) return false;
      if ((call.name === "edit" || data.strategy !== undefined) && data.strategy !== "staged_replace" && data.strategy !== "protected_in_place") return false;
      phase = 2;
    } else if (data.phase === "result") {
      if (phase < 1 || phase > 2) return false;
      phase = 3;
    } else return false;
    if (entry === selected) return true;
  }
  return false;
}

/** Reconstruct from bounded Session entries. No disk observation, replay or second history store. */
export function collectChanges(branch: readonly any[], cwd: string): ChangeRecord[] {
  branch = branch.slice(-512);
  const calls = new Map<string, any>();
  const argumentBudget = { bytes: MAX_RECOVERY_ARGUMENT_BYTES };
  const callOrder = new Map<string, number>();
  const duplicate = new Set<string>();
  const entries = new Map<string, any>();
  const duplicateEntries = new Set<string>();
  const records: ChangeRecord[] = [];
  const order = new Map<string, number>();
  let scannedBlocks = 0, callsOverflow = false;
  // Spend bounded recovery work on the newest requests first. Old large calls
  // cannot make the latest receipt unavailable merely by exhausting the budget.
  for (let position = branch.length - 1; position >= 0; position--) {
    const entry = branch[position];
    if (entries.has(entry.id)) duplicateEntries.add(entry.id);
    entries.set(entry.id, entry);
    order.set(entry.id, position);
    if (callsOverflow || entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    scannedBlocks += entry.message.content.length;
    if (entry.message.content.length > 128 || scannedBlocks > 4096) {
      callsOverflow = true; calls.clear(); callOrder.clear(); duplicate.clear(); continue;
    }
    for (let callIndex = entry.message.content.length - 1; callIndex >= 0; callIndex--) {
      if (calls.size >= 512) { callsOverflow = true; calls.clear(); callOrder.clear(); duplicate.clear(); break; }
      const call = entry.message.content[callIndex];
      if (call?.type !== "toolCall" || typeof call.id !== "string" || call.id.length > 256) continue;
      if (calls.has(call.id)) duplicate.add(call.id);
      const bounded = boundedRecoveryArguments(call, argumentBudget);
      calls.set(call.id, { id: call.id, name: call.name, arguments: bounded ? call.arguments : undefined,
        requestHash: bounded ? mutationRequestHash(call.name, call.arguments) : undefined });
      callOrder.set(call.id, order.get(entry.id)!);
    }
  }
  for (const receipt of collectStructuredMutationReceipts(branch)) {
    if (typeof receipt.toolCallId !== "string" || receipt.toolCallId.length < 1 || receipt.toolCallId.length > 256) continue;
    const receiptOrder = order.get(receipt.entryId)!;
    const precedingCall = (callOrder.get(receipt.toolCallId) ?? Infinity) < receiptOrder;
    const call = duplicateEntries.size || duplicate.has(receipt.toolCallId) || !precedingCall ? undefined : calls.get(receipt.toolCallId);
    const entry = entries.get(receipt.entryId);
    const index = receipt.receiptVersion === 2 ? Number(receipt.itemId.slice(receipt.toolCallId.length + 1)) : 0;
    const exactItemId = receipt.receiptVersion !== 2 || receipt.itemId === `${receipt.toolCallId}:${index}`;
    const input = call?.name === "file_batch" ? call.arguments?.operations?.[index] : call?.arguments;
    const item = entry?.message?.toolName === "file_batch" ? entry.message.details?.items?.[index] : undefined;
    const details = item?.receipt ?? entry?.message?.details ?? entry?.data;
    const historicalTarget = isAbsolute(receipt.target);
    const target = historicalTarget ? resolve(receipt.target) : receipt.target;
    const destination = receipt.receiptVersion === 2 && receipt.destination ? resolve(cwd, receipt.destination) : undefined;
    let bound = false;
    const executionEntries = call ? branch.slice(callOrder.get(call.id)! + 1) : [];
    if (exactItemId && historicalTarget && call?.name === "file_batch" && input?.operation === receipt.operation) {
      const intent = boundRecoveryItem(executionEntries, call, index, receipt.receiptVersion === 2 ? receipt.status : "succeeded");
      bound = intent?.target === receipt.target && intent?.destination === destination;
    } else if (exactItemId && historicalTarget && call?.name === receipt.operation && typeof input?.path === "string") {
      if (receipt.receiptVersion === 2) {
        // The ordered standalone intent records the authorized canonical target.
        // Reopening/forking with another cwd must not reinterpret old arguments.
        const intentEntry = uniqueProgress(executionEntries, call.id, "intent", receipt.itemId);
        // Existing-file v1 success producers already persist a request-hashed
        // origin before issuing I/O; it also binds their v2 partial outcome.
        const intent = intentEntry === undefined ? uniqueProgress(executionEntries, call.id, "origin", receipt.itemId) : intentEntry;
        bound = index === 0 && intent?.data.operation === receipt.operation && intent?.data.target === receipt.target
          && intent?.data.requestHash === call.requestHash
          && intent?.data.destination === receipt.destination && (!receipt.destination || isAbsolute(receipt.destination))
          && (intent !== entry || entry?.data?.phase === "intent");
        if (bound && hasEarlierTerminal(executionEntries, executionEntries.indexOf(intent), call.id, receipt.itemId, 0)) bound = false;
      } else {
        const origin = uniqueProgress(executionEntries, call.id, "origin");
        if (origin !== undefined) {
          bound = origin !== null && origin.data.itemId === `${call.id}:0` && origin.data.target === target && origin.data.operation === receipt.operation
            && origin.data.requestHash === call.requestHash
            && origin !== entry
            && !hasEarlierTerminal(executionEntries, executionEntries.indexOf(origin), call.id, `${call.id}:0`, 0);
        } else bound = resolveToolPath(cwd, input.path) === target;
      }
    }
    if (bound && receipt.receiptVersion === 2 && call?.name !== "file_batch") {
      const origin = uniqueProgress(executionEntries, call.id, "origin");
      if (origin !== undefined) bound = origin !== null && origin.data.itemId === receipt.itemId && origin.data.target === target
        && origin.data.operation === receipt.operation && origin.data.requestHash === mutationRequestHash(call.name, input)
        && !hasEarlierTerminal(executionEntries, executionEntries.indexOf(origin), call.id, receipt.itemId, 0);
    }
    if (bound && call.name !== "file_batch" && !validStandalonePrefix(executionEntries, entry, call, receipt.target, receipt.receiptVersion === 2 ? receipt.destination : undefined)) bound = false;
    if (bound && receipt.receiptVersion === 2 && conflictingTerminal(executionEntries, entry, receipt.toolCallId, receipt.itemId, index, receipt, details)) bound = false;
    if (bound && entry?.data?.phase === "intent" && receipt.operation === "write") {
      const prepared = call?.name === "file_batch" ? uniqueBatchPreparation(executionEntries, call)?.targets.get(`${call.id}:${index}`)
        : uniqueProgress(executionEntries, call.id, "origin")?.data;
      // An interrupted create has no completed directory receipt. Its intent
      // list must match the earlier bound plan; missing old metadata is not [] .
      bound = samePlannedDirectories(prepared?.directories, entry.data.directories);
    }
    if (receipt.receiptVersion === 2 && receipt.historyConflict) bound = false;
    if (bound && hasLaterMutationActivity(branch, receiptOrder + 1, receipt.toolCallId, receipt.receiptVersion === 2 ? receipt.itemId : `${receipt.toolCallId}:0`, entry, call.name === "file_batch")) bound = false;
    records.push({ entryId: receipt.entryId, toolCallId: receipt.toolCallId, itemId: receipt.receiptVersion === 2 ? receipt.itemId : `${receipt.toolCallId}:0`,
      operation: receipt.operation, target, destination,
      status: receipt.receiptVersion === 1 ? "succeeded" : receipt.status, preview: false,
      original: bound ? input : undefined, item: bound ? item : undefined,
      receipt: details,
      requiresVerification: receipt.receiptVersion === 2 ? receipt.requiresVerification : undefined,
      reason: typeof (item?.reason ?? details?.cause ?? details?.reason) === "string" ? (item?.reason ?? details.cause ?? details.reason).slice(0, 800) : undefined,
      batchSize: call?.name === "file_batch" ? call.arguments?.operations?.length : undefined,
      postimage: bound && typeof details?.sha256 === "string" && SHA256.test(details.sha256) ? details.sha256 : undefined,
      sourceIdentity: bound ? details?.sourceIdentity : undefined,
      unavailable: bound ? undefined : callsOverflow ? "Assistant content exceeds bounded history inspection limits; unable to reconstruct safely."
        : !historicalTarget ? "Originating cwd is missing for this relative legacy receipt; unable to reconstruct its target safely."
        : "Original request or ordered matching preparation is missing/ambiguous in the bounded history; unable to reconstruct." });
    if (records.length > MAX_CHANGES) records.shift();
  }
  // A persisted, request-bound preparation precedes every per-item intent.
  // After interruption, items with no later intent/outcome are safely unstarted.
  for (let n = 0; n < branch.length; n++) {
    const entry = branch[n], data = entry.data, call = calls.get(data?.toolCallId);
    if (entry.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || data?.phase !== "prepared"
      || !call || duplicateEntries.size || duplicate.has(call.id) || call.name !== "file_batch" || (callOrder.get(call.id) ?? Infinity) >= n) continue;
    const executionEntries = branch.slice(callOrder.get(call.id)! + 1);
    const preparation = uniqueBatchPreparation(executionEntries, call);
    if (!preparation || preparation.prepared !== entry) continue;
    const intents = preparation.targets;
    for (let index = 0; index < (call.arguments?.operations?.length ?? 0) && index < 16; index++) {
      const itemId = `${call.id}:${index}`, intent = intents.get(itemId);
      if (!intent) continue;
      let hasRecord = false;
      for (const record of records) if (record.itemId === itemId) { hasRecord = true; break; }
      if (hasRecord) continue;
      if (laterBatchActivity(executionEntries, call.id, index)) continue;
      // Any later item activity, even malformed, prevents a no-start claim.
      let hasActivity = false;
      for (let laterIndex = n + 1; laterIndex < branch.length; laterIndex++) {
        const later = branch[laterIndex];
        if (later.data?.toolCallId === call.id && (later.data?.itemId === itemId || later.data?.phase === "prepared")
          || later.message?.role === "toolResult" && later.message.toolCallId === call.id) { hasActivity = true; break; }
      }
      if (hasActivity) continue;
      records.push({ entryId: entry.id, toolCallId: call.id, itemId, operation: intent.operation, target: intent.target,
        destination: intent.destination, status: "not_started", preview: false, original: call.arguments.operations[index], batchSize: call.arguments.operations.length });
      if (records.length > MAX_CHANGES) records.shift();
    }
  }
  const previews: ChangeRecord[] = [];
  // Previews deliberately have no durable mutation receipt. They are view-only.
  for (const entry of branch) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (typeof message?.toolCallId !== "string" || message.toolCallId.length < 1 || message.toolCallId.length > 256) continue;
    const call = message && !duplicate.has(message.toolCallId) && (callOrder.get(message.toolCallId) ?? Infinity) < order.get(entry.id)!
      ? calls.get(message.toolCallId) : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "file_batch" || call?.name !== "file_batch"
      || call.arguments?.dryRun !== true || message.details?.preview !== true || !Array.isArray(message.details.items) || message.details.items.length > 16) continue;
    for (let index = 0; index < message.details.items.length; index++) {
      const item = message.details.items[index];
      if (item?.itemId !== `${call.id}:${index}` || (item.status !== "preview" && item.status !== "failed_no_change" && item.status !== "cancelled" && item.status !== "not_started") || item.stateChanged !== false || item.receipt !== undefined
        || typeof item.target !== "string" || item.target.length > 4096 || item.operation !== call.arguments.operations?.[index]?.operation) continue;
      previews.push({ entryId: entry.id, toolCallId: call.id, itemId: item.itemId, operation: item.operation,
        target: item.target, destination: item.destination, status: item.status, preview: true, item });
      if (previews.length > MAX_CHANGES) previews.shift();
    }
  }
  const combined = records.concat(previews);
  // At most 256 entries, only on explicit /changes. Stable insertion keeps the
  // map call-owned without a captured comparator, wrapper records or global state.
  for (let n = 1; n < combined.length; n++) {
    const value = combined[n], position = order.get(value.entryId) ?? -1;
    let at = n;
    while (at > 0 && (order.get(combined[at - 1].entryId) ?? -1) > position) { combined[at] = combined[at - 1]; at--; }
    combined[at] = value;
  }
  return combined.slice(-MAX_CHANGES);
}

export interface ChangeObservation { path: string; exists: boolean; identity?: PathIdentity; sha256?: string; hashOmitted?: string }

function retainedTemporary(record: ChangeRecord): string | undefined {
  const path = record.receipt?.commit?.retainedTemporary;
  if (path === undefined) return undefined;
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || dirname(path) !== dirname(record.target)
    || !RETAINED_COMMIT_NAME_PATTERN.test(basename(path))) throw new Error("Retained candidate path cannot be safely reconstructed.");
  return path;
}

function retainedParents(record: ChangeRecord): string[] {
  const directories = record.receipt?.creation?.createdDirectories ?? record.receipt?.createdDirectories
    ?? (record.receipt?.phase === "intent" ? record.receipt.directories : undefined);
  if (directories === undefined) return [];
  if (!Array.isArray(directories) || directories.length > 32) throw new Error("Recorded parent side effects exceed verification bounds.");
  const paths: string[] = [];
  for (const directory of directories) {
    const path = typeof directory === "string" ? directory : directory?.identity?.canonical ?? directory?.path;
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path)) throw new Error("Recorded parent side effect cannot be reconstructed.");
    const tail = relative(path, record.target);
    if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error("Recorded side effect is not a parent of the bound target.");
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

async function observe(path: string, hash: boolean, assertAllowed: (() => Promise<void>) & { assertCurrent?: () => void }): Promise<ChangeObservation> {
  await assertAllowed();
  let identity: PathIdentity;
  try { identity = await capturePathIdentity(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await assertAllowed();
    // An ENOENT from a dangling link must not be reported as absence.
    try { await lstat(path); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false }; throw missing; }
    throw new Error("Path exists but its object cannot be safely observed.");
  }
  if (identity.canonical !== path) throw new Error("Recorded canonical target now resolves elsewhere.");
  const observation: ChangeObservation = { path, exists: true, identity };
  if (!hash || identity.directory) return observation;
  if (Number(identity.size) > MAX_VERIFY_BYTES) return { ...observation, hashOmitted: "Content exceeds the 32 MiB verification bound." };
  await assertAllowed();
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (String(opened.dev) !== identity.device || String(opened.ino) !== identity.inode || opened.nlink.toString() !== identity.links) throw new Error("Object changed before verification read.");
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      if (assertAllowed.assertCurrent) assertAllowed.assertCurrent();
      else await assertAllowed();
      const read = await handle.read(buffer, 0, Math.min(buffer.length, MAX_VERIFY_BYTES + 1 - bytes), null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > MAX_VERIFY_BYTES) throw new Error("File grew beyond verification bound.");
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    await assertAllowed();
    if (!sameIdentity(identity, await capturePathIdentity(path))) throw new Error("Object changed during verification.");
    observation.sha256 = digest.digest("hex");
  } finally { await handle.close(); }
  return observation;
}

export async function verifyChange(record: ChangeRecord, assertAllowed: (() => Promise<void>) & { assertCurrent?: () => void }) {
  if (record.preview || record.unavailable || !record.original) throw new Error("This record cannot authorize verification; no change was replayed.");
  const source = await observe(record.target, Boolean(record.postimage), assertAllowed);
  const destination = record.destination ? await observe(record.destination, false, assertAllowed) : undefined;
  const retained = retainedTemporary(record);
  const temporary = retained ? await observe(retained, true, assertAllowed) : undefined;
  const parents: ChangeObservation[] = [];
  for (const path of retainedParents(record)) parents.push(await observe(path, false, assertAllowed));
  await assertAllowed();
  // A second path (or a permission await) can change the first observation.
  // Recheck all identities, including metadata-only and oversized files.
  for (const observation of [source, ...(destination ? [destination] : []), ...(temporary ? [temporary] : []), ...parents]) {
    if (observation.identity) {
      if (!sameIdentity(observation.identity, await capturePathIdentity(observation.path))) throw new Error("Object changed before observation was accepted.");
    } else {
      try { await lstat(observation.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new Error("Path appeared before absence observation was accepted.");
    }
  }
  // Scope includes workspace inode/realpath checks, not only Session generation.
  await assertAllowed();
  assertAllowed.assertCurrent?.();
  return { source, destination, temporary, parents,
    postimageMatches: record.postimage && source.sha256 ? record.postimage === source.sha256 : undefined,
    destinationIdentityMatches: record.sourceIdentity && destination?.identity
      ? record.sourceIdentity.device === destination.identity.device && record.sourceIdentity.inode === destination.identity.inode : undefined,
    scope: OBSERVATION_SCOPE };
}

function boundedString(value: unknown, label: string, max = 8192): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} is missing or exceeds the draft bound; supply a fresh request.`);
  return value;
}

function draftOperation(record: ChangeRecord): unknown {
  const input = record.original;
  const path = boundedString(record.target, "Recorded target", 4096);
  if (!isAbsolute(path)) throw new Error("Draft needs a recorded absolute target; originating cwd cannot be guessed.");
  if (record.operation === "write") return { operation: "write", path,
    mode: record.batchSize === undefined ? record.receipt?.commit ? "overwrite" : "create" : input.mode,
    content: boundedString(input.content, "Content") };
  if (record.operation === "delete") return { operation: "delete", path };
  if (record.operation === "move") return { operation: "move", path, destination: boundedString(record.destination, "Recorded destination", 4096) };
  if (!Array.isArray(input.edits) || input.edits.length > 20) throw new Error("Original edit parameters cannot be reconstructed.");
  const changes = [];
  for (const edit of input.edits) {
    if (input.snapshot) {
      if (edit.newLines !== undefined && (!Array.isArray(edit.newLines) || edit.newLines.length > 200)) throw new Error("Snapshot replacement exceeds draft bound.");
      const newLines: string[] | undefined = edit.newLines === undefined ? undefined : [];
      if (newLines) for (const line of edit.newLines) newLines.push(boundedString(line, "Replacement line", 2048));
      // Stale snapshot IDs and LINE#ID anchors are never serialized into a new draft.
      changes.push({ kind: edit.kind, originalLineHint: parseSnapshotLineReference(edit.start, "start").line,
        originalEndLineHint: edit.end ? parseSnapshotLineReference(edit.end, "end").line : undefined, newLines });
    } else {
      if (edit.expectedLine !== undefined && (!Number.isSafeInteger(edit.expectedLine) || edit.expectedLine < 1)) throw new Error("Original exact-edit location hint is invalid.");
      changes.push({ oldText: boundedString(edit.oldText, "Old text"), newText: boundedString(edit.newText, "New text"), originalLineHint: edit.expectedLine });
    }
  }
  return { operation: "edit", path, desiredChanges: changes };
}

export function remainingDraft(records: readonly ChangeRecord[], verifiedItems: ReadonlySet<string>): string {
  if (records.length > 16) throw new Error("Batch history is incomplete in the bounded window; unable to reconstruct remaining work.");
  for (const record of records) {
    if (record.batchSize !== undefined && record.batchSize !== records.length) throw new Error("Batch history is incomplete in the bounded window; unable to reconstruct remaining work.");
    if (!record.preview && (record.unavailable || !record.original)) throw new Error("Original request or matching preparation is missing/ambiguous; unable to reconstruct remaining work.");
  }
  const parts: string[] = [];
  let bytes = 0;
  for (const record of records) {
    if (record.preview || record.status === "succeeded") continue;
    if (record.status === "partial" || record.status === "state_unknown" || record.requiresVerification) {
      if (!verifiedItems.has(record.itemId)) throw new Error(`${record.itemId}: verify partial/unknown state before preparing remaining work.`);
      continue; // Observation never turns an uncertain old mutation into an automatic retry.
    }
    if (record.status !== "failed_no_change" && record.status !== "not_started") continue;
    if (!record.original || record.unavailable) throw new Error(record.unavailable ?? "Original parameters are unavailable; supply a fresh request.");
    const text = JSON.stringify(draftOperation(record), null, 2);
    bytes += Buffer.byteLength(text);
    if (bytes > 48 * 1024) throw new Error("Remaining request exceeds the draft bound; select a smaller set or supply a fresh request.");
    parts.push(text);
  }
  if (!parts.length) throw new Error("No confirmed unstarted/no-change items to draft. Successful and uncertain items are excluded.");
  const id = boundedString(records[0]?.toolCallId, "Source batch identifier", 256);
  if (CHANGE_ID_CONTROL_PATTERN.test(id)) throw new Error("Source batch identifier contains control characters; supply a fresh request.");
  const draft = `Prepare a NEW request for the following remaining desired changes. Read current targets first and use fresh evidence, snapshots and anchors; original line hints are not evidence. Revalidate paths and request current authorization. Never replay the old batch or repeat successful items. Partial/unknown items are excluded and need separate examination.\n\nSource batch: ${JSON.stringify(id)} (reference only, no authority).\n\n${parts.join("\n\n")}\n`;
  if (Buffer.byteLength(draft) > 48 * 1024) throw new Error("Complete remaining request exceeds the 48 KiB draft bound; supply a smaller request.");
  return draft;
}

function validObservation(value: any, path: string): boolean {
  if (!value || value.path !== path || typeof value.exists !== "boolean") return false;
  if (!value.exists) return value.identity === undefined && value.sha256 === undefined && value.hashOmitted === undefined;
  const identity = value.identity;
  if (!identity || identity.path !== path || identity.canonical !== path || typeof identity.directory !== "boolean") return false;
  for (const key of ["device", "inode", "size", "mode", "links"]) if (typeof identity[key] !== "string" || !OBSERVATION_UNSIGNED_INTEGER_PATTERN.test(identity[key])) return false;
  for (const key of ["mtime", "ctime"]) if (typeof identity[key] !== "string" || !OBSERVATION_SIGNED_INTEGER_PATTERN.test(identity[key])) return false;
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !SHA256.test(value.sha256))) return false;
  if (value.hashOmitted !== undefined && (typeof value.hashOmitted !== "string" || !value.hashOmitted || value.hashOmitted.length > 256 || Number(identity.size) <= MAX_VERIFY_BYTES)) return false;
  return !(value.sha256 && value.hashOmitted);
}

/** Accept only complete, ordered observations of this exact bounded receipt. */
export function collectVerifiedChanges(branch: readonly any[], records: readonly ChangeRecord[], sessionId: string): Set<string> {
  const verified = new Set<string>(), positions = new Map<string, number>(), duplicates = new Set<string>();
  for (let n = 0; n < branch.length; n++) { if (positions.has(branch[n].id)) duplicates.add(branch[n].id); positions.set(branch[n].id, n); }
  for (let n = 0; n < branch.length; n++) {
    const entry = branch[n], data = entry?.data;
    if (entry.type !== "custom" || entry.customType !== CHANGE_VERIFICATION_ENTRY || data?.version !== 1 || data.sessionId !== sessionId
      || duplicates.has(entry.id) || data.scope !== OBSERVATION_SCOPE || typeof data.observedAt !== "string" || data.observedAt.length > 40 || !Number.isFinite(Date.parse(data.observedAt))) continue;
    for (const record of records) {
      if (record.unavailable || record.preview || data.itemId !== record.itemId || data.toolCallId !== record.toolCallId || data.sourceEntryId !== record.entryId
        || duplicates.has(record.entryId) || (positions.get(record.entryId) ?? Infinity) >= n || !validObservation(data.source, record.target)
        || (record.destination ? !validObservation(data.destination, record.destination) : data.destination !== undefined)) continue;
      let parents: string[];
      try { parents = retainedParents(record); } catch { continue; }
      let temporary: string | undefined;
      try { temporary = retainedTemporary(record); } catch { continue; }
      if (temporary ? !validObservation(data.temporary, temporary) || data.temporary.exists && !data.temporary.identity.directory && !data.temporary.sha256 && !data.temporary.hashOmitted : data.temporary !== undefined) continue;
      if (!Array.isArray(data.parents) || data.parents.length !== parents.length) continue;
      let parentsValid = true;
      for (let i = 0; i < parents.length; i++) if (!validObservation(data.parents[i], parents[i])) { parentsValid = false; break; }
      if (!parentsValid) continue;
      if (record.postimage && data.source.exists && !data.source.identity.directory && !data.source.sha256 && !data.source.hashOmitted) continue;
      const postimageMatches = record.postimage && data.source.sha256 ? record.postimage === data.source.sha256 : undefined;
      const destinationMatches = record.sourceIdentity && data.destination?.identity
        ? record.sourceIdentity.device === data.destination.identity.device && record.sourceIdentity.inode === data.destination.identity.inode : undefined;
      if (data.postimageMatches !== postimageMatches || data.destinationIdentityMatches !== destinationMatches) continue;
      verified.add(record.itemId);
    }
  }
  return verified;
}

export class ChangeViewer {
  private body: string;
  private positions?: Uint32Array;
  private widths?: Int32Array;
  private count = 0;
  private offset = 0;
  private cached?: string[];
  private cachedWidth = -1;
  private cachedHeight = -1;
  private cachedOffset = -1;
  private rowsMaterialized = 0;
  private graphemesVisited = 0;
  private tui?: TUI;
  private done?: (value: void) => void;
  constructor(body: string, tui: TUI, done: (value: void) => void) {
    this.body = body.slice(0, 65536).replaceAll("\t", "   ").slice(0, 65536); this.tui = tui; this.done = done;
    // Cold dialog preparation: at most 524,296 bytes of numeric scroll metadata.
    // No wrapped lines or grapheme strings survive this loop.
    this.positions = new Uint32Array(this.body.length + 1); this.widths = new Int32Array(this.body.length + 1);
    for (const part of CHANGE_GRAPHEMES.segment(this.body)) {
      this.positions[this.count] = part.index;
      this.widths[this.count++] = part.segment.includes("\n") || part.segment === "\r" ? -1 : graphemeWidth(part.segment);
    }
    this.positions[this.count] = this.body.length;
  }
  private nextRow(start: number, width: number): number {
    let end = start, columns = 0;
    while (end < this.count) {
      const size = this.widths![end]; this.graphemesVisited++;
      if (size === -1) return end + 1;
      if (columns + size > width && end > start) break;
      columns += size; end++;
    }
    return end;
  }
  private previousRow(start: number, width: number): number {
    if (!start) return 0;
    let cursor = start - 1;
    while (cursor > 0 && this.widths![cursor - 1] !== -1) cursor--;
    let previous = cursor;
    while (cursor < start) { previous = cursor; cursor = this.nextRow(cursor, width); }
    return previous;
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.min(1000, (this.tui?.terminal.rows ?? 24) - 2));
    if (this.cached && this.cachedWidth === width && this.cachedHeight === height && this.cachedOffset === this.offset) return this.cached;
    const output = [];
    let cursor = this.offset;
    while (cursor < this.count && output.length < height) {
      const next = this.nextRow(cursor, width), end = this.widths![next - 1] === -1 ? next - 1 : next;
      output.push(truncateToWidth(this.body.substring(this.positions![cursor], this.positions![end]), width, ""));
      this.rowsMaterialized++; cursor = next;
    }
    output.push(width >= 21 ? "↑↓ scroll · Esc close" : width >= 9 ? "Esc close" : width >= 3 ? "Esc" : "");
    this.cached = output; this.cachedWidth = width; this.cachedHeight = height; this.cachedOffset = this.offset;
    return output;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { const done = this.done; this.dispose(); done?.(); return; }
    const width = Math.max(1, this.cachedWidth);
    let steps = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) ? 10 : 1;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) while (steps-- > 0) this.offset = this.previousRow(this.offset, width);
    if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) while (steps-- > 0) {
      const next = this.nextRow(this.offset, width); if (next >= this.count) break; this.offset = next;
    }
    this.tui?.requestRender();
  }
  invalidate(): void { this.cached = undefined; }
  dispose(): void { this.body = ""; this.positions = undefined; this.widths = undefined; this.cached = undefined; this.count = 0; this.offset = 0; this.tui = undefined; this.done = undefined; }
  getDiagnostics() { return { bodyCodeUnits: this.body.length, scrollBytes: (this.positions?.byteLength ?? 0) + (this.widths?.byteLength ?? 0), cachedRows: this.cached?.length ?? 0,
    rowsMaterialized: this.rowsMaterialized, graphemesVisited: this.graphemesVisited, lifecycleReferences: Number(Boolean(this.tui)) + Number(Boolean(this.done)) }; }
}

interface ObservationPermissions { authorizeFileObservation(ctx: ExtensionContext, paths: readonly string[]): Promise<(() => Promise<void>) & { assertCurrent(): void }> }

function assertChangesSession(ctx: ExtensionContext, sessionId: string): void {
  if (sessionId !== ctx.sessionManager.getSessionId() || !ctx.isIdle()) throw new Error("Session changed or became busy; reopen /changes.");
}

/** One factory for an explicit dialog lifetime; no callbacks are created by its render/input methods. */
async function showChangeViewer(ctx: ExtensionContext, text: string): Promise<void> {
  await ctx.ui.custom<void>(function createChangeViewer(tui, _theme, _keys, done) { return new ChangeViewer(text, tui, done); });
}

export function registerChanges(pi: ExtensionAPI, permissions: ObservationPermissions): void {
  pi.registerCommand("changes", { description: "View Session file changes, verify current state, or draft remaining work", async handler(_args, ctx) {
    if (!ctx.hasUI || !ctx.isIdle()) { ctx.ui.notify("/changes needs an idle Session with dialog UI.", "warning"); return; }
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const branch = recentMutationEntries(ctx.sessionManager);
      const records = collectChanges(branch, ctx.cwd);
      if (!records.length) { ctx.ui.notify("No reconstructable changes in the bounded Session history (512 entries). Missing history cannot be recreated.", "info"); return; }
      const labels: string[] = [];
      for (const record of records) labels.push(`${displayMetadata(record.itemId)} [${displayMetadata(record.status)}] ${displayMetadata(record.operation)} ${displayMetadata(record.target)}`);
      const selected = await ctx.ui.select("Session changes", labels); assertChangesSession(ctx, sessionId);
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      if (index < 0) return;
      const record = records[index];
      const action = await ctx.ui.select(displayMetadata(record.itemId), ["View", "Verify current state", "Draft remaining request"]); assertChangesSession(ctx, sessionId);
      if (action === "View") {
        const item = record.item ?? record;
        const text = batchExpandedSummary(`${displayMetadata(record.itemId)} [${displayMetadata(record.status)}]${record.unavailable ? `\n${record.unavailable}` : ""}`, [item]);
        await showChangeViewer(ctx, text);
      } else if (action === "Verify current state") {
        if (record.preview || record.unavailable) throw new Error(record.unavailable ?? "Preview is not a mutation receipt. Execute a newly prepared request first.");
        const paths = record.destination ? [record.target, record.destination] : [record.target];
        paths.push(...retainedParents(record));
        const temporary = retainedTemporary(record); if (temporary) paths.push(temporary);
        const assertAllowed = await permissions.authorizeFileObservation(ctx, paths); assertChangesSession(ctx, sessionId);
        const observation = await verifyChange(record, assertAllowed); assertChangesSession(ctx, sessionId);
        assertAllowed.assertCurrent();
        pi.appendEntry(CHANGE_VERIFICATION_ENTRY, { version: 1, sessionId, sourceEntryId: record.entryId, itemId: record.itemId,
          toolCallId: record.toolCallId, observedAt: new Date().toISOString(), ...observation });
        const text = verificationSummary(observation);
        await showChangeViewer(ctx, text);
      } else if (action === "Draft remaining request") {
        const verified = collectVerifiedChanges(recentMutationEntries(ctx.sessionManager), records, sessionId);
        const batch: ChangeRecord[] = [];
        for (const item of records) if (item.toolCallId === record.toolCallId) batch.push(item);
        const draft = remainingDraft(batch, verified);
        const previous = ctx.ui.getEditorText();
        const choice = previous ? await ctx.ui.select("Keep current input or place draft", ["Append draft", "Replace editor", "Cancel"]) : "Replace editor";
        assertChangesSession(ctx, sessionId);
        if (choice !== "Append draft" && choice !== "Replace editor") return;
        if (ctx.ui.getEditorText() !== previous) throw new Error("Editor changed while the draft was prepared; existing input was preserved.");
        ctx.ui.setEditorText(choice === "Append draft" ? `${previous}\n\n${draft}` : draft);
      }
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
  } });
}
