import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "../packages/ai/src/types.ts";
import { Agent } from "../packages/agent/src/agent.ts";
import type { AgentEvent } from "../packages/agent/src/types.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class AssistantFixtureStream implements AsyncIterable<AssistantMessageEvent> {
	private readonly count: number;
	private readonly onYield: () => void;
	private finalMessage: AssistantMessage | undefined;

	constructor(count: number, onYield: () => void = () => {}) {
		this.count = count;
		this.onYield = onYield;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const text = { type: "text" as const, text: "" };
		const message = {
			role: "assistant" as const,
			content: [text],
			api: "benchmark",
			provider: "benchmark",
			model: "benchmark",
			usage: EMPTY_USAGE,
			stopReason: "stop" as const,
			timestamp: 0,
		} as AssistantMessage;
		yield { type: "start", partial: message };
		yield { type: "text_start", contentIndex: 0, partial: message };
		for (let sequence = 0; sequence < this.count; sequence++) {
			text.text += "x";
			this.onYield();
			yield { type: "text_delta", contentIndex: 0, delta: "x", partial: message };
		}
		yield { type: "text_end", contentIndex: 0, content: text.text, partial: message };
		this.finalMessage = message;
		yield { type: "done", reason: "stop", message };
	}

	async result(): Promise<AssistantMessage> {
		if (!this.finalMessage) throw new Error("stream not complete");
		return this.finalMessage;
	}
}

class AbortFixtureStream implements AsyncIterable<AssistantMessageEvent> {
	private readonly signal: AbortSignal;
	private readonly onWaiting: () => void;
	private readonly message: AssistantMessage;

	constructor(signal: AbortSignal, onWaiting: () => void) {
		this.signal = signal;
		this.onWaiting = onWaiting;
		this.message = {
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			api: "benchmark",
			provider: "benchmark",
			model: "benchmark",
			usage: EMPTY_USAGE,
			stopReason: "aborted",
			timestamp: 0,
		} as AssistantMessage;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		yield { type: "start", partial: this.message };
		yield { type: "text_start", contentIndex: 0, partial: this.message };
		yield { type: "text_delta", contentIndex: 0, delta: "x", partial: this.message };
		this.onWaiting();
		if (!this.signal.aborted) {
			await new Promise<void>((resolve) => this.signal.addEventListener("abort", () => resolve(), { once: true }));
		}
	}

	async result(): Promise<AssistantMessage> {
		return this.message;
	}
}

class MutableAssistantFixtureStream implements AsyncIterable<AssistantMessageEvent> {
	private readonly providerGate: Promise<void>;
	private readonly onWaiting: () => void;
	private finalMessage: AssistantMessage | undefined;

	constructor(providerGate: Promise<void>, onWaiting: () => void) {
		this.providerGate = providerGate;
		this.onWaiting = onWaiting;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const text = { type: "text" as const, text: "before" };
		const message = {
			role: "assistant" as const,
			content: [text],
			api: "benchmark",
			provider: "benchmark",
			model: "benchmark",
			usage: EMPTY_USAGE,
			stopReason: "stop" as const,
			timestamp: 0,
		} as AssistantMessage;
		yield { type: "start", partial: message };
		yield { type: "text_start", contentIndex: 0, partial: message };
		yield { type: "text_delta", contentIndex: 0, delta: "before", partial: message };
		this.onWaiting();
		await this.providerGate;
		text.text = "after";
		yield { type: "text_delta", contentIndex: 0, delta: "after", partial: message };
		this.finalMessage = message;
		yield { type: "done", reason: "stop", message };
	}

	async result(): Promise<AssistantMessage> {
		if (!this.finalMessage) throw new Error("stream not complete");
		return this.finalMessage;
	}
}

test("observer delivery coalesces 100,000 assistant updates and preserves the final boundary", async () => {
	let snapshots = 0;
	const order: string[] = [];
	const agent = new Agent({
		streamFn: () => new AssistantFixtureStream(100_000) as never,
		eventInstrumentation: { onAssistantSnapshot: () => { snapshots++; } },
	});
	agent.subscribeObserver((event) => {
		if (event.type === "message_update") {
			const firstContent = (event.message as AssistantMessage).content[0];
			order.push(`update:${firstContent?.type === "text" ? firstContent.text.length : -1}`);
		}
		if (event.type === "message_end") order.push("end");
	}, { minIntervalMs: 60_000 });

	await agent.prompt("benchmark");
	assert.deepEqual(order.slice(-2), ["update:100000", "end"]);
	assert.ok(order.filter((entry) => entry.startsWith("update:")).length <= 2);
	assert.ok(snapshots <= 2);
	assert.equal(agent.eventDeliveryStats.maxPendingKeys, 1);
	await agent.waitForIdle();
});

