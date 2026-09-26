import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { Key, matchesKey, Text, type TUI } from "@super-pi/tui";
import { resolveToolPath } from "./core.ts";
import { capturePathIdentity, sameIdentity, type PathIdentity } from "./native-file-core.ts";
import { boundBatchIntents, collectStructuredMutationReceipts, recentMutationEntries } from "./session-evidence.ts";
import { batchExpandedSummary, PreviewBudget } from "./change-preview.ts";

export const CHANGE_VERIFICATION_ENTRY = "file-change-verification-v1";
const MAX_CHANGES = 128;
const MAX_VERIFY_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ChangeRecord {
  entryId: string; toolCallId: string; itemId: string; operation: string;
  target: string; destination?: string; status: string; preview: boolean;
  original?: any; item?: any; postimage?: string; sourceIdentity?: { device: string; inode: string };
  receipt?: any;
  reason?: string;
  unavailable?: string;
  batchSize?: number;
}

function terminalOutcome(entry: any, callId: string, itemId: string, index: number): any {
  if (entry.type === "custom" && entry.customType === "file-mutation-progress-v2" && entry.data?.toolCallId === callId
    && entry.data.itemId === itemId && entry.data.phase === "result") return entry.data;
  if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === callId) {
    const data = entry.message.details;
    return entry.message.toolName === "file_batch" ? data?.items?.[index] : data;
  }
}

function conflictingTerminal(entries: readonly any[], selected: any, callId: string, itemId: string, index: number, outcome: any): boolean {
  let previous = false;
  for (const entry of entries) {
    if (entry.id === selected.id) break;
    const terminal = terminalOutcome(entry, callId, itemId, index);
    if (!terminal) continue;
    // The one normal mirror is a durable custom result followed by the matching
    // aggregate tool result. A later custom terminal cannot borrow an old intent.
    if (previous || entry.type !== "custom" || selected.type !== "message"
      || terminal.status !== outcome.status || terminal.stateChanged !== outcome.stateChanged
      || terminal.operation !== outcome.operation || terminal.target !== outcome.target || terminal.destination !== outcome.destination) return true;
    previous = true;
  }
  return false;
}

function uniqueBatchPreparation(entries: readonly any[], call: any) {
  let prepared: any, position = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || entry.data?.toolCallId !== call.id || entry.data.phase !== "prepared") continue;
    if (prepared) return undefined; // Even a malformed competing preparation is ambiguous.
    prepared = entry; position = index;
  }
  if (!prepared || entries.slice(0, position).some(entry => entry.data?.toolCallId === call.id && entry.data?.itemId !== undefined)) return undefined;
  const targets = boundBatchIntents([prepared], call.arguments, call.id);
  if (!Array.isArray(call.arguments?.operations) || targets.size !== call.arguments.operations.length) return undefined;
  return { prepared, position, targets };
}

