import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import ts from "typescript";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension package.
import { McpSchemaCache, configFingerprint, prepareSchemaCache } from "../packages/mcp-bridge/src/schema-cache.js";
// @ts-expect-error JavaScript extension package.
import { MAX_TOOL_LIST_PAGES, MAX_TOOL_CATALOG_BYTES } from "../packages/mcp-bridge/src/client.js";

function tool(name: string, extra = {}) { return { name, inputSchema: { type: "object" }, ...extra }; }

function fixture(t: TestContext, pages: any[], overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "sp-mcp-pagination-"));
	const previous = process.env.SP_CODING_AGENT_DIR;
	process.env.SP_CODING_AGENT_DIR = root;
	const cache = new McpSchemaCache(), registered = new Map<string, any>();
	const config = { id: "fixture", source: "fixture", transport: "http", url: "https://fixture.invalid/mcp", headers: {},
		maxTools: 64, startupTimeoutMs: 3000, toolTimeoutMs: 3000, ...overrides };
	const runtime = new McpBridgeRuntime({ registerTool(value: any) { registered.set(value.name, value); } }, root, cache);
	const control = { pages, result: { content: [{ type: "text", text: "ok" }] } as any, calls: [] as string[], cursors: [] as unknown[], initializes: 0 };
	t.mock.method(globalThis, "fetch", async (_input: any, init: RequestInit) => {
		if (init.method !== "POST") return new Response(null, { status: 405 });
		const request = JSON.parse(init.body as string);
		if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
		let result;
		if (request.method === "initialize") {
			control.initializes++; result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pagination", version: "1" } };
		} else if (request.method === "tools/list") {
			control.cursors.push(request.params?.cursor);
			const index = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
			result = control.pages[index];
			if (typeof result === "function") result = await result(request, init.signal);
			if (result instanceof Error) throw result;
		} else if (request.method === "tools/call") { control.calls.push(request.params.name); result = control.result; }
		else throw new Error(`unexpected method ${request.method}`);
		return Response.json({ jsonrpc: "2.0", id: request.id, result });
	});
	t.after(async () => {
		await runtime.close();
		if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR;
		else process.env.SP_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	return { root, cache, config, runtime, control, registered, connect: (signal?: AbortSignal) => runtime.connect(config, signal) };
}

test("MCP discovery registers, searches, calls and caches every tool across three pages", async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, { tools: [], nextCursor: "2" }, { tools: [tool("last")] }]);
	await f.connect();
	assert.deepEqual(f.control.cursors, [undefined, "1", "2"]);
	assert.deepEqual(f.runtime.searchTools("fixture"), ["mcp__fixture__first", "mcp__fixture__last"]);
	for (const name of ["first", "last"]) assert.equal((await f.registered.get(`mcp__fixture__${name}`).execute(name, {})).content[0].text, "ok");
	assert.deepEqual(f.control.calls, ["first", "last"]);
	assert.deepEqual(new McpSchemaCache().get(f.config, f.root).tools.map((item: any) => item.name), ["first", "last"]);
});

test("MCP discovery accepts a null terminal cursor at the actual SDK decoding boundary", async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: null }]);
	await f.connect();
	assert.deepEqual(f.runtime.toolNames(), ["mcp__fixture__first"]);
});

test("MCP second-page failure publishes no partial replacement and preserves the last complete cache", async t => {
	const f = fixture(t, [{ tools: [tool("old")] }]);
	await f.connect();
	const before = readFileSync(f.cache.path, "utf8");
	f.control.pages = [{ tools: [tool("new")], nextCursor: "1" }, new Error("second page failed")];
	await assert.rejects(f.connect(), { code: "protocol-error" });
	assert.equal(f.registered.has("mcp__fixture__new"), false);
	assert.equal(readFileSync(f.cache.path, "utf8"), before);
	assert.deepEqual(f.runtime.toolNames(), ["mcp__fixture__old"]);
	f.control.pages[1] = { tools: [tool("last")] };
	await f.connect();
	assert.deepEqual(f.runtime.toolNames(), ["mcp__fixture__new", "mcp__fixture__last"]);
});

for (const cursor of [undefined, "", null]) for (const last of [false, true]) {
	test(`MCP terminal cursor ${String(cursor)} on ${last ? "last" : "first"} page`, async t => {
		const final = { tools: [tool("last")], nextCursor: cursor };
		const f = fixture(t, last ? [{ tools: [tool("first")], nextCursor: "1" }, final] : [final]);
		await f.connect();
		assert.equal(f.control.cursors.length, last ? 2 : 1);
		assert.ok(f.runtime.searchTools("last").includes("mcp__fixture__last"));
	});
}

for (const cursor of [0, false, {}, [], "x".repeat(4097)]) {
	test(`MCP malformed/oversized cursor ${typeof cursor}/${String(cursor).length} rejects before registration`, async t => {
		const f = fixture(t, [{ tools: [tool("first")], nextCursor: cursor }]);
		await assert.rejects(f.connect(), { code: "protocol-error" });
		assert.equal(f.registered.size, 0);
		assert.equal(f.cache.get(f.config, f.root), null);
	});
}

