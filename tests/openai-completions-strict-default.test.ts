import assert from "node:assert/strict";
import test from "node:test";
import { MODELS } from "../packages/ai/src/models.generated.ts";
import { validateToolArguments } from "../packages/ai/src/utils/validation.ts";
import { isContextOverflow } from "../packages/ai/src/utils/overflow.ts";
import { stream as streamCompletions, streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { deriveModelCapabilities, getModelCapabilities } from "../packages/ai/src/model-capabilities.ts";
import type { Context, Model, Tool } from "../packages/ai/src/types.ts";

const TOOL: Tool = {
	name: "lookup",
	description: "lookup",
	parameters: {
		type: "object",
		properties: { query: { type: "string" }, note: { type: "string" } },
	},
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

function model(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	return {
		id: "unknown-endpoint-model",
		name: "Unknown endpoint model",
		api: "openai-completions",
		provider: "fixture-unknown",
		baseUrl: "https://unknown.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 1_024,
		...(compat ? { compat } : {}),
	};
}

function context(): Context {
	return { systemPrompt: "strict fixture", messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [TOOL] };
}

async function captureWire(entry: Model<"openai-completions">): Promise<Record<string, any>> {
	let wire: Record<string, any> | undefined;
	const stream = streamCompletions(entry, context(), {
		apiKey: "fixture-key",
		maxTokens: 1,
		fetch: async (_input, init) => {
			const payload = JSON.parse(String(init?.body));
			wire = payload;
			const strict = payload.tools?.[0]?.function?.strict;
			if (strict !== undefined) {
				return new Response(JSON.stringify({ error: { message: "Invalid parameter: strict" } }), { status: 400 });
			}
			const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: entry.id,
				choices: [{ index: 0, delta: { content: "accepted" }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const result = await stream.result();
	assert.ok(wire, "the serializer must reach the fixture wire");
	return { wire, result };
}

test("wire alone omits strict and does not promote optional properties for unknown endpoints", async () => {
	const { wire, result } = await captureWire(model());
	assert.equal(wire.tools[0].function.strict, undefined);
	assert.deepEqual(wire.tools[0].function.parameters, TOOL.parameters);
	assert.equal(result.stopReason, "stop");
});

test("all built-in chat models carry consistent explicit strict metadata", async () => {
	let positives = 0, negatives = 0;
	for (const catalog of Object.values(MODELS)) for (const entry of Object.values(catalog)) {
		if (entry.api !== "openai-completions") continue;
		const chat = entry as Model<"openai-completions">;
		assert.equal(typeof chat.compat?.supportsStrictMode, "boolean", `${chat.provider}/${chat.id} needs explicit metadata`);
		const expected = chat.compat?.supportsStrictMode === true;
		assert.equal(deriveModelCapabilities(chat).strictToolSchema, expected, `${chat.provider}/${chat.id}`);
		const { wire } = await captureWire(chat);
		assert.equal(wire.tools[0].function.strict, expected ? true : undefined, `${chat.provider}/${chat.id}`);
		if (expected) positives++; else negatives++;
	}
	assert.ok(positives > 500); assert.ok(negatives > 50);
});

test("explicit capability supports strict while explicit compat false and capability false veto it", async () => {
	const base = model();
	const declared = { ...base, capabilities: { ...deriveModelCapabilities(base), strictToolSchema: true } };
	assert.equal((await captureWire(declared)).wire.tools[0].function.strict, true);
	assert.equal((await captureWire({ ...declared, compat: { supportsStrictMode: false } })).wire.tools[0].function.strict, undefined);
	assert.equal((await captureWire({ ...model({ supportsStrictMode: true }), capabilities: deriveModelCapabilities(base) })).wire.tools[0].function.strict, undefined);
});

test("non-strict schemas still use the unchanged local argument validator", () => {
	const required = { ...TOOL, parameters: { ...TOOL.parameters, required: ["query"] } };
	assert.throws(() => validateToolArguments(required, { type: "toolCall", id: "call", name: "lookup", arguments: {} }));
	assert.deepEqual(validateToolArguments(required, { type: "toolCall", id: "call", name: "lookup", arguments: { query: "valid" } }), { query: "valid" });
});

test("unknown OpenAI-compatible endpoints default to non-strict on capability and wire", async () => {
	const entry = model();
	assert.equal(deriveModelCapabilities(entry).strictToolSchema, false);
	assert.equal(getModelCapabilities(entry).strictToolSchema, false);
	const { wire, result } = await captureWire(entry);
	const functionTool = wire.tools[0].function;
	assert.equal(functionTool.strict, undefined);
	assert.deepEqual(functionTool.parameters, TOOL.parameters);
	assert.equal(result.stopReason, "stop");
	assert.equal(isContextOverflow(result, entry.contextWindow), false, "compatibility errors must not trigger compaction");
});

test("explicit strict metadata is authoritative in both capability and final wire", async () => {
	const entry = model({ supportsStrictMode: true });
	assert.equal(deriveModelCapabilities(entry).strictToolSchema, true);
	const { wire } = await captureWire({ ...entry, compat: { supportsStrictMode: true } });
	const functionTool = wire.tools[0].function;
	assert.equal(functionTool.strict, true);
	assert.deepEqual(functionTool.parameters.required, ["query", "note"]);

	const disabled = model({ supportsStrictMode: false });
	assert.equal(deriveModelCapabilities(disabled).strictToolSchema, false);
	const disabledWire = await captureWire(disabled);
	assert.equal(disabledWire.wire.tools[0].function.strict, undefined);
});

test("strict=require remains a local error when the endpoint does not support strict tools", async () => {
	const required = { ...TOOL, constrainedSampling: { type: "json_schema" as const, strict: "require" as const } };
	const entry = model();
	let sends = 0;
	const result = await streamSimple(entry, { ...context(), tools: [required] }, {
			apiKey: "fixture-key",
			fetch: async () => { sends++; throw new Error("wire must not be attempted"); },
		} as any).result();
	assert.equal(sends, 0);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /requires JSON-schema constrained sampling.*strict tools are unsupported/);
});
