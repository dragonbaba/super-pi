import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
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
  unavailable?: string;
  batchSize?: number;
}

/** Reconstruct from bounded Session entries. No disk observation, replay or second history store. */
export function collectChanges(branch: readonly any[], cwd: string): ChangeRecord[] {
  branch = branch.slice(-512);
  const calls = new Map<string, any>();
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
    }
  }
  for (const receipt of collectStructuredMutationReceipts(branch)) {
    const call = duplicate.has(receipt.toolCallId) ? undefined : calls.get(receipt.toolCallId);
    const entry = entries.get(receipt.entryId);
    const index = receipt.receiptVersion === 2 ? Number(receipt.itemId.slice(receipt.toolCallId.length + 1)) : 0;
    const input = call?.name === "file_batch" ? call.arguments?.operations?.[index] : call?.arguments;
    const item = entry?.message?.toolName === "file_batch" ? entry.message.details?.items?.[index] : undefined;
    const details = item?.receipt ?? entry?.message?.details ?? entry?.data;
    const target = resolve(cwd, receipt.target);
    const destination = receipt.receiptVersion === 2 && receipt.destination ? resolve(cwd, receipt.destination) : undefined;
    let bound = false;
    if (call?.name === "file_batch" && input?.operation === receipt.operation) {
      const intent = boundBatchIntents(branch, call.arguments, call.id).get(`${call.id}:${index}`);
      bound = intent?.target === receipt.target && intent?.destination === destination;
    } else if (call?.name === receipt.operation && typeof input?.path === "string") {
      const expected = receipt.operation === "edit" || receipt.operation === "write" ? resolveToolPath(cwd, input.path) : resolve(cwd, input.path);
      bound = expected === target && (receipt.operation !== "move" || typeof input.destination === "string" && resolve(cwd, input.destination) === destination);
    }
    records.push({ entryId: receipt.entryId, toolCallId: receipt.toolCallId, itemId: `${receipt.toolCallId}:${index}`,
      operation: receipt.operation, target, destination,
      status: receipt.receiptVersion === 1 ? "succeeded" : receipt.status, preview: false,
      original: bound ? input : undefined, item: bound ? item : undefined,
      batchSize: call?.name === "file_batch" ? call.arguments?.operations?.length : undefined,
      postimage: bound && typeof details?.sha256 === "string" && SHA256.test(details.sha256) ? details.sha256 : undefined,
      sourceIdentity: bound ? details?.sourceIdentity : undefined,
      unavailable: bound ? undefined : "Original request or matching preparation is missing/ambiguous in the bounded history; unable to reconstruct." });
    if (records.length > MAX_CHANGES) records.shift();
  }
  const previews: ChangeRecord[] = [];
  // Previews deliberately have no durable mutation receipt. They are view-only.
  for (const entry of branch) {
    const message = entry.type === "message" ? entry.message : undefined;
    const call = message && !duplicate.has(message.toolCallId) ? calls.get(message.toolCallId) : undefined;
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

export async function verifyChange(record: ChangeRecord, assertAllowed: () => Promise<void>) {
  if (record.preview || record.unavailable || !record.original) throw new Error("This record cannot authorize verification; no change was replayed.");
  const source = await observe(record.target, Boolean(record.postimage), assertAllowed);
  const destination = record.destination ? await observe(record.destination, false, assertAllowed) : undefined;
  await assertAllowed();
  return { source, destination,
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
  const path = boundedString(input.path, "Path", 4096);
  if (record.operation === "write") return { operation: "write", path, mode: input.mode, content: boundedString(input.content, "Content") };
  if (record.operation === "delete") return { operation: "delete", path };
  if (record.operation === "move") return { operation: "move", path, destination: boundedString(input.destination, "Destination", 4096) };
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

interface ObservationPermissions { authorizeFileObservation(ctx: ExtensionContext, paths: readonly string[]): Promise<() => Promise<void>> }

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
        const assertAllowed = await permissions.authorizeFileObservation(ctx, paths); assertSession();
        const observation = await verifyChange(record, assertAllowed); assertSession();
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
