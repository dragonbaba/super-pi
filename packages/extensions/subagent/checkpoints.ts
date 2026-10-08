import type { Message } from "@super-pi/ai";

export const CHECKPOINT_BYTES = 1024 * 1024;
export const CHECKPOINT_MESSAGES = 128;
export const CHECKPOINT_HANDOFF_BYTES = 768 * 1024;
export const CHECKPOINT_HANDOFF_MESSAGES = 96;
export const CHECKPOINT_PLANNING = `Plan long work as bounded phases BEFORE delegation, each with a verifiable deliverable and a handoff point in stopCondition. With checkpoint/resumeTaskId, completed context is limited to ${CHECKPOINT_BYTES} bytes (1 MiB) and ${CHECKPOINT_MESSAGES} messages, including prompts, assistant messages and tool results; resumed history consumes that same capacity. Handoff starts at ${CHECKPOINT_HANDOFF_BYTES} bytes (768 KiB) or ${CHECKPOINT_HANDOFF_MESSAGES} messages, reserving space for a concise summary. Keep reads and tool batches small; return file locations instead of full files/logs. A handoff must state completed work, verification, changed files, remaining work and the next bounded assignment. Review that result before starting a fresh task; do not repeatedly resume a nearly full checkpoint. No automatic extra agents or token/turn quotas.`;

/** Capacity exhaustion may hand back work; corrupt/unsupported context must still fail. */
export class CheckpointCapacityError extends Error {}
export interface TaskCheckpoint {
	version: 1;
	id: string;
	agent: string;
	cwd: string;
	device: string;
	inode: string;
	turns: number;
	updatedAt: number;
	pending: boolean;
	messages: Message[];
}
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function fileIdentity(value: unknown): value is string { return typeof value === "string" && /^[0-9]{1,30}$/.test(value); }

/** Bound JSON before materialization; no second full-size string just to measure it. */
export function assertCheckpointJson(value: unknown, maximum = CHECKPOINT_BYTES): void {
	let remaining = maximum, nodes = 0;
	function visit(item: unknown, depth: number): void {
		if (depth > 32) throw new Error("Checkpoint/control structure exceeds depth 32.");
		if (++nodes > 20000) throw new CheckpointCapacityError("Checkpoint/control structure exceeds 20000 nodes.");
		if (typeof item === "string") {
			remaining -= 2;
			for (let i = 0; i < item.length && remaining >= 0; i++) {
				const code = item.charCodeAt(i);
				if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) remaining -= 2;
				else if (code < 32) remaining -= 6;
				else if (code < 128) remaining--;
				else if (code < 2048) remaining -= 2;
				else if (code >= 0xD800 && code <= 0xDBFF && item.charCodeAt(i + 1) >= 0xDC00 && item.charCodeAt(i + 1) <= 0xDFFF) { remaining -= 4; i++; }
				else remaining -= code >= 0xD800 && code <= 0xDFFF ? 6 : 3;
			}
		} else if (typeof item === "number" && Number.isFinite(item)) remaining -= String(item).length;
		else if (item === null || typeof item === "boolean") remaining -= item === false ? 5 : 4;
		else if (Array.isArray(item)) {
			if (typeof (item as unknown as { toJSON?: unknown }).toJSON === "function") throw new Error("Checkpoint contains a custom serializer.");
			remaining -= 2 + Math.max(0, item.length - 1);
			for (const entry of item) visit(entry, depth + 1);
		} else if (item && typeof item === "object" && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
			remaining -= 2;
			let first = true;
			const keys = Object.keys(item);
			if (keys.length > 20000) throw new CheckpointCapacityError("Checkpoint/control structure exceeds 20000 nodes.");
			for (const key of keys) {
				remaining -= first ? 1 : 2; first = false;
				visit(key, depth + 1); visit((item as Record<string, unknown>)[key], depth + 1);
			}
		} else throw new Error("Checkpoint contains non-JSON data.");
		if (remaining < 0) throw new CheckpointCapacityError(`Checkpoint/control message exceeds ${maximum} bytes.`);
	}
	visit(value, 0);
}

export function encodeCheckpoint(checkpoint: TaskCheckpoint): string {
	if (checkpoint.messages.length > CHECKPOINT_MESSAGES) throw new CheckpointCapacityError("Checkpoint limit reached: 128 messages. Split the remaining work into a fresh task.");
	const messages: Message[] = [];
	for (const message of checkpoint.messages) messages.push(checkpointMessage(message));
	const projected: TaskCheckpoint = { version: checkpoint.version, id: checkpoint.id, agent: checkpoint.agent, cwd: checkpoint.cwd,
		device: checkpoint.device, inode: checkpoint.inode, turns: checkpoint.turns, updatedAt: checkpoint.updatedAt, pending: checkpoint.pending, messages };
	assertCheckpointJson(projected);
	return JSON.stringify(projected);
}