for (const cycle of [false, true]) test(`MCP rejects ${cycle ? "cycling" : "repeated"} cursors without a partial catalog`, async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" },
		{ tools: [], nextCursor: cycle ? "2" : "1" }, { tools: [], nextCursor: "1" }]);
	await assert.rejects(f.connect(), { code: "protocol-error" });
	assert.equal(f.control.cursors.length, cycle ? 3 : 2);
	assert.equal(f.registered.size, 0);
});

for (const complete of [false, true]) test(`MCP 128-page boundary complete=${complete}`, async t => {
	const pages = Array.from({ length: MAX_TOOL_LIST_PAGES }, (_, index) => ({ tools: complete ? [tool(`tool_${index}`)] : [],
		nextCursor: complete && index === MAX_TOOL_LIST_PAGES - 1 ? undefined : String(index + 1) }));
	const f = fixture(t, pages, { maxTools: 128 });
	if (complete) { await f.connect(); assert.equal(f.runtime.toolNames().length, 128); }
	else { await assert.rejects(f.connect(), { code: "protocol-error" }); assert.equal(f.registered.size, 0); }
	assert.equal(f.control.cursors.length, MAX_TOOL_LIST_PAGES);
});

test("MCP configured tool limit is cumulative across pages", async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, { tools: [tool("second"), tool("third")] }], { maxTools: 2 });
	await assert.rejects(f.connect(), { code: "protocol-error" });
	assert.equal(f.registered.size, 0);
});

test("MCP catalog byte limit is cumulative even when every individual schema fits", async t => {
	const description = "x".repeat(Math.floor(MAX_TOOL_CATALOG_BYTES / 3));
	const f = fixture(t, [0, 1, 2].map(index => ({ tools: [tool(`tool_${index}`, { description })], nextCursor: index === 2 ? undefined : String(index + 1) })));
	await assert.rejects(f.connect(), { code: "protocol-error" });
	assert.equal(f.control.cursors.length, 3);
	assert.equal(f.registered.size, 0);
});

for (const field of ["inputSchema", "outputSchema"]) for (const limit of ["bytes", "depth"]) {
	test(`MCP rejects ${field} exceeding ${limit} before publishing any page`, async t => {
		let schema: any = { type: "object", description: limit === "bytes" ? "x".repeat(16 * 1024) : "" };
		if (limit === "depth") for (let index = 0; index < 33; index++) schema = { type: "object", properties: { nested: schema } };
		const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, { tools: [tool("bad", { [field]: schema })] }]);
		await assert.rejects(f.connect(), { code: "protocol-error" });
		assert.equal(f.registered.size, 0);
	});
}

for (const duplicate of ["first", "FIRST"]) test(`MCP preflights cross-page duplicate identity ${duplicate}`, async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, { tools: [tool(duplicate)] }]);
	await assert.rejects(f.connect(), { code: "protocol-error" });
	assert.equal(f.registered.size, 0);
	assert.equal(f.cache.get(f.config, f.root), null);
});

test("MCP all pages retain SDK output validation and required-task metadata", async t => {
	const outputSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
	const f = fixture(t, [{ tools: [tool("first", { outputSchema }), tool("task", { execution: { taskSupport: "required" } })], nextCursor: "1" },
		{ tools: [tool("last", { outputSchema })] }]);
	await f.connect();
	for (const name of ["first", "last"]) {
		const registered = f.registered.get(`mcp__fixture__${name}`);
		f.control.result = { content: [], structuredContent: { value: "invalid" } };
		assert.equal((await registered.execute(name, {})).details.mcpError, "protocol-error");
		f.control.result = { content: [], structuredContent: { value: 7 } };
		assert.equal((await registered.execute(name, {})).details.mcpError, undefined);
	}
	const count = f.control.calls.length;
	assert.equal((await f.registered.get("mcp__fixture__task").execute("task", {})).details.mcpError, "protocol-error");
	assert.equal(f.control.calls.length, count, "required-task metadata must reject before dispatch");
});

