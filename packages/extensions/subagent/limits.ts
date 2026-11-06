// Compatibility entry; implementation is owned by the native session layer.
export * from "@super-pi/coding-agent/internal/tasks/limits";
import { HARD_MAX_CONCURRENT, HARD_MAX_TASKS, type SubagentLimits } from "@super-pi/coding-agent/internal/tasks/limits";

export function describeSubagentLimits(limits: SubagentLimits): string {
	return `Subagent limits: ${limits.maxConcurrent} running concurrently; ${limits.maxTasks} tasks per call and reserved across unfinished calls in this session runtime. Batch slots release when that call finishes. Hard ceilings: ${HARD_MAX_CONCURRENT} concurrent, ${HARD_MAX_TASKS} tasks. Excess concurrency queues; excess task count is rejected before launch. Limits are ceilings, not targets.`;
}

export const DELEGATION_GUIDANCE = "Delegate only independently useful work; use the fewest agents that cover the work. Give each child one distinct objective, exact scope, existing evidence, verifiable deliverable and stop condition. Scout locates facts; planner produces a plan; reviewer reports actionable defects; worker implements the assigned change. State whether the child's effective tools can run verification commands; the default worker has no shell, so the parent owns command-based verification. Do not launch a role whose output you already have, duplicate investigations, or automatically add planning/review/fix stages. Keep dependencies sequential. Parent-routed writers share the parent's scope and require foreground or chain execution; a different cwd alone does not isolate them. Use readOnly for parallel/background research. Require concise results with evidence locations; completion or a blocker ends the assignment.";
