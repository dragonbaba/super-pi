import { parse, resolve } from "node:path";
import { WINDOWS_BATCH_COMPONENT_PATTERN, WINDOWS_PATH_SEPARATOR_PATTERN } from "./regex.ts";
import { resolveToolPath } from "./file-path.ts";
import { mutationRequestHash } from "./file-invocation.ts";
import { canonicalCreationDirectories, directoryKey } from "./file-creation.ts";
import { selectCommitMetadata } from "./file-commit-metadata.ts";
import { PreviewBudget } from "./change-preview.ts";
import { assertIndependent, copyBatchInput, type BatchInput } from "./file-batch-protocol.ts";
import { formatBatchResult, type ItemResult } from "./file-results.ts";
import type { PathIdentity } from "./native-file-core.ts";
import { FileService, type PreparedFileItem, type ExecutePreparedFile, type FileExecutionHooks, type FileOperationInput } from "./file-service.ts";

export { FileBatchParameters } from "./file-batch-protocol.ts";
export { renderBatchResult } from "./file-results.ts";
type BatchItem = PreparedFileItem & { itemId: string };

/** Fixed input and bounded preparation, with no model-turn or display-based admission rules. */
export class FileBatch {
  readonly input: BatchInput;
  readonly requestHash: string;
  readonly items: BatchItem[] = [];
  readonly id: string;
  private readonly service: FileService;
  private state: "new" | "preparing" | "ready" | "executing" | "released" = "new";
  private revoked = false;

  constructor(service: FileService, id: string, input: unknown) {
    this.service = service; this.id = id; this.input = copyBatchInput(input, true);
    this.requestHash = mutationRequestHash("file_batch", this.input);
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.state !== "new") throw new Error("Batch preparation is single-use.");
    this.state = "preparing";
    const budget = new PreviewBudget();
    let index = 0;
    try {
      for (; index < this.input.operations.length; index++) {
        this.assertLive(); signal?.throwIfAborted();
        const operation = this.input.operations[index];
        const path = operation.operation === "edit" || operation.operation === "write"
          ? resolveToolPath(this.service.cwd, operation.path) : resolve(this.service.cwd, operation.path);
        if (process.platform === "win32") {
          const targets = operation.destination ? [path, resolve(this.service.cwd, operation.destination)] : [path];
          for (const target of targets) for (const component of target.slice(parse(target).root.length).split(WINDOWS_PATH_SEPARATOR_PATTERN)) {
            if (WINDOWS_BATCH_COMPONENT_PATTERN.test(component)) throw new Error("[BATCH_CONFLICT] Ambiguous Windows path component (device, stream, trailing dot or space) is unsupported.");
          }
        }
        const input: FileOperationInput = { path: operation.path };
        if (operation.content !== undefined) input.content = operation.content;
        if (operation.destination !== undefined) input.destination = operation.destination;
        if (operation.snapshot !== undefined) input.snapshot = operation.snapshot;
        if (operation.edits !== undefined) input.edits = operation.edits;
        const item = await this.service.prepare(operation.operation, input, signal, operation.mode, budget) as BatchItem;
        item.itemId = `${this.id}:${index}`;
        this.items.push(item);
        this.assertLive();
        if (item.snapshot) await selectCommitMetadata(item.snapshot.target);
      }
      this.assertLive(); signal?.throwIfAborted();
      assertIndependent(this.items);
      this.state = "ready";
    } catch (error) {
      this.dispose();
      throw new Error(`${this.id}:${index}: ${error instanceof Error ? error.message : String(error)}\nPreflight failed; no batch item executed.`, { cause: error });
    }
  }
  assertLive(): void { if (this.revoked || this.state === "released") throw new Error("[STALE_STATE] Batch was released."); }
  release(): void {
    this.revoked = true;
    // An executing OS effect owns its plan until it returns and its receipt is captured.
    if (this.state !== "executing" && this.state !== "preparing") this.dispose();
  }
  private dispose(): void {
    this.state = "released"; this.revoked = true;
    for (const item of this.items) this.service.release(item);
    this.items.length = 0;
  }
  async execute(hooks: FileExecutionHooks) {
    this.assertLive();
    if (this.state !== "ready") throw new Error("Batch must be prepared and can execute only once.");
    this.state = "executing";
    const execution = new BatchExecution(this, this.service, hooks);
    try { return await execution.execute(); }
    finally { this.dispose(); }
  }
}

