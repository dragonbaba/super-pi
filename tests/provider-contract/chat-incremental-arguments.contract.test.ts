import assert from "node:assert/strict";
import test from "node:test";
import { chatArgumentsFixture, chatEventsFixture } from "../helpers/chat-arguments-fixture.ts";
import { IncrementalToolArguments } from "../../packages/ai/src/utils/incremental-tool-arguments.ts";
import { stream as sourceChat } from "../../packages/ai/src/api/openai-completions.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";
import { Type } from "typebox";
import { Agent } from "../../packages/agent/src/agent.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { chatArgumentsModel } from "../helpers/chat-arguments-fixture.ts";
// Agent consumes the built ai package's completeness registry. Keep this integration on that same graph.
import { stream as builtChat } from "@super-pi/ai/api/openai-completions";

test("actual Chat adapter parses accumulated argument JSON only at finalization", async () => {
	const input = JSON.stringify({ payload: "x".repeat(8192) });
	const fixture = chatArgumentsFixture([input], 64), parse = JSON.parse;
	let argumentParseCalls = 0, argumentParseCodeUnits = 0, deltas = 0;
	JSON.parse = function (text, reviver) {
		if (typeof text === "string" && text.startsWith('{"payload"')) { argumentParseCalls++; argumentParseCodeUnits += text.length; }
		return parse(text, reviver);
	};
	try {
		const stream = fixture.start();
		for await (const event of stream) if (event.type === "toolcall_delta") deltas++;
		const output = await stream.result();
		assert.equal(output.stopReason, "toolUse", output.errorMessage);
		assert.deepEqual((output.content[0] as any).arguments, { payload: "x".repeat(8192) });
		assert.ok(deltas > 100);
		assert.deepEqual({ argumentParseCalls, argumentParseCodeUnits }, { argumentParseCalls: 1, argumentParseCodeUnits: input.length });
	} finally { JSON.parse = parse; fixture.release(); }
});

test("interleaved Chat tools have independent numeric generations and no parser state on events", async () => {
	const inputs = ['{"path":"alpha","nested":[1,2]}', '{"path":"beta","nested":{"x":true}}'];
	const fixture = chatArgumentsFixture(inputs, 2), generations = [-1, -1], roots: object[] = [], snapshots: unknown[] = [];
	const push = AssistantMessageEventStream.prototype.push;
	AssistantMessageEventStream.prototype.push = function(event) {
		if (event.type === "toolcall_delta") {
			const index = event.contentIndex, block = event.partial.content[index] as any;
			assert.equal(block.toolArgsGeneration, event.toolArgsGeneration);
			assert.equal(block.partialArgs, undefined); assert.equal(block.parser, undefined);
			if (event.delta.length > 0) {
				if (!roots[index]) { roots[index] = block.arguments; snapshots[index] = Object.freeze(structuredClone(block.arguments)); }
				else assert.equal(block.arguments, roots[index]);
			}
		}
		push.call(this, event);
	};
	try {
		const stream = fixture.start();
		for await (const event of stream) {
			if (event.type !== "toolcall_delta") continue;
			const index = event.contentIndex;
			assert.equal(event.toolArgsGeneration, ++generations[index]);
		}
		const output = await stream.result();
		for (let index = 0; index < inputs.length; index++) {
			const block = output.content[index] as any;
			assert.deepEqual(block.arguments, JSON.parse(inputs[index])); assert.equal(block.toolArgsGeneration, undefined);
			assert.deepEqual(snapshots[index], {}); assert.equal(hasIncompleteToolArguments(block.arguments), false);
		}
	} finally { AssistantMessageEventStream.prototype.push = push; fixture.release(); }
});

const toolChunk = (tool: unknown) => ({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }] });
const finished = (reason = "tool_calls") => ({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: reason }] });

