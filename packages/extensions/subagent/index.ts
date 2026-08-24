/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import type { AgentToolResult } from "@super-pi/agent-core";
import type { Message } from "@super-pi/ai";
import { StringEnum } from "@super-pi/ai";
import { getSupportedThinkingLevels } from "@super-pi/ai/compat";
import {
	VERSION,
	type ExtensionAPI,
	type ExtensionCommandContext,
	withFileMutationQueue,
} from "@super-pi/coding-agent";
import { Text } from "@super-pi/tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { assertProjectAgentAccess, buildChildEnvironment, canonicalWorkspace } from "./child-security.ts";
import { consumeDelegatedTaskPolicies, type DelegatedTaskPolicy } from "./delegation.ts";
import {
	formatModelAssignments,
	loadModelAssignments,
	parseModelAssignmentCommand,
	saveModelAssignments,
	type SubagentThinkingLevel,
} from "./model-assignments.ts";
import {
	GENERIC_RUNTIME_PATTERN,
	SUPPORTED_SP_VERSION_PATTERN,
	TRUNCATED_SUFFIX_PATTERN,
	UNSAFE_FILE_NAME_PATTERN,
} from "./regex.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_TRANSPORT_BYTES = 128 * 1024 * 1024;
const MAX_JSON_TRANSPORT_EVENTS = 500_000;
const MAX_RETAINED_JSON_EVENTS = 100_000;
const MAX_MESSAGES = 3;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_RETAINED_TEXT_BYTES = 24 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024;
const MAX_TASK_CHARS = 16 * 1024;
const MAX_PREVIOUS_CHARS = 50 * 1024;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_AGENT_TOOLS = Object.freeze(["read", "grep", "find", "ls"] as const);
const BUILTIN_AGENT_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);
const CHILD_GUARD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-guard.ts");

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatElapsedMs(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatAgentUsage(usage: UsageStats): string {
	let text = `${usage.turns} turn${usage.turns === 1 ? "" : "s"} ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
	if (usage.cacheRead) text += ` R${formatTokens(usage.cacheRead)}`;
	if (usage.cacheWrite) text += ` W${formatTokens(usage.cacheWrite)}`;
	text += ` $${usage.cost.toFixed(4)}`;
	if (usage.contextTokens > 0) text += ` ctx:${formatTokens(usage.contextTokens)}`;
	return text;
}

export function countTextLines(value: string): number {
	let count = 1;
	for (let offset = value.indexOf("\n"); offset >= 0; offset = value.indexOf("\n", offset + 1)) count++;
	return count;
}

export interface ResolvedSubagentExecution {
	provider: string;
	model: string;
	thinkingLevel?: SubagentThinkingLevel;
	authEnv: Readonly<Record<string, string | undefined>>;
}

export function appendSubagentModelArgs(args: string[], execution: ResolvedSubagentExecution | undefined): void {
	if (!execution) return;
	args.push("--provider", execution.provider, "--model", execution.model);
	if (execution.thinkingLevel) args.push("--thinking", execution.thinkingLevel);
}

const INHERIT_ROUTE_LABEL = "继承父会话（清除当前分配）";
const INHERIT_THINKING_LABEL = "继承父会话思考等级";

export type InteractiveModelAssignment =
	| { action: "clear"; agent: string }
	| { action: "set"; agent: string; assignment: { provider: string; model: string; thinkingLevel?: SubagentThinkingLevel } };

export async function promptSubagentModelAssignment(
	ctx: ExtensionCommandContext,
	agents: readonly AgentConfig[],
	assignments: ReadonlyMap<string, { provider: string; model: string; thinkingLevel?: SubagentThinkingLevel }>,
): Promise<InteractiveModelAssignment | undefined> {
	const roleByLabel = new Map<string, string>();
	const sortedAgents = agents.slice();
	sortedAgents.sort((left, right) => left.name.localeCompare(right.name));
	for (const agent of sortedAgents) {
		const current = assignments.get(agent.name);
		const route = current
			? `${current.provider}/${current.model}${current.thinkingLevel ? ` thinking:${current.thinkingLevel}` : ""}`
			: "继承父会话";
		roleByLabel.set(`${agent.name} — ${route}`, agent.name);
	}
	if (roleByLabel.size === 0) {
		ctx.ui.notify("No subagent roles are available in the current scope.", "warning");
		return undefined;
	}
	const roleLabel = await ctx.ui.select("选择子代理角色", [...roleByLabel.keys()]);
	const agent = roleLabel ? roleByLabel.get(roleLabel) : undefined;
	if (!agent) return undefined;

	const models = ctx.modelRegistry.getAvailable();
	const providerSet = new Set<string>();
	for (const model of models) providerSet.add(model.provider);
	const providerOptions = [INHERIT_ROUTE_LABEL];
	const providers = Array.from(providerSet);
	providers.sort();
	for (const provider of providers) providerOptions.push(provider);
	const provider = await ctx.ui.select("选择模型供应商", providerOptions);
	if (!provider) return undefined;
	if (provider === INHERIT_ROUTE_LABEL) return { action: "clear", agent };

	const modelByLabel = new Map<string, (typeof models)[number]>();
	const providerModels: (typeof models)[number][] = [];
	for (const model of models) if (model.provider === provider) providerModels.push(model);
	providerModels.sort((left, right) => left.id.localeCompare(right.id));
	for (const model of providerModels) {
		const label = model.name && model.name !== model.id ? `${model.id} — ${model.name}` : model.id;
		modelByLabel.set(label, model);
	}
	const modelLabel = await ctx.ui.select("选择工作模型", [...modelByLabel.keys()]);
	const model = modelLabel ? modelByLabel.get(modelLabel) : undefined;
	if (!model) return undefined;

	const supportedLevels = getSupportedThinkingLevels(model) as SubagentThinkingLevel[];
	const thinkingOptions = [INHERIT_THINKING_LABEL];
	for (const level of supportedLevels) thinkingOptions.push(level);
	const thinking = await ctx.ui.select("选择思考等级", thinkingOptions);
	if (!thinking) return undefined;
	return {
		action: "set",
		agent,
		assignment: {
			provider: model.provider,
			model: model.id,
			...(thinking === INHERIT_THINKING_LABEL ? {} : { thinkingLevel: thinking as SubagentThinkingLevel }),
		},
	};
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

const EMPTY_USAGE: UsageStats = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});
// Shared only by waiting/terminal placeholders. Active runs always own a mutable array.
const EMPTY_MESSAGES = Object.freeze([]) as unknown as Message[];

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	startedAt?: number;
	completedAt?: number;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

interface ResultStateCounts {
	waiting: number;
	running: number;
	succeeded: number;
	failed: number;
}

interface SubagentRenderState {
	latestDetails?: SubagentDetails;
	counts?: ResultStateCounts;
}

interface SubagentTheme {
	fg: (color: any, text: string) => string;
	bold: (text: string) => string;
}

class SubagentStatusText extends Text {
	private details: SubagentDetails | undefined;
	private counts: ResultStateCounts | undefined;
	private theme: SubagentTheme | undefined;
	private renderedText = "";

	setStatus(details: SubagentDetails, counts: ResultStateCounts, theme: SubagentTheme): void {
		this.details = details;
		this.counts = counts;
		this.theme = theme;
		this.refreshStatus();
	}

	override setText(text: string): void {
		this.details = undefined;
		this.counts = undefined;
		this.theme = undefined;
		this.renderedText = text;
		super.setText(text);
	}

	private refreshStatus(): void {
		const details = this.details;
		const counts = this.counts;
		const theme = this.theme;
		if (!details || !counts || !theme) return;
		let text = theme.fg(
			counts.failed > 0 ? "error" : counts.running > 0 ? "warning" : counts.waiting > 0 ? "muted" : "success",
			`${counts.succeeded}/${details.results.length} completed`,
		);
		if (counts.running > 0) text += theme.fg("warning", ` · ${counts.running} working`);
		if (counts.waiting > 0) text += theme.fg("muted", ` · ${counts.waiting} waiting`);
		if (counts.failed > 0) text += theme.fg("error", ` · ${counts.failed} failed`);
		const now = Date.now();
		for (const result of details.results) text += `\n\n${renderAgentStatus(result, theme, now)}`;
		if (text === this.renderedText) return;
		this.renderedText = text;
		super.setText(text);
	}

	override render(width: number): string[] {
		// Elapsed text advances only when another UI event requests a render.
		this.refreshStatus();
		return super.render(width);
	}
}

function capText(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return `${result}\n[truncated]`;
}

function capTextHeadTail(value: string, maxBytes: number): string {
	const totalBytes = Buffer.byteLength(value, "utf8");
	if (totalBytes <= maxBytes) return value;
	const sideBudget = Math.max(1, Math.floor((maxBytes - 256) / 2));
	const head = capText(value, sideBudget).replace(TRUNCATED_SUFFIX_PATTERN, "");
	let tail = value.slice(-sideBudget);
	while (Buffer.byteLength(tail, "utf8") > sideBudget) tail = tail.slice(1);
	const omittedBytes = Math.max(0, totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
	return `${head}\n[truncated: ${omittedBytes} UTF-8 bytes omitted; head and tail retained]\n${tail}`;
}

function boundedJsonValue(value: unknown, maxBytes: number): unknown {
	try {
		const raw = JSON.stringify(value);
		const rawBytes = Buffer.byteLength(raw, "utf8");
		if (rawBytes <= maxBytes) return JSON.parse(raw) as unknown;
		return { truncated: true, originalBytes: rawBytes };
	} catch {
		return { truncated: true, reason: "not JSON-serializable" };
	}
}

function boundedTextContent(content: unknown): Array<{ type: "text"; text: string }> {
	if (!Array.isArray(content)) return [];
	let remaining = MAX_RETAINED_TEXT_BYTES;
	const retained: Array<{ type: "text"; text: string }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text !== "string" || remaining <= 0) continue;
		const bounded = capTextHeadTail(text, remaining);
		retained.push({ type: "text", text: bounded });
		remaining -= Buffer.byteLength(bounded, "utf8");
	}
	return retained;
}

export function jsonEventLimitReason(eventBytes: number, retainedEventCount: number): string | undefined {
	if (eventBytes > MAX_JSON_LINE_BYTES) return "Subagent JSON event exceeded 8 MiB.";
	if (retainedEventCount > MAX_RETAINED_JSON_EVENTS) return "Subagent emitted too many retained completion events.";
	return undefined;
}

export function jsonTransportLimitReason(totalBytes: number, eventCount: number): string | undefined {
	if (totalBytes > MAX_JSON_TRANSPORT_BYTES || eventCount > MAX_JSON_TRANSPORT_EVENTS) {
		return "Subagent JSON transport exceeded its bounded budget.";
	}
	return undefined;
}

export function boundedMessage(message: Message): Message {
	// Preserve useful final text structurally. Whole-JSON slicing can make valid
	// messages unparsable and used to replace successful reports with no content.
	let raw: string;
	try { raw = JSON.stringify(message); }
	catch { return { role: "assistant", content: [{ type: "text", text: "[invalid child message: not JSON-serializable]" }], timestamp: Date.now() } as Message; }
	const rawBytes = Buffer.byteLength(raw, "utf8");
	// Child events were just parsed from JSON and are not mutated after retention;
	// retaining the original avoids a second full parse and object graph allocation.
	if (rawBytes <= MAX_MESSAGE_BYTES) return message;

	const record = message as unknown as Record<string, unknown>;
	const content = Array.isArray(record.content) ? record.content : [];
	if (record.role === "assistant") {
		const retained: Array<Record<string, unknown>> = [];
		let remainingTextBytes = MAX_RETAINED_TEXT_BYTES;
		const contentLimit = Math.min(content.length, 32);
		for (let index = 0; index < contentLimit; index++) {
			const part = content[index];
			if (!part || typeof part !== "object") continue;
			const item = part as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string" && remainingTextBytes > 0) {
				const text = capTextHeadTail(item.text, remainingTextBytes);
				retained.push({ type: "text", text });
				remainingTextBytes -= Buffer.byteLength(text, "utf8");
			} else if (item.type === "toolCall" && typeof item.name === "string") {
				const retainedCall: Record<string, unknown> = {
					type: "toolCall",
					name: capText(item.name, 256),
					arguments: boundedJsonValue(item.arguments, MAX_TOOL_ARGUMENT_BYTES),
				};
				if (typeof item.id === "string") retainedCall.id = capText(item.id, 256);
				retained.push(retainedCall);
			}
		}
		retained.push({
			type: "text",
			text: `[child message reduced from ${rawBytes} UTF-8 bytes; final text retained, large traces/details removed]`,
		});
		return {
			role: "assistant",
			content: retained,
			timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
			api: typeof record.api === "string" ? capText(record.api, 256) : undefined,
			provider: typeof record.provider === "string" ? capText(record.provider, 256) : undefined,
			model: typeof record.model === "string" ? capText(record.model, 256) : undefined,
			stopReason: typeof record.stopReason === "string" ? capText(record.stopReason, 256) : undefined,
			errorMessage: typeof record.errorMessage === "string" ? capText(record.errorMessage, 4096) : undefined,
			usage: record.usage && typeof record.usage === "object" ? boundedJsonValue(record.usage, 2048) : undefined,
		} as unknown as Message;
	}

	const retainedText = boundedTextContent(content);
	return {
		role: record.role,
		content: retainedText.length > 0 ? retainedText : [{ type: "text", text: "[large child event reduced; no text content]" }],
		toolCallId: typeof record.toolCallId === "string" ? capText(record.toolCallId, 256) : undefined,
		toolName: typeof record.toolName === "string" ? capText(record.toolName, 256) : undefined,
		isError: typeof record.isError === "boolean" ? record.isError : undefined,
		timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
		details: { truncated: true, originalBytes: rawBytes },
	} as Message;
}

function appendBoundedMessage(messages: Message[], message: Message): Message {
	const bounded = boundedMessage(message);
	messages.push(bounded);
	if (messages.length > MAX_MESSAGES) messages.shift();
	return bounded;
}

export function effectiveTools(agent: AgentConfig, allowMutation: boolean): { tools: string[]; allowBash: boolean } {
	const requested = agent.tools ?? DEFAULT_AGENT_TOOLS;
	const allowBash =
		allowMutation && agent.source === "user" && agent.tools !== undefined && agent.tools.includes("bash");
	const tools: string[] = [];
	for (const tool of requested) {
		if (!BUILTIN_AGENT_TOOLS.has(tool)) continue;
		if (!allowMutation && (tool === "write" || tool === "edit" || tool === "bash")) continue;
		if (tool === "bash" && !allowBash) continue;
		if (tools.includes(tool)) continue;
		tools.push(tool);
	}
	return { tools, allowBash };
}

function findAgent(agents: readonly AgentConfig[], name: string): AgentConfig | undefined {
	for (const agent of agents) if (agent.name === name) return agent;
	return undefined;
}

export function assertSubagentBatchPreflight(
	agents: readonly AgentConfig[],
	agentNames: readonly string[],
	policies: readonly DelegatedTaskPolicy[],
	parallel: boolean,
): void {
	if (agentNames.length !== policies.length) throw new Error("Subagent preflight task count does not match delegated policies.");
	const writerCwds = new Set<string>();
	for (let index = 0; index < agentNames.length; index++) {
		const name = agentNames[index];
		const policy = policies[index];
		const agent = findAgent(agents, name);
		if (!agent) {
			const available: string[] = [];
			for (const candidate of agents) available.push(`"${candidate.name}"`);
			throw new Error(`Unknown agent role: "${name}". Choose agent from: ${available.join(", ") || "none"}. Put custom labels such as "audit-lsp" in task, not agent; no subagent was started.`);
		}
		if (agent.source === "project" && policy.source !== "primary") {
			throw new Error(`Project-local agent "${name}" cannot use a non-primary workspace. Use the primary project cwd or a user-level agent; no subagent was started.`);
		}
		if (!parallel || !policy.allowMutation) continue;
		const tools = effectiveTools(agent, true).tools;
		if (!tools.includes("write") && !tools.includes("edit") && !tools.includes("bash")) continue;
		if (writerCwds.has(policy.canonicalCwd)) {
			throw new Error(`Parallel mutation-capable tasks share cwd "${policy.canonicalCwd}". Use chain/sequential execution or set readOnly: true on all but one task; task text alone does not change capabilities. No subagent was started.`);
		}
		writerCwds.add(policy.canonicalCwd);
	}
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || Boolean(result.errorMessage);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function subagentCleanupError(primary: unknown, ownedPath: string, cleanupError: unknown): Error {
	const cleanupReason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
	const cleanupMessage = `Failed to remove owned subagent prompt directory "${ownedPath}": ${cleanupReason}. Close handles for this exact directory and retry cleanup.`;
	if (!(primary instanceof Error)) return new Error(primary === undefined ? cleanupMessage : `${String(primary)} ${cleanupMessage}`);
	return new Error(capText(`${primary.message} Cleanup also failed: ${cleanupMessage}`, 4096), { cause: primary });
}

export function failureDisplayText(
	result: Pick<SingleResult, "exitCode" | "stopReason" | "errorMessage" | "stderr" | "messages">,
	maxBytes = 4096,
): string | undefined {
	const failed = result.exitCode !== 0
		|| result.stopReason === "error"
		|| result.stopReason === "aborted"
		|| Boolean(result.errorMessage);
	if (!failed) return undefined;
	return capText(
		result.errorMessage || result.stderr.trim() || getFinalOutput(result.messages)
			|| `Subagent exited with code ${result.exitCode} before producing output.`,
		maxBytes,
	);
}

export function expandPreviousPlaceholder(task: string, previousOutput: string): string {
	const placeholder = "{previous}";
	const replacement = capText(previousOutput, MAX_PREVIOUS_CHARS);
	let count = 0;
	let cursor = 0;
	while ((cursor = task.indexOf(placeholder, cursor)) !== -1) {
		count++;
		cursor += placeholder.length;
	}
	const expandedLength = task.length + count * (replacement.length - placeholder.length);
	if (!Number.isSafeInteger(expandedLength) || expandedLength > MAX_TASK_CHARS) {
		throw new Error(`Expanded chain task exceeds ${MAX_TASK_CHARS} characters`);
	}
	return count === 0 ? task : task.replaceAll(placeholder, replacement);
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	const truncated = capText(output, PER_TASK_OUTPUT_CAP);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

export function formatParallelResultText(results: SingleResult[], externallyAborted = false): string {
	const { succeeded, failed } = resultStateCounts(results);
	if (failed > 0) {
		const failures: string[] = [];
		for (const result of results) {
			if (isFailedResult(result)) failures.push(`${result.agent}: ${capText(getResultOutput(result), 1024)}`);
		}
		if (externallyAborted) throw new Error("Parallel subagent batch was aborted.");
		if (succeeded === 0) throw new Error(capText(`Parallel subagents failed: ${failures.join("; ")}`, 4096));
	}
	const summaries: string[] = [];
	for (const result of results) {
		const resultFailed = isFailedResult(result);
		const output = resultFailed ? capText(getResultOutput(result), 1024) : truncateParallelOutput(getResultOutput(result));
		summaries.push(`### [${result.agent}] ${resultFailed ? "failed" : "completed"}\n\n${output}`);
	}
	return `Parallel: ${succeeded}/${results.length} succeeded${failed > 0 ? `; ${failed} failed` : ""}\n\n${summaries.join("\n\n---\n\n")}`;
}

