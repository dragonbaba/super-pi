import assert from "node:assert/strict";
import test from "node:test";
import { bedrockArgumentsFixture } from "../helpers/bedrock-arguments-fixture.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";
import { Type } from "typebox";
import { Agent } from "../../packages/agent/src/agent.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { bedrockArgumentsModel } from "../helpers/bedrock-arguments-fixture.ts";
// Agent consumes the built ai package's completeness registry. Keep this integration on that same graph.
import { stream as builtBedrock } from "@super-pi/ai/api/bedrock-converse-stream";

test("Bedrock wire indices stay separate from output order across text, thinking and parallel tools", async () => {
	const fixture = bedrockArgumentsFixture(['{"path":"a"}', '{"path":"b"}'], 1);
	fixture.events.splice(1, 0,
		{ contentBlockDelta: { contentBlockIndex: 50, delta: { text: "text" } } },
		{ contentBlockDelta: { contentBlockIndex: 70, delta: { reasoningContent: { text: "think", signature: "signed" } } } });
	fixture.events.splice(fixture.events.length - 1, 0,
		{ contentBlockStop: { contentBlockIndex: 50 } }, { contentBlockStop: { contentBlockIndex: 70 } },
		{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "late" } } } });
	try {
		const stream = fixture.start(), indices = new Set<number>();
		for await (const event of stream) if (event.type === "toolcall_delta") indices.add(event.contentIndex);
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual([...indices], [2, 3]);
		assert.deepEqual(result.content.map((block: any) => block.arguments ?? block.text ?? block.thinking), ["text", "think", { path: "a" }, { path: "b" }]);
		assert.equal((result.content[1] as any).thinkingSignature, "signed");
		for (const block of result.content as any[]) { assert.equal(block.index, undefined); assert.equal(block.toolArgsGeneration, undefined); }
	} finally { fixture.release(); }
});

test("Bedrock concurrent requests do not share argument owners", async () => {
	const fixture = bedrockArgumentsFixture(['{"path":"a","nested":[1,2]}'], 1);
	try {
		const outputs = await Promise.all([fixture.start().result(), fixture.start().result()]);
		for (const output of outputs) assert.equal(output.stopReason, "toolUse", output.errorMessage);
		assert.deepEqual(outputs[0].content, outputs[1].content);
		assert.notEqual((outputs[0].content[0] as any).arguments, (outputs[1].content[0] as any).arguments);
	} finally { fixture.release(); }
});

for (const ending of ["length", "service-error"] as const) test(`Bedrock ${ending} preserves final argument ownership and releases metadata`, async () => {
	const fixture = bedrockArgumentsFixture(['{"path":"unfinished'], 2, true);
	fixture.events[fixture.events.length - 1] = ending === "length" ? { messageStop: { stopReason: "max_tokens" } }
		: { internalServerException: { name: "InternalServerException", message: "offline failure" } };
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
		const result = await stream.result(), block = result.content[0] as any;
		assert.equal(result.stopReason, ending === "length" ? "length" : "error");
		assert.equal(hasIncompleteToolArguments(block.arguments), true);
		assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined); assert.equal(block.partialJson, undefined);
	} finally { fixture.release(); }
});

test("actual Bedrock adapter parses accumulated argument JSON only at finalization", async () => {
	const input = JSON.stringify({ payload: "x".repeat(8192) });
	const fixture = bedrockArgumentsFixture([input], 64), parse = JSON.parse;
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

test("interleaved Bedrock tools have independent numeric generations and no parser state on events", async () => {
	const inputs = ['{"path":"alpha","nested":[1,2]}', '{"path":"beta","nested":{"x":true}}'];
	const fixture = bedrockArgumentsFixture(inputs, 2), generations = [0, 0], roots: object[] = [], snapshots: unknown[] = [];
	const push = AssistantMessageEventStream.prototype.push;
	// partial is producer-owned and may already have advanced by the time a queued event is consumed.
	AssistantMessageEventStream.prototype.push = function(event) {
		if (event.type === "toolcall_delta") {
			const index = event.contentIndex, block = event.partial.content[index] as any;
			assert.equal(block.toolArgsGeneration, event.toolArgsGeneration);
			assert.equal(block.partialJson, undefined); assert.equal(block.parser, undefined);
			if (!roots[index]) { roots[index] = block.arguments; snapshots[index] = Object.freeze(structuredClone(block.arguments)); }
			else assert.equal(block.arguments, roots[index]);
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

for (const omitStop of [false, true]) for (const input of ['', '{"path":"open', '{"path":"done"}']) {
	test(`Bedrock terminal completeness, omitted tool stop=${omitStop}, input=${input}`, async () => {
		const fixture = bedrockArgumentsFixture([input], 2, omitStop);
		try {
			const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
			const output = await stream.result(), block = output.content[0] as any;
			assert.equal(output.stopReason, "toolUse", output.errorMessage);
			assert.equal(hasIncompleteToolArguments(block.arguments), input !== '{"path":"done"}');
			assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined);
		} finally { fixture.release(); }
	});
}

for (const reason of ["abort", "error"] as const) test(`Bedrock ${reason} releases transient metadata and keeps partial arguments incomplete`, async () => {
	const controller = new AbortController(), fixture = bedrockArgumentsFixture(['{"path":"' + 'x'.repeat(1000) + '"}'], 16, false, reason === "error" ? 3 : undefined);
	try {
		const stream = fixture.start(undefined, controller.signal);
		for await (const event of stream) if (reason === "abort" && event.type === "toolcall_delta") controller.abort();
		const output = await stream.result(), block = output.content[0] as any;
		assert.equal(output.stopReason, reason === "abort" ? "aborted" : "error");
		assert.equal(hasIncompleteToolArguments(block.arguments), true);
		assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined);
	} finally { fixture.release(); }
});

for (const complete of [false, true]) test(`Bedrock → Agent recovery and frozen observer snapshots, complete=${complete}`, async () => {
	const fixture = bedrockArgumentsFixture([complete ? '{"path":"fixture"}' : '{"path":"unfinished'], 2);
	let requests = 0, executions = 0;
	const snapshots: { value: object; json: string }[] = [];
	const agent = new Agent({ streamFn: (model, _context, options) => {
		if (requests++ === 0) return fixture.start(builtBedrock, options?.signal);
		const tail = new AssistantMessageEventStream();
		const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: [], stopReason: "stop" as const,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		tail.push({ type: "start", partial: message }); tail.push({ type: "done", reason: "stop", message }); return tail;
	} });
	agent.state.model = bedrockArgumentsModel;
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
