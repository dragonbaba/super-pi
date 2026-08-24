import type { ExtensionAPI, ToolDefinition } from "@super-pi/coding-agent";
import { Type, type TSchema } from "typebox";
import {
	formatStatus,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	type GoalRuntime,
	goalIdRejectionReason,
	isContradictoryCompletionSummary,
	STATUS_KEY,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	return tool;
}

const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime) {
	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
		label: "Goal Complete",
		description:
			"Complete the active /goal only after every requirement is implemented and verified. Requires the current goal_id.",
		promptSnippet: "Complete a fully verified active goal",
		promptGuidelines: [
			"Audit every requirement before completion; otherwise keep working.",
			"Pass only the exact current goal_id; never reuse a stale id.",
		],
		parameters: Type.Object({
			goal_id: Type.String({ description: "Exact current goal_id stale-turn guard." }),
			summary: Type.String({ description: "Completed work and verification evidence." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const completedGoal = runtime.activeGoal;
			const goal = completedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";

			if (!completedGoal) {
				const rejection = "Goal completion rejected: no active goal.";
				ctx.ui.notify(rejection, "warning");

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}
			const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
			if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
				const rejection = "Goal completion rejected: current run does not own the active goal.";
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}
			if (hasPendingSkipForGoal(runtime, completedGoal.id)) {
				runtime.recordGoalUsage(completedGoal, ctx);
				runtime.persistGoal(completedGoal);
				runtime.updateStatus(ctx, completedGoal);
				runtime.clearBudgetWrapUp();
				const rejection = "Goal completion rejected: goal is queued to be skipped.";
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
			if (staleGoalRejection) {
				const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
				ctx.ui.notify(rejection, "warning");
				if (completingDuringBudgetWrapUp) {
					runtime.recordGoalUsage(completedGoal, ctx);
					runtime.persistGoal(completedGoal);
					runtime.updateStatus(ctx, completedGoal);
					runtime.clearBudgetWrapUp();
				}

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}
			if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
				const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
				ctx.ui.notify(rejection, "warning");

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}

			const rejectionReason = !summary
				? "summary is empty"
				: isContradictoryCompletionSummary(summary)
					? "summary says the goal is not complete"
					: undefined;
			if (rejectionReason) {
				runtime.recordGoalUsage(completedGoal, ctx);
				runtime.persistGoal(completedGoal);
				runtime.updateStatus(ctx, completedGoal);
				const rejection = `Goal completion rejected: ${rejectionReason}.`;
				ctx.ui.notify(rejection, "warning");
				if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

				return {
					content: [
						{
							type: "text",
							text: rejection,
						},
					],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}

			runtime.activeGoal = transitionGoal(completedGoal, "complete");
			runtime.setCompletionSummary(runtime.activeGoal.id, summary);
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			if (runtime.pendingQueueAction?.kind === "prioritize") {
				runtime.persistGoal(runtime.activeGoal);
				ctx.ui.setStatus(STATUS_KEY, "complete");
				ctx.ui.notify(`Goal complete: ${goal}. Priority goal waits for Pi to settle.`, "info");
				return {
					content: [{ type: "text", text: `Goal complete: ${summary}` }],
					details: {
						goal,
						goal_id: requestedGoalId,
						summary,
					} satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			if (runtime.queuedGoals.length > 0) {
				runtime.pendingQueueAction = {
					kind: "advance",
					goalId: runtime.activeGoal.id,
					reason: "complete",
					completedText: goal,
				};
				runtime.persistGoal(runtime.activeGoal);
				ctx.ui.setStatus(STATUS_KEY, "complete");
				ctx.ui.notify(
					`Goal complete: ${goal}. Next goal queued: ${runtime.queuedGoals[0]?.text}`,
					"info",
				);
				return {
					content: [
						{
							type: "text",
							text: `Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`,
						},
					],
					details: {
						goal,
						goal_id: requestedGoalId,
						summary,
					} satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			runtime.persistGoal(runtime.activeGoal);

			ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
			runtime.clearActiveGoal(ctx);
			runtime.showCompletionStatus(ctx);
			ctx.ui.notify(`Goal complete: ${goal}`, "info");

			return {
				content: [{ type: "text", text: `Goal complete: ${summary}` }],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				terminate: true,
			};
		},
	});

	const goalBlockedTool = defineTool({
		name: GOAL_BLOCKED_TOOL,
		label: "Goal Blocked",
		description:
			"Block the active /goal only after the same true impasse recurs for three turns and user/external action is required. Requires current goal_id and evidence.",
		promptSnippet: "Block a repeatedly proven external impasse",
		promptGuidelines: [
			"Do not block for incomplete, uncertain, difficult, or recoverable work; after resume, count three fresh turns.",
			"Pass only the exact current goal_id.",
		],
		parameters: Type.Object({
			goal_id: Type.String({ description: "Exact current goal_id." }),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_REASON_LENGTH,
				description: "Required user/external action.",
			}),
			evidence: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
				description: "Evidence proving the repeated impasse.",
			}),
			repeated_turns: Type.Integer({
				minimum: 3,
				description: "Consecutive turns with this blocker.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const blockedGoal = runtime.activeGoal;
			const goal = blockedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
			const repeatedTurns =
				typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
			const reject = (rejectionReason: string, terminate = false) => {
				const rejection = `goal_blocked rejected: ${rejectionReason}.`;
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text" as const, text: rejection }],
					details: {
						goal,
						goal_id: requestedGoalId,
						reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
						evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
						repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
					} satisfies GoalBlockedDetails,
					...(terminate ? { terminate: true as const } : {}),
				};
			};

			if (!blockedGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			if (hasPendingSkipForGoal(runtime, blockedGoal.id)) {
				runtime.recordGoalUsage(blockedGoal, ctx);
				runtime.persistGoal(blockedGoal);
				runtime.updateStatus(ctx, blockedGoal);
				runtime.clearBudgetWrapUp();
				return reject("goal is queued to be skipped", true);
			}
			const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (blockedGoal.status !== "active") {
				return reject(`goal is ${blockedGoal.status}, not active`);
			}
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
			if (!evidence) return reject("evidence is empty");
			if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
			if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
			if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

			const stoppedGoal = runtime.stopActiveGoal(ctx, {
				kind: "blocker_report",
				expectedGoalId: blockedGoal.id,
				reason,
			});
			if (!stoppedGoal) return reject("active goal changed before blocker transition");
			ctx.ui.notify(`Goal blocked: ${truncateNotification(reason)}`, "warning");

			return {
				content: [{ type: "text", text: `Goal blocked: ${reason}` }],
				details: {
					goal,
					goal_id: requestedGoalId,
					reason,
					evidence,
					repeated_turns: repeatedTurns,
				} satisfies GoalBlockedDetails,
				terminate: true,
			};
		},
	});

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);
}

function hasPendingSkipForGoal(runtime: GoalRuntime, goalId: string) {
	return (
		runtime.pendingQueueAction?.kind === "advance" &&
		runtime.pendingQueueAction.reason === "skip" &&
		runtime.pendingQueueAction.goalId === goalId
	);
}
