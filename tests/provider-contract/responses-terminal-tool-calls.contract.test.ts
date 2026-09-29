import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../../packages/agent/src/agent.ts";
import { stream as streamCodex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { processResponsesStream } from "../../packages/ai/src/api/openai-responses-shared.ts";
import { byteChunks, codexModel, codexToken, responsesOutput, runCodexSse, sseFrames, sseResponse, textEvents } from "../helpers/responses-sse-fixture.ts";

const model: any = { ...codexModel, api: "openai-responses", provider: "fixture" };
const sink = { push() {} } as never;
const call = (id: string) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "bash" });
const custom = { type: "custom_tool_call", id: "ct_1", call_id: "call_c", name: "apply_patch", input: "" };
const completed = { type: "response.completed", response: { id: "resp", status: "completed" } };

async function* replay(events: readonly unknown[]) {
	for (const event of events) yield event as never;
}

// A completed response may only hand the agent tool calls whose output_item.done arrived.
for (const [name, events, unfinished] of [
	["function_call without output_item.done", [
		{ type: "response.output_item.added", output_index: 0, item: { ...call("1"), arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":"rm -rf /tmp/build' },
		completed,
	], "bash (call_1|fc_1)"],
	// llama.cpp-style servers omit output_index, so parallel calls collide on one slot.
	["parallel calls without output_index", [
		{ type: "response.output_item.added", item: { ...call("a"), arguments: "" } },
		{ type: "response.function_call_arguments.delta", delta: '{"command":"echo a"}' },
		{ type: "response.output_item.added", item: { ...call("b"), arguments: "" } },
		{ type: "response.function_call_arguments.delta", delta: '{"command":"echo b"}' },
		{ type: "response.output_item.done", item: { ...call("a"), arguments: '{"command":"echo a"}' } },
		{ type: "response.output_item.done", item: { ...call("b"), arguments: '{"command":"echo b"}' } },
		completed,
	], "bash (call_a|fc_a)"],
	["custom_tool_call without output_item.done", [
		{ type: "response.output_item.added", output_index: 0, item: custom },
		{ type: "response.custom_tool_call_input.delta", output_index: 0, delta: "*** Begin Patch" },
		completed,
	], "apply_patch (call_c|ct_1)"],
] as const) test(`Responses rejects completed stream with ${name}`, async () => {
	await assert.rejects(
		processResponsesStream(replay(events), responsesOutput(), sink, model),
		new RegExp(`^Error: OpenAI Responses stream completed with an unfinished tool call: ${unfinished.replace(/[()|]/g, "\\$&")}$`),
	);
});

test("Responses keeps finished function and custom tool calls", async () => {
	const done = { ...call("1"), arguments: '{"command":"ls"}' };
	const output = responsesOutput();
	await processResponsesStream(replay([
		{ type: "response.output_item.added", output_index: 0, item: { ...done, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: done.arguments },
		{ type: "response.output_item.done", output_index: 0, item: done },
		{ type: "response.output_item.added", output_index: 1, item: custom },
		{ type: "response.custom_tool_call_input.delta", output_index: 1, delta: "patch" },
		{ type: "response.output_item.done", output_index: 1, item: { ...custom, input: "patch" } },
		completed,
	]), output, sink, model);
	assert.equal(output.stopReason, "toolUse");
	assert.deepEqual(output.content.map((block: any) => [block.id, block.arguments, block.partialJson, block.customInput]), [
		["call_1|fc_1", { command: "ls" }, undefined, undefined],
		["call_c|ct_1", { input: "patch" }, undefined, undefined],
	]);
});

test("Responses leaves unfinished calls on truncated responses to the length path", async () => {
	const output = responsesOutput();
	await processResponsesStream(replay([
		{ type: "response.output_item.added", output_index: 0, item: { ...call("1"), arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":' },
		{ type: "response.incomplete", response: { id: "resp", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
	]), output, sink, model);
	assert.equal(output.stopReason, "length");
});

test("Codex SSE surfaces an unfinished tool call as an error result instead of tool use", async () => {
	const message = await runCodexSse(byteChunks(sseFrames([
		{ type: "response.output_item.added", output_index: 0, item: { ...call("1"), arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":"ls' },
		completed,
	]), 4096));
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /unfinished tool call: bash \(call_1\|fc_1\)/);
});

test("Agent never executes a tool call whose output_item.done did not arrive", async () => {
	let requests = 0, executions = 0;
	// Any follow-up request (only reachable if the call ran) ends the run with text.
	const fetch: typeof globalThis.fetch = async () => sseResponse(byteChunks(sseFrames(++requests > 1 ? textEvents() : [
		{ type: "response.output_item.added", output_index: 0, item: { ...call("1"), arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":"rm -rf /tmp/build' },
		completed,
	]), 4096));
	const agent = new Agent({ streamFn: (_m, context, options) => streamCodex(codexModel, context, { ...options, apiKey: codexToken(), transport: "sse", fetch, maxRetries: 0 }) });
	agent.state.model = codexModel;
	agent.state.tools = [{ name: "bash", label: "bash", description: "fixture", parameters: { type: "object", properties: {} } as never,
		execute: async () => { executions++; return { content: [{ type: "text", text: "ran" }], details: {} }; } }];
	await agent.prompt("offline");
	await agent.waitForIdle();
	assert.equal(requests, 1);
	assert.equal(executions, 0);
	const last: any = agent.state.messages.at(-1);
	assert.equal(last.role, "assistant");
	assert.equal(last.stopReason, "error");
	assert.equal(agent.state.messages.some((message: any) => message.role === "toolResult"), false);
});

for (const ending of ["toolUse", "length", "error", "abort"] as const) test(`Agent respects the real Codex ${ending} tool boundary`, async () => {
	let requests = 0, executions = 0;
	const finished = { ...call("1"), arguments: '{"command":"ls"}' };
	const first: unknown[] = [
		{ type: "response.output_item.added", output_index: 0, item: { ...finished, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: finished.arguments },
	];
	if (ending === "toolUse") first.push({ type: "response.output_item.done", output_index: 0, item: finished }, completed);
	else if (ending === "length") first.push({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
	else if (ending === "error") first.push({ type: "response.failed", response: { status: "failed", error: { message: "offline failure" } } });
	const fetch: typeof globalThis.fetch = async () => {
		requests++;
		if (ending !== "abort" || requests > 1) return sseResponse(byteChunks(sseFrames(requests > 1 ? textEvents() : first), 4096));
		return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sseFrames(first))); } }), { headers: { "content-type": "text/event-stream" } });
	};
	const agent = new Agent({ streamFn: (_m, context, options) => streamCodex(codexModel, context, { ...options, apiKey: codexToken(), transport: "sse", fetch, maxRetries: 0 }) });
	agent.state.model = codexModel;
	agent.state.tools = [{ name: "bash", label: "bash", description: "fixture", parameters: { type: "object", properties: {} } as never,
		execute: async () => { executions++; return { content: [{ type: "text", text: "ran" }], details: {} }; } }];
	const off = agent.subscribe(event => { if (ending === "abort" && event.type === "message_update") agent.abort(); });
	try {
		await agent.prompt("offline boundary");
		await agent.waitForIdle();
		assert.equal(executions, ending === "toolUse" ? 1 : 0);
		assert.equal(requests, ending === "toolUse" || ending === "length" ? 2 : 1);
		const results = agent.state.messages.filter((message: any) => message.role === "toolResult") as any[];
		assert.equal(results.length, ending === "toolUse" || ending === "length" ? 1 : 0);
		if (ending === "length") {
			assert.equal((agent.state.messages.find(message => message.role === "assistant") as any).stopReason, "length");
			assert.equal(results[0].isError, true, "truncated calls receive the existing synthetic error result");
		}
		const last: any = agent.state.messages.at(-1);
		assert.equal(last.stopReason, ending === "toolUse" || ending === "length" ? "stop" : ending === "abort" ? "aborted" : ending);
	} finally { off(); agent.abort(); }
});

test("Agent aborts its live Codex request when an awaited consumer throws", { timeout: 15_000 }, async () => {
	let requests = 0, cancels = 0, signal: AbortSignal | undefined;
	let bodyController!: ReadableStreamDefaultController<Uint8Array>;
	let finishCancel!: () => void;
	const cancelled = new Promise<void>(resolve => { finishCancel = resolve; });
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			bodyController = controller;
			controller.enqueue(new TextEncoder().encode(sseFrames(textEvents().slice(0, -1))));
		},
		cancel() { cancels++; finishCancel(); },
	});
	let producer!: ReturnType<typeof streamCodex>;
	const fetch: typeof globalThis.fetch = async () => {
		requests++;
		return requests === 1
			? new Response(body, { headers: { "content-type": "text/event-stream" } })
			: sseResponse(byteChunks(sseFrames(textEvents()), 4096));
	};
	const agent = new Agent({ streamFn: (_m, context, options) => {
		signal = options?.signal;
		producer = streamCodex(codexModel, context, { ...options, apiKey: codexToken(), transport: "sse", fetch, maxRetries: 0 });
		return producer;
	} });
	agent.state.model = codexModel;
	let failed = false;
	const off = agent.subscribe(event => {
		if (event.type === "message_update" && !failed) { failed = true; throw new Error("offline consumer failure"); }
	});
	try {
		await agent.prompt("offline consumer boundary");
		assert.equal(failed, true);
		assert.equal(signal?.aborted, true, "run owner must cancel before releasing activeRun");
		await cancelled;
		assert.equal((await producer.result()).stopReason, "aborted");
		assert.equal(cancels, 1);
		assert.equal(body.locked, false);
		assert.equal(agent.state.isStreaming, false);
		assert.equal((agent.state.messages.at(-1) as any).stopReason, "error", "consumer failure retains its original error classification");
		assert.match((agent.state.messages.at(-1) as any).errorMessage, /offline consumer failure/);
		await agent.prompt("next request");
		assert.equal(requests, 2);
		assert.equal((agent.state.messages.at(-1) as any).stopReason, "stop");
	} finally {
		off(); agent.abort();
		if (cancels === 0) bodyController.close();
		await producer.result();
	}
});
