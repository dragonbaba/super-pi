import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// @ts-expect-error JavaScript extension package.
import * as bridge from "../packages/mcp-bridge/src/bridge.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function connect(handler: any) {
	const client = bridge.createMcpClient?.() ?? new Client({ name: "baseline", version: "1" });
	const server = new Server({ name: "local-fixture", version: "1" }, { capabilities: { tools: {} } });
	server.setRequestHandler(CallToolRequestSchema, handler);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server, clientTransport };
}

test("100000 actual SDK client progress deliveries allocate no Promise history", async () => {
	const started = deferred<any>();
	const final = deferred<any>();
	const pair = await connect(async (request: any) => { started.resolve(request); return final.promise; });
	const runtime = new bridge.McpBridgeRuntime({ registerTool() {} }, "client-workspace");
	const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 30_000 }, client: pair.client };
	let updates = 0;
	let promises = 0;
	const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
	try {
		const pending = runtime.callRemoteTool(state, "fixture", {}, undefined, () => { updates++; });
		const request = await started.promise;
		const progressToken = request.params._meta.progressToken;
		hook.enable();
		for (let progress = 0; progress < 100_000; progress++) pair.clientTransport.onmessage!({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress, total: 100_000 } });
		hook.disable();
		final.resolve({ content: [{ type: "text", text: "final" }] });
		const result = await pending;
		assert.equal(result.content[0].text, "final");
		assert.ok(updates > 0);
		assert.equal(runtime.activeCalls.size, 0);
		assert.equal(promises, 0, "SDK notification scheduling creates a per-update Promise queue");
	} finally { hook.disable(); final.resolve({ content: [] }); await pair.client.close(); await pair.server.close(); }
});

test("actual SDK media result validation does not decode complete base64", async () => {
	const pair = await connect(async () => ({ content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHioAAAAASUVORK5CYII=" }] }));
	const original = globalThis.atob;
	let decodes = 0;
	globalThis.atob = (value) => { decodes++; return original(value); };
	try {
		const result = await pair.client.callTool({ name: "fixture", arguments: {} });
		assert.equal(result.content.length, 1);
		assert.equal(decodes, 0, "SDK validation decoded data before byte admission");
	} finally { globalThis.atob = original; await pair.client.close(); await pair.server.close(); }
});

test("late SDK progress is ignored without serializing a server payload", async () => {
	const started = deferred<any>();
	const pair = await connect(async (request: any) => { started.resolve(request); return { content: [] }; });
	const errors: string[] = [];
	pair.client.onerror = (error: Error) => { errors.push(error.message); };
	try {
		await pair.client.callTool({ name: "fixture" }, undefined, { onprogress() {} });
		const request = await started.promise;
		pair.clientTransport.onmessage!({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: request.params._meta.progressToken, progress: 1, message: "CANARY_LATE_PROGRESS_SECRET" } });
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(errors, []);
	} finally { await pair.client.close(); await pair.server.close(); }
});