test("MCP all pages share one startup deadline instead of resetting it per page", async t => {
	const f = fixture(t, [() => { t.mock.timers.tick(2000); return { tools: [tool("first")], nextCursor: "1" }; },
		() => { t.mock.timers.tick(1001); return { tools: [tool("last")], nextCursor: "2" }; }]);
	const caller = new AbortController();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await assert.rejects(f.connect(caller.signal), { code: "protocol-error" });
	t.mock.timers.reset();
	assert.equal(f.control.cursors.length, 2);
	assert.equal(f.registered.size, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

for (const stop of ["cancel", "close"]) test(`MCP ${stop} on the second page cannot publish a partial catalog`, async t => {
	const caller = new AbortController();
	let closing: Promise<void> | undefined;
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, () => {
		if (stop === "cancel") caller.abort();
		else closing = f.runtime.close();
		return { tools: [tool("last")], nextCursor: "2" };
	}]);
	await assert.rejects(f.connect(caller.signal), { code: "aborted" });
	await closing;
	assert.equal(f.control.cursors.length, 2);
	assert.equal(f.registered.size, 0);
	assert.equal(f.cache.get(f.config, f.root), null);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.equal(f.runtime.states.get("fixture").connectPromise, null);
});

for (const route of ["prepare", "construct"]) test(`MCP v2 first-page cache is invalidated on ${route} and replaced with a complete catalog`, async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, { tools: [tool("last")] }]);
	f.cache.put(f.config, f.root, [tool("first")], null);
	const oldFingerprint = createHmac("sha256", readFileSync(join(f.root, "mcp-activation.key")))
		.update("super-pi.mcp-schema-cache.v2\0").update(configFingerprint(f.config, f.root)).digest("hex");
	writeFileSync(f.cache.path, JSON.stringify({ version: 2, entries: [{ fingerprint: oldFingerprint, updatedAt: Date.now(), tools: [tool("first")] }] }));
	const migrated = route === "prepare" ? new McpSchemaCache(f.cache.path, prepareSchemaCache(f.cache.path)) : new McpSchemaCache(f.cache.path);
	assert.equal(migrated.get(f.config, f.root), null);
	assert.deepEqual(JSON.parse(readFileSync(f.cache.path, "utf8")), { version: 3, entries: [] });
	f.runtime.schemaCache = migrated;
	await f.connect();
	assert.deepEqual(new McpSchemaCache().get(f.config, f.root).tools.map((item: any) => item.name), ["first", "last"]);
});

test("MCP complete persisted catalog restores lazily and validates a later-page call after reconnect", async t => {
	const f = fixture(t, [{ tools: [tool("first")], nextCursor: "1" }, { tools: [tool("last", { outputSchema: { type: "object", required: ["value"] } })] }]);
	await f.connect(); await f.runtime.close();
	const restoredTools = new Map<string, any>(), cache = new McpSchemaCache();
	const restored = new McpBridgeRuntime({ registerTool(value: any) { restoredTools.set(value.name, value); } }, f.root, cache);
	t.after(() => restored.close());
	restored.addCached(f.config, cache.get(f.config, f.root));
	assert.deepEqual(restored.searchTools("fixture"), ["mcp__fixture__first", "mcp__fixture__last"]);
	assert.equal(f.control.initializes, 1, "restoration itself remains lazy");
	f.control.result = { content: [], structuredContent: {} };
	assert.equal((await restoredTools.get("mcp__fixture__last").execute("restored", {})).details.mcpError, "protocol-error");
	assert.equal(f.control.initializes, 2);
	assert.deepEqual(f.control.cursors, [undefined, "1", undefined, "1"]);
	await restored.close();
});

for (const mode of ["counts", "gc"]) test(`MCP catalog ${mode} benchmark is a normal regression gate`, { timeout: 15000 }, async () => {
	await new Promise<void>((done, reject) => {
		execFile(process.execPath, ["--expose-gc", "--experimental-strip-types", fileURLToPath(new URL("../scripts/bench/mcp-catalog.ts", import.meta.url)), mode],
			{ windowsHide: true, timeout: 12000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } }, (error, stdout, stderr) => {
				if (error || !stdout.includes(mode === "gc" ? '"retained":0' : '"growingPrefixSerializations":0')) {
					reject(new Error(`${error?.message ?? "benchmark did not run"}\n${stdout}\n${stderr}`));
				} else done();
			});
	});
});

test("MCP per-tool gathering has no callbacks, promises or repeated prefix copies", () => {
	const path = new URL("../packages/mcp-bridge/src/client.js", import.meta.url);
	const source = ts.createSourceFile("client.js", readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	let inspected = 0;
	function visit(node: ts.Node) {
		if (ts.isForOfStatement(node) && node.expression.getText(source) === "page.tools") {
			inspected++;
			function inspect(child: ts.Node) {
				const failure = ts.isNewExpression(child) && child.expression.getText(source) === "Error" && ts.isThrowStatement(child.parent);
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isAwaitExpression(child) ||
					(ts.isNewExpression(child) && !failure) || ts.isArrayLiteralExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
				if (ts.isCallExpression(child)) assert.doesNotMatch(child.expression.getText(source), /\.(concat|slice|map|filter|flatMap|then|catch|finally|bind)$/);
				ts.forEachChild(child, inspect);
			}
			inspect(node.statement);
		}
		ts.forEachChild(node, visit);
	}
	// Exact lifecycle exemptions outside this loop: listAllTools' parent abort
	// forwarder and sequential SDK requests. Schema graph copies are bounded by
	// validateJsonShape/canonicalJsonShape and measured by the catalog benchmark.
	visit(source);
	assert.equal(inspected, 1);
});
