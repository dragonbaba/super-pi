import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../packages/agent/src/agent.ts";
import { stream as sourcePi } from "../../packages/ai/src/api/pi-messages.ts";
import { stream as builtPi } from "@super-pi/ai/api/pi-messages";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { IncrementalToolArguments } from "../../packages/ai/src/utils/incremental-tool-arguments.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";
import { piMessagesArgumentsFixture, piMessagesArgumentsModel, piMessagesEventsFixture, piMessagesUsage } from "../helpers/pi-messages-arguments-fixture.ts";

const start = (contentIndex = 0) => ({ type: "toolcall_start", contentIndex, id: `tool-${contentIndex}`, toolName: "fixture" });
const delta = (text: string, contentIndex = 0) => ({ type: "toolcall_delta", contentIndex, delta: text });
const done = (reason = "toolUse") => ({ type: "done", reason, usage: piMessagesUsage });
const end = (args: unknown) => ({ type: "toolcall_end", contentIndex: 0, toolCall: {
	type: "toolCall", id: "final-id", name: "final-name", arguments: args, thoughtSignature: "signed", namespace: "ns",
} });
async function resultOf(events: readonly unknown[]) {
	const fixture = piMessagesEventsFixture(events);
	try { const stream = fixture.start(); for await (const _event of stream) { /* drain */ } return await stream.result(); }
	finally { fixture.release(); }
}

for (const args of [{ path: "server-correction" }, {}, { nested: { unicode: "中😀" } }]) test(`Pi Messages authoritative terminal object replaces preview: ${JSON.stringify(args)}`, async () => {
	const result = await resultOf([start(), delta('{"path":"unfinished'), end(args), done()]);
	assert.equal(result.stopReason, "toolUse");
	const block = result.content[0] as any;
	assert.deepEqual(block.arguments, args); assert.equal(hasIncompleteToolArguments(block.arguments), false);
	assert.equal(block.id, "final-id"); assert.equal(block.name, "final-name");
	assert.equal(block.thoughtSignature, "signed"); assert.equal(block.namespace, "ns"); assert.equal(block.toolArgsGeneration, undefined);
});

test("Pi Messages interleaved tools mutate only their own previews and expose fixed event generations", async () => {
	const inputs = ['{"path":"中😀\\n","nested":[1,2]}', '{"path":"beta","nested":{"x":true}}'];
	const fixture = piMessagesArgumentsFixture(inputs, 2), generations = [0, 0], roots: object[] = [], snapshots: unknown[] = [];
	const push = AssistantMessageEventStream.prototype.push;
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
		for await (const event of stream) if (event.type === "toolcall_delta") assert.equal(event.toolArgsGeneration, ++generations[event.contentIndex]);
		const result = await stream.result(); assert.equal(result.stopReason, "toolUse");
		for (let index = 0; index < inputs.length; index++) {
			const block = result.content[index] as any;
			assert.deepEqual(block.arguments, JSON.parse(inputs[index])); assert.equal(block.toolArgsGeneration, undefined);
			assert.deepEqual(snapshots[index], {});
		}
	} finally { AssistantMessageEventStream.prototype.push = push; fixture.release(); }
});

for (const reason of ["toolUse", "length"]) for (const input of ["", '{"path":"open', '{"path":"done"}']) test(`Pi Messages missing tool end finalizes once: ${reason}, ${input}`, async () => {
	const finalize = IncrementalToolArguments.prototype.finalize; let finalizations = 0;
	IncrementalToolArguments.prototype.finalize = function(text) { finalizations++; return finalize.call(this, text); };
	try {
		const result = await resultOf([start(), delta(input), done(reason)]), block = result.content[0] as any;
		assert.equal(result.stopReason, reason); assert.equal(finalizations, 1);
		assert.equal(hasIncompleteToolArguments(block.arguments), input !== '{"path":"done"}');
		assert.equal(block.toolArgsGeneration, undefined);
	} finally { IncrementalToolArguments.prototype.finalize = finalize; }
});

test("Pi Messages starts replace prior owners, including a tool slot becoming text", async () => {
	const dispose = IncrementalToolArguments.prototype.dispose; let disposed = 0;
	IncrementalToolArguments.prototype.dispose = function() { disposed++; return dispose.call(this); };
	try {
		const result = await resultOf([start(), delta('{"discarded":'), start(), delta('{"alsoDiscarded":'),
			{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "ok" },
			{ type: "text_end", contentIndex: 0, content: "final", contentSignature: "text-signature" }, done("stop")]);
		assert.equal(disposed, 2); assert.deepEqual(result.content, [{ type: "text", text: "final", textSignature: "text-signature" }]);
	} finally { IncrementalToolArguments.prototype.dispose = dispose; }
});

