import assert from "node:assert/strict";
import test from "node:test";
import { processResponsesStream } from "../../packages/ai/src/api/openai-responses-shared.ts";
import { IncrementalToolArguments } from "../../packages/ai/src/utils/incremental-tool-arguments.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";
import { responsesArgumentsFixture } from "../helpers/responses-arguments-fixture.ts";
import { codexModel, responsesOutput, sseFrames, byteChunks, sseResponse } from "../helpers/responses-sse-fixture.ts";
import { stream as openai } from "../../packages/ai/src/api/openai-responses.ts";
import { stream as azure } from "../../packages/ai/src/api/azure-openai-responses.ts";

const item = (args: string) => ({ type: "function_call", id: "fc_1", call_id: "call_1", name: "fixture", arguments: args });
const added = (args: string) => ({ type: "response.output_item.added", output_index: 0, item: item(args) });
const delta = (text: string) => ({ type: "response.function_call_arguments.delta", output_index: 0, delta: text });
const argsDone = (args: string) => ({ type: "response.function_call_arguments.done", output_index: 0, arguments: args });
const done = (args: string) => ({ type: "response.output_item.done", output_index: 0, item: item(args) });
const completed = { type: "response.completed", response: { id: "resp", status: "completed" } };
async function* replay(events: readonly unknown[]) { for (const event of events) yield event as never; }

test("actual Responses SSE parses argument JSON only at output_item.done", async () => {
	const input = JSON.stringify({ payload: "x".repeat(8192) }), fixture = responsesArgumentsFixture([input], 64), parse = JSON.parse;
	let calls = 0, units = 0;
	JSON.parse = function(text, reviver) {
		if (typeof text === "string" && text.startsWith('{"payload"')) { calls++; units += text.length; }
		return parse(text, reviver);
	};
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* real delivery */ }
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.equal((result.content[0] as any).arguments.payload.length, 8192);
		assert.deepEqual({ calls, units }, { calls: 1, units: input.length });
	} finally { JSON.parse = parse; fixture.release(); }
});

test("interleaved Responses tools mutate private previews with independent numeric generations", async () => {
	const inputs = ['{"path":"alpha","nested":[1,2]}', '{"path":"beta","nested":{"x":true}}'];
	const fixture = responsesArgumentsFixture(inputs, 2), generations = [0, 0], roots: object[] = [], snapshots: unknown[] = [];
	try {
		const stream = fixture.start();
		for await (const event of stream) if (event.type === "toolcall_delta") {
			const index = event.contentIndex, block = event.partial.content[index] as any;
			assert.equal(event.toolArgsGeneration, ++generations[index]); assert.equal(block.toolArgsGeneration, generations[index]);
			assert.equal(block.partialJson, undefined); assert.equal(block.parser, undefined);
			if (!roots[index]) { roots[index] = block.arguments; snapshots[index] = Object.freeze(structuredClone(block.arguments)); }
			else assert.equal(block.arguments, roots[index]);
		}
		const result = await stream.result();
		for (let index = 0; index < inputs.length; index++) {
			const block = result.content[index] as any;
			assert.deepEqual(block.arguments, JSON.parse(inputs[index])); assert.equal(block.toolArgsGeneration, undefined);
			assert.deepEqual(snapshots[index], {}); assert.equal(hasIncompleteToolArguments(block.arguments), false);
		}
	} finally { fixture.release(); }
});

for (const [name, initial, fragments, whole, final, expected] of [
	["suffix", '{"path":"', ["old"], '{"path":"old"}', "", { path: "old" }],
	["replacement", '{"path":"', ["old"], '{"path":"new"}', "", { path: "new" }],
	["same", "", ['{"path":"old"}'], '{"path":"old"}', "", { path: "old" }],
	["final authority", "", ['{"path":"old"}'], '{"path":"old"}', '{"path":"final"}', { path: "final" }],
	["initial only", '{"path":"initial"}', [], undefined, "", { path: "initial" }],
	["empty replacement", '{"path":"old"}', [], "", "", {}],
] as const) test(`Responses authoritative argument boundary: ${name}`, async () => {
	const events: unknown[] = [added(initial), ...fragments.map(delta)]; if (whole !== undefined) events.push(argsDone(whole));
	events.push(done(final), completed);
	const output = responsesOutput(), seen: string[] = [], preview: unknown[] = [];
	const sink = { push(event: any) {
		if (event.type === "toolcall_delta") { seen.push(event.delta); preview.push(structuredClone(event.partial.content[0].arguments)); }
	} } as never;
	await processResponsesStream(replay(events), output, sink, codexModel);
	const block = output.content[0] as any;
	assert.deepEqual(block.arguments, expected); assert.equal(hasIncompleteToolArguments(block.arguments), name === "empty replacement");
	assert.equal(block.toolArgsGeneration, undefined);
	assert.deepEqual(seen, name === "suffix" ? ["old", '"}'] : fragments);
	if (name === "suffix") assert.deepEqual(preview.at(-1), { path: "old" });
});

