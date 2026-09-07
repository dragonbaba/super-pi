import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../packages/agent/src/agent.ts";
import { alphaHeadless, alphaModelRuntime } from "./helpers/alpha-session.ts";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";

test("session input seam preserves MCP tool-level error status", async () => {
	const fixture = await alphaHeadless(alphaModelRuntime());
	try {
		const result = { content: [{ type: "text", text: "bounded failure" }], details: { mcpError: "budget-not-configured" } };
		const outcome = await fixture.session.agent.afterToolCall!({ toolCall: { type: "toolCall", id: "mcp-fail", name: "mcp__fixture__fixture", arguments: {} }, args: {}, result, isError: false } as never);
		assert.equal(outcome?.isError, true);
	} finally { await fixture.release(); }
});

test("MCP progress observer rejection cannot replace the canonical final result", async () => {
	let tool: any;
	const runtime = new McpBridgeRuntime({ registerTool(value: any) { tool = value; } }, "fixture-workspace");
	const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
		async callTool(_params: any, _schema: any, options: any) {
			options.onprogress({ progress: 1 });
			await Promise.resolve();
			options.onprogress({ progress: 2 });
			return { content: [{ type: "text", text: "canonical-final" }] };
		},
	} };
	runtime.registerRemoteTool(state, { name: "fixture", inputSchema: { type: "object", properties: {} } });
	let streams = 0;
	const finals: any[] = [];
	const agent = new Agent({ initialState: { tools: [tool] }, streamFn: (() => {
		const withTool = streams++ === 0;
		const message = { role: "assistant", content: withTool ? [{ type: "toolCall", id: "mcp-final", name: tool.name, arguments: {} }] : [{ type: "text", text: "done" }],
			api: "fixture", provider: "fixture", model: "fixture", stopReason: withTool ? "toolUse" : "stop", timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		return { async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: message };
			if (withTool) { yield { type: "toolcall_start", contentIndex: 0, partial: message }; yield { type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message }; }
			yield { type: "done", reason: message.stopReason, message };
		}, async result() { return message; } };
	}) as never });
	agent.subscribe(async (event) => {
		if (event.type === "tool_execution_update") throw new Error("CANARY_OBSERVER_SECRET");
		if (event.type === "tool_execution_end") finals.push(event);
	});
	await agent.prompt("fixture");
	assert.equal(finals.length, 1);
	assert.equal(finals[0].isError, false);
	assert.equal(finals[0].result.content[0].text, "canonical-final");
	assert.equal(runtime.activeCalls.size, 0);
});
