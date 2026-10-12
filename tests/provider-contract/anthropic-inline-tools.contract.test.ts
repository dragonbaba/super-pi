import assert from "node:assert/strict";
import test from "node:test";
import { stream, type AnthropicOptions } from "../../packages/ai/src/api/anthropic-messages.ts";
import { conservativeModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import type { Context, Model, Tool } from "../../packages/ai/src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5", name: "Claude Opus 5", api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};
const read: Tool = { name: "read", description: "read", parameters: { type: "object", properties: {} } };
const lookup: Tool = { name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } };
function response(): Response {
	return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","usage":{}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"OK"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
}
function fixture() {
	const bodies: any[] = [];
	const headers: Headers[] = [];
	const context: Context = { systemPrompt: "Use read.", tools: [read], messages: [] };
	async function turn(nextModel = model, options: Partial<AnthropicOptions> = {}, addUser = true) {
		if (addUser) context.messages.push({ role: "user", content: "continue", timestamp: 1 });
		const result = await stream(nextModel, context, { apiKey: "fixture", cacheRetention: "none", maxRetries: 0,
			...options,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				bodies.push(await request.json()); headers.push(request.headers);
				return response();
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		context.messages.push(result);
		return result;
	}
	return { bodies, headers, context, turn };
}

test("inline definitions, replacement, removal and prompt updates preserve the initial prefix", async () => {
	const f = fixture();
	await f.turn();
	f.context.tools = [read, lookup]; f.context.systemPrompt = "Use read and lookup.";
	await f.turn();
	assert.deepEqual(f.bodies[1].tools, f.bodies[0].tools);
	assert.deepEqual(f.bodies[1].system, f.bodies[0].system);
	assert.match(f.headers[1].get("anthropic-beta") ?? "", /inline-tools-2026-09-15/);
	assert.equal(f.bodies[1].messages.at(-1).role, "system");
	assert.equal(f.bodies[1].messages.at(-1).content.find((b: any) => b.type === "tool_addition").tool.definition.name, "lookup");
	f.context.tools = [read, { ...lookup, description: "new lookup schema", parameters: { type: "object", properties: { key: { type: "string" } } } }];
	await f.turn();
	assert.equal(f.bodies[2].messages.at(-1).content[0].tool.definition.description, "new lookup schema");
	f.context.tools = [read]; f.context.systemPrompt = "Use only read.";
	await f.turn();
	assert.deepEqual(f.bodies[3].tools, f.bodies[0].tools);
	assert.ok(f.bodies[3].messages.at(-1).content.some((b: any) => b.type === "tool_removal" && b.tool.name === "lookup"));
	assert.match(f.bodies[3].messages.at(-1).content.find((b: any) => b.type === "text").text, /Use only read\./);
	assert.deepEqual(f.bodies[3].messages.slice(0, f.bodies[2].messages.length), f.bodies[2].messages);
});

test("checkpoints survive JSON resume, own schemas, and rebase after pruning", async () => {
	const f = fixture();
	const owned = { ...read, parameters: { type: "object", properties: { path: { type: "string" } } } };
	f.context.tools = [owned];
	const initial = await f.turn();
	assert.ok(initial.anthropicContext);
	owned.parameters.properties.path.type = "number";
	assert.equal((initial.anthropicContext.tools[0].parameters as any).properties.path.type, "string");
	f.context.messages = JSON.parse(JSON.stringify(f.context.messages));
	const replacement = await f.turn();
	assert.equal(f.bodies[1].messages.at(-1).content[0].tool.definition.input_schema.properties.path.type, "number");
	assert.equal((await f.turn()).anthropicContext, undefined, "unchanged requests do not persist duplicate snapshots");
	f.context.messages = [replacement, { role: "user", content: "after compaction", timestamp: 2 }];
	await f.turn(model, {}, false);
	assert.equal(f.bodies[3].tools[0].input_schema.properties.path.type, "number");
	assert.equal(f.bodies[3].messages.some((m: any) => m.role === "system"), false);
});

test("tool-result adjacency, removal of all tools and empty initial tools", async () => {
	const f = fixture();
	const first = await f.turn();
	first.content = [{ type: "toolCall", id: "call", name: "read", arguments: {} }]; first.stopReason = "toolUse";
	f.context.messages.push({ role: "toolResult", toolName: "read", toolCallId: "call", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2, addedToolNames: ["lookup"] });
	f.context.tools = [read, lookup];
	await f.turn(model, {}, false);
	const messages = f.bodies[1].messages;
	assert.deepEqual(messages.slice(-3).map((m: any) => m.role), ["assistant", "user", "system"]);
	assert.equal(messages.at(-2).content[0].type, "tool_result");
	assert.equal(messages.at(-2).content[0].content, "done");
	f.context.tools = [];
	await f.turn();
	assert.deepEqual(f.bodies[2].messages.at(-1).content.map((b: any) => b.tool.name), ["read", "lookup"]);
	const empty = fixture(); empty.context.tools = [];
	assert.equal((await empty.turn()).anthropicContext, undefined);
	empty.context.tools = [read]; await empty.turn();
	assert.equal(empty.bodies[1].messages.some((m: any) => m.role === "system"), false);
});

test("exact model and custom compat gates keep legacy and no-tool paths intact", async () => {
	for (const id of ["claude-opus-4-7", "claude-sonnet-5", "claude-opus-5-unknown"]) {
		const f = fixture(); await f.turn({ ...model, id });
		assert.equal(f.headers[0].get("anthropic-beta")?.includes("inline-tools"), false);
		assert.equal(f.bodies[0].tools.length, 1);
	}
	for (const compat of [undefined, { supportsMidConvoSystemMessages: true }, { supportsMidConvoToolChanges: true }]) {
		const f = fixture(); await f.turn({ ...model, provider: "custom", compat });
		assert.equal(f.bodies[0].tools.length, 1);
	}
	const custom = fixture();
	await custom.turn({ ...model, provider: "custom", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } });
	assert.match(custom.headers[0].get("anthropic-beta") ?? "", /inline-tools/);
	const f = fixture(); await f.turn(); f.context.tools = [lookup];
	await f.turn({ ...model, compat: { supportsMidConvoToolChanges: false } });
	assert.deepEqual(f.bodies[1].tools.map((tool: any) => tool.name), ["lookup"]);
	assert.equal(f.bodies[1].messages.some((m: any) => m.role === "system"), false);
	await f.turn();
	assert.equal(f.bodies[2].tools[0].name, "lookup");
	const noTools = { ...model, capabilities: conservativeModelCapabilities(), contextWindow: 32768, maxTokens: 4096 };
	await f.turn(noTools);
	assert.equal(f.bodies[3].tools, undefined);
});

test("payload declaration overrides reset continuity, and partial updates never carry snapshots", async () => {
	const f = fixture();
	await f.turn(model, { onPayload: payload => { (payload as any).tools = [{ name: "override", description: "override", input_schema: { type: "object", properties: {} } }]; } });
	assert.equal((f.context.messages.at(-1) as any).anthropicContext, null);
	await f.turn();
	assert.equal(f.bodies[1].tools[0].name, "read");
	const events = stream(model, { systemPrompt: "read", tools: [read], messages: [{ role: "user", content: "go", timestamp: 1 }] }, { apiKey: "fixture", fetch: async () => response(), maxRetries: 0 });
	let partials = 0;
	for await (const event of events) {
		if ("partial" in event) { partials++; assert.equal(event.partial.anthropicContext, undefined); }
	}
	assert.ok(partials > 0);
	assert.ok((await events.result()).anthropicContext);
	const buffered = stream(model, { tools: [read], messages: [{ role: "user", content: "go", timestamp: 1 }] }, { apiKey: "fixture", fetch: async () => response(), maxRetries: 0 });
	assert.ok((await buffered.result()).anthropicContext);
	for await (const event of buffered) if ("partial" in event) assert.equal(event.partial.anthropicContext, undefined);
	const failed = await stream(model, f.context, { apiKey: "fixture", fetch: async () => new Response("fail", { status: 400 }), maxRetries: 0 }).result();
	assert.equal(failed.stopReason, "error"); assert.equal(failed.anthropicContext, undefined);
});

test("payload hooks cannot mutate historical schemas or the next request's placeholder", async () => {
	const f = fixture(); const first = await f.turn();
	const saved = JSON.stringify(first.anthropicContext);
	await f.turn(model, { onPayload: payload => {
		const wire = payload as any;
		wire.tools[0].input_schema.properties.injected = { type: "string" };
		wire.tools.at(-1).name = "mutated-placeholder";
	} });
	assert.equal(JSON.stringify(first.anthropicContext), saved);
	assert.equal((f.context.messages.at(-1) as any).anthropicContext, null);
	await f.turn();
	assert.equal(f.bodies[2].tools[0].input_schema.properties.injected, undefined);
	assert.equal(f.bodies[2].tools.at(-1).name, "__pi_deferred_placeholder__");
});

test("conversion policy changes rebase snapshots and inline tail contributes to request headroom", async () => {
	const f = fixture();
	const first = await f.turn();
	first.usage.input = first.usage.totalTokens = 1000;
	f.context.systemPrompt = "Updated instruction ".repeat(500);
	await f.turn({ ...model, contextWindow: 12000 }, { maxTokens: 6000 });
	assert.ok(f.bodies[1].max_tokens < 5000, "new system text must reduce available response capacity after usage anchor");
	await f.turn({ ...model, compat: { supportsEagerToolInputStreaming: false } });
	assert.equal(f.bodies[2].messages.some((m: any) => m.role === "system"), false);
	assert.equal(f.bodies[2].system[0].text, f.context.systemPrompt);
	assert.equal(f.bodies[2].tools[0].eager_input_streaming, undefined);
});

test("review: inline beta transport preserves automatic and explicit beta headers", async () => {
	const f = fixture();
	await f.turn({ ...model, compat: { supportsEagerToolInputStreaming: false } });
	assert.match(f.headers[0].get("anthropic-beta") ?? "", /fine-grained-tool-streaming-2025-05-14/);
	assert.match(f.headers[0].get("anthropic-beta") ?? "", /interleaved-thinking-2025-05-14/);
	await f.turn(model, { headers: { "Anthropic-Beta": "custom-feature, another-feature" } });
	assert.match(f.headers[1].get("anthropic-beta") ?? "", /custom-feature/);
	assert.match(f.headers[1].get("anthropic-beta") ?? "", /another-feature/);
	assert.match(f.headers[1].get("anthropic-beta") ?? "", /inline-tools-2026-09-15/);
});

test("review: rebased prefix declarations are counted even with old reported usage", async () => {
	for (const reset of ["legacy", "policy", "hook", "model"] as const) {
		const f = fixture(); const first = await f.turn();
		first.usage.input = first.usage.totalTokens = 1000;
		if (reset === "legacy") first.anthropicContext = undefined;
		if (reset === "hook") first.anthropicContext = null;
		if (reset === "model") first.model = "different-model";
		f.context.systemPrompt = "New instruction ".repeat(600);
		const nextModel = { ...model, contextWindow: 12000, ...(reset === "policy" ? { compat: { supportsEagerToolInputStreaming: false } } : {}) };
		await f.turn(nextModel, { maxTokens: 6000 });
		assert.ok(f.bodies[1].max_tokens < 5000, `${reset}: missing new initial declarations`);
	}
});

test("review: effective metadata tracks inline instructions and currently available definitions", async () => {
	const f = fixture(); const observations: any[] = [];
	const options = { onEffectiveDispatch: (observation: any) => { observations.push(observation); } };
	await f.turn(model, options);
	f.context.tools = [read, lookup]; f.context.systemPrompt = "Use lookup now.";
	await f.turn(model, options);
	assert.notEqual(observations[0].instructionsHash, observations[1].instructionsHash);
	assert.notEqual(observations[0].toolsHash, observations[1].toolsHash);
	assert.equal(observations[0].toolCount, 1);
	assert.equal(observations[1].toolCount, 2);
	f.context.tools = [lookup]; await f.turn(model, options);
	assert.equal(observations[2].toolCount, 1);
	assert.notEqual(observations[1].toolIdentifierSetHash, observations[2].toolIdentifierSetHash);
	assert.equal(JSON.stringify(observations).includes("Use lookup now."), false);
});
