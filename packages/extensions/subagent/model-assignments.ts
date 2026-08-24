import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@super-pi/coding-agent";
import { isSafeIdentifier } from "./syntax.ts";

export const SUBAGENT_MODEL_CONFIG_PATH = path.join(getAgentDir(), "subagent-models.json");
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SubagentModelAssignment {
	provider: string;
	model: string;
	thinkingLevel?: SubagentThinkingLevel;
}

export type SubagentModelCommand =
	| { action: "interactive" }
	| { action: "list" }
	| { action: "set"; agent: string; assignment: SubagentModelAssignment }
	| { action: "clear"; agent: string }
	| { action: "clear-all" };

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ASSIGNMENTS = 64;
const MAX_MODEL_ID_LENGTH = 500;
const MAX_COMMAND_LENGTH = 2048;
let nextTempId = 1;

function isThinkingLevel(value: unknown): value is SubagentThinkingLevel {
	for (const level of THINKING_LEVELS) if (value === level) return true;
	return false;
}

function isModelId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_MODEL_ID_LENGTH) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x20 || code === 0x7F) return false;
	}
	return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, first: string, second: string, third?: string): boolean {
	let count = 0;
	for (const key of Object.keys(record)) {
		if (key !== first && key !== second && key !== third) return false;
		count++;
	}
	return count === (third === undefined ? 2 : (record[third] === undefined ? 2 : 3));
}

export function parseModelAssignments(content: string): Map<string, SubagentModelAssignment> {
	if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new Error("Subagent model assignment file exceeds 64 KiB.");
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch { throw new Error("Subagent model assignment file is not valid JSON."); }
	if (!isPlainRecord(parsed)
		|| !hasOnlyKeys(parsed, "schemaVersion", "assignments")
		|| parsed.schemaVersion !== 1
		|| !isPlainRecord(parsed.assignments)) {
		throw new Error("Subagent model assignment file must use only schemaVersion 1 and an assignments object.");
	}
	const assignments = new Map<string, SubagentModelAssignment>();
	for (const agent of Object.keys(parsed.assignments).sort()) {
		if (assignments.size >= MAX_ASSIGNMENTS) throw new Error(`Subagent model assignments exceed ${MAX_ASSIGNMENTS} entries.`);
		if (!isSafeIdentifier(agent)) throw new Error(`Invalid subagent name in model assignments: ${agent}`);
		const raw = parsed.assignments[agent];
		if (!isPlainRecord(raw)
			|| !hasOnlyKeys(raw, "provider", "model", "thinkingLevel")
			|| !isSafeIdentifier(raw.provider, 128)
			|| !isModelId(raw.model)
			|| (raw.thinkingLevel !== undefined && !isThinkingLevel(raw.thinkingLevel))) {
			throw new Error(`Invalid model assignment for subagent: ${agent}`);
		}
		assignments.set(agent, {
			provider: raw.provider,
			model: raw.model,
			...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel }),
		});
	}
	return assignments;
}

export function loadModelAssignments(filePath = SUBAGENT_MODEL_CONFIG_PATH): Map<string, SubagentModelAssignment> {
	try { return parseModelAssignments(fs.readFileSync(filePath, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
}

function serializedAssignments(assignments: ReadonlyMap<string, SubagentModelAssignment>): string {
	if (assignments.size > MAX_ASSIGNMENTS) throw new Error(`Subagent model assignments exceed ${MAX_ASSIGNMENTS} entries.`);
	const output: Record<string, SubagentModelAssignment> = Object.create(null) as Record<string, SubagentModelAssignment>;
	const names = [...assignments.keys()].sort();
	for (const name of names) {
		if (!isSafeIdentifier(name)) throw new Error(`Invalid subagent name in model assignments: ${name}`);
		const assignment = assignments.get(name);
		if (!assignment
			|| !isSafeIdentifier(assignment.provider, 128)
			|| !isModelId(assignment.model)
			|| (assignment.thinkingLevel !== undefined && !isThinkingLevel(assignment.thinkingLevel))) {
			throw new Error(`Invalid model assignment for subagent: ${name}`);
		}
		output[name] = { ...assignment };
	}
	const content = `${JSON.stringify({ schemaVersion: 1, assignments: output }, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new Error("Subagent model assignment file exceeds 64 KiB.");
	return content;
}

export function saveModelAssignments(
	assignments: ReadonlyMap<string, SubagentModelAssignment>,
	filePath = SUBAGENT_MODEL_CONFIG_PATH,
): void {
	const content = serializedAssignments(assignments);
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${nextTempId++}.tmp`);
	try {
		fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		fs.renameSync(tempPath, filePath);
	} finally {
		try { fs.rmSync(tempPath, { force: true }); } catch { /* Exact temporary file cleanup only. */ }
	}
}

function tokenizeCommand(value: string): string[] {
	const tokens: string[] = [];
	let start = -1;
	for (let index = 0; index <= value.length; index++) {
		const code = index < value.length ? value.charCodeAt(index) : 0x20;
		const whitespace = code === 0x20 || code === 0x09 || code === 0x0D || code === 0x0A;
		if (!whitespace && start < 0) start = index;
		if (whitespace && start >= 0) {
			tokens.push(value.slice(start, index));
			start = -1;
		}
	}
	return tokens;
}

export function parseModelAssignmentCommand(args: string | undefined): SubagentModelCommand {
	const input = args ?? "";
	if (input.length > MAX_COMMAND_LENGTH) throw new Error(`Subagent model command exceeds ${MAX_COMMAND_LENGTH} characters.`);
	const tokens = tokenizeCommand(input);
	if (tokens.length === 0) return { action: "interactive" };
	if (tokens.length === 1 && tokens[0] === "list") return { action: "list" };
	if (tokens.length === 1 && tokens[0] === "clear-all") return { action: "clear-all" };
	if (tokens.length === 2 && tokens[0] === "clear" && isSafeIdentifier(tokens[1])) {
		return { action: "clear", agent: tokens[1] };
	}
	if ((tokens.length === 4 || tokens.length === 5)
		&& tokens[0] === "set"
		&& isSafeIdentifier(tokens[1])
		&& isSafeIdentifier(tokens[2], 128)
		&& isModelId(tokens[3])
		&& (tokens.length === 4 || isThinkingLevel(tokens[4]))) {
		return {
			action: "set",
			agent: tokens[1],
			assignment: {
				provider: tokens[2],
				model: tokens[3],
				...(tokens.length === 5 ? { thinkingLevel: tokens[4] as SubagentThinkingLevel } : {}),
			},
		};
	}
	throw new Error("Usage: /subagent-model [list | set <agent> <provider> <model> [off|minimal|low|medium|high|xhigh|max] | clear <agent> | clear-all]");
}

export function formatModelAssignments(assignments: ReadonlyMap<string, SubagentModelAssignment>): string {
	if (assignments.size === 0) return "No subagent model assignments. Unassigned roles inherit the parent session model.";
	const lines = ["Subagent model assignments:"];
	for (const agent of [...assignments.keys()].sort()) {
		const assignment = assignments.get(agent)!;
		lines.push(`- ${agent}: ${assignment.provider}/${assignment.model}${assignment.thinkingLevel ? ` thinking:${assignment.thinkingLevel}` : ""}`);
	}
	return lines.join("\n");
}
