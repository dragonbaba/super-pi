import type { ToolDefinition } from "../extensions/types.ts";
import type { MutationStatus } from "./native-file-core.ts";
import type { BatchInput, Operation } from "./file-batch-protocol.ts";
import { batchExpandedSummary, BatchResultText, releaseBatchRenderState, displayMetadata, type ChangePreview } from "./change-preview.ts";
import { RELEASE_TOOL_RENDER_DERIVED_STATE } from "../tools/tool-render-lifecycle.ts";
import { commitSummary } from "./file-commit.ts";

export interface ItemResult { itemId: string; operation: Operation; target: string; destination?: string; status: MutationStatus | "preview"; stateChanged: boolean | "unknown"; requiresVerification?: true; reason?: string; receipt?: unknown; preview?: ChangePreview }

export function formatBatchResult(input: Pick<BatchInput, "dryRun">, results: ItemResult[], plannedDirectories: string[]) {
    let succeeded = 0, failed = 0, notStarted = 0;
    let requiresVerification = false;
    let firstReason: string | undefined;
    for (const result of results) { requiresVerification ||= Boolean(result.requiresVerification); if (result.status === "succeeded") succeeded++; else if (result.status === "not_started") notStarted++; else if (result.status !== "preview") { failed++; firstReason ??= result.reason; } }
    const preview = input.dryRun === true;
    let summary = preview ? failed === 0 ? `Preflight passed for ${results.length} items. No changes; apply revalidates and requires current authorization.`
      : `Preflight failed. No changes; ${failed} failed, ${notStarted} not started.${firstReason ? `\n${displayMetadata(firstReason)}` : ""}`
      : `file_batch: ${succeeded} succeeded, ${failed} failed, ${notStarted} not started.${firstReason ? `\n${displayMetadata(firstReason)}` : ""}`;
    if (requiresVerification) summary += "\nVerify current state and any retained candidate; do not automatically retry uncertain items.";
    const collapsedSummary = summary;
    if (!preview) for (const result of results) {
      const receipt = result.receipt as any;
      summary += `\n${displayMetadata(result.itemId)}: ${result.status === "succeeded" && receipt?.created ? "Added" : result.operation} ${displayMetadata(result.target)}: ${result.status}`;
      if (receipt?.commit) summary += `\n${commitSummary(receipt.commit)}`;
      if (result.status === "succeeded" && receipt?.creation) {
        summary += receipt.creation.addedLines === undefined ? ` (${receipt.creation.bytes} bytes)` : ` (+${receipt.creation.addedLines} -0)`;
        if (receipt.creation.createdDirectories.length) summary += `; created ${receipt.creation.createdDirectories.length} parent directories`;
      }
    }
    const expandedSummary = batchExpandedSummary(collapsedSummary, results, plannedDirectories);
    return { content: [{ type: "text" as const, text: summary }], details: { mutationReceiptVersion: 2, operation: "file_batch", preview, collapsedSummary, expandedSummary, plannedDirectories, succeeded, failed, notStarted, items: results }, isError: failed > 0 };
}

export const renderBatchResult: NonNullable<ToolDefinition<any, any>["renderResult"]> = function renderBatchResult(result, options, _theme, context) {
  const component = context.lastComponent instanceof BatchResultText ? context.lastComponent : new BatchResultText("", 0, 0);
  context.state.batchComponent = component;
  context.state[RELEASE_TOOL_RENDER_DERIVED_STATE] = releaseBatchRenderState;
  const primary = result.content[0];
  const full = primary?.type === "text" ? primary.text : "";
  component.setBatchText(options.isPartial ? "File batch running" : options.expanded ? result.details?.expandedSummary ?? full : result.details?.collapsedSummary ?? full);
  return component;
};
