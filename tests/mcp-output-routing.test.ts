import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { convertMcpResult, McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHioAAAAASUVORK5CYII=";

function fixture(result: unknown, budget?: number) {
	let tool: any;
	let calls = 0;
	const runtime = new McpBridgeRuntime({ registerTool(value: unknown) { tool = value; } }, "fixture-workspace");
	const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
		async callTool() { calls++; return result; },
	} };
	runtime.registerRemoteTool(state, { name: "fixture", inputSchema: { type: "object", properties: {} } });
	const owner = budget === undefined ? undefined : createToolResultPresentationOwner({ enabled: true, budgetTokens: budget }, "routing-session")!;
	const ctx = { mcpResultInputConfigured: owner?.mcpInputConfigured ?? false,
		admitMcpResultInput(content: any, id: string) { owner!.admitMcpInput(content, id); } };
	return { owner, runtime, calls: () => calls, execute: () => tool.execute("routing-call", {}, undefined, undefined, ctx) };
}

for (const content of [
	[{ type: "text", text: "x".repeat(64 * 1024) }],
	[{ type: "audio", data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=", mimeType: "audio/wav" }],
	[{ type: "resource", resource: { uri: "fixture://user:CANARY_SECRET@host/path?token=CANARY_SECRET#CANARY_SECRET", blob: "YQ==", mimeType: "application/octet-stream" } }],
]) {
	test(`no-budget ${content[0]!.type} returns one bounded configuration failure`, async () => {
		const run = fixture({ content });
		const result = await run.execute();
		assert.equal(result.details.mcpError, "budget-not-configured");
		assert.equal(run.calls(), 1);
		assert.ok(JSON.stringify(result).length < 512);
		assert.equal(JSON.stringify(result).includes("CANARY_SECRET"), false);
		assert.equal(run.runtime.activeCalls.size, 0);
	});
}

test("no-budget tiny text preserves its baseline ToolResult", async () => {
	const run = fixture({ content: [{ type: "text", text: "tiny" }] });
	assert.deepEqual(await run.execute(), { content: [{ type: "text", text: "tiny" }], details: { server: "fixture", remoteTool: "fixture" } });
	assert.equal(run.calls(), 1);
});

test("configured MCP server error retains canonical text for recovery", async () => {
	const text = "server failure detail ".repeat(10_000);
	const run = fixture({ isError: true, content: [{ type: "text", text }] }, 256);
	try {
		const result = await run.execute();
		assert.equal(result.details.mcpError, "server-tool-error");
		assert.ok(result.content[0].text === text, "canonical server error source was lost");
		assert.equal(run.calls(), 1);
	} finally { run.owner!.dispose(); }
});

test("configured large text respects both model byte and token ceilings", async () => {
	const run = fixture({ content: [{ type: "text", text: "x".repeat(1024 * 1024) }] }, 1_000_000);
	try {
		const result = await run.execute();
		assert.equal(result.content[0].text.length, 1024 * 1024);
		const view = run.owner!.create(result.content, "routing-call");
		assert.equal(view?.version, 2);
		assert.ok(Buffer.byteLength(JSON.stringify(view!.modelContent)) <= 50 * 1024);
		assert.equal(run.calls(), 1);
	} finally { run.owner!.dispose(); }
});

test("large structured data has a bounded serialization and canonical object recovery", () => {
	const structuredContent = { rows: ["x".repeat(1024 * 1024), "tail"], order: [3, 1, 2] };
	const content = convertMcpResult({ content: [], structuredContent });
	assert.ok(Buffer.byteLength(content[0].text) <= 50 * 1024, "complete structured JSON was materialized as model text");
	assert.equal(content[0].mcpSource.value, structuredContent);
	assert.deepEqual(content[0].mcpSource.value.order, [3, 1, 2]);
});

test("MCP typed canonical text mutation invalidates an issued artifact", () => {
	const content = convertMcpResult({ content: [{ type: "resource", resource: { uri: "fixture://blob", blob: "YQ==", mimeType: "application/octet-stream" } }] });
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "routing-session")!;
	try {
		const view = owner.create(content, "routing-call");
		if (view?.version !== 2 || !view.artifact) assert.fail("artifact missing");
		const messages = [{ role: "toolResult", toolCallId: "routing-call", content }];
		owner.readArtifact(view.artifact.id, messages);
		content[0].text = "tampered canonical text";
		assert.throws(() => owner.readArtifact(view.artifact!.id, messages), { code: "stale-artifact" });
	} finally { owner.dispose(); }
});

test("PNG bytes declared as JPEG fail before full base64 decoding", () => {
	assert.throws(() => convertMcpResult({ content: [{ type: "image", data: PNG, mimeType: "image/jpeg" }] }), { code: "invalid-typed-content" });
});

test("MCP partial base64 padding is malformed", () => {
	assert.throws(() => convertMcpResult({ content: [{ type: "image", data: "ab=", mimeType: "image/png" }] }), { code: "invalid-typed-content" });
});

test("MCP typed continuation does not expose private source annotations", () => {
	const content = convertMcpResult({ content: [{ type: "resource", resource: { uri: "fixture://blob", blob: "YQ==", mimeType: "application/octet-stream" } }] });
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "routing-session")!;
	try {
		const view = owner.create(content, "routing-call");
		if (view?.version !== 2) assert.fail("continuation missing");
		const chunk = owner.readContinuation(view.continuation.cursor, [{ role: "toolResult", toolCallId: "routing-call", content }]);
		assert.equal(JSON.stringify(chunk).includes("mcpSource"), false);
	} finally { owner.dispose(); }
});