function laterBatchActivity(entries: readonly any[], callId: string, index: number): boolean {
  for (const entry of entries) {
    const data = entry.data;
    if (data?.toolCallId === callId && data.itemId !== undefined) {
      const suffix = typeof data.itemId === "string" ? data.itemId.slice(callId.length + 1) : "";
      const number = Number(suffix);
      if (!Number.isInteger(number) || data.itemId !== `${callId}:${number}` || number > index) return true;
    }
    const message = entry.message;
    if (message?.role === "toolResult" && message.toolCallId === callId && Array.isArray(message.details?.items)) {
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
  const intents = entries.filter(entry => entry.type === "custom" && entry.customType === "file-mutation-progress-v2"
    && entry.data?.toolCallId === call.id && entry.data.itemId === itemId && entry.data.phase === "intent");
  if (intents.length > 1) return undefined;
  if (intents.length === 1) {
    const intent = intents[0].data;
    if (intent.requestHash !== preparation.prepared.data.requestHash || intent.operation !== prepared.operation
      || intent.target !== prepared.target || intent.destination !== prepared.destination || status === "not_started") return undefined;
  } else if (!["cancelled", "not_started"].includes(status)) return undefined;
  // Entered items persist intent before revalidation. Cancellation before item
  // entry and remaining not-started items have preparation but no intent.
  if (status !== "succeeded" && laterBatchActivity(entries, call.id, index)) return undefined;
  return prepared;
}

/** Reconstruct from bounded Session entries. No disk observation, replay or second history store. */
export function collectChanges(branch: readonly any[], cwd: string): ChangeRecord[] {
  branch = branch.slice(-512);
  const calls = new Map<string, any>();
  const callOrder = new Map<string, number>();
  const duplicate = new Set<string>();
  const entries = new Map<string, any>();
  const records: ChangeRecord[] = [];
  const order = new Map<string, number>();
  for (const entry of branch) {
    entries.set(entry.id, entry);
    order.set(entry.id, order.size);
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const call of entry.message.content) {
      if (call.type !== "toolCall" || typeof call.id !== "string") continue;
      if (calls.has(call.id)) duplicate.add(call.id);
      calls.set(call.id, call);
      callOrder.set(call.id, order.get(entry.id)!);
    }
  }
  for (const receipt of collectStructuredMutationReceipts(branch)) {
    const receiptOrder = order.get(receipt.entryId)!;
    const precedingCall = (callOrder.get(receipt.toolCallId) ?? Infinity) < receiptOrder;
    const call = duplicate.has(receipt.toolCallId) || !precedingCall ? undefined : calls.get(receipt.toolCallId);
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
    const executionEntries = call ? branch.slice(callOrder.get(call.id)! + 1, receiptOrder + 1) : [];
    if (exactItemId && historicalTarget && call?.name === "file_batch" && input?.operation === receipt.operation) {
      const intent = boundRecoveryItem(executionEntries, call, index, receipt.receiptVersion === 2 ? receipt.status : "succeeded");
      bound = intent?.target === receipt.target && intent?.destination === destination;
    } else if (exactItemId && historicalTarget && call?.name === receipt.operation && typeof input?.path === "string") {
      const expected = receipt.operation === "edit" || receipt.operation === "write" ? resolveToolPath(cwd, input.path) : resolve(cwd, input.path);
      bound = expected === target && (receipt.operation !== "move" || typeof input.destination === "string" && resolve(cwd, input.destination) === destination);
      if (bound && receipt.receiptVersion === 2) bound = executionEntries.some(candidate => candidate.type === "custom" && candidate.customType === "file-mutation-progress-v2"
        && candidate.data?.phase === "intent" && candidate.data.toolCallId === call.id && candidate.data.itemId === receipt.itemId
        && candidate.data.operation === receipt.operation && candidate.data.target === receipt.target && candidate.data.destination === receipt.destination);
    }
    if (bound && receipt.receiptVersion === 2 && conflictingTerminal(executionEntries, entry, receipt.toolCallId, receipt.itemId, index, receipt)) bound = false;
    records.push({ entryId: receipt.entryId, toolCallId: receipt.toolCallId, itemId: receipt.receiptVersion === 2 ? receipt.itemId : `${receipt.toolCallId}:0`,
      operation: receipt.operation, target, destination,
      status: receipt.receiptVersion === 1 ? "succeeded" : receipt.status, preview: false,
      original: bound ? input : undefined, item: bound ? item : undefined,
      receipt: details,
      reason: typeof (item?.reason ?? details?.cause ?? details?.reason) === "string" ? (item?.reason ?? details.cause ?? details.reason).slice(0, 800) : undefined,
      batchSize: call?.name === "file_batch" ? call.arguments?.operations?.length : undefined,
      postimage: bound && typeof details?.sha256 === "string" && SHA256.test(details.sha256) ? details.sha256 : undefined,
      sourceIdentity: bound ? details?.sourceIdentity : undefined,
      unavailable: bound ? undefined : !historicalTarget ? "Originating cwd is missing for this relative legacy receipt; unable to reconstruct its target safely."
        : "Original request or ordered matching preparation is missing/ambiguous in the bounded history; unable to reconstruct." });
    if (records.length > MAX_CHANGES) records.shift();
  }
  // A persisted, request-bound preparation precedes every per-item intent.
  // After interruption, items with no later intent/outcome are safely unstarted.
  for (let n = 0; n < branch.length; n++) {
    const entry = branch[n], data = entry.data, call = calls.get(data?.toolCallId);
    if (entry.type !== "custom" || entry.customType !== "file-mutation-progress-v2" || data?.phase !== "prepared"
      || !call || duplicate.has(call.id) || call.name !== "file_batch" || (callOrder.get(call.id) ?? Infinity) >= n) continue;
    const executionEntries = branch.slice(callOrder.get(call.id)! + 1);
    const preparation = uniqueBatchPreparation(executionEntries, call);
    if (!preparation || preparation.prepared !== entry) continue;
    const intents = preparation.targets;
    for (let index = 0; index < (call.arguments?.operations?.length ?? 0) && index < 16; index++) {
      const itemId = `${call.id}:${index}`, intent = intents.get(itemId);
      if (!intent || records.some(record => record.itemId === itemId)) continue;
      if (laterBatchActivity(executionEntries, call.id, index)) continue;
      // Any later item activity, even malformed, prevents a no-start claim.
      if (branch.slice(n + 1).some(later => later.data?.toolCallId === call.id && (later.data?.itemId === itemId || later.data?.phase === "prepared")
        || later.message?.role === "toolResult" && later.message.toolCallId === call.id)) continue;
      records.push({ entryId: entry.id, toolCallId: call.id, itemId, operation: intent.operation, target: intent.target,
        destination: intent.destination, status: "not_started", preview: false, original: call.arguments.operations[index], batchSize: call.arguments.operations.length });
      if (records.length > MAX_CHANGES) records.shift();
    }
  }
  const previews: ChangeRecord[] = [];
  // Previews deliberately have no durable mutation receipt. They are view-only.
  for (const entry of branch) {
    const message = entry.type === "message" ? entry.message : undefined;
    const call = message && !duplicate.has(message.toolCallId) && (callOrder.get(message.toolCallId) ?? Infinity) < order.get(entry.id)!
      ? calls.get(message.toolCallId) : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "file_batch" || call?.name !== "file_batch"
      || call.arguments?.dryRun !== true || message.details?.preview !== true || !Array.isArray(message.details.items) || message.details.items.length > 16) continue;
    for (let index = 0; index < message.details.items.length; index++) {
      const item = message.details.items[index];
      if (item?.itemId !== `${call.id}:${index}` || typeof item.target !== "string" || item.target.length > 4096 || item.operation !== call.arguments.operations?.[index]?.operation) continue;
      previews.push({ entryId: entry.id, toolCallId: call.id, itemId: item.itemId, operation: item.operation,
        target: item.target, destination: item.destination, status: "preview", preview: true, item });
      if (previews.length > MAX_CHANGES) previews.shift();
    }
  }
  const combined = records.concat(previews);
  combined.sort((left, right) => (order.get(left.entryId) ?? -1) - (order.get(right.entryId) ?? -1));
  return combined.slice(-MAX_CHANGES);
}

