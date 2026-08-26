import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import type { AssistantMessage, AssistantMessageEvent } from "../packages/ai/src/types.ts";
import { Agent } from "../packages/agent/src/agent.ts";
import type { AgentToolUpdateCallback } from "../packages/agent/src/types.ts";

const EMPTY_USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class ToolFixtureStream implements AsyncIterable<AssistantMessageEvent> {
	private readonly withTool: boolean;
	private finalMessage: AssistantMessage | undefined;
	constructor(withTool: boolean) { this.withTool = withTool; }
	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const content = this.withTool
			? [{ type: "toolCall" as const, id: "tool-1", name: "progress", arguments: {} }]
			: [{ type: "text" as const, text: "done" }];
		const message = {
			role: "assistant" as const, content, api: "benchmark", provider: "benchmark", model: "benchmark",
			usage: EMPTY_USAGE, stopReason: this.withTool ? "toolUse" as const : "stop" as const, timestamp: 0,
		} as AssistantMessage;
		this.finalMessage = message;
		yield { type: "start", partial: message };
		if (this.withTool) {
			yield { type: "toolcall_start", contentIndex: 0, partial: message };
			yield { type: "toolcall_end", contentIndex: 0, toolCall: content[0] as never, partial: message };
			yield { type: "done", reason: "toolUse", message };
		} else {
			yield { type: "text_start", contentIndex: 0, partial: message };
			yield { type: "text_end", contentIndex: 0, content: "done", partial: message };
			yield { type: "done", reason: "stop", message };
		}
	}
	async result(): Promise<AssistantMessage> {
		if (!this.finalMessage) throw new Error("stream not complete");
		return this.finalMessage;
	}
}

class ParallelToolFixtureStream implements AsyncIterable<AssistantMessageEvent> {
	private readonly withTools: boolean;
	private finalMessage: AssistantMessage | undefined;
	constructor(withTools: boolean) { this.withTools = withTools; }
	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const content = this.withTools
			? Array.from({ length: 4 }, (_, index) => ({
					type: "toolCall" as const,
					id: `tool-${index}`,
					name: "parallel-progress",
					arguments: { tool: index },
				}))
			: [{ type: "text" as const, text: "done" }];
		const message = {
			role: "assistant" as const, content, api: "benchmark", provider: "benchmark", model: "benchmark",
			usage: EMPTY_USAGE, stopReason: this.withTools ? "toolUse" as const : "stop" as const, timestamp: 0,
		} as AssistantMessage;
		this.finalMessage = message;
		yield { type: "start", partial: message };
		if (this.withTools) {
			for (let index = 0; index < content.length; index++) {
				yield { type: "toolcall_start", contentIndex: index, partial: message };
				yield { type: "toolcall_end", contentIndex: index, toolCall: content[index] as never, partial: message };
			}
			yield { type: "done", reason: "toolUse", message };
		} else {
			yield { type: "done", reason: "stop", message };
		}
	}
	async result(): Promise<AssistantMessage> {
		if (!this.finalMessage) throw new Error("stream not complete");
		return this.finalMessage;
	}
}