/** One invocation owner, at most 16 plans/results and 32 unique missing parents per item. */
class BatchExecution {
  private readonly batch: FileBatch;
  private readonly service: FileService;
  private readonly hooks: FileExecutionHooks;
  private readonly results: ItemResult[] = [];
  private readonly plannedDirectories: string[] = [];
  private readonly sharedDirectories = new Map<string, PathIdentity>();
  private readonly fileHooks: FileExecutionHooks;
  private current = 0;
  constructor(batch: FileBatch, service: FileService, hooks: FileExecutionHooks) {
    this.batch = batch; this.service = service; this.hooks = hooks;
    this.fileHooks = { assertCurrent: this.assertCurrent, record: this.record, signal: hooks.signal, sharedDirectories: this.sharedDirectories, batch: true };
    const directories = new Set<string>();
    for (const item of batch.items) {
      this.results.push({ itemId: item.itemId, operation: item.operation, target: item.target,
        destination: item.native?.destination, status: "not_started", stateChanged: false, preview: item.preview });
      if (batch.input.dryRun && item.creation) for (const path of item.creation.directories) {
        const key = directoryKey(path);
        if (!directories.has(key)) { directories.add(key); this.plannedDirectories.push(path); }
      }
    }
  }
  readonly assertCurrent = (): void => {
    this.batch.assertLive(); this.hooks.signal?.throwIfAborted(); this.hooks.assertCurrent();
  };
  readonly record = (entry: Record<string, unknown>): void => {
    this.hooks.record({ ...entry, requestHash: this.batch.requestHash });
  };
  readonly run = async (execute: ExecutePreparedFile): Promise<void> => {
    const { batch, service, fileHooks } = this;
    for (this.current = 0; this.current < batch.items.length; this.current++) await service.revalidate(batch.items[this.current], fileHooks);
    this.current = 0;
    if (batch.input.dryRun) { for (const result of this.results) result.status = "preview"; return; }
    const targets = [];
    for (const item of batch.items) targets.push({ itemId: item.itemId, operation: item.operation, target: item.target,
      destination: item.native?.destination, directories: item.creation ? canonicalCreationDirectories(item.creation) : item.operation === "write" ? [] : undefined });
    this.record({ toolCallId: batch.id, phase: "prepared", items: targets });
    for (this.current = 0; this.current < batch.items.length; this.current++) {
      const item = batch.items[this.current], result = this.results[this.current];
      const receipt = await execute(item, batch.id, fileHooks, item.itemId);
      result.receipt = receipt; result.status = receipt.status; result.stateChanged = receipt.stateChanged;
      if (typeof receipt.cause === "string") result.reason = receipt.cause.slice(0, 800);
      if (receipt.requiresVerification || receipt.commit?.retainedTemporary || receipt.status === "partial" || receipt.status === "state_unknown") result.requiresVerification = true;
      if (receipt.status !== "succeeded") break;
    }
  };
  async execute() {
    try { await this.service.withPreparedItems(this.batch.items, this.run); }
    catch (error) {
      const result = this.results[Math.min(this.current, this.results.length - 1)];
      // This catch is an all-item/pre-item failure, never a rewrite of a completed item's outcome.
      if (result.status === "not_started") {
        result.status = this.hooks.signal?.aborted ? "cancelled" : "failed_no_change";
        result.reason = (error instanceof Error ? error.message : String(error)).slice(0, 800);
      }
    } finally { this.sharedDirectories.clear(); }
    return formatBatchResult(this.batch.input, this.results, this.plannedDirectories);
  }
}