export function firstTextLines(value: string, maxLines: number): string {
	let end = 0;
	for (let line = 0; line < maxLines; line++) {
		const newline = value.indexOf("\n", end);
		if (newline < 0) return value;
		if (line === maxLines - 1) return value.slice(0, newline);
		end = newline + 1;
	}
	return value;
}

function resultStateCounts(results: readonly SingleResult[], target?: ResultStateCounts): ResultStateCounts {
	const counts = target ?? { waiting: 0, running: 0, succeeded: 0, failed: 0 };
	counts.waiting = 0;
	counts.running = 0;
	counts.succeeded = 0;
	counts.failed = 0;
	for (const result of results) {
		if (result.exitCode === -1 && result.startedAt === undefined) counts.waiting++;
		else if (result.exitCode === -1) counts.running++;
		else if (isFailedResult(result)) counts.failed++;
		else counts.succeeded++;
	}
	return counts;
}

function renderAgentStatus(
	result: SingleResult,
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
	now: number,
): string {
	let icon: string;
	let status: string;
	if (result.startedAt === undefined) {
		icon = theme.fg("muted", "○");
		status = "waiting";
	} else {
		const elapsed = formatElapsedMs((result.completedAt ?? now) - result.startedAt);
		if (result.exitCode === -1) {
			icon = theme.fg("warning", "⏳");
			status = `working ${elapsed}`;
		} else if (isFailedResult(result)) {
			icon = theme.fg("error", "✗");
			status = `failed after ${elapsed}`;
		} else {
			icon = theme.fg("success", "✓");
			status = `completed in ${elapsed}`;
		}
	}
	const step = result.step === undefined ? "" : theme.fg("muted", `#${result.step} `);
	return `${icon} ${step}${theme.fg("toolTitle", theme.bold(result.agent))} ${theme.fg("muted", status)}\n` +
		`  ${theme.fg("dim", `model: ${result.model ?? "—"} · ${formatAgentUsage(result.usage)}`)}`;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	onFailure?: () => void,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	let firstError: unknown;
	let stopped = false;
	async function runWorker(): Promise<void> {
		while (!stopped) {
			const current = nextIndex++;
			if (current >= items.length) return;
			try {
				results[current] = await fn(items[current], current);
			} catch (error) {
				if (firstError === undefined) firstError = error;
				stopped = true;
				onFailure?.();
			}
		}
	}
	const workers: Promise<void>[] = new Array(limit);
	for (let index = 0; index < limit; index++) workers[index] = runWorker();
	await Promise.all(workers);
	if (firstError !== undefined) throw firstError;
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	try {
		const safeName = agentName.replace(UNSAFE_FILE_NAME_PATTERN, "_");
		const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
		return { dir: tmpDir, filePath };
	} catch (error) {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* preserve primary failure */ }
		throw error;
	}
}

