import { Type } from "typebox";

export const MAX_TASK_CHARS = 16 * 1024;
const MAX_FIELD_CHARS = 1024;
const SCOPE_LABEL = "\n\nScope: ";
const DELIVERABLE_LABEL = "\nDeliverable: ";
const STOP_LABEL = "\nStop condition: ";
const FIELDS = ["scope", "deliverable", "stopCondition"] as const;

export const assignmentProperties = {
	scope: Type.String({ minLength: 1, maxLength: MAX_FIELD_CHARS, description: "Required: exact files, subsystem or question in scope; exclusions where needed. Does not grant file permissions." }),
	deliverable: Type.String({ minLength: 1, maxLength: MAX_FIELD_CHARS, description: "Required: concrete result the parent can verify; concise findings with evidence locations, plan, or scoped changes and checks." }),
	stopCondition: Type.String({ minLength: 1, maxLength: MAX_FIELD_CHARS, description: "Required: observable completion condition. Stop and report if blocked or further work would exceed scope." }),
};

export interface Assignment {
	task?: string;
	scope?: string;
	deliverable?: string;
	stopCondition?: string;
}

/** Admission only: validate the whole bounded batch before discovering or starting children. */
export function assertAssignments(input: unknown): void {
	if (!input || typeof input !== "object") throw new Error("Subagent requires a task with scope, deliverable and stopCondition; no task was started.");
	const params = input as { tasks?: unknown; chain?: unknown };
	if (Array.isArray(params.tasks)) {
		for (let i = 0; i < params.tasks.length; i++) assertAssignment(params.tasks[i], `tasks[${i}]`);
	} else if (Array.isArray(params.chain)) {
		for (let i = 0; i < params.chain.length; i++) assertAssignment(params.chain[i], `chain[${i}]`);
	} else assertAssignment(input, "task");
}

function assertAssignment(value: unknown, label: string): void {
	const item = value as Assignment | null;
	for (const key of FIELDS) {
		const field = item?.[key];
		if (typeof field !== "string" || !field.trim() || field.length > MAX_FIELD_CHARS) {
			throw new Error(`Subagent ${label}.${key} must be nonblank text of at most ${MAX_FIELD_CHARS} characters; no task was started.`);
		}
	}
	if (!item || typeof item.task !== "string" || !item.task.trim()) throw new Error(`Subagent ${label} requires a nonblank task objective; no task was started.`);
	assertAssignmentLength(item, item.task);
}

function assertAssignmentLength(item: Assignment, task: string): void {
	const length = task.length + item.scope!.length + item.deliverable!.length + item.stopCondition!.length + SCOPE_LABEL.length + DELIVERABLE_LABEL.length + STOP_LABEL.length;
	if (length > MAX_TASK_CHARS) throw new Error(`Subagent task plus responsibility fields exceeds ${MAX_TASK_CHARS} characters; shorten the assignment before launch.`);
}

/** One materialization per launch, including a chain's bounded previous result. */
export function formatAssignment(item: Assignment, task: string): string {
	assertAssignmentLength(item, task);
	return `${task}${SCOPE_LABEL}${item.scope}${DELIVERABLE_LABEL}${item.deliverable}${STOP_LABEL}${item.stopCondition}`;
}

export const CHILD_RESPONSIBILITIES = "You own only this assignment. Follow its objective, scope, deliverable and stop condition within the delegated tools and permissions. Reuse supplied evidence; re-check it only when it may be stale or insufficient. Do not repeat completed investigation, expand scope, or pursue optional improvements. Use the smallest checks needed to verify the deliverable. Return immediately when done; if blocked, report the blocker, evidence and the smallest next action to the parent. Return concise results, changed files or evidence locations, verification and unresolved issues; omit raw logs and repeated context. The task has no token or turn quota; the runtime deadline still applies.";
