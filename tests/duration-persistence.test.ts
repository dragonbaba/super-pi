import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@super-pi/ai";
import { AssistantMessageEventStream, EventStream } from "../packages/ai/src/utils/event-stream.ts";
import { lazyStream } from "../packages/ai/src/api/lazy.ts";
import { Type } from "typebox";
import { agentLoop, runHostToolDispatch } from "../packages/agent/src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentTool } from "../packages/agent/src/types.ts";

const model = { id: "fixture", api: "openai-responses", provider: "fixture" } as Model<"openai-responses">;
function message(timestamp: number): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp };
}

test("assistant timing uses monotonic completion and preserves forwarding, deferred and stream compatibility", async t => {
	let wall = 1000, monotonic = 10;
	t.mock.method(Date, "now", () => wall);
	t.mock.method(performance, "now", () => monotonic);
	// A plain EventStream remains assignable; new subclass-private fields would break SDK callers.
	const structural: AssistantMessageEventStream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		event => event.type === "done", event => (event as Extract<AssistantMessageEvent, { type: "done" }>).message);
	structural.end(message(wall));
	for (const finish of ["done", "error", "end"] as const) {
		const stream = new AssistantMessageEventStream(), result = message(wall);
		monotonic += 25.4; wall -= 100;
		if (finish === "end") stream.end(result);
		else if (finish === "error") { result.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: result }); }
		else stream.push({ type: "done", reason: "stop", message: result });
		assert.equal((await stream.result()).durationMs, 25);
		const late = message(wall + 1000); stream.push({ type: "done", reason: "stop", message: late }); stream.end(late);
		assert.equal(late.durationMs, undefined);
		for await (const _event of stream) { /* Drain production queues. */ }
	}
	const outer = new AssistantMessageEventStream(), inner = new AssistantMessageEventStream(), shared = message(wall);
	monotonic += 4; inner.push({ type: "done", reason: "stop", message: shared });
	monotonic += 100; outer.push({ type: "done", reason: "stop", message: shared });
	assert.equal(shared.durationMs, 4);
	const historic = message(wall - 1), fetched = new AssistantMessageEventStream();
	fetched.end(historic); assert.equal(historic.durationMs, undefined);
	const preset = { ...message(wall), durationMs: 0 };
	new AssistantMessageEventStream().end(preset); assert.equal(preset.durationMs, 0);
});

test("lazy setup failure retains request timestamp and measures failed setup", async t => {
	let wall = 1000, monotonic = 10;
	t.mock.method(Date, "now", () => wall);
	t.mock.method(performance, "now", () => monotonic);
	const stream = lazyStream(model, async () => { wall = 2000; monotonic = 60; throw new Error("setup failed"); });
	const result = await stream.result();
	assert.equal(result.timestamp, 1000);
	assert.equal(result.durationMs, 50);
	assert.equal(result.errorMessage, "setup failed");
});

test("tool duration excludes preflight, progress drain and result hooks; unexecuted calls remain untimed", async t => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	for (const mode of ["success", "throw", "abort", "observer-error", "hook-error", "blocked", "invalid", "unknown", "cancelled"] as const) {
		const controller = new AbortController(), events: AgentEvent[] = [];
		let executions = 0;
		const producer = Object.freeze({ content: [{ type: "text" as const, text: "done" }], details: {} });
		const tool: AgentTool = { name: "timed", label: "timed", description: "fixture", parameters: Type.Object({}),
			validateInput: () => { if (mode === "invalid") throw new Error("input rejected"); },
			execute: async (_id, _args, _signal, update) => {
				executions++; now += 25;
				if (mode === "abort") { controller.abort(); throw new Error("aborted during execute"); }
				if (mode === "throw") throw new Error("execute failed");
				update?.(producer); return producer;
			} };
		if (mode === "cancelled") controller.abort();
		const config: AgentLoopConfig = { model, convertToLlm: values => values as never,
			beforeToolCall: async () => { now += 100; return mode === "blocked" ? { block: true, reason: "fixture" } : undefined; },
			afterToolCall: async () => { now += 300; if (mode === "hook-error") throw new Error("hook failed"); return undefined; } };
		const result = await runHostToolDispatch({ type: "toolCall", id: mode, name: mode === "unknown" ? "missing" : "timed", arguments: {} },
			{ systemPrompt: "", messages: [], tools: [tool] }, config, event => {
				events.push(event);
				if (event.type === "tool_execution_update") return new Promise<void>((resolve, reject) => {
					setImmediate(() => { now += 200; if (mode === "observer-error") reject(new Error("drain failed")); else resolve(); });
				});
			}, controller.signal);
		const expected = executions ? 25 : undefined;
		assert.equal(result.durationMs, expected, mode);
		const ended = events.find(event => event.type === "tool_execution_end");
		assert.equal(ended?.type === "tool_execution_end" ? ended.durationMs : undefined, expected, mode);
		assert.equal("durationMs" in producer, false);
	}
});

test("parallel and nested tools persist their own execution durations", async t => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	let releaseA!: () => void, releaseB!: () => void, started!: () => void, endedB!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; }), bDone = new Promise<void>(resolve => { endedB = resolve; });
	const aGate = new Promise<void>(resolve => { releaseA = resolve; }), bGate = new Promise<void>(resolve => { releaseB = resolve; });
	const result = { content: [{ type: "text" as const, text: "done" }], details: {} };
	const a: AgentTool = { name: "a", label: "a", description: "fixture", parameters: Type.Object({}), execute: async () => { await aGate; return result; } };
	const b: AgentTool = { ...a, name: "b", execute: async () => { started(); await bGate; return result; } };
	const config: AgentLoopConfig = { model, convertToLlm: values => values as never, shouldStopAfterTurn: () => true };
	const events: AgentEvent[] = [];
	const run = agentLoop([], { systemPrompt: "", messages: [], tools: [a, b] }, config, undefined, () => {
		const stream = new AssistantMessageEventStream(), response = message(Date.now());
		response.content = ["a", "b"].map(name => ({ type: "toolCall", id: name, name, arguments: {} }));
		response.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message: response }); return stream;
	});
	const consume = (async () => { for await (const event of run) { events.push(event); if (event.type === "tool_execution_end" && event.toolCallId === "b") endedB(); } })();
	await ready; now = 15; releaseB(); await bDone; now = 40; releaseA(); await consume;
	const final = await run.result();
	assert.deepEqual(final.filter(value => value.role === "toolResult").map(value => [value.toolName, value.durationMs]), [["a", 40], ["b", 15]]);
	assert.deepEqual(events.filter(event => event.type === "tool_execution_end").map(event => [event.toolName, event.durationMs]), [["b", 15], ["a", 40]]);
	const child: AgentTool = { ...a, name: "child", execute: async () => { now += 7; return result; } };
	const parent: AgentTool = { ...a, name: "parent", orchestration: true, execute: async (_id, _args, _signal, _update, context) => {
		assert.ok(context); const nested = await context.callTool("child", {}); assert.equal(nested.durationMs, 7); return result;
	} };
	const nestedRun = agentLoop([], { systemPrompt: "", messages: [], tools: [parent, child] }, config, undefined, () => {
		const stream = new AssistantMessageEventStream(), response = message(Date.now());
		response.content = [{ type: "toolCall", id: "parent", name: "parent", arguments: {} }]; response.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: response }); return stream;
	});
	const nestedEnds: Array<[string, number | undefined]> = [];
	for await (const event of nestedRun) if (event.type === "tool_execution_end") nestedEnds.push([event.toolName, event.durationMs]);
	assert.deepEqual(nestedEnds, [["child", 7], ["parent", 7]]);
});