export function windowsTaskkillPath(systemRoot = process.env.SystemRoot): string {
	const root = systemRoot && path.win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
	return path.win32.join(root, "System32", "taskkill.exe");
}

function forceKillProcessTree(pid: number): void {
	try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function killProcessTree(pid: number | undefined): ReturnType<typeof setTimeout> | undefined {
	if (!pid || pid <= 0) return undefined;
	if (process.platform === "win32") {
		const result = spawnSync(windowsTaskkillPath(), ["/PID", `${pid}`, "/T", "/F"], {
			shell: false,
			stdio: "ignore",
			windowsHide: true,
			timeout: 10_000,
		});
		if (result.error) throw new Error(`System32 taskkill failed for PID ${pid}: ${result.error.message}`);
		if (result.status !== 0 && processIsAlive(pid)) {
			throw new Error(`System32 taskkill exited with status ${result.status ?? "unknown"}; PID ${pid} is still running`);
		}
		return undefined;
	}
	try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
	// Pass pid as a timer argument instead of allocating a delayed closure. The
	// caller owns this escalation handle and clears it when the child exits.
	const timer = setTimeout(forceKillProcessTree, 5000, pid);
	timer.unref();
	return timer;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const executable = fs.realpathSync.native(process.execPath);
	const sourceLauncher = process.env.SP_SOURCE_LAUNCHER;
	if (sourceLauncher && path.isAbsolute(sourceLauncher)) {
		let trustedLauncher: string | undefined;
		try { trustedLauncher = fs.realpathSync.native(sourceLauncher); } catch { /* Fall through. */ }
		if (trustedLauncher) return { command: executable, args: [trustedLauncher, ...args] };
	}
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && path.isAbsolute(currentScript)) {
		let trustedScript: string | undefined;
		try { trustedScript = fs.realpathSync.native(currentScript); } catch { /* Fail closed below. */ }
		if (trustedScript) return { command: executable, args: [trustedScript, ...args] };
	}

	const execName = path.basename(executable).toLowerCase();
	const isGenericRuntime = GENERIC_RUNTIME_PATTERN.test(execName);
	if (!isGenericRuntime) return { command: executable, args };
	throw new Error("Cannot locate a trusted absolute Pi executable; refusing PATH/cwd lookup");
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function emitSingleResultUpdate(
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	result: SingleResult,
): void {
	if (!onUpdate) return;
	onUpdate({
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
		details: makeDetails([result]),
	});
}

class NumberCompletion {
	readonly promise: Promise<number>;
	private resolvePromise!: (value: number) => void;

	constructor() {
		this.promise = new Promise<number>((resolve) => { this.resolvePromise = resolve; });
	}

	resolve(value: number): void {
		this.resolvePromise(value);
	}
}

class SubagentProcessRun {
	private readonly proc: ChildProcessByStdio<null, Readable, Readable>;
	private readonly completion = new NumberCompletion();
	private readonly stdoutDecoder = new StringDecoder("utf8");
	private readonly stdoutListener = this.onStdoutData.bind(this);
	private readonly stderrListener = this.onStderrData.bind(this);
	private readonly closeListener = this.onClose.bind(this);
	private readonly errorListener = this.onError.bind(this);
	private readonly abortListener = this.onAbort.bind(this);
	private readonly signal: AbortSignal | undefined;
	private readonly timeoutMs: number;
	private readonly result: SingleResult;
	private readonly onUpdate: OnUpdateCallback | undefined;
	private readonly makeDetails: (results: SingleResult[]) => SubagentDetails;
	private buffer = "";
	private jsonTransportBytes = 0;
	private jsonTransportEventCount = 0;
	private retainedJsonEventCount = 0;
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private forceKillTimer: ReturnType<typeof setTimeout> | undefined;
	private abortListenerAttached = false;
	private killRequested = false;
	private childClosed = false;
	private settled = false;
	wasAborted = false;
	timedOut = false;

	constructor(
		args: string[],
		childCwd: string,
		execution: ResolvedSubagentExecution | undefined,
		allowBash: boolean,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		result: SingleResult,
		onUpdate: OnUpdateCallback | undefined,
		makeDetails: (results: SingleResult[]) => SubagentDetails,
	) {
		this.signal = signal;
		this.timeoutMs = timeoutMs;
		this.result = result;
		this.onUpdate = onUpdate;
		this.makeDetails = makeDetails;
		const invocation = getPiInvocation(args);
		this.proc = spawn(invocation.command, invocation.args, {
			cwd: childCwd,
			env: buildChildEnvironment(process.env, execution?.authEnv ?? {}, {
				SP_SUBAGENT_WORKSPACE: childCwd,
				SP_SUBAGENT_ALLOW_BASH: allowBash ? "1" : "0",
			}),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	run(): Promise<number> {
		this.proc.stdout.on("data", this.stdoutListener);
		this.proc.stderr.on("data", this.stderrListener);
		this.proc.once("close", this.closeListener);
		this.proc.once("error", this.errorListener);
		this.timeout = setTimeout(SubagentProcessRun.handleTimeout, this.timeoutMs, this);
		if (this.signal) {
			if (this.signal.aborted) this.onAbort();
			else {
				this.signal.addEventListener("abort", this.abortListener, { once: true });
				this.abortListenerAttached = true;
			}
		}
		return this.completion.promise;
	}

	private static handleTimeout(run: SubagentProcessRun): void {
		run.timedOut = true;
		run.result.errorMessage = `Subagent timed out after ${run.timeoutMs}ms. Retry with a larger timeoutMs or split the task.`;
		run.requestProcessTreeKill();
	}

	private onAbort(): void {
		this.wasAborted = true;
		this.requestProcessTreeKill();
	}

	private requestProcessTreeKill(): void {
		if (this.killRequested || this.childClosed) return;
		this.killRequested = true;
		try {
			this.forceKillTimer = killProcessTree(this.proc.pid);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.result.errorMessage = capText(`${this.result.errorMessage ? `${this.result.errorMessage} ` : ""}Process cleanup failed: ${reason}.`, 4096);
			try { this.proc.kill("SIGKILL"); } catch { /* Exact child may already have exited. */ }
		}
	}

	private processLine(line: string): boolean {
		if (line.length === 0) return true;
		const lineBytes = Buffer.byteLength(line, "utf8");
		this.jsonTransportBytes += lineBytes + 1;
		this.jsonTransportEventCount++;
		let limitReason = jsonEventLimitReason(lineBytes, 0)
			?? jsonTransportLimitReason(this.jsonTransportBytes, this.jsonTransportEventCount);
		if (limitReason) {
			this.result.errorMessage = limitReason;
			this.requestProcessTreeKill();
			return false;
		}
		let event: any;
		try { event = JSON.parse(line); }
		catch { return true; }
		const eventType = event.type;
		if ((eventType === "message_end" || eventType === "tool_result_end") && event.message) {
			this.retainedJsonEventCount++;
			limitReason = jsonEventLimitReason(0, this.retainedJsonEventCount);
			if (limitReason) {
				this.result.errorMessage = limitReason;
				this.requestProcessTreeKill();
				return false;
			}
		}
		if (eventType === "message_end" && event.message) {
			const message = appendBoundedMessage(this.result.messages, event.message as Message);
			if (message.role === "assistant") {
				this.result.usage.turns++;
				const usage = message.usage;
				if (usage) {
					this.result.usage.input += usage.input || 0;
					this.result.usage.output += usage.output || 0;
					this.result.usage.cacheRead += usage.cacheRead || 0;
					this.result.usage.cacheWrite += usage.cacheWrite || 0;
					this.result.usage.cost += usage.cost?.total || 0;
					this.result.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!this.result.model && message.model) this.result.model = message.model;
				if (message.stopReason) this.result.stopReason = message.stopReason;
				if (message.errorMessage) this.result.errorMessage = message.errorMessage;
			}
			emitSingleResultUpdate(this.onUpdate, this.makeDetails, this.result);
		} else if (eventType === "tool_result_end" && event.message) {
			appendBoundedMessage(this.result.messages, event.message as Message);
			emitSingleResultUpdate(this.onUpdate, this.makeDetails, this.result);
		}
		return true;
	}

	private onStdoutData(data: Buffer): void {
		if (this.settled) return;
		this.buffer += this.stdoutDecoder.write(data);
		let lineStart = 0;
		for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n", lineStart)) {
			if (!this.processLine(this.buffer.slice(lineStart, newline))) {
				this.buffer = "";
				return;
			}
			lineStart = newline + 1;
		}
		if (lineStart > 0) this.buffer = this.buffer.slice(lineStart);
		const limitReason = jsonEventLimitReason(Buffer.byteLength(this.buffer, "utf8"), 0);
		if (limitReason) {
			this.result.errorMessage = limitReason;
			this.requestProcessTreeKill();
			this.buffer = "";
		}
	}

	private onStderrData(data: Buffer): void {
		if (!this.settled) this.result.stderr = capText(this.result.stderr + data.toString(), MAX_STDERR_BYTES);
	}

	private onClose(code: number | null): void {
		if (this.settled) return;
		this.childClosed = true;
		this.buffer += this.stdoutDecoder.end();
		if (this.buffer.trim()) this.processLine(this.buffer);
		this.settle(code ?? (this.timedOut || this.wasAborted ? 1 : 0));
	}

	private onError(error: Error): void {
		if (this.settled) return;
		this.childClosed = true;
		this.result.errorMessage = capText(`Failed to start subagent: ${error.message}`, 4096);
		this.settle(1);
	}

	private settle(exitCode: number): void {
		if (this.settled) return;
		this.settled = true;
		this.dispose();
		this.completion.resolve(exitCode);
	}

	private dispose(): void {
		if (this.timeout) clearTimeout(this.timeout);
		if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
		if (this.abortListenerAttached) this.signal?.removeEventListener("abort", this.abortListener);
		this.proc.stdout.off("data", this.stdoutListener);
		this.proc.stderr.off("data", this.stderrListener);
		this.proc.off("close", this.closeListener);
		this.proc.off("error", this.errorListener);
		this.buffer = "";
	}
}

async function runSingleAgent(
	policy: DelegatedTaskPolicy,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	execution: ResolvedSubagentExecution | undefined,
	timeoutMs: number,
): Promise<SingleResult> {
	const agent = findAgent(agents, agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: EMPTY_MESSAGES,
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: EMPTY_USAGE,
			step,
		};
	}

	if (agent.source === "project" && policy.source !== "primary") {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: EMPTY_MESSAGES,
			stderr: "Project-local agents cannot be delegated to an additional or full-access-exact workspace.",
			usage: EMPTY_USAGE,
			step,
		};
	}

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		CHILD_GUARD_PATH,
		"--no-skills",
		"--no-prompt-templates",
	];
	appendSubagentModelArgs(args, execution);
	const toolPolicy = effectiveTools(agent, policy.allowMutation);
	args.push("--tools", toolPolicy.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: execution ? `${execution.provider}/${execution.model}` : undefined,
		startedAt: Date.now(),
		step,
	};

	emitSingleResultUpdate(onUpdate, makeDetails, currentResult);
	let primaryError: unknown;
	try {
		if (task.length > MAX_TASK_CHARS) throw new Error(`Task exceeds ${MAX_TASK_CHARS} characters`);
		const childCwd = canonicalWorkspace(policy.canonicalCwd);
		if (childCwd !== policy.canonicalCwd) throw new Error("Delegated child cwd changed after permission authorization.");
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		const processRun = new SubagentProcessRun(
			args,
			childCwd,
			execution,
			toolPolicy.allowBash,
			signal,
			timeoutMs,
			currentResult,
			onUpdate,
			makeDetails,
		);
		const exitCode = await processRun.run();

		currentResult.exitCode = exitCode;
		currentResult.completedAt = Date.now();
		if (exitCode !== 0 && !currentResult.errorMessage) {
			currentResult.errorMessage = failureDisplayText(currentResult);
		}
		emitSingleResultUpdate(onUpdate, makeDetails, currentResult);
		if (processRun.wasAborted) throw new Error("Subagent was aborted");
		if (processRun.timedOut) throw new Error(currentResult.errorMessage ?? `Subagent timed out after ${timeoutMs}ms.`);
		return currentResult;
	} catch (error) {
		primaryError = error;
		if (currentResult.exitCode === -1) {
			currentResult.exitCode = 1;
			currentResult.completedAt = Date.now();
			currentResult.errorMessage = capText(error instanceof Error ? error.message : String(error), 4096);
			emitSingleResultUpdate(onUpdate, makeDetails, currentResult);
		}
		throw error;
	} finally {
		if (tmpPromptDir) {
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch (error) {
				throw subagentCleanupError(primaryError, tmpPromptDir, error);
			}
		}
	}
}