export interface ChangeObservation { path: string; exists: boolean; identity?: PathIdentity; sha256?: string; hashOmitted?: string }

function retainedParents(record: ChangeRecord): string[] {
  const directories = record.receipt?.creation?.createdDirectories ?? record.receipt?.createdDirectories;
  if (directories === undefined) return [];
  if (!Array.isArray(directories) || directories.length > 32) throw new Error("Recorded parent side effects exceed verification bounds.");
  const paths: string[] = [];
  for (const directory of directories) {
    const path = directory?.identity?.canonical ?? directory?.path;
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path)) throw new Error("Recorded parent side effect cannot be reconstructed.");
    const tail = relative(path, record.target);
    if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error("Recorded side effect is not a parent of the bound target.");
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

async function observe(path: string, hash: boolean, assertAllowed: () => Promise<void>): Promise<ChangeObservation> {
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
      await assertAllowed();
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
  const parents: ChangeObservation[] = [];
  for (const path of retainedParents(record)) parents.push(await observe(path, false, assertAllowed));
  await assertAllowed();
  // A second path (or a permission await) can change the first observation.
  // Recheck all identities, including metadata-only and oversized files.
  for (const observation of destination ? [source, destination, ...parents] : [source, ...parents]) {
    if (observation.identity) {
      if (!sameIdentity(observation.identity, await capturePathIdentity(observation.path))) throw new Error("Object changed before observation was accepted.");
    } else {
      try { await lstat(observation.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new Error("Path appeared before absence observation was accepted.");
    }
  }
  assertAllowed.assertCurrent?.();
  return { source, destination, parents,
    postimageMatches: record.postimage && source.sha256 ? record.postimage === source.sha256 : undefined,
    destinationIdentityMatches: record.sourceIdentity && destination?.identity
      ? record.sourceIdentity.device === destination.identity.device && record.sourceIdentity.inode === destination.identity.inode : undefined,
    scope: "Filesystem observation only; not a semantic/test result, proof of earlier side effects, or permission to replay." };
}

function boundedString(value: unknown, label: string, max = 8192): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} is missing or exceeds the draft bound; supply a fresh request.`);
  return value;
}

function draftOperation(record: ChangeRecord): unknown {
  const input = record.original;
  const path = boundedString(record.target, "Recorded target", 4096);
  if (!isAbsolute(path)) throw new Error("Draft needs a recorded absolute target; originating cwd cannot be guessed.");
  if (record.operation === "write") return { operation: "write", path, mode: input.mode, content: boundedString(input.content, "Content") };
  if (record.operation === "delete") return { operation: "delete", path };
  if (record.operation === "move") return { operation: "move", path, destination: boundedString(record.destination, "Recorded destination", 4096) };
  if (!Array.isArray(input.edits) || input.edits.length > 20) throw new Error("Original edit parameters cannot be reconstructed.");
  const changes = [];
  for (const edit of input.edits) {
    if (input.snapshot) {
      if (edit.newLines !== undefined && (!Array.isArray(edit.newLines) || edit.newLines.length > 200)) throw new Error("Snapshot replacement exceeds draft bound.");
      const newLines = edit.newLines?.map((line: unknown) => boundedString(line, "Replacement line", 2048));
      // Stale snapshot IDs and LINE#ID anchors are never serialized into a new draft.
      changes.push({ kind: edit.kind, originalLineHint: Number.parseInt(edit.start, 10), originalEndLineHint: edit.end ? Number.parseInt(edit.end, 10) : undefined, newLines });
    } else changes.push({ oldText: boundedString(edit.oldText, "Old text"), newText: boundedString(edit.newText, "New text") });
  }
  return { operation: "edit", path, desiredChanges: changes };
}

export function remainingDraft(records: readonly ChangeRecord[], verifiedItems: ReadonlySet<string>): string {
  if (records.length > 16 || records.some(record => record.batchSize !== undefined && record.batchSize !== records.length)) throw new Error("Batch history is incomplete in the bounded window; unable to reconstruct remaining work.");
  if (records.some(record => !record.preview && (record.unavailable || !record.original))) throw new Error("Original request or matching preparation is missing/ambiguous; unable to reconstruct remaining work.");
  const parts: string[] = [];
  let bytes = 0;
  for (const record of records) {
    if (record.preview || record.status === "succeeded") continue;
    if (record.status === "partial" || record.status === "state_unknown") {
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
  return `Prepare a NEW request for the following remaining desired changes. Read current targets first and use fresh evidence, snapshots and anchors; original line hints are not evidence. Revalidate paths and request current authorization. Never replay the old batch or repeat successful items. Partial/unknown items are excluded and need separate examination.\n\nSource batch: ${records[0]?.toolCallId ?? "unknown"} (reference only, no authority).\n\n${parts.join("\n\n")}\n`;
}

class ChangeViewer {
  private text: Text;
  private offset = 0;
  private total = 0;
  private tui?: TUI;
  private done?: (value: void) => void;
  constructor(body: string, tui: TUI, done: (value: void) => void) { this.text = new Text(body, 0, 0); this.tui = tui; this.done = done; }
  render(width: number): string[] {
    const lines = this.text.render(width), height = Math.max(1, (this.tui?.terminal.rows ?? 24) - 2);
    this.total = lines.length;
    this.offset = Math.max(0, Math.min(this.offset, this.total - height));
    const output = [];
    for (let i = this.offset; i < Math.min(this.total, this.offset + height); i++) output.push(lines[i]);
    output.push(width >= 21 ? "↑↓ scroll · Esc close" : width >= 9 ? "Esc close" : width >= 3 ? "Esc" : "");
    return output;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { const done = this.done; this.dispose(); done?.(); return; }
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, Key.down)) this.offset = Math.min(this.total - 1, this.offset + 1);
    if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - 10);
    if (matchesKey(data, Key.pageDown)) this.offset = Math.min(this.total - 1, this.offset + 10);
    this.tui?.requestRender();
  }
  invalidate(): void { this.text.invalidate(); }
  dispose(): void { this.text.setText(""); this.tui = undefined; this.done = undefined; }
}

interface ObservationPermissions { authorizeFileObservation(ctx: ExtensionContext, paths: readonly string[]): Promise<(() => Promise<void>) & { assertCurrent(): void }> }

export function registerChanges(pi: ExtensionAPI, permissions: ObservationPermissions): void {
  pi.registerCommand("changes", { description: "View Session file changes, verify current state, or draft remaining work", async handler(_args, ctx) {
    if (!ctx.hasUI || !ctx.isIdle()) { ctx.ui.notify("/changes needs an idle Session with dialog UI.", "warning"); return; }
    const sessionId = ctx.sessionManager.getSessionId();
    const assertSession = () => { if (sessionId !== ctx.sessionManager.getSessionId() || !ctx.isIdle()) throw new Error("Session changed or became busy; reopen /changes."); };
    try {
      const branch = recentMutationEntries(ctx.sessionManager);
      const records = collectChanges(branch, ctx.cwd);
      if (!records.length) { ctx.ui.notify("No reconstructable changes in the bounded Session history (512 entries). Missing history cannot be recreated.", "info"); return; }
      const labels = records.map(record => stripVTControlCharacters(`${record.itemId} [${record.status}] ${record.operation} ${record.target}`).replace(/[\x00-\x1f\x7f]/g, "?"));
      const selected = await ctx.ui.select("Session changes", labels); assertSession();
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      if (index < 0) return;
      const record = records[index];
      const action = await ctx.ui.select(record.itemId, ["View", "Verify current state", "Draft remaining request"]); assertSession();
      if (action === "View") {
        const item = record.item ?? record;
        const text = batchExpandedSummary(`${record.itemId} [${record.status}]${record.unavailable ? `\n${record.unavailable}` : ""}`, [item]);
        await ctx.ui.custom<void>((tui, _theme, _keys, done) => new ChangeViewer(text, tui, done));
      } else if (action === "Verify current state") {
        if (record.preview || record.unavailable) throw new Error(record.unavailable ?? "Preview is not a mutation receipt. Execute a newly prepared request first.");
        const paths = record.destination ? [record.target, record.destination] : [record.target];
        paths.push(...retainedParents(record));
        const assertAllowed = await permissions.authorizeFileObservation(ctx, paths); assertSession();
        const observation = await verifyChange(record, assertAllowed); assertSession();
        assertAllowed.assertCurrent();
        pi.appendEntry(CHANGE_VERIFICATION_ENTRY, { version: 1, sessionId, sourceEntryId: record.entryId, itemId: record.itemId,
          toolCallId: record.toolCallId, observedAt: new Date().toISOString(), ...observation });
        const text = new PreviewBudget().take(JSON.stringify(observation, null, 2), 400).text;
        await ctx.ui.custom<void>((tui, _theme, _keys, done) => new ChangeViewer(text, tui, done));
      } else if (action === "Draft remaining request") {
        const verified = new Set<string>();
        for (const entry of recentMutationEntries(ctx.sessionManager) as any[]) {
          const data = entry?.data;
          if (entry.type !== "custom" || entry.customType !== CHANGE_VERIFICATION_ENTRY || data?.version !== 1 || data.sessionId !== sessionId) continue;
          for (const candidate of records) if (data.itemId === candidate.itemId && data.toolCallId === candidate.toolCallId && data.sourceEntryId === candidate.entryId) verified.add(candidate.itemId);
        }
        const draft = remainingDraft(records.filter(item => item.toolCallId === record.toolCallId), verified);
        const previous = ctx.ui.getEditorText();
        const choice = previous ? await ctx.ui.select("Keep current input or place draft", ["Append draft", "Replace editor", "Cancel"]) : "Replace editor";
        assertSession();
        if (choice !== "Append draft" && choice !== "Replace editor") return;
        if (ctx.ui.getEditorText() !== previous) throw new Error("Editor changed while the draft was prepared; existing input was preserved.");
        ctx.ui.setEditorText(choice === "Append draft" ? `${previous}\n\n${draft}` : draft);
      }
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
  } });
}