test("legacy subscribe remains awaited and receives every assistant update", async () => {
	let updates = 0;
	const agent = new Agent({ streamFn: () => new AssistantFixtureStream(20) as never });
	agent.subscribe(async (event) => { if (event.type === "message_update") updates++; });
	await agent.prompt("benchmark");
	assert.equal(updates, 22);
});

test("assistant observers receive a deeply frozen flush-time snapshot isolated from provider mutation", async () => {
	let releaseProvider = () => {};
	const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
	let markProviderWaiting = () => {};
	const providerWaiting = new Promise<void>((resolve) => { markProviderWaiting = resolve; });
	let markObserved = () => {};
	const observed = new Promise<void>((resolve) => { markObserved = resolve; });
	let captured: Extract<AgentEvent, { type: "message_update" }> | undefined;
	const agent = new Agent({
		streamFn: () => new MutableAssistantFixtureStream(providerGate, markProviderWaiting) as never,
	});
	agent.subscribeObserver((event) => {
		if (event.type !== "message_update" || captured) return;
		captured = event;
		markObserved();
	}, { minIntervalMs: 0 });

	const prompt = agent.prompt("snapshot fixture");
	await providerWaiting;
	await observed;
	assert.ok(captured);
	const capturedContent = (captured.message as AssistantMessage).content[0];
	assert.equal(capturedContent?.type === "text" ? capturedContent.text : undefined, "before");
	assert.equal(Object.isFrozen(captured), true);
	assert.equal(Object.isFrozen(captured.message), true);
	assert.equal(Object.isFrozen((captured.message as AssistantMessage).content), true);
	assert.equal(Object.isFrozen(capturedContent), true);
	assert.equal(Object.isFrozen(captured.assistantMessageEvent), true);
	assert.throws(() => {
		if (capturedContent?.type === "text") capturedContent.text = "observer mutation";
	}, TypeError);

	releaseProvider();
	await prompt;
	assert.equal(capturedContent?.type === "text" ? capturedContent.text : undefined, "before");
});

test("a slow observer does not stop provider consumption but final settlement awaits it", async () => {
	let produced = 0;
	let releaseObserver = () => {};
	let markStarted = () => {};
	const observerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
	const agent = new Agent({ streamFn: () => new AssistantFixtureStream(10_000, () => { produced++; }) as never });
	agent.subscribeObserver(async (event) => {
		if (event.type !== "message_update") return;
		markStarted();
		await observerGate;
	}, { minIntervalMs: 60_000 });

	const prompt = agent.prompt("benchmark");
	await observerStarted;
	assert.equal(produced, 10_000);
	assert.equal(agent.state.isStreaming, true);
	releaseObserver();
	await prompt;
	assert.equal(agent.state.isStreaming, false);
});

test("latest state does not leak across agent runs", async () => {
	const lengths: number[] = [];
	const runLengths = [7, 3];
	let run = 0;
	const agent = new Agent({ streamFn: () => new AssistantFixtureStream(runLengths[run++]!) as never });
	agent.subscribeObserver((event) => {
		if (event.type !== "message_update") return;
		const content = (event.message as AssistantMessage).content[0];
		if (content?.type === "text") lengths.push(content.text.length);
	}, { minIntervalMs: 60_000 });

	await agent.prompt("first");
	await agent.prompt("second");

	assert.deepEqual(lengths.slice(-2), [7, 3]);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
});

test("one large message snapshot carries bounded metadata for every changed tool", async () => {
	const toolCounts = [16, 8, 4, 2, 1];
	for (const toolCount of toolCounts) {
		let snapshots = 0;
		let deliveries = 0;
		let pendingMetadataHwm = 0;
		let pendingMetadata = -1;
		let captured: AgentEvent | undefined;
		const agent = new Agent({
			streamFn: (() => { throw new Error("unused"); }) as never,
			eventInstrumentation: {
				onAssistantSnapshot: () => { snapshots++; },
				onPendingToolMetadata(pending): void {
					pendingMetadata = pending;
					if (pending > pendingMetadataHwm) pendingMetadataHwm = pending;
				},
			},
		});
		(agent as unknown as { activeRun: unknown }).activeRun = {
			promise: Promise.resolve(),
			resolve(): void {},
			abortController: new AbortController(),
		};
		agent.subscribeObserver((event) => {
			if (event.type !== "message_update") return;
			deliveries++;
			captured = event;
		}, { minIntervalMs: 60_000 });

		const content: Array<Record<string, unknown>> = [{ type: "text", text: "x".repeat(64 * 1024) }];
		for (let index = 0; index < toolCount; index++) {
			content.push({
				type: "toolCall",
				id: `tool-${index}`,
				name: "fixture",
				arguments: { value: `${index}:`.padEnd(4 * 1024, "x") },
				partialArgs: `generation-${index}`,
			});
		}
		const message = {
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			content,
			timestamp: 0,
		};
		const processEvent = (event: unknown): Promise<void> =>
			(agent as unknown as { processEvents(event: unknown): Promise<void> }).processEvents(event);
		for (let index = 0; index < toolCount; index++) {
			await processEvent({
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: index + 1,
					delta: `generation-${index}`,
					partial: message,
				},
			});
		}
		await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();

		const changedTools = (captured as AgentEvent & {
			changedToolUpdates?: ReadonlyArray<{ toolCallId: string; contentIndex: number }>;
		} | undefined)?.changedToolUpdates;
		assert.equal(snapshots, 1, `${toolCount} tools cloned the full message more than once`);
		assert.equal(deliveries, 1, `${toolCount} tools produced more than one observer delivery`);
		assert.equal(changedTools?.length, toolCount);
		assert.deepEqual(changedTools?.map((entry) => entry.toolCallId),
			Array.from({ length: toolCount }, (_, index) => `tool-${index}`));
		assert.equal(Object.isFrozen(changedTools), true);
		assert.equal(Object.isFrozen(changedTools?.[0]), true);
		assert.equal(pendingMetadataHwm, toolCount);
		assert.equal(pendingMetadata, 0);
		assert.equal(agent.eventDeliveryStats.maxPendingKeys, 1);
		assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
		await (agent as unknown as { eventDelivery: { dispose(): Promise<void> } }).eventDelivery.dispose();
	}
});

