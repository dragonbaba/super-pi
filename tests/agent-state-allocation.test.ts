import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentMessage } from "../packages/agent/src/types.ts";
import { Agent, type AgentOptions } from "../packages/agent/src/agent.ts";

const UNUSED_STREAM: AgentOptions["streamFn"] = () => {
	throw new Error("state fixture does not stream");
};

test("Agent state reuses stable accessors while preserving assignment isolation", () => {
	const first = new Agent({ streamFn: UNUSED_STREAM }).state;
	const second = new Agent({ streamFn: UNUSED_STREAM }).state;
	const firstTools = Object.getOwnPropertyDescriptor(first, "tools");
	const secondTools = Object.getOwnPropertyDescriptor(second, "tools");
	const firstMessages = Object.getOwnPropertyDescriptor(first, "messages");
	const secondMessages = Object.getOwnPropertyDescriptor(second, "messages");

	assert.ok(firstTools?.get);
	assert.ok(firstTools.set);
	assert.strictEqual(firstTools.get, secondTools?.get);
	assert.strictEqual(firstTools.set, secondTools?.set);
	assert.strictEqual(firstMessages?.get, secondMessages?.get);
	assert.strictEqual(firstMessages?.set, secondMessages?.set);
	assert.equal(firstTools.enumerable, true);
	assert.equal(firstMessages?.enumerable, true);

	const tools: typeof first.tools = [];
	const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 0 }];
	first.tools = tools;
	first.messages = messages;
	assert.notStrictEqual(first.tools, tools);
	assert.notStrictEqual(first.messages, messages);
	tools.push({ name: "late-tool" } as (typeof tools)[number]);
	messages.push({ role: "user", content: "late-message", timestamp: 1 });
	assert.equal(first.tools.length, 0);
	assert.equal(first.messages.length, 1);

	assert.deepEqual(Object.keys(first), [
		"systemPrompt",
		"model",
		"thinkingLevel",
		"tools",
		"messages",
		"isStreaming",
		"streamingMessage",
		"pendingToolCalls",
		"errorMessage",
	]);
	for (const symbol of Object.getOwnPropertySymbols(first)) {
		assert.equal(Object.getOwnPropertyDescriptor(first, symbol)?.enumerable, false);
	}
});

test("mutable agent state construction contains no per-instance accessor functions", () => {
	const source = readFileSync(new URL("../packages/agent/src/agent.ts", import.meta.url), "utf8");
	const start = source.indexOf("function createMutableAgentState(");
	const end = source.indexOf("\n}\n\n/** Options for constructing", start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	const body = source.slice(start, end);

	assert.doesNotMatch(body, /\bget\s+(?:tools|messages)\s*\(/);
	assert.doesNotMatch(body, /\bset\s+(?:tools|messages)\s*\(/);
	assert.doesNotMatch(body, /=>|FunctionExpression|\.bind\s*\(/);
});
