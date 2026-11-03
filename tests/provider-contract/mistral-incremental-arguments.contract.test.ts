import assert from "node:assert/strict";
import test from "node:test";
import { mistralArgumentsFixture, mistralEventsFixture } from "../helpers/mistral-arguments-fixture.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";
import { Type } from "typebox";
import { Agent } from "../../packages/agent/src/agent.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { mistralArgumentsModel } from "../helpers/mistral-arguments-fixture.ts";
// Agent consumes the built ai package's completeness registry. Keep this integration on that same graph.
import { stream as builtMistral } from "@super-pi/ai/api/mistral-conversations";
import { stream as sourceMistral } from "../../packages/ai/src/api/mistral-conversations.ts";

const toolsChunk = (...calls: unknown[]) => ({ id: "fixture", choices: [{ delta: { tool_calls: calls }, finish_reason: null }] });
const finished = (reason = "tool_calls") => ({ id: "fixture", choices: [{ delta: {}, finish_reason: reason }] });
const call = (args: unknown, fields: Record<string, unknown> = {}) => ({ index: 7, id: "one", ...fields, function: { name: "fixture", arguments: args } });

for (const [name, wire, chunkSize, expectedError] of [
	["CRLF and split UTF-8", `data: ${JSON.stringify({ choices: [{ delta: { content: "中😀" }, finish_reason: "stop" }] })}\r\n\r\ndata: [DONE]\r\n\r\n`, 1, undefined],
	["multiline data", 'data: {"choices":\ndata: [{"delta":{"content":"中😀"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', 13, undefined],
	["unterminated final event", 'data: {"choices":[{"delta":{"content":"中😀"},"finish_reason":"stop"}]}', 17, undefined],
	["read chunk capacity", "x".repeat(1024 * 1024 + 1), 1024 * 1024 + 1, /stream chunk exceeded/],
	["event capacity", "data: " + "x".repeat(1024 * 1024), 65536, /streaming event exceeded/],
	["invalid event shape", 'data: {"choices":null}\n\n', 64, /Invalid Mistral streaming event/],
] as const) test(`Mistral native SSE preserves ${name}`, async () => {
	const bytes = new TextEncoder().encode(wire); let cursor = 0, cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (cursor >= bytes.length) { controller.close(); return; }
			controller.enqueue(bytes.subarray(cursor, cursor + chunkSize)); cursor += chunkSize;
		},
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 }); // Keep unread EOF pending so errors exercise cancellation of an open body.
	const stream = sourceMistral(mistralArgumentsModel, { messages: [] }, {
		apiKey: "fixture", maxRetries: 0, fetch: async () => new Response(body),
	});
	for await (const _event of stream) { /* drain */ }
	const result = await stream.result();
	if (expectedError) { assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, expectedError); }
	else { assert.equal(result.stopReason, "stop", result.errorMessage); assert.equal((result.content[0] as any).text, "中😀"); }
	assert.equal(body.locked, false);
	if (expectedError) assert.equal(cancelled, true);
});

for (const [name, fragments, expected] of [
	["object argument", [{ path: "ok" }], { path: "ok" }],
	["object fragment", ['{"nested":', { path: "ok" }, '}'], { nested: { path: "ok" } }],
	["unicode and escapes", Array.from('{"path":"中😀\\n\\u4e2d"}'), { path: "中😀\n中" }],
] as const) test(`Mistral preserves ${name} input semantics`, async () => {
	const fixture = mistralEventsFixture([...fragments.map(fragment => toolsChunk(call(fragment))), finished()]);
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual((result.content[0] as any).arguments, expected);
	} finally { fixture.release(); }
});

test("Mistral late id/name and content interleaving retain one argument owner", async () => {
	const fixture = mistralEventsFixture([
		{ choices: [{ delta: { content: "before" } }] },
		toolsChunk({ index: 7, id: "null", function: { arguments: '{"path":"' } }),
		{ choices: [{ delta: { content: [{ type: "thinking", thinking: [{ text: "think" }] }, { type: "text", text: "after" }] } }] },
		toolsChunk(call('ok"}', { id: "late" })), finished(),
	]);
	try {
		const stream = fixture.start();
		for await (const event of stream) if (event.type === "toolcall_delta") assert.equal(event.contentIndex, 1);
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual(result.content.map((block: any) => block.arguments ?? block.text ?? block.thinking), ["before", { path: "ok" }, "think", "after"]);
		assert.equal((result.content[1] as any).id, "late"); assert.equal((result.content[1] as any).name, "fixture");
	} finally { fixture.release(); }
});