const AGENT_ROLE_DESCRIPTION = "Registered agent role, not a task label. Choose an available role such as planner, reviewer, scout, or worker; put custom names such as audit-lsp in task.";

const TaskItem = Type.Object({
	agent: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: AGENT_ROLE_DESCRIPTION }),
	task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Delegated task" }),
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Task working directory" })),
	readOnly: Type.Optional(Type.Boolean({ description: "Remove write, edit, and bash" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_TIMEOUT_MS, description: "Task timeout after launch (ms)" })),
}, { additionalProperties: false });

const ChainItem = Type.Object({
	agent: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: AGENT_ROLE_DESCRIPTION }),
	task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Task; may use {previous}" }),
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Step working directory" })),
	readOnly: Type.Optional(Type.Boolean({ description: "Remove write, edit, and bash" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_TIMEOUT_MS, description: "Step timeout after launch (ms)" })),
}, { additionalProperties: false });

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Agent source: user (default), project, or both.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: `Single-mode ${AGENT_ROLE_DESCRIPTION}` })),
	task: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Task for single mode" })),
	tasks: Type.Optional(Type.Array(TaskItem, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, description: "Sequential tasks" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Confirm project agents; defaults true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Single-task working directory" })),
	readOnly: Type.Optional(Type.Boolean({ description: "Single-task read-only downgrade" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_TIMEOUT_MS, description: "Default task timeout; 1800000ms" })),
}, { additionalProperties: false });