test("tool ends remain sticky when a text update is the final event in the flush", async () => {
	let captured: Extract<AgentEvent, { type: "message_update" }> | undefined;
	const agent = new Agent({ streamFn: (() => { throw new Error("unused"); }) as never });
	(agent as unknown as { activeRun: unknown }).activeRun = {
		promise: Promise.resolve(),
		resolve(): void {},
		abortController: new AbortController(),
	};
	agent.subscribeObserver((event) => {
		if (event.type === "message_update") captured = event;
	}, { minIntervalMs: 60_000 });
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		content: [
			{ type: "text", text: "done" },
			{ type: "toolCall", id: "tool-a", name: "a", arguments: {} },
			{ type: "toolCall", id: "tool-b", name: "b", arguments: {} },
		],
		timestamp: 0,
	};
	const processEvent = (assistantMessageEvent: unknown): Promise<void> =>
		(agent as unknown as { processEvents(event: unknown): Promise<void> }).processEvents({
			type: "message_update",
			message,
			assistantMessageEvent,
		});
	await processEvent({ type: "toolcall_start", contentIndex: 1, partial: message });
	await processEvent({ type: "toolcall_delta", contentIndex: 1, delta: "a", partial: message, toolArgsGeneration: 1 });
	await processEvent({ type: "toolcall_end", contentIndex: 1, toolCall: message.content[1], partial: message });
	await processEvent({ type: "toolcall_end", contentIndex: 2, toolCall: message.content[2], partial: message });
	await processEvent({ type: "text_delta", contentIndex: 0, delta: "done", partial: message });
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();

	assert.equal(captured?.assistantMessageEvent.type, "text_delta");
	assert.deepEqual(captured?.changedToolUpdates?.map((update) => ({
		id: update.toolCallId,
		phase: update.phase,
		finalized: update.finalized,
	})), [
		{ id: "tool-a", phase: "end", finalized: true },
		{ id: "tool-b", phase: "end", finalized: true },
	]);
	assert.equal(agent.eventDeliveryStats.received, 5);
	assert.equal(agent.eventDeliveryStats.coalesced, 4);
	assert.equal(agent.eventDeliveryStats.delivered, 1);
	await (agent as unknown as { eventDelivery: { dispose(): Promise<void> } }).eventDelivery.dispose();
});

test("abort flushes the final latest update and leaves no stale pending delivery", async () => {
	let markWaiting = () => {};
	const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
	const order: string[] = [];
	const agent = new Agent({
		streamFn: (_model, _context, options) => {
			if (!options?.signal) throw new Error("abort fixture requires an active signal");
			return new AbortFixtureStream(options.signal, markWaiting) as never;
		},
	});
	agent.subscribeObserver((event) => {
		if (event.type === "message_update") order.push("update");
		if (event.type === "message_end") order.push("end");
	}, { minIntervalMs: 60_000 });

	const prompt = agent.prompt("abort fixture");
	await waiting;
	agent.abort();
	await prompt;

	assert.deepEqual(order.slice(-2), ["update", "end"]);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
	assert.equal((agent as unknown as { pendingMessageUpdateEvent?: unknown }).pendingMessageUpdateEvent, undefined);
	assert.equal((agent as unknown as { pendingChangedToolUpdates: Map<string, unknown> }).pendingChangedToolUpdates.size, 0);
	const delivered = order.length;
	await Promise.resolve();
	assert.equal(order.length, delivered);
});
