import { createHash } from "node:crypto";
import {
  CONFIG_DIR_NAME,
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@super-pi/coding-agent";
import {
  ANALYTICS_VERSION,
  CHECKPOINT_TYPE,
  collectRepairMetrics,
  createRepairMetric,
  formatRepairMarkdown,
  publicAggregate,
  type RepairMetric,
} from "./aggregate.ts";
import { extractRepairKinds } from "./core.ts";
import { deliverRepairReport } from "./output.ts";
import { mergeAndPersist, readAggregateStore } from "./storage.ts";
import { RepeatedWarningGate } from "./warning-state.ts";

const TOOL_INPUT_REPAIR_VERSION = "tool-input-repair-v1@pi.84.1+guardrails.3";
const MAX_PENDING_REPAIRS = 2_048;
const MAX_RECORDED_REPAIR_IDS = 4_096;
const EMPTY_PENDING_REPAIRS: readonly PendingRepair[] = Object.freeze([]);

interface PendingRepair {
  sessionId: string;
  metric: RepairMetric;
}

export default function toolInputRepairTelemetryExtension(pi: ExtensionAPI): void {
  let flushTail: Promise<void> = Promise.resolve();
  const pendingRepairs: PendingRepair[] = [];
  const recordedRepairIds = new Set<string>();
  const aggregationWarnings = new RepeatedWarningGate();

  const recordRepairs = (
    event: { toolCallId: string; toolName: string; input: unknown },
    ctx: ExtensionContext,
  ): void => {
    const kinds = extractRepairKinds(event.input);
    if (kinds.length === 0) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const timestamp = new Date().toISOString();
    for (const kind of kinds) {
      const repairId = `${sessionId}\u0000${event.toolCallId}\u0000${kind}`;
      if (recordedRepairIds.has(repairId)) continue;
      if (pendingRepairs.length >= MAX_PENDING_REPAIRS) break;
      while (recordedRepairIds.size >= MAX_RECORDED_REPAIR_IDS) {
        const oldest = recordedRepairIds.values().next().value;
        if (oldest === undefined) break;
        recordedRepairIds.delete(oldest);
      }
      recordedRepairIds.add(repairId);
      pendingRepairs.push({
        sessionId,
        metric: createRepairMetric(
          `repair:${event.toolCallId}:${kind}`,
          timestamp,
          model,
          event.toolName,
          kind,
          "auto_repaired",
          TOOL_INPUT_REPAIR_VERSION,
        ),
      });
    }
  };

  pi.on("tool_call", recordRepairs);
  pi.on("tool_result", recordRepairs);

  const enqueueFlush = (ctx: ExtensionContext, notifyFailure: boolean): Promise<void> => {
    // Capture context-owned Session data synchronously; queued callbacks must not
    // dereference a context invalidated by session replacement or shutdown.
    const branch = ctx.sessionManager.getBranch();
    const checkpointIndex = findCheckpointIndex(branch);
    const snapshot = {
      branch: branch.slice(checkpointIndex + 1),
      initialModel: modelBeforeIndex(branch, checkpointIndex),
      sessionId: ctx.sessionManager.getSessionId(),
    };
    const pending = flushTail.then(async () => {
      // Take repairs only when this serialized flush begins. If the preceding
      // flush requeued a failed batch, the next queued flush can persist it.
      const repairBatch = takePendingRepairs(pendingRepairs, snapshot.sessionId);
      try {
        await flushSnapshot(pi, snapshot, repairBatch);
        aggregationWarnings.recordSuccess();
      } catch (error) {
        if (repairBatch.length > 0) {
          requeuePendingRepairs(pendingRepairs, repairBatch);
        }
        if (notifyFailure) {
          const message = error instanceof Error ? error.message : "Unknown aggregate write error.";
          if (aggregationWarnings.shouldNotify(message)) {
            try {
              ctx.ui.notify(`Tool repair aggregation skipped: ${message}`, "warning");
            } catch {
              // The session may have been replaced while a queued flush completed.
            }
          }
        }
      }
    });
    flushTail = pending;
    return pending;
  };

  pi.on("agent_settled", (_event, ctx) => enqueueFlush(ctx, true));
  pi.on("session_shutdown", (_event, ctx) => enqueueFlush(ctx, false));

  pi.registerCommand("tool-repairs", {
    description: "Copy bounded cross-session tool repair aggregates; use --json for machine output",
    handler: async (args, ctx) => {
      const option = args.trim();
      if (option !== "" && option !== "--json") {
        ctx.ui.notify("Usage: /tool-repairs [--json]", "warning");
        return;
      }

      await enqueueFlush(ctx, false);
      try {
        const store = await readAggregateStore();
        const json = option === "--json";
        const report = json
          ? `${JSON.stringify({ generatedAt: new Date().toISOString(), ...publicAggregate(store) }, null, 2)}\n`
          : formatRepairMarkdown(store);
        const delivered = await deliverRepairReport(
          ctx.cwd,
          CONFIG_DIR_NAME,
          report,
          json ? "json" : "markdown",
          ctx.mode === "tui",
          copyToClipboard,
        );
        if (delivered.destination === "clipboard") {
          ctx.ui.notify(`Copied ${store.buckets.length} cross-session tool repair bucket(s) to the clipboard.`, "info");
        } else {
          ctx.ui.notify(`Tool repair aggregate written to ${delivered.path}`, "warning");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown tool repair report error.";
        ctx.ui.notify(`Could not deliver tool repair aggregates: ${message}`, "error");
      }
    },
  });
}

async function flushSnapshot(
  pi: ExtensionAPI,
  snapshot: { branch: readonly SessionEntry[]; initialModel?: string; sessionId: string },
  repairBatch: readonly PendingRepair[],
): Promise<void> {
  const checkpointIndex = findCheckpointIndex(snapshot.branch);
  const pendingEntries = snapshot.branch.slice(checkpointIndex + 1);
  if (pendingEntries.length === 0 && repairBatch.length === 0) return;

  const metrics = collectRepairMetrics(pendingEntries, snapshot.initialModel);
  for (const repair of repairBatch) metrics.push(repair.metric);
  if (metrics.length > 0) {
    const hashes = new Array<string>(metrics.length);
    for (let index = 0; index < metrics.length; index++) {
      hashes[index] = eventHash(snapshot.sessionId, metrics[index]!.entryId);
    }
    await mergeAndPersist(metrics, hashes);
  }
  pi.appendEntry(CHECKPOINT_TYPE, {
    schemaVersion: 1,
    analyticsVersion: ANALYTICS_VERSION,
    aggregatedEvents: metrics.length,
  });
}

function takePendingRepairs(
  pending: PendingRepair[],
  sessionId: string,
): readonly PendingRepair[] {
  let batch: PendingRepair[] | undefined;
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < pending.length; readIndex++) {
    const repair = pending[readIndex]!;
    if (repair.sessionId === sessionId) {
      (batch ??= []).push(repair);
      continue;
    }
    if (writeIndex !== readIndex) pending[writeIndex] = repair;
    writeIndex++;
  }
  pending.length = writeIndex;
  return batch ?? EMPTY_PENDING_REPAIRS;
}

function requeuePendingRepairs(
  pending: PendingRepair[],
  failed: readonly PendingRepair[],
): void {
  const failedCount = Math.min(failed.length, MAX_PENDING_REPAIRS);
  const retainedCount = Math.min(pending.length, MAX_PENDING_REPAIRS - failedCount);
  pending.length = retainedCount;
  for (let index = retainedCount - 1; index >= 0; index--) {
    pending[index + failedCount] = pending[index]!;
  }
  for (let index = 0; index < failedCount; index++) pending[index] = failed[index]!;
}

function findCheckpointIndex(entries: readonly SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom") continue;
    const customType = (entry as typeof entry & { customType?: unknown }).customType;
    if (customType === CHECKPOINT_TYPE) return index;
  }
  return -1;
}

function modelBeforeIndex(entries: readonly SessionEntry[], exclusiveIndex: number): string | undefined {
  for (let index = exclusiveIndex - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const { provider, model } = entry.message;
    if (typeof provider === "string" && typeof model === "string") return `${provider}/${model}`;
  }
  return undefined;
}

function eventHash(sessionId: string, entryId: string): string {
  return createHash("sha256")
    .update(sessionId)
    .update("\u0000")
    .update(entryId)
    .digest("hex")
    .slice(0, 24);
}