test("100,000 tool progress updates retain one pending value and flush before end", async () => {
	let streamCalls = 0;
	let maxPending = 0;
	let legacyUpdates = 0;
	const order: string[] = [];
	const tool = {
		name: "progress", label: "Progress", description: "fixture",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_id: string, _params: unknown, _signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
			for (let sequence = 0; sequence < 100_000; sequence++) {
				onUpdate?.({ content: [{ type: "text", text: String(sequence) }], details: { sequence } });
			}
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const agent = new Agent({
		initialState: { tools: [tool as never] },
		streamFn: () => new ToolFixtureStream(streamCalls++ === 0) as never,
		eventInstrumentation: {
			onToolProgressPending: (_toolCallId, pending) => { maxPending = Math.max(maxPending, pending); },
		},
	});
	agent.subscribe((event) => { if (event.type === "tool_execution_update") legacyUpdates++; });
	agent.subscribeObserver((event) => {
		if (event.type === "tool_execution_update") order.push(`update:${event.partialResult.details.sequence}`);
		if (event.type === "tool_execution_end") order.push("end");
	}, { minIntervalMs: 60_000 });

	await agent.prompt("benchmark");
	assert.equal(maxPending, 1);
	assert.equal(legacyUpdates, 2);
	assert.deepEqual(order.slice(-2), ["update:99999", "end"]);
	assert.equal(agent.eventDeliveryStats.maxPendingKeys, 1);
});

test("100,000 updates across four parallel tools retain at most four latest keys", async () => {
	let streamCalls = 0;
	const activePending = new Set<string>();
	let maxPendingSlots = 0;
	const order = new Map<string, string[]>();
	const tool = {
		name: "parallel-progress", label: "Parallel progress", description: "fixture",
		parameters: { type: "object", properties: { tool: { type: "number" } }, required: ["tool"] },
		execute: async (toolCallId: string, _params: unknown, _signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
			for (let sequence = 0; sequence < 25_000; sequence++) {
				onUpdate?.({ content: [{ type: "text", text: String(sequence) }], details: { sequence } });
			}
			return { content: [{ type: "text", text: "done" }], details: { toolCallId } };
		},
	};
	const agent = new Agent({
		initialState: { tools: [tool as never] },
		streamFn: () => new ParallelToolFixtureStream(streamCalls++ === 0) as never,
		toolExecution: "parallel",
		eventInstrumentation: {
			onToolProgressPending: (toolCallId, pending) => {
				if (pending) activePending.add(toolCallId);
				else activePending.delete(toolCallId);
				maxPendingSlots = Math.max(maxPendingSlots, activePending.size);
			},
		},
	});
	agent.subscribeObserver((event) => {
		if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
		const events = order.get(event.toolCallId) ?? [];
		if (event.type === "tool_execution_update") events.push(`update:${event.partialResult.details.sequence}`);
		else events.push("end");
		order.set(event.toolCallId, events);
	}, { minIntervalMs: 60_000 });

	await agent.prompt("benchmark");
	assert.ok(maxPendingSlots <= 4);
	assert.equal(agent.eventDeliveryStats.maxPendingKeys, 4);
	for (let index = 0; index < 4; index++) {
		assert.deepEqual(order.get(`tool-${index}`)?.slice(-2), ["update:24999", "end"]);
	}
});

test("awaited tool progress applies backpressure and preserves every legacy update", async () => {
	let streamCalls = 0;
	const sequences: number[] = [];
	const tool = {
		name: "progress", label: "Progress", description: "awaited fixture",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_id: string, _params: unknown, _signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
			for (let sequence = 0; sequence < 100; sequence++) {
				await onUpdate?.awaited({
					content: [{ type: "text", text: String(sequence) }],
					details: { sequence },
				});
			}
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const agent = new Agent({
		initialState: { tools: [tool as never] },
		streamFn: () => new ToolFixtureStream(streamCalls++ === 0) as never,
	});
	agent.subscribe((event) => {
		if (event.type === "tool_execution_update") sequences.push(event.partialResult.details.sequence);
	});

	await agent.prompt("benchmark");

	assert.deepEqual(sequences, Array.from({ length: 100 }, (_, index) => index));
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
});

test("publish in the settled-before-cleanup microtask window restarts the drain", async () => {
	let streamCalls = 0;
	let releaseTool = () => {};
	const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
	let updateCallback: AgentToolUpdateCallback | undefined;
	let injectSecond = true;
	const updates: number[] = [];
	let markFirstDelivered = () => {};
	const firstDelivered = new Promise<void>((resolve) => { markFirstDelivered = resolve; });
	const tool = {
		name: "progress", label: "Progress", description: "microtask fixture",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_id: string, _params: unknown, _signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
			updateCallback = onUpdate;
			onUpdate?.({ content: [{ type: "text", text: "1" }], details: { sequence: 1 } });
			await toolGate;
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const agent = new Agent({
		initialState: { tools: [tool as never] },
		streamFn: () => new ToolFixtureStream(streamCalls++ === 0) as never,
		eventInstrumentation: {
			onToolProgressDrainSettled: () => {
				if (!injectSecond) return;
				injectSecond = false;
				updateCallback?.({ content: [{ type: "text", text: "2" }], details: { sequence: 2 } });
			},
		},
	});
	agent.subscribe((event) => {
		if (event.type !== "tool_execution_update") return;
		updates.push(event.partialResult.details.sequence);
		if (updates.length === 1) markFirstDelivered();
	});

	const prompt = agent.prompt("microtask fixture");
	await firstDelivered;
	await nextTask();
	assert.deepEqual(updates, [1, 2]);
	releaseTool();
	await prompt;
});

test("tool progress hot path no longer retains an update Promise array", () => {
	const source = readFileSync("packages/agent/src/agent-loop.ts", "utf8");
	assert.doesNotMatch(source, /updateEvents\s*:\s*Promise<void>\[\]/);
	assert.doesNotMatch(source, /Promise\.all\(updateEvents\)/);
});
