import type { ExtensionAPI, ToolDefinition } from "@super-pi/coding-agent";
import { withFileMutationQueue } from "@super-pi/coding-agent";
import { Text } from "@super-pi/tui";
import { Type } from "typebox";
import { consumePermissionPathApproval } from "../resource-lifecycle-guard/permission-contract.ts";
import type { MutationWriteGuard } from "./core.ts";
import { executeNativePlan, nativeFailure, validateNativeInput, type NativeInput, type NativeOperation, type NativeReceipt } from "./native-file-core.ts";

export const MUTATION_PROGRESS_ENTRY = "file-mutation-progress-v2";

/** Final bounded text is constructed at completion, never reserialized on render. */
export const renderFileMutationResult: NonNullable<ToolDefinition<any, any>["renderResult"]> = function renderFileMutationResult(result, options, _theme, context) {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const primary = result.content[0];
  component.setText(options.isPartial ? "File operation running" : primary?.type === "text" ? primary.text : "");
  return component;
};

/** Same queue as edit/write, with a total ordering and no duplicate lock acquisition. */
export async function withMutationPaths<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  async function acquire(index: number): Promise<T> {
    return index === ordered.length ? run() : withFileMutationQueue(ordered[index], () => acquire(index + 1));
  }
  return acquire(0);
}

export function registerNativeTools(pi: ExtensionAPI, guard: MutationWriteGuard, generation: () => number): void {
  for (const operation of ["delete", "move"] as const) {
    const properties = {
      path: Type.String({ minLength: 1, maxLength: 4096, description: "One literal existing file path; delete also accepts an empty directory." }),
      purpose: Type.Optional(Type.String({ maxLength: 800, description: "Reason and effects; deletion is irreversible and creates no backup." })),
    };
    pi.registerTool({
      name: operation,
      label: operation,
      description: operation === "delete" ? "Irreversibly delete one ordinary file or empty directory. No recursion, glob or backup. Requires current native path authorization."
        : "Move one ordinary file on the same filesystem without replacement. Exclusive hard link then unlink; partial failure can leave both names. No automatic rollback or replay.",
      parameters: operation === "move" ? Type.Object({ ...properties, destination: Type.String({ minLength: 1, maxLength: 4096, description: "Absent destination with an existing parent directory." }) }, { additionalProperties: false })
        : Type.Object(properties, { additionalProperties: false }),
      executionMode: "sequential",
      renderResult: renderFileMutationResult,
      async execute(toolCallId, input: NativeInput, signal, _onUpdate, ctx) {
        validateNativeInput(operation, input);
        const approval = consumePermissionPathApproval(input, toolCallId, operation);
        if (!approval?.nativePlan || !approval.assertCurrent || approval.nativePlan.cwd !== ctx.cwd) throw new Error("[POLICY_BLOCKED] Native file operation requires a current one-call permission grant.");
        const plan = approval.nativePlan;
        let reservation: number | undefined;
        let receipt: NativeReceipt;
        try {
          receipt = await withMutationPaths(plan.destination ? [plan.source.canonical, plan.destination] : [plan.source.canonical], async () => {
            await guard.assertNativeEvidence(plan.source.canonical);
            reservation = guard.reserveNativeMutation(generation(), plan.source.canonical, plan.destination);
            signal?.throwIfAborted();
            approval.assertCurrent!();
            pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "intent", operation, target: plan.source.canonical, destination: plan.destination });
            return executeNativePlan(plan, approval.assertCurrent!, signal);
          });
        } catch (error) { receipt = nativeFailure(plan, error, signal?.aborted ? "cancelled" : "failed_no_change"); }
        if (receipt.stateChanged === false) guard.releaseMutation(reservation);
        else {
          await guard.invalidate(ctx.cwd, plan.source.canonical);
          if (plan.destination) await guard.invalidate(ctx.cwd, plan.destination);
        }
        try { pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "result", ...receipt }); }
        catch (error) {
          if (receipt.stateChanged !== false) receipt = nativeFailure(plan, error, "state_unknown");
        }
        return nativeToolResult(receipt);
      },
    });
  }
}

export function nativeToolResult(receipt: NativeReceipt) {
  return { content: [{ type: "text" as const, text: `${receipt.operation}: ${receipt.status}; ${receipt.target}${receipt.destination ? ` -> ${receipt.destination}` : ""}${receipt.cause ? `\n${receipt.cause}` : ""}${receipt.requiresVerification ? "\nVerify current state before further action. Do not automatically retry." : ""}` }],
    details: receipt, isError: !receipt.ok };
}