export default function (pi: ExtensionAPI) {
	if (!SUPPORTED_SP_VERSION_PATTERN.test(VERSION)) {
		console.warn(`@super-pi/subagent disabled: Pi ${VERSION} is unsupported (requires 0.84.x).`);
		return;
	}

	pi.registerCommand("subagent-model", {
		description: "Assign exact provider/model/thinking routes to subagent roles",
		handler: async (args, ctx) => {
			try {
				const command = parseModelAssignmentCommand(args);
				const assignments = loadModelAssignments();
				if (command.action === "interactive") {
					if (!ctx.hasUI) {
						ctx.ui.notify(formatModelAssignments(assignments), "info");
						return;
					}
					const scope: AgentScope = ctx.isProjectTrusted() ? "both" : "user";
					const agents = discoverAgents(canonicalWorkspace(ctx.cwd), scope).agents;
					const selected = await promptSubagentModelAssignment(ctx, agents, assignments);
					if (!selected) return;
					if (selected.action === "clear") {
						const removed = assignments.delete(selected.agent);
						if (removed) saveModelAssignments(assignments);
						ctx.ui.notify(
							removed
								? `Cleared model assignment for ${selected.agent}; it now inherits the parent session model.`
								: `${selected.agent} already inherits the parent session model.`,
							removed ? "info" : "warning",
						);
						return;
					}
					assignments.set(selected.agent, selected.assignment);
					saveModelAssignments(assignments);
					ctx.ui.notify(
						`Assigned ${selected.agent} → ${selected.assignment.provider}/${selected.assignment.model}${selected.assignment.thinkingLevel ? ` thinking:${selected.assignment.thinkingLevel}` : " (parent thinking level)"}.`,
						"info",
					);
					return;
				}
				if (command.action === "list") {
					ctx.ui.notify(formatModelAssignments(assignments), "info");
					return;
				}
				if (command.action === "clear-all") {
					assignments.clear();
					saveModelAssignments(assignments);
					ctx.ui.notify("Cleared all subagent model assignments; roles now inherit the parent session model.", "info");
					return;
				}
				if (command.action === "clear") {
					const removed = assignments.delete(command.agent);
					if (removed) saveModelAssignments(assignments);
					ctx.ui.notify(
						removed
							? `Cleared model assignment for ${command.agent}; it now inherits the parent session model.`
							: `No model assignment exists for ${command.agent}.`,
						removed ? "info" : "warning",
					);
					return;
				}

				const scope: AgentScope = ctx.isProjectTrusted() ? "both" : "user";
				const agents = discoverAgents(canonicalWorkspace(ctx.cwd), scope).agents;
				let roleExists = false;
				for (const agent of agents) {
					if (agent.name !== command.agent) continue;
					roleExists = true;
					break;
				}
				if (!roleExists) throw new Error(`Unknown subagent role: ${command.agent}`);
				const model = ctx.modelRegistry.find(command.assignment.provider, command.assignment.model);
				if (!model) {
					throw new Error(`Unknown provider/model: ${command.assignment.provider}/${command.assignment.model}`);
				}
				assignments.set(command.agent, {
					provider: model.provider,
					model: model.id,
					...(command.assignment.thinkingLevel ? { thinkingLevel: command.assignment.thinkingLevel } : {}),
				});
				saveModelAssignments(assignments);
				ctx.ui.notify(
					`Assigned ${command.agent} → ${model.provider}/${model.id}${command.assignment.thinkingLevel ? ` thinking:${command.assignment.thinkingLevel}` : ""}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate tasks to isolated subagents. agent is a registered role (planner/reviewer/scout/worker), never a custom task name; put labels and instructions in task. Supports single, parallel tasks, or sequential chain.",
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const defaultTimeoutMs = params.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			// Trust is checked before touching project-local agent files. Confirmation can never substitute for trust.
			assertProjectAgentAccess(agentScope, ctx.isProjectTrusted(), ctx.hasUI, confirmProjectAgents);
			const trustedWorkspace = canonicalWorkspace(ctx.cwd);
			const discovery = discoverAgents(trustedWorkspace, agentScope);
			const agents = discovery.agents;
			const modelAssignments = loadModelAssignments();
			const executionFor = async (agentName: string): Promise<ResolvedSubagentExecution | undefined> => {
				const assignment = modelAssignments.get(agentName);
				const model = assignment
					? ctx.modelRegistry.find(assignment.provider, assignment.model)
					: ctx.model;
				if (assignment && !model) {
					throw new Error(`Assigned subagent model is unavailable: ${assignment.provider}/${assignment.model}. Update it with /subagent-model.`);
				}
				if (!model) return undefined;
				const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
				return {
					provider: model.provider,
					model: model.id,
					thinkingLevel: assignment?.thinkingLevel ?? ctx.thinkingLevel,
					authEnv: (auth?.env ?? {}) as Record<string, string>,
				};
			};

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) throw new Error("Invalid parameters: provide exactly one of single, parallel, or chain mode");
			const requestedCwds: (string | undefined)[] = [];
			const requestedAgentNames: string[] = [];
			if (params.chain) {
				for (const step of params.chain) {
					requestedCwds.push(step.cwd);
					requestedAgentNames.push(step.agent);
				}
			} else if (params.tasks) {
				for (const task of params.tasks) {
					requestedCwds.push(task.cwd);
					requestedAgentNames.push(task.agent);
				}
			} else {
				requestedCwds.push(params.cwd);
				requestedAgentNames.push(params.agent!);
			}
			const delegatedPolicies = consumeDelegatedTaskPolicies(params, requestedCwds, ctx.cwd, toolCallId);
			assertSubagentBatchPreflight(agents, requestedAgentNames, delegatedPolicies, hasTasks);
			const uniqueAgentNames = new Set(requestedAgentNames);

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const projectAgentNames: string[] = [];
				for (const name of uniqueAgentNames) {
					const agent = findAgent(agents, name);
					if (agent?.source === "project") projectAgentNames.push(agent.name);
				}

				if (projectAgentNames.length > 0) {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgentNames.join(", ")}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) throw new Error("Project-local agents were not approved");
				}
			}

			// Resolve every route and credential before launching the first child so a
			// bad later task cannot leave a partially started batch.
			const executions = new Map<string, ResolvedSubagentExecution | undefined>();
			for (const name of uniqueAgentNames) executions.set(name, await executionFor(name));

			if (params.chain && params.chain.length > 0) {
				const chainDetails = makeDetails("chain");
				const results: SingleResult[] = [];
				const chainResults: SingleResult[] = new Array(params.chain.length);
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const execution = executions.get(step.agent);
					chainResults[i] = {
						agent: step.agent,
						agentSource: findAgent(agents, step.agent)?.source ?? "unknown",
						task: step.task,
						exitCode: -1,
						messages: EMPTY_MESSAGES,
						stderr: "",
						usage: EMPTY_USAGE,
						model: execution ? `${execution.provider}/${execution.model}` : undefined,
						step: i + 1,
					};
				}
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = expandPreviousPlaceholder(step.task, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									chainResults[i] = currentResult;
									onUpdate({
										content: partial.content,
										details: chainDetails(chainResults.slice()),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						delegatedPolicies[i],
						agents,
						step.agent,
						taskWithContext,
						i + 1,
						signal,
						chainUpdate,
						chainDetails,
						executions.get(step.agent),
						step.timeoutMs ?? defaultTimeoutMs,
					);
					results.push(result);
					chainResults[i] = result;

					const isError = isFailedResult(result);
					if (isError) throw new Error(`Chain stopped at step ${i + 1} (${step.agent}): ${capText(getResultOutput(result), PER_TASK_OUTPUT_CAP)}`);
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: chainDetails(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				const parallelDetails = makeDetails("parallel");
				if (params.tasks.length > MAX_PARALLEL_TASKS) throw new Error(`Too many parallel tasks; maximum is ${MAX_PARALLEL_TASKS}`);

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					const execution = executions.get(params.tasks[i].agent);
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: EMPTY_MESSAGES,
						stderr: "",
						usage: EMPTY_USAGE,
						model: execution ? `${execution.provider}/${execution.model}` : undefined,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const { waiting, running } = resultStateCounts(allResults);
						const done = allResults.length - waiting - running;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: parallelDetails([...allResults]),
						});
					}
				};

				const batchAbort = new AbortController();
				const batchSignal = signal
					? AbortSignal.any([signal, batchAbort.signal])
					: batchAbort.signal;
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						delegatedPolicies[index],
						agents,
						t.agent,
						t.task,
						undefined,
						batchSignal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						parallelDetails,
						executions.get(t.agent),
						t.timeoutMs ?? defaultTimeoutMs,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				}, () => batchAbort.abort(new Error("A sibling subagent failed")));

				const summaryText = formatParallelResultText(results, signal?.aborted === true);
				return {
					content: [
						{
							type: "text",
							text: summaryText,
						},
					],
					details: parallelDetails(results),
				};
			}

			if (params.agent && params.task) {
				const singleDetails = makeDetails("single");
				const result = await runSingleAgent(
					delegatedPolicies[0],
					agents,
					params.agent,
					params.task,
					undefined,
					signal,
					onUpdate,
					singleDetails,
					executions.get(params.agent),
					defaultTimeoutMs,
				);
				const isError = isFailedResult(result);
				if (isError) throw new Error(`Agent ${result.stopReason || "failed"}: ${capText(getResultOutput(result), PER_TASK_OUTPUT_CAP)}`);
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: singleDetails([result]),
				};
			}

			throw new Error("Invalid subagent parameters");
		},

		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let mode = "single";
			let count = 1;
			if (args.chain && args.chain.length > 0) {
				mode = "chain";
				count = args.chain.length;
			} else if (args.tasks && args.tasks.length > 0) {
				mode = "parallel";
				count = args.tasks.length;
			}
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", mode);
			if (count > 1) text += theme.fg("muted", ` (${count})`);
			component.setText(text);
			return component;
		},

		renderResult(result, _options, theme, context) {
			const component = context.lastComponent instanceof SubagentStatusText
				? context.lastComponent
				: new SubagentStatusText("", 0, 0);
			const state = context.state as SubagentRenderState;
			const incoming = result.details as SubagentDetails | undefined;
			if (incoming && incoming.results.length > 0) state.latestDetails = incoming;
			const details = incoming && incoming.results.length > 0 ? incoming : state.latestDetails;
			if (!details || details.results.length === 0) {
				component.setText(theme.fg("error", "✗ subagent failed"));
				return component;
			}

			const counts = resultStateCounts(
				details.results,
				state.counts ?? (state.counts = { waiting: 0, running: 0, succeeded: 0, failed: 0 }),
			);
			component.setStatus(details, counts, theme);
			return component;
		},
	});
}