/** Completed, paired text/tool messages only. No grants, environment, backend extras or hidden reasoning. */
export function checkpointMessage(value: unknown): Message {
	const item = value as Record<string, any> | undefined;
	if (!item || !integer(item.timestamp)) throw new Error("Invalid checkpoint message timestamp.");
	if (item.role === "user") {
		if (!bounded(item.content, 32768)) throw new Error("Checkpoint user context must be bounded text.");
		return { role: "user", content: item.content, timestamp: item.timestamp };
	}
	if (item.role !== "assistant" && item.role !== "toolResult" || !Array.isArray(item.content)) throw new Error("Unsupported checkpoint message.");
	if (item.content.length > 128) throw new CheckpointCapacityError("Checkpoint message exceeds 128 content blocks.");
	const content: any[] = [];
	for (const part of item.content) {
		if (part?.type === "text" && typeof part.text === "string") {
			if (part.text.length > CHECKPOINT_BYTES) throw new CheckpointCapacityError("Checkpoint text exceeds 1 MiB.");
			content.push({ type: "text", text: part.text });
		}
		else if (part?.type === "thinking" && item.role === "assistant") continue;
		else if (part?.type === "toolCall" && item.role === "assistant" && bounded(part.id, 256) && bounded(part.name, 128)
			&& part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)) {
			content.push({ type: "toolCall", id: part.id, name: part.name, arguments: part.arguments });
		} else throw new Error("Checkpoint contains unsupported content; no partial context was saved.");
	}
	if (item.role === "toolResult") {
		if (!bounded(item.toolCallId, 256) || !bounded(item.toolName, 128) || typeof item.isError !== "boolean") throw new Error("Invalid checkpoint tool result.");
		return { role: "toolResult", toolCallId: item.toolCallId, toolName: item.toolName, content, isError: item.isError, timestamp: item.timestamp };
	}
	if (!bounded(item.api, 128) || !bounded(item.provider, 128) || !bounded(item.model, 256)
		|| !["stop", "toolUse", "length"].includes(item.stopReason)) throw new Error("Checkpoint requires a completed assistant response.");
	return { role: "assistant", api: item.api, provider: item.provider, model: item.model, stopReason: item.stopReason, timestamp: item.timestamp, content,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as Message;
}

export function decodeCheckpoint(encoded: string, id: string, agent: string, cwd: string | undefined): TaskCheckpoint {
	if (Buffer.byteLength(encoded) > CHECKPOINT_BYTES) throw new Error("Checkpoint exceeds 1 MiB.");
	const value = JSON.parse(encoded) as TaskCheckpoint;
	assertCheckpointJson(value);
	if (!value || value.version !== 1 || value.id !== id || value.agent !== agent || value.cwd !== cwd
		|| !fileIdentity(value.device) || !fileIdentity(value.inode) || !integer(value.turns) || !integer(value.updatedAt) || typeof value.pending !== "boolean"
		|| !Array.isArray(value.messages) || value.messages.length > CHECKPOINT_MESSAGES || value.messages.length === 0) throw new Error("Invalid checkpoint identity or bounds.");
	const messages: Message[] = [];
	const outstanding = new Map<string, string>();
	for (const raw of value.messages) {
		const message = checkpointMessage(raw);
		if (message.role === "toolResult") {
			if (outstanding.get(message.toolCallId) !== message.toolName) throw new Error("Checkpoint has an unmatched tool result.");
			outstanding.delete(message.toolCallId);
		} else {
			if (outstanding.size) throw new Error("Checkpoint contains unfinished tool calls.");
			if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") {
				if (outstanding.has(part.id)) throw new Error("Checkpoint contains duplicate tool calls.");
				outstanding.set(part.id, part.name);
			}
		}
		messages.push(message);
	}
	if (outstanding.size) throw new Error("Checkpoint contains unfinished tool calls.");
	return { version: 1, id, agent, cwd: value.cwd, device: value.device, inode: value.inode, turns: value.turns,
		updatedAt: value.updatedAt, pending: value.pending, messages };
}

export function appendCheckpointTurn(checkpoint: TaskCheckpoint, assistant: unknown, results: unknown): void {
	if (!Array.isArray(results)) throw new Error("Invalid checkpoint turn results.");
	if (checkpoint.messages.length + results.length + 1 > CHECKPOINT_MESSAGES) throw new CheckpointCapacityError("Checkpoint limit reached: 128 messages. Split the remaining work into a fresh task.");
	checkpoint.messages.push(checkpointMessage(assistant));
	for (const result of results) checkpoint.messages.push(checkpointMessage(result));
	checkpoint.turns++; checkpoint.updatedAt = Date.now(); checkpoint.pending = false;
}
