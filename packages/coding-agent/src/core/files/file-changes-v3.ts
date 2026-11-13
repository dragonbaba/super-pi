import { setImmediate as yieldCommand } from "node:timers/promises";
import type { ReadonlySessionManager } from "../session-manager.ts";
import type { ChangeRecord } from "./changes.ts";
import { FileResultReader, type FileResultPage } from "./file-result-store.ts";
import { FILE_RESULT_ENTRY, boundedFileEntryId, boundedResultId, parseFileResultEnvelope, parseFileResultPayload, parseFileResultReference,
  fileResultReference, sameResultBinding, type FileResultEnvelope, type FileResultPayload } from "./file-result-protocol.ts";
import { fileMutationItem } from "./file-mutation-input.ts";

export const FILE_CHANGES_PAGE_ITEMS = 16;
const SCAN_YIELD_ENTRIES = 512;
export interface FileChangesCallV3 { ref: string; toolCallId: string; operation: string; itemCount: number; complete: boolean; }
export interface FileChangesPageV3 {
  version: 3; resultRef: string; records: ChangeRecord[]; itemCount: number; visited: number;
  hasMore: boolean; callComplete: boolean; coverageComplete: boolean;
}

/** Explicit /changes dialog owner. Discovery walks indexed entries once and
 * retains only seen call IDs, bounded by the frozen session entry count. Item
 * paging retains one <=64 KiB reader page, never a whole invocation item map.
 * All references are released when the command closes or its epoch changes. */