test("Chat explicitly compatible endpoints may omit finish_reason without skipping final validation", async () => {
	const fixture = chatArgumentsFixture(['{"path":"ok"}'], 2, true);
	try {
		const stream = fixture.start((model, context, options) => sourceChat({ ...model, compat: { supportsFinishReason: false } }, context, options));
		for await (const _event of stream) { /* drain */ }
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual((result.content[0] as any).arguments, { path: "ok" });
		assert.equal(hasIncompleteToolArguments((result.content[0] as any).arguments), false);
	} finally { fixture.release(); }
});

test("Chat interleaves text, reasoning and JSON tool input with stable output positions", async () => {
	const fixture = chatEventsFixture([
		{ id: "fixture", choices: [{ index: 0, delta: { content: "text", reasoning_content: "think", reasoning: "duplicate",
			tool_calls: [{ index: 0, id: "one", function: { name: "fixture", arguments: '{"path":"' } }] }, finish_reason: null }] },
		toolChunk({ index: 0, function: { arguments: 'ok"}' } }), finished(),
	]);
	try {
		const stream = fixture.start();
		for await (const event of stream) if (event.type === "toolcall_delta") assert.equal(event.contentIndex, 2);
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual(result.content.map((block: any) => block.arguments ?? block.text ?? block.thinking), ["text", "think", { path: "ok" }]);
		assert.equal((result.content[1] as any).thinkingSignature, "reasoning_content");
	} finally { fixture.release(); }
});

for (const firstIdentity of ["index", "id"] as const) test(`Chat resolves late ${firstIdentity === "index" ? "id/name" : "index/name"} without replacing the JSON owner`, async () => {
	const first = firstIdentity === "index" ? { index: 7 } : { id: "late" };
	const fixture = chatEventsFixture([
		toolChunk({ ...first, type: "function", function: { arguments: '{"path":"' } }),
		toolChunk({ ...first, index: 7, id: "late", function: { name: "fixture", arguments: 'ok"}' } }), finished(),
	]);
	try {
		const stream = fixture.start(), generations: unknown[] = [];
		for await (const event of stream) if (event.type === "toolcall_delta") generations.push(event.toolArgsGeneration);
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.equal(result.content.length, 1); const block = result.content[0] as any;
		assert.deepEqual([block.id, block.name, block.arguments, block.streamIndex, block.toolArgsGeneration], ["late", "fixture", { path: "ok" }, undefined, undefined]);
		assert.deepEqual(generations, [1, 2]);
	} finally { fixture.release(); }
});

test("Chat JSON placeholder transitions to custom input and releases the unused parser", async () => {
	const fixture = chatEventsFixture([toolChunk({ index: 0, id: "custom" }),
		toolChunk({ index: 0, type: "custom", custom: { name: "grammar", input: "" } }),
		toolChunk({ index: 0, type: "custom", custom: { name: "grammar", input: "hello" } }), finished()]);
	const dispose = IncrementalToolArguments.prototype.dispose, states: ReturnType<IncrementalToolArguments["diagnostics"]>[] = [];
	IncrementalToolArguments.prototype.dispose = function() { dispose.call(this); states.push(this.diagnostics()); };
	try {
		const stream = fixture.start(), generations: unknown[] = [];
		for await (const event of stream) if (event.type === "toolcall_delta") generations.push(event.toolArgsGeneration);
		const result = await stream.result(), block = result.content[0] as any;
		assert.equal(result.stopReason, "toolUse", result.errorMessage); assert.deepEqual(block.arguments, { input: "hello" });
		assert.deepEqual(generations, [0, 1, 2, 3]);
		assert.equal(states.length, 1); assert.equal(states[0].finalizations, 0); assert.equal(states[0].retainedRoot, false); assert.equal(states[0].retainedRawCodeUnits, 0);
		assert.equal(block.customInput, undefined); assert.equal(block.toolArgsGeneration, undefined);
	} finally { IncrementalToolArguments.prototype.dispose = dispose; fixture.release(); }
});

