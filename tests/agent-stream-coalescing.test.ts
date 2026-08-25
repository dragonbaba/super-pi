import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "../packages/ai/src/types.ts";
import { Agent } from "../packages/agent/src/agent.ts";

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
	const delivered = order.length;
	await Promise.resolve();
	assert.equal(order.length, delivered);
});
