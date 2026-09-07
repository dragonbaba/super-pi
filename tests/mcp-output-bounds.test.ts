import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The extension package is JavaScript and has no declarations.
import { convertMcpResult, McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error The extension package is JavaScript and has no declarations.
import { MAX_TEXT_BYTES, boundedJson } from "../packages/mcp-bridge/src/security.js";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

test("MCP tiny text preserves exact text and block ordering", () => {
	assert.deepEqual(convertMcpResult({ content: [{ type: "text", text: "first" }, { type: "text", text: "中 é 😀" }] }),
		[{ type: "text", text: "first" }, { type: "text", text: "中 é 😀" }]);
});

for (const bytes of [64 * 1024, 1024 * 1024, 10 * 1024 * 1024]) {
	test(`MCP ${bytes} text remains recoverable through the existing G2 artifact`, () => {
		const text = "x".repeat(bytes);
		const content = convertMcpResult({ content: [{ type: "text", text }] });
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "mcp-red-session")!;
		try {
			const presentation = owner.create(content, "mcp-red-call");
			assert.equal(presentation?.version, 2);
			if (presentation?.version !== 2 || !presentation.artifact) assert.fail("canonical recovery artifact missing");
			assert.ok(presentation.truncation.modelEstimatedTokens <= 256);
			const recovered = owner.readArtifact(presentation.artifact.id, [{ role: "toolResult", toolCallId: "mcp-red-call", content }]);
			const block = recovered.content[0];
			assert.equal(block?.type, "text");
			if (block?.type !== "text") assert.fail("text source missing");
			assert.equal(block.text.length, bytes, "bridge discarded canonical suffix before G2 admission");
		} finally {
			owner.dispose();
		}
	});
}

test("MCP structured serialization rejects cycles explicitly", () => {
	const value: Record<string, unknown> = {};
	value.self = value;
	assert.throws(() => boundedJson(value), { code: "invalid-structured-content" });
});

test("MCP legacy byte notice itself fits its emergency allowance", () => {
	const value = boundedJson({ text: "x".repeat(MAX_TEXT_BYTES * 2) }, MAX_TEXT_BYTES);
	assert.ok(Buffer.byteLength(value) <= MAX_TEXT_BYTES);
});

test("MCP malformed typed base64 is an explicit failure", () => {
	assert.throws(() => convertMcpResult({ content: [{ type: "image", mimeType: "image/png", data: "%%%" }] }),
		{ code: "invalid-typed-content" });
});

test("MCP protocol errors do not expose arbitrary server payloads", async () => {
	const runtime = new McpBridgeRuntime({ registerTool() {} }, "mcp-red-workspace");
	const canary = "CANARY_MCP_PROTOCOL_SECRET_5CB";
	const state = { status: "connected", error: null as string | null, config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
		async callTool() { throw new Error(canary); },
	} };
	await assert.rejects(runtime.callRemoteTool(state, "fixture", {}, undefined), (error: Error) => {
		assert.equal(error.message.includes(canary), false);
		assert.equal(String(state.error).includes(canary), false);
		return true;
	});
});

test("MCP production execution installs an isolated progress callback", async () => {
	let registered: any;
	let updates = 0;
	const runtime = new McpBridgeRuntime({ registerTool(tool: unknown) { registered = tool; } }, "mcp-red-workspace");
	const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
		async callTool(_params: unknown, _schema: unknown, options: any) {
			assert.equal(typeof options.onprogress, "function", "MCP request does not own a progress callback");
			for (let i = 0; i < 100_000; i++) options.onprogress({ progress: i, total: 100_000 });
			return { content: [{ type: "text", text: "final" }] };
		},
	} };
	runtime.registerRemoteTool(state, { name: "fixture", inputSchema: { type: "object", properties: {} } });
	const result = await registered.execute("mcp-red-call", {}, undefined, () => { updates++; });
	assert.deepEqual(result.content, [{ type: "text", text: "final" }]);
	assert.ok(updates > 0);
});

for (const kind of ["audio", "resource"] as const) {
	test(`MCP ${kind} payload remains recoverable without base64 model text`, () => {
		const data = kind === "audio"
			? "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="
			: "YQ==";
		const source = kind === "audio"
			? { type: "audio", data, mimeType: "audio/wav" }
			: { type: "resource", resource: { uri: "fixture://binary", blob: data, mimeType: "application/octet-stream" } };
		const content = convertMcpResult({ content: [source] });
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "mcp-typed-session")!;
		try {
			const view = owner.create(content, "mcp-typed-call");
			for (const block of content) if (block.type === "text") assert.equal(block.text.includes(data), false);
			assert.ok(view?.version === 2 && view.artifact, "omitted typed source has no existing-owner recovery handle");
		} finally { owner.dispose(); }
	});
}

test("MCP mixed text blocks beyond the content cap are not silently discarded", () => {
	const content: { type: "text"; text: string }[] = [];
	for (let index = 0; index < 257; index++) content.push({ type: "text", text: `block-${index}` });
	assert.throws(() => convertMcpResult({ content }), { code: "result-size-limit" });
});

test("MCP first delivery may be final without creating a progress update", async () => {
	let registered: any;
	let calls = 0;
	let updates = 0;
	const runtime = new McpBridgeRuntime({ registerTool(tool: unknown) { registered = tool; } }, "mcp-red-workspace");
	const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
		async callTool() { calls++; return { content: [{ type: "text", text: "final-only" }] }; },
	} };
	runtime.registerRemoteTool(state, { name: "fixture", inputSchema: { type: "object", properties: {} } });
	const result = await registered.execute("mcp-final-call", {}, undefined, () => { updates++; });
	assert.equal(calls, 1);
	assert.equal(updates, 0);
	assert.deepEqual(result.content, [{ type: "text", text: "final-only" }]);
});

test("MCP list pagination is not a tools/call cursor contract", async () => {
	const { CallToolResultSchema, ListToolsResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
	assert.equal("nextCursor" in CallToolResultSchema.shape, false);
	assert.equal("nextCursor" in ListToolsResultSchema.shape, true);
	const metadata = { fixtureOpaqueCursor: "opaque-fixture-token" };
	assert.deepEqual(CallToolResultSchema.parse({ content: [], _meta: metadata })._meta, metadata);
});