for (const reason of ["length", "content_filter"]) test(`Chat retains the ${reason} terminal boundary`, async () => {
	const fixture = chatEventsFixture([toolChunk({ index: 0, id: "one", type: "function", function: { name: "fixture", arguments: '{"path":"unfinished' } }), finished(reason)]);
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
		const result = await stream.result(); assert.equal(result.stopReason, reason === "length" ? "length" : "error");
		assert.equal(hasIncompleteToolArguments((result.content[0] as any).arguments), true);
	} finally { fixture.release(); }
});

for (const omitStop of [false, true]) for (const input of ['', '{"path":"open', '{"path":"done"}']) {
	test(`Chat terminal completeness, omitted finish reason=${omitStop}, input=${input}`, async () => {
		const fixture = chatArgumentsFixture([input], 2, omitStop);
		try {
			const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
			const output = await stream.result(), block = output.content[0] as any;
			assert.equal(output.stopReason, omitStop ? "error" : "toolUse", output.errorMessage);
			assert.equal(hasIncompleteToolArguments(block.arguments), input !== '{"path":"done"}');
			assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined);
		} finally { fixture.release(); }
	});
}

for (const reason of ["abort", "error"] as const) test(`Chat ${reason} releases transient metadata and keeps partial arguments incomplete`, async () => {
	const controller = new AbortController(), fixture = chatArgumentsFixture(['{"path":"' + 'x'.repeat(1000) + '"}'], 16, false, reason === "error" ? 3 : undefined);
	try {
		const stream = fixture.start(undefined, controller.signal);
		for await (const event of stream) if (reason === "abort" && event.type === "toolcall_delta" && event.delta.length > 0) controller.abort();
		const output = await stream.result(), block = output.content[0] as any;
		assert.equal(output.stopReason, reason === "abort" ? "aborted" : "error");
		assert.equal(hasIncompleteToolArguments(block.arguments), true);
		assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined);
	} finally { fixture.release(); }
});

for (const complete of [false, true]) test(`Chat → Agent recovery and frozen observer snapshots, complete=${complete}`, async () => {
	const fixture = chatArgumentsFixture([complete ? '{"path":"fixture"}' : '{"path":"unfinished'], 2);
	let requests = 0, executions = 0;
	const snapshots: { value: object; json: string }[] = [];
	const agent = new Agent({ streamFn: (model, _context, options) => {
		if (requests++ === 0) return fixture.start(builtChat, options?.signal);
		const tail = new AssistantMessageEventStream();
		const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: [], stopReason: "stop" as const,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		tail.push({ type: "start", partial: message }); tail.push({ type: "done", reason: "stop", message }); return tail;
	} });
	agent.state.model = chatArgumentsModel;
	agent.state.tools = [{ name: "fixture", label: "fixture", description: "fixture", parameters: Type.Object({ path: Type.String() }),
		execute: async () => { executions++; return { content: [{ type: "text", text: "done" }], details: {} }; } }];
	agent.subscribeObserver(event => {
		if (event.type !== "message_update" || event.message.role !== "assistant") return;
		const block = event.message.content[0];
		if (block?.type === "toolCall") snapshots.push({ value: block.arguments, json: JSON.stringify(block.arguments) });
	}, { minIntervalMs: 0 });
	try {
		await agent.prompt("offline fixture"); await agent.waitForIdle();
		assert.equal(requests, 2); assert.equal(executions, complete ? 1 : 0);
		const result = agent.state.messages.find(message => message.role === "toolResult") as any;
		assert.equal(result.isError, !complete);
		if (!complete) assert.match(result.content[0].text, /^\[TOOL_ARGS_INCOMPLETE\]/);
		assert.ok(snapshots.length > 0);
		for (const snapshot of snapshots) { assert.equal(Object.isFrozen(snapshot.value), true); assert.equal(JSON.stringify(snapshot.value), snapshot.json); }
	} finally { agent.abort(); fixture.release(); }
});