for (const input of ["", '{"path":"unfinished', '{"path":"done"}']) test(`Responses final completeness: ${input}`, async () => {
	const fixture = responsesArgumentsFixture([input], 2);
	try {
		const stream = fixture.start(); for await (const _event of stream) { /* drain */ }
		const result = await stream.result(), block = result.content[0] as any;
		assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.equal(hasIncompleteToolArguments(block.arguments), input !== '{"path":"done"}');
		assert.equal(block.toolArgsGeneration, undefined);
	} finally { fixture.release(); }
});

test("arguments.done alone cannot authorize execution and collision releases displaced parsers", async () => {
	const dispose = IncrementalToolArguments.prototype.dispose, released: ReturnType<IncrementalToolArguments["diagnostics"]>[] = [];
	IncrementalToolArguments.prototype.dispose = function() { dispose.call(this); released.push(this.diagnostics()); };
	try {
		for (const events of [[added("{}"), argsDone("{}"), completed], [added("{}"), added("{}"), done("{}"), completed]]) {
			const output = responsesOutput();
			await assert.rejects(processResponsesStream(replay(events), output, { push() {} } as never, codexModel), /unfinished tool call/);
			for (const block of output.content as any[]) assert.equal(block.toolArgsGeneration, undefined);
		}
		assert.equal(released.length, 3);
		for (const state of released) { assert.equal(state.retainedRawCodeUnits, 0); assert.equal(state.retainedRoot, false); }
	} finally { IncrementalToolArguments.prototype.dispose = dispose; }
});

test("Responses length boundary releases JSON and grammar scratch without making partial JSON complete", async () => {
	const output = responsesOutput();
	await processResponsesStream(replay([added('{"path":"open'),
		{ type: "response.output_item.added", output_index: 1, item: { type: "custom_tool_call", id: "ct", call_id: "ct", name: "patch", input: "raw" } },
		{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
	]), output, { push() {} } as never, codexModel);
	assert.equal(output.stopReason, "length"); assert.equal(hasIncompleteToolArguments((output.content[0] as any).arguments), true);
	assert.deepEqual((output.content[1] as any).arguments, { input: "raw" });
	for (const block of output.content as any[]) { assert.equal(block.toolArgsGeneration, undefined); assert.equal(block.customInput, undefined); }
});

for (const [name, factory] of [["openai", openai], ["azure", azure]] as const) test(`${name} SDK SSE reaches the shared incremental producer`, async () => {
	const fetch: typeof globalThis.fetch = async () => sseResponse(byteChunks(sseFrames([added(""), delta('{"path":"ok"}'), argsDone('{"path":"ok"}'), done(""), completed]), 32));
	const model: any = { ...codexModel, api: name === "openai" ? "openai-responses" : "azure-openai-responses", provider: name === "openai" ? "openai" : "azure-openai", baseUrl: "https://fixture.invalid" };
	const stream = factory(model, { messages: [] }, { apiKey: "fixture", fetch, maxRetries: 0 });
	for await (const _event of stream) { /* SDK decodes fixture SSE */ }
	const result = await stream.result(); assert.equal(result.stopReason, "toolUse", result.errorMessage);
	assert.deepEqual((result.content[0] as any).arguments, { path: "ok" });
});

import { Agent } from "../../packages/agent/src/agent.ts";
import { Type } from "typebox";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
// Match Agent's built ai completeness registry.
import { stream as builtCodex } from "@super-pi/ai/api/openai-codex-responses";

for (const complete of [false, true]) test(`Responses → Agent recovery and frozen observer snapshots, complete=${complete}`, async () => {
	const fixture = responsesArgumentsFixture([complete ? '{"path":"fixture"}' : '{"path":"unfinished'], 2);
	let requests = 0, executions = 0;
	const snapshots: { value: object; json: string }[] = [];
	const agent = new Agent({ streamFn: (model, _context, options) => {
		if (requests++ === 0) return fixture.start(builtCodex, options?.signal);
		const tail = new AssistantMessageEventStream();
		const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: [], stopReason: "stop" as const,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		tail.push({ type: "start", partial: message }); tail.push({ type: "done", reason: "stop", message }); return tail;
	} });
	agent.state.model = codexModel;
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
