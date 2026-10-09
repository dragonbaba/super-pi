import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "@super-pi/coding-agent";

export interface SubagentLimits {
	readonly maxConcurrent: number;
	readonly maxTasks: number;
}

export const HARD_MAX_CONCURRENT = 64;
export const HARD_MAX_TASKS = 256;
export const DEFAULT_LIMITS: SubagentLimits = Object.freeze({ maxConcurrent: 16, maxTasks: 64 });
export const SUBAGENT_LIMITS_PATH = join(getConfigDir(), "subagent-limits.json");
const MAX_CONFIG_BYTES = 4096;

export function parseSubagentLimits(content: string, label = "Subagent"): SubagentLimits {
	if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new Error(`${label} limits file exceeds 4096 bytes.`);
	let value: unknown;
	try { value = JSON.parse(content); }
	catch { throw new Error(`${label} limits file must contain valid JSON.`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} limits must be an object.`);
	const config = value as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "maxConcurrent" && key !== "maxTasks") throw new Error(`Unknown ${label.toLowerCase()} limit: ${key}.`);
	}
	const maxConcurrent = config.maxConcurrent === undefined ? DEFAULT_LIMITS.maxConcurrent : config.maxConcurrent;
	const maxTasks = config.maxTasks === undefined ? DEFAULT_LIMITS.maxTasks : config.maxTasks;
	if (!Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1 || (maxConcurrent as number) > HARD_MAX_CONCURRENT) {
		throw new Error(`${label} maxConcurrent must be an integer from 1 to ${HARD_MAX_CONCURRENT}.`);
	}
	if (!Number.isSafeInteger(maxTasks) || (maxTasks as number) < 1 || (maxTasks as number) > HARD_MAX_TASKS) {
		throw new Error(`${label} maxTasks must be an integer from 1 to ${HARD_MAX_TASKS}.`);
	}
	if ((maxConcurrent as number) > (maxTasks as number)) throw new Error(`${label} maxConcurrent cannot exceed maxTasks.`);
	return Object.freeze({ maxConcurrent: maxConcurrent as number, maxTasks: maxTasks as number });
}

export function loadSubagentLimits(filePath = SUBAGENT_LIMITS_PATH, label = "Subagent"): SubagentLimits {
	let fd: number;
	try { fd = openSync(filePath, "r"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_LIMITS;
		throw error;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error(`${label} limits must be a file of at most 4096 bytes.`);
		const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length > MAX_CONFIG_BYTES) throw new Error(`${label} limits file exceeds 4096 bytes.`);
		return parseSubagentLimits(buffer.toString("utf8", 0, length), label);
	} finally { closeSync(fd); }
}

export function describeSubagentLimits(limits: SubagentLimits): string {
	return `Subagent limits: ${limits.maxConcurrent} running concurrently; ${limits.maxTasks} tasks per call and reserved across unfinished calls in this session runtime. Batch slots release when that call finishes. Hard ceilings: ${HARD_MAX_CONCURRENT} concurrent, ${HARD_MAX_TASKS} tasks. Excess concurrency queues; excess task count is rejected before launch. Limits are ceilings, not targets.`;
}

export const DELEGATION_GUIDANCE = "Delegate only independently useful work; use the fewest agents that cover the work. Give each child one distinct objective, exact scope, existing evidence, verifiable deliverable and stop condition. Scout locates facts; planner produces a plan; reviewer reports actionable defects; worker implements the assigned change. State whether the child's effective tools can run verification commands; the default worker has no shell, so the parent owns command-based verification. Do not launch a role whose output you already have, duplicate investigations, or automatically add planning/review/fix stages. Keep dependencies sequential and give parallel writers disjoint ownership in isolated workspaces; use readOnly for research. Require concise results with evidence locations; completion or a blocker ends the assignment.";
