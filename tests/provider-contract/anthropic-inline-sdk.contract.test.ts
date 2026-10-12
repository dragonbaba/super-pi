import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

// These are SDK types, deliberately without casts: 0.91.1 cannot represent this
// protocol. This fixture does not enable inline tools in Super Pi's adapter.
const initialTool = { name: "read", description: "Read a file", input_schema: { type: "object" as const, properties: {} } };
const addition = {
	type: "tool_addition",
	tool: { type: "tool_definition", definition: {
		name: "lookup", description: "Look up a record", input_schema: {
			type: "object", properties: { key: { type: "string" } }, required: ["key"],
		},
	} },
} satisfies BetaContentBlockParam;
const replacement = {
	type: "tool_addition",
	tool: { type: "tool_definition", definition: {
		name: "lookup", description: "Look up multiple records", input_schema: {
			type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"],
		},
	} },
} satisfies BetaContentBlockParam;
const removal = { type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } } satisfies BetaContentBlockParam;

test("Anthropic beta SDK preserves typed inline definitions, replacement and removal on the wire", async () => {
	const captured: { body: any; headers: Headers }[] = [];
	const client = new Anthropic({ apiKey: "offline-fixture", baseURL: "https://fixture.invalid", maxRetries: 0,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			captured.push({ body: await request.json(), headers: request.headers });
			return new Response("", { headers: { "content-type": "text/event-stream" } });
		},
	});
	const messages: BetaMessageParam[] = [{ role: "user", content: "Find a record" }];
	const tools = [initialTool];
	Object.freeze(initialTool.input_schema.properties);
	Object.freeze(initialTool.input_schema);
	Object.freeze(initialTool);
	Object.freeze(tools);
	for (const block of [addition, replacement, removal]) {
		messages.push({ role: "system", content: [block] });
		const response = await client.beta.messages.create({ model: "fixture", max_tokens: 32,
			betas: ["inline-tools-2026-09-15"], tools, messages, stream: true,
		}).asResponse();
		await response.text();
		messages.push({ role: "assistant", content: "OK" }, { role: "user", content: "Continue" });
	}
	for (let index = 0; index < captured.length; index++) {
		const current = captured[index];
		assert.match(current.headers.get("anthropic-beta") ?? "", /inline-tools-2026-09-15/);
		assert.equal(current.headers.get("x-api-key"), "offline-fixture");
		assert.deepEqual(current.body.tools, tools);
		assert.deepEqual(current.body.messages.at(-1).content, [[addition, replacement, removal][index]]);
		if (index > 0) assert.deepEqual(current.body.messages.slice(0, captured[index - 1].body.messages.length), captured[index - 1].body.messages);
	}
	assert.equal(captured.length, 3);
});