test("Pi Messages start/end without deltas and interleaved thinking preserve metadata", async () => {
	const result = await resultOf([start(), { type: "thinking_start", contentIndex: 1 },
		{ type: "thinking_delta", contentIndex: 1, delta: "preview" },
		{ type: "thinking_end", contentIndex: 1, content: "final", contentSignature: "thinking-signature", redacted: true }, end({ path: "ok" }), done()]);
	assert.equal(result.stopReason, "toolUse"); assert.deepEqual((result.content[0] as any).arguments, { path: "ok" });
	assert.deepEqual(result.content[1], { type: "thinking", thinking: "final", thinkingSignature: "thinking-signature", redacted: true });
});

test("Pi Messages server error releases parser and preserves partial/rewrite diagnostics", async () => {
	const result = await resultOf([start(), delta('{"path":"partial'), { type: "error", reason: "error", usage: piMessagesUsage,
		errorMessage: "server failed", responseId: "response", rewrite: { policyId: "p", policyVersion: 1, changed: true, tokenCountChange: 0, messageCountChange: 0, systemPromptChanged: false } }]);
	assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "server failed"); assert.equal(result.responseId, "response");
	const block = result.content[0] as any; assert.equal(block.toolArgsGeneration, undefined); assert.equal(hasIncompleteToolArguments(block.arguments), true);
	assert.equal(result.diagnostics?.[0]?.type, "pi_messages_rewrite");
});

for (const reason of ["abort", "error", "eof"] as const) test(`Pi Messages local ${reason} retains existing empty error result and clears prior partial metadata`, async () => {
	const fixture = reason === "eof" ? piMessagesEventsFixture([start(), delta('{"path":')])
		: piMessagesArgumentsFixture(['{"path":"' + 'x'.repeat(1000) + '"}'], 16, false, reason === "error" ? 3 : undefined);
	const controller = new AbortController(); let partial: any;
	try {
		const stream = fixture.start(undefined, controller.signal);
		for await (const event of stream) if (event.type === "toolcall_delta") { partial = event.partial; if (reason === "abort") controller.abort(); }
		const result = await stream.result(); assert.equal(result.stopReason, reason === "abort" ? "aborted" : "error");
		assert.deepEqual(result.content, []); assert.equal(partial.content[0].toolArgsGeneration, undefined);
		if (reason === "eof") assert.match(result.errorMessage!, /without a terminal event/);
	} finally { fixture.release(); }
});

for (const separator of ["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n"]) for (const chunkSize of [1, 17]) test(`Pi Messages native SSE split UTF-8/separator ${JSON.stringify(separator)}, chunk=${chunkSize}`, async () => {
	const frames = [{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "中😀" }, done("stop")];
	const bytes = new TextEncoder().encode(frames.map(e => `event: ignored\ndata: ${JSON.stringify(e)}`).join(separator) + separator + "unread");
	let cursor = 0, cancelled = false;
	const body = new ReadableStream<Uint8Array>({ pull(controller) {
		controller.enqueue(bytes.subarray(cursor, cursor + chunkSize)); cursor += chunkSize;
	}, cancel() { cancelled = true; } }, { highWaterMark: 0 });
	const stream = sourcePi(piMessagesArgumentsModel, { messages: [] }, { apiKey: "fixture", fetch: async () => new Response(body) });
	for await (const _event of stream) { /* drain */ }
	const result = await stream.result(); assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal((result.content[0] as any).text, "中😀"); assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test("Pi Messages retains first data line and EOF terminal handling; DONE alone is not terminal", async () => {
	for (const success of [true, false]) {
		const wire = success ? `:comment\ndata: ${JSON.stringify(done("stop"))}\ndata: invalid-second-line` : 'data: [DONE]\n\n';
		const stream = sourcePi(piMessagesArgumentsModel, { messages: [] }, { apiKey: "fixture", fetch: async () => new Response(wire) });
		for await (const _event of stream) { /* drain */ }
		const result = await stream.result(); assert.equal(result.stopReason, success ? "stop" : "error");
		if (!success) assert.match(result.errorMessage!, /without a terminal event/);
	}
});

for (const complete of [false, true]) test(`PiMessages → Agent recovery and frozen observer snapshots, complete=${complete}`, async () => {
	const fixture = piMessagesArgumentsFixture([complete ? '{"path":"fixture"}' : '{"path":"unfinished'], 2, !complete);
	let requests = 0, executions = 0;
	const snapshots: { value: object; json: string }[] = [];
	const agent = new Agent({ streamFn: (model, _context, options) => {
		if (requests++ === 0) return fixture.start(builtPi, options?.signal);
		const tail = new AssistantMessageEventStream();
		const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: [], stopReason: "stop" as const,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		tail.push({ type: "start", partial: message }); tail.push({ type: "done", reason: "stop", message }); return tail;
	} });
	agent.state.model = piMessagesArgumentsModel;
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