export class FileChangesV3 {
  private session: ReadonlySessionManager | undefined;
  private reader: FileResultReader | undefined;
  private readonly sessionId: string;
  private readonly history: number;
  private readonly context: number;
  private readonly capacity: number;
  private scanId: string | null;
  private scanned = 0;
  private readonly seen = new Map<string, Set<string>>();
  private seenCalls = 0;
  private root: FileResultEnvelope | undefined;
  private rootPayload: FileResultPayload | undefined;
  private call: { name: string; arguments: Record<string, any> } | undefined;
  private resultRef = "";
  private pending: FileResultPage | undefined;
  private pendingOffset = 0;
  private cursor: string | null = null;
  private started = 0;
  private visited = 0;
  private incomplete = false;
  constructor(session: ReadonlySessionManager) {
    this.session = session; this.reader = new FileResultReader(session);
    this.sessionId = session.getSessionId(); this.history = session.getHistoryGeneration(); this.context = session.getContextGeneration();
    this.capacity = session.getEntryCount(); this.scanId = session.getLeafId();
  }
  assertCurrent(): void {
    const session = this.session;
    if (!session || !session.isHistoryConsistent() || session.getSessionId() !== this.sessionId
      || session.getHistoryGeneration() !== this.history || session.getContextGeneration() !== this.context) {
      this.dispose(); throw new Error("[FILE_RESULT_BRANCH] Changes dialog belongs to a changed session or branch.");
    }
  }
  get hasMoreCalls(): boolean { return this.scanId !== null; }
  async calls(signal?: AbortSignal): Promise<FileChangesCallV3[]> {
    this.assertCurrent(); const result: FileChangesCallV3[] = [];
    while (this.scanId && result.length < FILE_CHANGES_PAGE_ITEMS) {
      this.assertCurrent(); signal?.throwIfAborted();
      if (++this.scanned > this.capacity) throw new Error("[FILE_RESULT_INVALID] Session branch contains a cycle.");
      const entry = this.session!.getEntry(this.scanId);
      if (!entry) throw new Error("[FILE_RESULT_INVALID] Changes branch is incomplete.");
      this.scanId = entry.parentId;
      if (entry.type === "custom" && entry.customType === FILE_RESULT_ENTRY) {
        const raw = entry.data as FileResultEnvelope;
        if (!raw || !boundedFileEntryId(raw.callEntryId) || !boundedResultId(raw.toolCallId)) throw new Error("[FILE_RESULT_INVALID] Invalid changes call identity.");
        let calls = this.seen.get(raw.callEntryId);
        if (!calls?.has(raw.toolCallId)) {
          const data = parseFileResultEnvelope(raw), payload = parseFileResultPayload(data);
          if (++this.seenCalls > this.capacity) throw new Error("[FILE_RESULT_INVALID] Changes discovery exceeded its owner capacity.");
          if (!calls) { calls = new Set(); this.seen.set(data.callEntryId, calls); }
          calls.add(data.toolCallId);
          result.push({ ref: fileResultReference(entry.id, data, data.hash), toolCallId: data.toolCallId,
            operation: data.operation, itemCount: data.itemCount, complete: payload.phase === "complete" });
        }
      }
      if (this.scanned % SCAN_YIELD_ENTRIES === 0) await yieldCommand();
    }
    this.assertCurrent(); signal?.throwIfAborted(); return result;
  }
  open(ref: string): void {
    this.assertCurrent(); this.closeItems();
    const page = this.reader!.read(ref, undefined, 128), reference = parseFileResultReference(page.resultRef);
    const entry = this.session!.getEntry(reference.entryId)!;
    if (entry.type !== "custom") throw new Error("[FILE_RESULT_INVALID] Missing changes result.");
    const root = parseFileResultEnvelope(entry.data), payload = parseFileResultPayload(root);
    const call = this.reader!.sourceCall;
    if (!call || call.id !== root.toolCallId || call.name !== root.operation) throw new Error("[FILE_RESULT_INVALID] Changes source call is unavailable.");
    this.call = call; this.root = root; this.rootPayload = payload; this.resultRef = page.resultRef;
    this.pending = page; this.cursor = page.nextCursor;
    this.started = payload.phase === "complete" ? payload.nextIndex as number
      : payload.phase === "result" || payload.phase === "intent" || payload.phase === "commit" ? payload.index! + 1 : 0;
    this.incomplete = payload.phase === "intent" || payload.phase === "commit";
  }
  private preparation(id: unknown): FileResultPayload {
    if (!boundedFileEntryId(id)) throw new Error("[FILE_RESULT_INVALID] Missing paired changes preparation.");
    const entry = this.session!.getEntry(id);
    if (entry?.type !== "custom" || entry.customType !== FILE_RESULT_ENTRY) throw new Error("[FILE_RESULT_INVALID] Missing changes preparation.");
    const data = parseFileResultEnvelope(entry.data), record = parseFileResultPayload(data);
    if (!sameResultBinding(this.root!, data) || record.phase !== "prepared") throw new Error("[FILE_RESULT_INVALID] Foreign changes preparation.");
    return record;
  }
  private item(entryId: string, preparation: FileResultPayload, receipt?: FileResultPayload): ChangeRecord {
    const index = preparation.index!, operation = preparation.operation!, source = preparation.source as any, destinationParent = preparation.destinationParent as any;
    const input = fileMutationItem(this.call!.name, this.call!.arguments, index);
    return { entryId, requestEntryId: this.root!.callEntryId, toolCallId: this.root!.toolCallId, itemId: `${this.root!.toolCallId}:${index}`,
      operation, target: preparation.target!, destination: preparation.destination, status: receipt?.status ?? "not_started", preview: false,
      original: input, receipt, item: receipt, reason: receipt?.reason as string | undefined,
      requiresVerification: receipt?.requiresVerification === true ? true : undefined,
      postimage: operation === "write" || operation === "edit" ? receipt?.sha256 as string | undefined : undefined,
      destinationPostimage: operation === "copy" || operation === "move" ? receipt?.sha256 as string | undefined : undefined,
      sourceIdentity: operation === "move" && preparation.moveStrategy !== "copy_unlink_verified" && source?.device === destinationParent?.device && !source?.directory
        ? { device: source.device, inode: source.inode } : undefined,
      receiptVersion: 3 };
  }
  nextItems(): FileChangesPageV3 {
    this.assertCurrent(); if (!this.root || !this.pending) throw new Error("[FILE_RESULT_INVALID] Open a changes call first.");
    const records: ChangeRecord[] = [];
    if (this.incomplete) {
      const preparation = this.preparation(this.rootPayload!.preparedId);
      records.push(this.item(parseFileResultReference(this.resultRef).entryId, preparation,
        { ...this.rootPayload!, phase: "result", operation: preparation.operation, target: preparation.target, destination: preparation.destination,
          status: "state_unknown", stateChanged: "unknown", requiresVerification: true }));
      this.incomplete = false; this.visited++;
    }
    while (records.length < FILE_CHANGES_PAGE_ITEMS) {
      if (this.pendingOffset >= this.pending.records.length) {
        if (!this.cursor) break;
        this.pending = this.reader!.read(this.resultRef, this.cursor, 128); this.pendingOffset = 0; this.cursor = this.pending.nextCursor;
      }
      const row = this.pending.records[this.pendingOffset++], record = row.record;
      if (record.phase === "result") { records.push(this.item(row.entryId, this.preparation(record.preparedId), record)); this.visited++; }
      else if (record.phase === "prepared" && record.index! >= this.started) { records.push(this.item(row.entryId, record)); this.visited++; }
    }
    const hasMore = this.pendingOffset < this.pending.records.length || this.cursor !== null;
    if (!hasMore && this.rootPayload!.phase !== "prepared" && this.visited !== this.root.itemCount) throw new Error("[FILE_RESULT_INVALID] Changes target coverage is incomplete.");
    return { version: 3, resultRef: this.resultRef, records, itemCount: this.root.itemCount, visited: this.visited,
      hasMore, callComplete: this.pending.callComplete, coverageComplete: !hasMore && this.pending.coverageComplete };
  }
  closeItems(): void {
    this.root = undefined; this.rootPayload = undefined; this.call = undefined; this.pending = undefined;
    this.pendingOffset = 0; this.cursor = null; this.resultRef = ""; this.started = 0; this.visited = 0; this.incomplete = false;
  }
  get diagnostics() { return { retainedReaderPages: this.pending ? 1 : 0, seenCalls: this.seenCalls, discoveryCapacity: this.capacity, sessionRetained: this.session !== undefined }; }
  dispose(): void { this.closeItems(); this.reader?.dispose(); this.reader = undefined; this.session = undefined; this.scanId = null; this.seen.clear(); this.seenCalls = 0; }
}