test("Mistral retains chunk-position matching when tool indices are absent", async () => {
	const fixture = mistralEventsFixture([
		toolsChunk(call('{"path":"', { index: undefined, id: "a" }), call('{"path":"', { index: undefined, id: "b" })),
		toolsChunk(call('a"}', { index: undefined, id: "a" }), call('b"}', { index: undefined, id: "b" })), finished(),
	]);
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.deepEqual(result.content.map((block: any) => [block.id, block.arguments]), [["a", { path: "a" }], ["b", { path: "b" }]]);
	} finally { fixture.release(); }
});

for (const reason of ["length", "error"]) test(`Mistral preserves ${reason} terminal classification`, async () => {
	const fixture = mistralEventsFixture([toolsChunk(call('{"path":"unfinished')), finished(reason)]);
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
		const result = await stream.result(); assert.equal(result.stopReason, reason);
		assert.equal(hasIncompleteToolArguments((result.content[0] as any).arguments), true);
		assert.equal((result.content[0] as any).toolArgsGeneration, undefined);
	} finally { fixture.release(); }
});

test("actual Mistral adapter parses accumulated argument JSON only at finalization", async () => {
	const input = JSON.stringify({ payload: "x".repeat(8192) });
	const fixture = mistralArgumentsFixture([input], 64), parse = JSON.parse;
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

test("interleaved Mistral tools have independent numeric generations and no parser state on events", async () => {
	const inputs = ['{"path":"alpha","nested":[1,2]}', '{"path":"beta","nested":{"x":true}}'];
	const fixture = mistralArgumentsFixture(inputs, 2), generations = [0, 0], roots: object[] = [], snapshots: unknown[] = [];
	const push = AssistantMessageEventStream.prototype.push;
	// partial is producer-owned and may already have advanced by the time a queued event is consumed.
	AssistantMessageEventStream.prototype.push = function(event) {
		if (event.type === "toolcall_delta") {
			const index = event.contentIndex, block = event.partial.content[index] as any;
			assert.equal(block.toolArgsGeneration, event.toolArgsGeneration);
			assert.equal(block.partialArgs, undefined); assert.equal(block.parser, undefined);
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
	test(`Mistral terminal completeness, omitted finish reason=${omitStop}, input=${input}`, async () => {
		const fixture = mistralArgumentsFixture([input], 2, omitStop);
		try {
			const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
			const output = await stream.result(), block = output.content[0] as any;
			assert.equal(output.stopReason, omitStop ? "error" : "toolUse", output.errorMessage);
			assert.equal(hasIncompleteToolArguments(block.arguments), input !== '{"path":"done"}');
			assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined);
		} finally { fixture.release(); }
	});
}

for (const reason of ["abort", "error"] as const) test(`Mistral ${reason} releases transient metadata and keeps partial arguments incomplete`, async () => {
	const controller = new AbortController(), fixture = mistralArgumentsFixture(['{"path":"' + 'x'.repeat(1000) + '"}'], 16, false, reason === "error" ? 3 : undefined);
	try {
		const stream = fixture.start(undefined, controller.signal);
		for await (const event of stream) if (reason === "abort" && event.type === "toolcall_delta") controller.abort();
		const output = await stream.result(), block = output.content[0] as any;
		assert.equal(output.stopReason, reason === "abort" ? "aborted" : "error");
		assert.equal(hasIncompleteToolArguments(block.arguments), true);
		assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.index, undefined);
	} finally { fixture.release(); }
});

for (const complete of [false, true]) test(`Mistral → Agent recovery and frozen observer snapshots, complete=${complete}`, async () => {
	const fixture = mistralArgumentsFixture([complete ? '{"path":"fixture"}' : '{"path":"unfinished'], 2);
	let requests = 0, executions = 0;
	const snapshots: { value: object; json: string }[] = [];
	const agent = new Agent({ streamFn: (model, _context, options) => {
		if (requests++ === 0) return fixture.start(builtMistral, options?.signal);
		const tail = new AssistantMessageEventStream();
		const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: [], stopReason: "stop" as const,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		tail.push({ type: "start", partial: message }); tail.push({ type: "done", reason: "stop", message }); return tail;
	} });
	agent.state.model = mistralArgumentsModel;
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
