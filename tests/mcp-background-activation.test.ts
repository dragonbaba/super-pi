import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
// @ts-expect-error JavaScript extension package.
import mcpBridgeExtension, { applyActivationItems, toolActivationFingerprint } from "../packages/mcp-bridge/src/index.js";
// @ts-expect-error JavaScript extension package.
import { loadActivationKey } from "../packages/mcp-bridge/src/activation-key.js";
// @ts-expect-error JavaScript extension package.
import { MAX_CONFIG_BYTES, MAX_SERVERS, sanitizeText } from "../packages/mcp-bridge/src/security.js";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension package.
import { loadMcpConfig } from "../packages/mcp-bridge/src/config.js";
// @ts-expect-error JavaScript extension package.
import { McpSchemaCache, configFingerprint } from "../packages/mcp-bridge/src/schema-cache.js";
// @ts-expect-error JavaScript extension package.
import { McpRuntimeLifecycle } from "../packages/mcp-bridge/src/lifecycle.js";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { emitSessionShutdownEvent } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { AssistantMessage } from "../packages/ai/src/types.ts";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "sp-mcp-background-"));
	t.diagnostic(`ownedFixture=${root}`);
	const previous = process.env.SP_CODING_AGENT_DIR;
	const previousEntry = process.argv[1];
	process.argv[1] = resolve("packages/coding-agent/dist/cli.js");
	const agentDir = join(root, "agent");
	const cleanup: Array<() => Promise<void>> = [];
	const gates: Array<ReturnType<typeof deferred>> = [];
	const endpoint = { tools: [{ name: "lookup", inputSchema: { type: "object" } }], gate: undefined as ReturnType<typeof deferred> | undefined,
		listed: deferred(), initializes: 0, lists: 0, calls: 0, fail: false, failInitialize: false };
	const server = createServer((request, response) => {
		if (request.method !== "POST") { response.writeHead(405).end(); return; }
		let body = "";
		request.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", async () => {
			const message = JSON.parse(body);
			if (message.method?.startsWith("notifications/")) { response.writeHead(202).end(); return; }
			let result;
			if (message.method === "initialize") {
				endpoint.initializes++;
				if (endpoint.failInitialize) { response.writeHead(503).end(); return; }
				result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "background-fixture", version: "1" } };
			} else if (message.method === "tools/list") {
				endpoint.lists++; endpoint.listed.resolve();
				await endpoint.gate?.promise;
				if (endpoint.fail) { response.writeHead(500).end(); return; }
				result = { tools: endpoint.tools };
			} else { endpoint.calls++; result = { content: [{ type: "text", text: "fixture ok" }] }; }
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	t.after(async () => {
		try {
			for (const gate of gates) gate.resolve();
			for (const close of cleanup.reverse()) await close();
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
			if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR;
			else process.env.SP_CODING_AGENT_DIR = previous;
			process.argv[1] = previousEntry;
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
	mkdirSync(join(agentDir, "config"), { recursive: true });
	process.env.SP_CODING_AGENT_DIR = agentDir;
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const config = { enabled: true, transport: "http", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, startupTimeoutMs: 3000 };
	function writeConfig(overrides = {}, id = "fixture") {
		writeFileSync(join(agentDir, "config", "mcp.json"), JSON.stringify({ version: 1, servers: { [id]: { ...config, ...overrides } } }));
	}
	writeConfig();
	function block() { endpoint.listed = deferred(); endpoint.gate = deferred(); gates.push(endpoint.gate); return endpoint.gate; }
	// `allow` models a host tool policy (allowlist) that silently ignores other names.
	function host(manager = SessionManager.inMemory(root), allow = (_name: string) => true) {
		const events = new Map<string, any>(), tools = new Map<string, any>(), notes: string[] = [];
		let active = ["read"];
		const pi = {
			on(name: string, handler: any) { events.set(name, handler); }, registerCommand() {},
			registerTool(tool: any) { tools.set(tool.name, tool); if (!active.includes(tool.name) && allow(tool.name)) active.push(tool.name); },
			getActiveTools: () => active, setActiveTools(names: string[]) { active = names.filter(allow); },
			appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
		};
		mcpBridgeExtension(pi);
		assert.ok(tools.has("mcp_search_tools"), "fixture must load the compatible host extension");
		const ctx = { cwd: root, isProjectTrusted: () => false, hasUI: true, sessionManager: manager, ui: { notify(text: string) { notes.push(text); } } };
		const stop = async () => { await events.get("session_shutdown")?.({}, ctx); };
		cleanup.push(stop);
		return { ctx, manager, tools, events, notes, active: () => active, stop, activate: (name: string) => { active = [...active, name]; },
			start: () => events.get("session_start")({}, ctx),
			search: (query = "lookup", signal?: AbortSignal) => tools.get("mcp_search_tools").execute("search", { query }, signal),
		};
	}
	return { root, agentDir, endpoint, block, host, cleanup, writeConfig };
}

const REMOTE = "mcp__fixture__lookup";

for (const source of ["global", "trusted-project"]) {
	for (const invalid of ["json", "oversized", "symlink", "server"]) test(`configuration failure still scrubs legacy schema cache: ${source} ${invalid}`, async t => {
		const f = await fixture(t);
		const config = loadMcpConfig(f.root, false).servers[0];
		let configPath = join(f.agentDir, "config", "mcp.json");
		if (source === "trusted-project") {
			writeFileSync(configPath, JSON.stringify({ version: 1, allowProjectConfig: true, servers: {} }));
			mkdirSync(join(f.root, ".sp", "config"), { recursive: true });
			configPath = join(f.root, ".sp", "config", "mcp.json");
		}
		if (invalid === "symlink") {
			const target = join(f.root, "linked-config.json");
			writeFileSync(target, JSON.stringify({ version: 1, servers: {} }));
			if (source === "global") unlinkSync(configPath);
			try { symlinkSync(target, configPath, "file"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("OS denies fixture file symlinks"); return; }
				throw error;
			}
		} else writeFileSync(configPath, invalid === "json" ? "{"
			: invalid === "oversized" ? " ".repeat(MAX_CONFIG_BYTES + 1)
			: JSON.stringify({ version: 1, servers: { invalid: { transport: "invalid" } } }));
		let expectedError: Error | undefined;
		try { loadMcpConfig(f.root, source === "trusted-project"); }
		catch (error) { assert.ok(error instanceof Error); expectedError = error; }
		assert.ok(expectedError, "fixture must be rejected by the real configuration validator");
		const cachePath = join(f.agentDir, "cache", "mcp-schemas-v1.json");
		mkdirSync(join(f.agentDir, "cache"));
		writeFileSync(cachePath, JSON.stringify({ version: 1, entries: [{
			fingerprint: configFingerprint(config, f.root), updatedAt: Date.now(), tools: f.endpoint.tools,
		}] }));
		const h = f.host(); h.ctx.isProjectTrusted = () => source === "trusted-project";
		await h.start();
		assert.deepEqual(h.notes, [`MCP bridge configuration error: ${sanitizeText(expectedError.message, 500)}`]);
		assert.equal(f.endpoint.initializes, 0);
		assert.deepEqual([...h.tools.keys()], ["mcp_search_tools"]);
		assert.equal(existsSync(join(f.agentDir, "mcp-activation.key")), false);
		assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), { version: 2, entries: [] });
	});
}

for (const configuration of ["absent", "empty"]) {
	for (const keyState of ["usable", "missing", "unavailable"]) test(`serverless startup scrubs legacy schema cache: config ${configuration}, key ${keyState}`, async t => {
		const f = await fixture(t);
		const configPath = join(f.agentDir, "config", "mcp.json");
		const config = loadMcpConfig(f.root, false).servers[0];
		if (configuration === "absent") unlinkSync(configPath);
		else writeFileSync(configPath, JSON.stringify({ version: 1, servers: {} }));
		const keyPath = join(f.agentDir, "mcp-activation.key");
		if (keyState === "usable") writeFileSync(keyPath, Buffer.alloc(32, 7));
		else if (keyState === "unavailable") mkdirSync(keyPath);
		const cachePath = join(f.agentDir, "cache", "mcp-schemas-v1.json");
		mkdirSync(join(f.agentDir, "cache"));
		writeFileSync(cachePath, JSON.stringify({ version: 1, entries: [{
			fingerprint: configFingerprint(config, f.root), updatedAt: Date.now(), tools: f.endpoint.tools,
		}] }));
		const h = f.host(); await h.start();
		assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), { version: 2, entries: [] });
		assert.equal(f.endpoint.initializes, 0);
		assert.deepEqual([...h.tools.keys()], ["mcp_search_tools"]);
		assert.deepEqual(h.notes, []);
		if (keyState === "usable") assert.deepEqual(readFileSync(keyPath), Buffer.alloc(32, 7));
		else if (keyState === "missing") assert.equal(existsSync(keyPath), false);
	});
}

test("serverless startup leaves keyed schema cache unchanged and creates no missing key or cache", async t => {
	const f = await fixture(t), cache = new McpSchemaCache();
	assert.equal(cache.put(loadMcpConfig(f.root, false).servers[0], f.root, f.endpoint.tools, null), true);
	const cachePath = join(f.agentDir, "cache", "mcp-schemas-v1.json");
	const keyPath = join(f.agentDir, "mcp-activation.key");
	const before = readFileSync(cachePath, "utf8");
	unlinkSync(keyPath);
	writeFileSync(join(f.agentDir, "config", "mcp.json"), JSON.stringify({ version: 1, servers: {} }));
	const h = f.host(); await h.start();
	assert.equal(readFileSync(cachePath, "utf8"), before);
	assert.equal(existsSync(keyPath), false);
	unlinkSync(cachePath);
	await h.start();
	assert.equal(existsSync(cachePath), false);
	assert.equal(existsSync(keyPath), false);
	assert.equal(f.endpoint.initializes, 0);
	assert.deepEqual(h.notes, []);
});

test("MCP session startup returns while real SDK discovery is pending; search waits and stays deferred", async t => {
	const f = await fixture(t), gate = f.block(), h = f.host();
	const starting = h.start();
	await f.endpoint.listed.promise;
	try {
		assert.equal(await Promise.race([starting.then(() => true), delay(250, false)]), true);
		assert.ok(h.active().includes("mcp_search_tools"));
		let settled = false;
		const search = h.search().finally(() => { settled = true; });
		await delay(10); assert.equal(settled, false);
		gate.resolve(); await search;
		assert.ok(h.active().includes(REMOTE));
		assert.equal(f.endpoint.initializes, 1);
	} finally { gate.resolve(); await starting; }
});

test("search activation survives extension replacement and validates changed configuration", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); assert.ok(h.active().includes(REMOTE));
	await h.stop();
	const resumed = f.host(h.manager); await resumed.start(); await resumed.search("nothing-matches");
	assert.ok(resumed.active().includes(REMOTE), "restore intent without searching the old tool again");
	await resumed.stop();
	f.writeConfig({ headers: { "X-Fixture": "new-config" } });
	const changed = f.host(h.manager); await changed.start(); await changed.search("nothing-matches");
	assert.equal(changed.active().includes(REMOTE), false);
});

test("concurrent real SDK connections share one discovery attempt", async t => {
	const f = await fixture(t), gate = f.block();
	const runtime = new McpBridgeRuntime({ registerTool() {} }, f.root);
	f.cleanup.push(() => runtime.close());
	const config = loadMcpConfig(f.root, false).servers[0];
	const settled = Promise.allSettled([runtime.connect(config), runtime.connect(config)]);
	await f.endpoint.listed.promise;
	try { await delay(30); assert.equal(f.endpoint.initializes, 1); }
	finally { gate.resolve(); await settled; }
});

test("aborting a search releases its listener without cancelling background discovery", async t => {
	const f = await fixture(t), gate = f.block(), h = f.host();
	const starting = h.start(); await f.endpoint.listed.promise;
	try {
		assert.equal(await Promise.race([starting.then(() => true), delay(250, false)]), true);
		const controller = new AbortController();
		const pending = h.search("lookup", controller.signal);
		const rejected = assert.rejects(pending);
		controller.abort(new Error("fixture search cancelled")); await rejected;
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(h.active().includes(REMOTE), false);
		gate.resolve(); await h.search();
		assert.ok(h.active().includes(REMOTE)); assert.equal(f.endpoint.initializes, 1);
	} finally { gate.resolve(); await starting; }
});

test("shutdown during discovery prevents late registration, activation and notifications", async t => {
	const f = await fixture(t), gate = f.block(), h = f.host();
	const starting = h.start(); await f.endpoint.listed.promise;
	await h.stop(); gate.resolve(); await starting; await delay(20);
	assert.equal(h.tools.has(REMOTE), false);
	assert.equal(h.active().includes(REMOTE), false);
	assert.deepEqual(h.notes, []);
});

test("background registration remains deferred and duplicate searches do not append duplicate intent", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search("nothing-matches");
	assert.ok(h.tools.has(REMOTE)); assert.equal(h.active().includes(REMOTE), false);
	await h.search(); const count = h.manager.getBranch().length;
	await h.search(); assert.equal(h.manager.getBranch().length, count);
	assert.equal(count, 1);
	assert.deepEqual(h.active(), ["read", "mcp_search_tools", REMOTE]);
	const saved = JSON.stringify(h.manager.getBranch());
	assert.equal(saved.includes("http://"), false, "session stores identity hashes, not connection configuration");
});

test("cached removed tools are deactivated on reconnect and never execute remotely", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); await h.stop();
	f.endpoint.tools = [];
	const resumed = f.host(h.manager); await resumed.start();
	assert.ok(resumed.active().includes(REMOTE));
	const result = await resumed.tools.get(REMOTE).execute("removed", {});
	assert.equal(result.details.mcpError, "protocol-error");
	assert.equal(f.endpoint.calls, 0);
	assert.equal(resumed.active().includes(REMOTE), false);
	assert.match(JSON.stringify(await resumed.search()), /No deferred/);
});

test("disabled servers and earlier session branches do not inherit activation", async t => {
	const f = await fixture(t), h = f.host();
	const before = h.manager.appendCustomEntry("fixture-before-activation", {});
	await h.start(); await h.search();
	h.manager.branch(before);
	await h.events.get("session_tree")({}, h.ctx);
	assert.equal(h.active().includes(REMOTE), false);
	await h.search(); await h.stop();
	f.writeConfig({ enabled: false });
	const disabled = f.host(h.manager); await disabled.start();
	assert.equal(disabled.active().includes(REMOTE), false);
	assert.match(JSON.stringify(await disabled.search()), /No deferred/);
});

test("a replaced generation cannot satisfy an old search or publish its failure", async t => {
	const f = await fixture(t), gate = f.block(), h = f.host();
	await h.start(); await f.endpoint.listed.promise;
	const old = assert.rejects(h.search());
	const next = h.start();
	gate.resolve(); await next; await old;
	await h.search("nothing-matches");
	assert.equal(h.active().includes(REMOTE), false);
	assert.deepEqual(h.notes, []);
});

test("background discovery failure settles searches and is reported once", async t => {
	const f = await fixture(t); f.endpoint.fail = true;
	const h = f.host(); await h.start();
	assert.match(JSON.stringify(await h.search()), /No deferred/);
	await delay(0);
	assert.equal(h.notes.length, 1);
	assert.match(h.notes[0]!, /connection failed/);
	assert.equal(h.active().includes(REMOTE), false);
});

test("one cached-server waiter may abort while another completes the shared connection", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); await h.stop();
	const gate = f.block(), resumed = f.host(h.manager); await resumed.start();
	const tool = resumed.tools.get(REMOTE), controller = new AbortController();
	const first = tool.execute("cancelled", {}, controller.signal);
	const second = tool.execute("waiting", {});
	await f.endpoint.listed.promise; controller.abort();
	assert.equal((await first).details.mcpError, "aborted");
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	gate.resolve(); assert.equal((await second).content[0].text, "fixture ok");
	assert.equal(f.endpoint.initializes, 2); assert.equal(f.endpoint.calls, 1);
});

test("real AgentSession supports same-script discovery/call, reload and persisted reopen", async t => {
	const f = await fixture(t);
	const manager = SessionManager.create(f.root, join(f.root, "sessions"));
	const errors: unknown[] = [];
	async function open(sessionManager: SessionManager) {
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resources = new DefaultResourceLoader({ cwd: f.root, agentDir: f.agentDir, settingsManager: settings,
			noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [mcpBridgeExtension] });
		await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
		const { session } = await createAgentSession({ cwd: f.root, agentDir: f.agentDir, resourceLoader: resources,
			settingsManager: settings, sessionManager,
			model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "http://unused", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 },
			modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never });
		f.cleanup.push(async () => { try { await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); } });
		await session.bindExtensions({ onError: error => { errors.push(error); } });
		return session;
	}
	const session = await open(manager);
	let request = 0;
	session.agent.streamFunction = () => {
		const first = request++ === 0;
		const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE, timestamp: 1,
			content: first ? [{ type: "toolCall", id: "mcp-script", name: "codemode", arguments: { code: `await tools.mcp_search_tools({query:"lookup"}); const r=await callTool("${REMOTE}",{}); await show(r.ref);` } }] : [{ type: "text", text: "done" }], stopReason: first ? "toolUse" : "stop" };
		const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); return stream;
	};
	await session.agent.prompt("fixture");
	const results = session.agent.state.messages.filter(message => message.role === "toolResult");
	assert.equal(results.length, 1); assert.equal(results[0]!.isError, false, JSON.stringify(results));
	assert.equal(f.endpoint.calls, 1); assert.ok(session.getActiveToolNames().includes(REMOTE));
	const oldTool = session.getToolDefinition(REMOTE)!;
	await session.reload(); assert.ok(session.getActiveToolNames().includes(REMOTE));
	const late = await oldTool.execute("old-generation", {}, undefined, undefined, {} as never);
	assert.equal((late.details as { mcpError: string }).mcpError, "aborted");
	const path = manager.getSessionFile(); assert.ok(path);
	const restored = await open(SessionManager.open(path));
	assert.ok(restored.getActiveToolNames().includes(REMOTE));
	assert.equal(f.endpoint.initializes, 1, "complete cache remains lazy after reload/reopen");
	rmSync(join(f.agentDir, "cache", "mcp-schemas-v1.json"));
	const uncached = await open(SessionManager.open(path));
	await uncached.getToolDefinition("mcp_search_tools")!.execute("wait", { query: "nothing-matches" }, undefined, undefined, {} as never);
	assert.ok(uncached.getActiveToolNames().includes(REMOTE), "uncached resume restores after discovery without reactivating by search");
	assert.equal(f.endpoint.initializes, 2);
	assert.deepEqual(errors, []);
});

test("server IDs that map to the same tool prefix do not share activation identity", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); await h.stop();
	f.writeConfig({}, "FIXTURE");
	const renamed = f.host(h.manager); await renamed.start(); await renamed.search("nothing-matches");
	assert.ok(renamed.tools.has(REMOTE));
	assert.equal(renamed.active().includes(REMOTE), false);
});

test("a renamed remote tool with the same normalized name does not inherit old activation", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); await h.stop();
	rmSync(join(f.agentDir, "cache", "mcp-schemas-v1.json"));
	f.endpoint.tools = [{ name: "LOOKUP", inputSchema: { type: "object" } }];
	const renamed = f.host(h.manager); await renamed.start(); await renamed.search("nothing-matches");
	assert.ok(renamed.tools.has(REMOTE));
	assert.equal(renamed.active().includes(REMOTE), false);
});

test("a rejected catalog cannot leave a partially registered tool active or searchable", async t => {
	const f = await fixture(t);
	f.endpoint.tools.push({ name: "LOOKUP", inputSchema: { type: "object" } });
	const h = f.host(); await h.start();
	assert.match(JSON.stringify(await h.search()), /No deferred/);
	assert.equal(h.active().includes(REMOTE), false);
});

test("runtime close shares completion and releases a pending discovery and callback", async t => {
	const f = await fixture(t), gate = f.block();
	const runtime = new McpBridgeRuntime({ registerTool() {} }, f.root);
	f.cleanup.push(() => runtime.close());
	const config = loadMcpConfig(f.root, false).servers[0];
	let changes = 0; runtime.onToolsChanged = () => { changes++; };
	const result = assert.rejects(runtime.connect(config), { code: "aborted" });
	await f.endpoint.listed.promise;
	const closing = runtime.close(); assert.equal(runtime.close(), closing);
	await closing; await result; gate.resolve();
	const state = runtime.states.get(config.id);
	assert.equal(state.connectPromise, null); assert.equal(state.client, null); assert.equal(state.transport, null);
	assert.equal(runtime.onToolsChanged, null); assert.equal(runtime.activeCalls.size, 0);
	assert.equal(runtime.registeredNames.size, 0); assert.equal(changes, 0);
});

test("a partial cached catalog registration is deactivated when startup fails", async t => {
	const f = await fixture(t);
	const config = loadMcpConfig(f.root, false).servers[0];
	const cache = new McpSchemaCache();
	assert.equal(cache.put(config, f.root, [
		{ name: "lookup", inputSchema: { type: "object" } },
		{ name: "LOOKUP", inputSchema: { type: "object" } },
	], null), true);
	const h = f.host(); await h.start();
	assert.equal(h.active().includes(REMOTE), false);
	assert.equal(h.notes.length, 1); assert.match(h.notes[0]!, /configuration error/);
});

test("lifecycle refuses an aborted attachment and unpublishes a failed runtime", async () => {
	const owner = new McpRuntimeLifecycle(() => {});
	const cancelled = new AbortController();
	const token = await owner.begin(cancelled.signal);
	const runtime = new McpBridgeRuntime({ registerTool() {} }, "lifecycle-fixture");
	cancelled.abort();
	try { assert.equal(await owner.attach(token, runtime), false); }
	finally { await runtime.close(); await owner.shutdown(); }
	const next = await owner.begin();
	const current = new McpBridgeRuntime({ registerTool() {} }, "lifecycle-fixture");
	try {
		assert.equal(await owner.attach(next, current), true);
		assert.equal(owner.publish(next, current), true);
		await current.close(); owner.fail(next, current);
		assert.equal(owner.current, null);
	} finally { await owner.shutdown(); }
});

test("cached catalog remains searchable after connection failure and during explicit retry", async t => {
	const f = await fixture(t);
	const tools = new Map<string, any>();
	const runtime = new McpBridgeRuntime({ registerTool(tool: any) { tools.set(tool.name, tool); } }, f.root);
	f.cleanup.push(() => runtime.close());
	const config = loadMcpConfig(f.root, false).servers[0];
	const state = runtime.addCached(config, { tools: f.endpoint.tools, serverInfo: null });
	const observed: string[][] = [];
	runtime.onToolsChanged = () => { observed.push(runtime.toolNames()); };
	assert.deepEqual(runtime.toolNames(), [REMOTE]);
	f.endpoint.failInitialize = true;
	assert.equal((await tools.get(REMOTE).execute("first", {})).details.mcpError, "protocol-error");
	assert.match(runtime.statusText(), /connection failed/);
	assert.deepEqual(runtime.searchTools("lookup"), [REMOTE]);
	assert.deepEqual(runtime.toolNames(), [REMOTE]);
	assert.deepEqual(observed, [[REMOTE]]);
	assert.equal(state.client, null); assert.equal(state.connectPromise, null);
	assert.equal(f.endpoint.initializes, 1); assert.equal(f.endpoint.calls, 0);
	f.endpoint.failInitialize = false;
	const gate = f.block();
	const second = tools.get(REMOTE).execute("second", {});
	await f.endpoint.listed.promise;
	try {
		assert.deepEqual(runtime.searchTools("lookup"), [REMOTE], "a pending retry still owns the valid catalog");
		assert.deepEqual(runtime.toolNames(), [REMOTE]);
	} finally { gate.resolve(); }
	assert.equal((await second).content[0].text, "fixture ok");
	assert.equal(state.error, null); assert.equal(state.status, "connected");
	assert.equal(f.endpoint.initializes, 2); assert.equal(f.endpoint.calls, 1);
});

test("cached activation survives discovery failure and a second tool call succeeds without reload", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); await h.stop();
	const resumed = f.host(h.manager); await resumed.start();
	const entries = resumed.manager.getBranch().length;
	f.endpoint.fail = true;
	assert.equal((await resumed.tools.get(REMOTE).execute("first", {})).details.mcpError, "protocol-error");
	assert.ok(resumed.active().includes(REMOTE));
	assert.match(JSON.stringify(await resumed.search()), /already active/);
	assert.equal(resumed.manager.getBranch().length, entries);
	assert.equal(f.endpoint.initializes, 2, "search must not automatically retry the failed call");
	assert.equal(f.endpoint.calls, 0);
	f.endpoint.fail = false;
	assert.equal((await resumed.tools.get(REMOTE).execute("second", {})).content[0].text, "fixture ok");
	assert.ok(resumed.active().includes(REMOTE));
	assert.equal(f.endpoint.initializes, 3); assert.equal(f.endpoint.calls, 1);
});

test("a rejected replacement catalog cannot reuse prior cached activation", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search(); await h.stop();
	f.endpoint.tools.push({ name: "LOOKUP", inputSchema: { type: "object" } });
	const resumed = f.host(h.manager); await resumed.start();
	assert.ok(resumed.active().includes(REMOTE));
	assert.equal((await resumed.tools.get(REMOTE).execute("collision", {})).details.mcpError, "protocol-error");
	assert.equal(resumed.active().includes(REMOTE), false);
	assert.match(JSON.stringify(await resumed.search()), /No deferred/);
	assert.equal(f.endpoint.calls, 0);
});

test("a remote tool activated outside search survives a later catalog update while it stays valid", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search("nothing-matches"); await h.stop();
	const resumed = f.host(h.manager); await resumed.start();
	assert.equal(resumed.active().includes(REMOTE), false, "cached registration stays deferred");
	resumed.activate(REMOTE);
	assert.equal((await resumed.tools.get(REMOTE).execute("manual", {})).content[0].text, "fixture ok");
	assert.ok(resumed.active().includes(REMOTE), "lazy discovery must not drop a valid manual activation");
	assert.equal(resumed.manager.getBranch().length, 0, "manual activation is not recorded as search intent");
	await resumed.stop();
	const reopened = f.host(h.manager); await reopened.start();
	assert.equal(reopened.active().includes(REMOTE), false, "only search intent is restored");
});

test("a manually activated remote tool is still deactivated when the server removes it", async t => {
	const f = await fixture(t), h = f.host();
	await h.start(); await h.search("nothing-matches"); await h.stop();
	f.endpoint.tools = [];
	const resumed = f.host(h.manager); await resumed.start();
	resumed.activate(REMOTE);
	assert.equal((await resumed.tools.get(REMOTE).execute("removed", {})).details.mcpError, "protocol-error");
	assert.equal(resumed.active().includes(REMOTE), false);
	assert.equal(f.endpoint.calls, 0);
});

test("activation fingerprints are absent rather than throwing when a server identity is missing", () => {
	const runtime = { toolConfig: () => ({ id: "fixture" }), registeredNames: new Map([[REMOTE, "fixture\0lookup"]]) };
	assert.equal(toolActivationFingerprint(runtime, REMOTE, new Map()), undefined);
	assert.equal(toolActivationFingerprint({ ...runtime, toolConfig: () => undefined }, REMOTE, new Map([["fixture", "id"]])), undefined);
	assert.match(toolActivationFingerprint(runtime, REMOTE, new Map([["fixture", "id"]])), /^[0-9a-f]{64}$/);
});

const activationRecords = (manager: SessionManager) => manager.getBranch()
	.filter((entry: any) => entry.type === "custom" && entry.customType === "mcp-tool-activation-v1")
	.map((entry: any) => entry.data);

test("progressive activation persists deltas with linear snapshots and restores every identity", async t => {
	const f = await fixture(t), names: string[] = [];
	f.endpoint.tools = [];
	for (let index = 0; index < 40; index++) {
		const name = `n${String(index).padStart(3, "0")}x`;
		f.endpoint.tools.push({ name, inputSchema: { type: "object" } });
		names.push(`mcp__fixture__${name}`);
	}
	const h = f.host(); await h.start();
	for (let index = 0; index < 40; index++) await h.search(`n${String(index).padStart(3, "0")}x`);
	const records = activationRecords(h.manager);
	const items = records.reduce((sum: number, record: any) => sum + record.tools.length, 0);
	assert.equal(records.length, 40, "one record per changed search");
	assert.ok(records.some((record: any) => !record.base) && records.some((record: any) => record.base));
	assert.ok(items <= 3 * 40, `persisted items stay linear: ${items}`);
	await h.search("n039x");
	assert.equal(activationRecords(h.manager).length, 40, "an unchanged search appends nothing");
	await h.stop();
	const reopened = f.host(h.manager); await reopened.start(); await reopened.search("nothing-matches");
	for (const name of names) assert.ok(reopened.active().includes(name), `${name} restored`);
});

test("the activation bound evicts the least recently refreshed identity", () => {
	const limit = MAX_SERVERS * 128, intent = new Map<string, string>(), fingerprint = (seed: string) => createHash("sha256").update(seed).digest("hex");
	const items = [];
	for (let index = 0; index < limit; index++) items.push({ name: `mcp__s__t${index}`, fingerprint: fingerprint(`old${index}`) });
	applyActivationItems(intent, items);
	applyActivationItems(intent, [{ name: "mcp__s__t0", fingerprint: fingerprint("new0") }]);
	applyActivationItems(intent, [{ name: "mcp__s__fresh", fingerprint: fingerprint("fresh") }]);
	assert.equal(intent.size, limit);
	assert.equal(intent.get("mcp__s__t0"), fingerprint("new0"), "a refreshed identity is not the oldest");
	assert.equal(intent.has("mcp__s__t1"), false);
	assert.ok(intent.has("mcp__s__fresh"));
});

test("only activations accepted by the host tool policy are recorded and reported", async t => {
	const f = await fixture(t), h = f.host(undefined, name => name !== REMOTE);
	await h.start();
	const text = JSON.stringify(await h.search());
	assert.match(text, /Not activated by the host tool policy/);
	assert.doesNotMatch(text, /Activated MCP tools/);
	assert.equal(h.active().includes(REMOTE), false);
	assert.equal(activationRecords(h.manager).length, 0);
	await h.stop();
	const permissive = f.host(h.manager); await permissive.start(); await permissive.search("nothing-matches");
	assert.equal(permissive.active().includes(REMOTE), false, "a rejected activation is never restored");
});

test("persisted activation identities are keyed by a machine-local secret", async t => {
	const f = await fixture(t), h = f.host();
	f.writeConfig({ headers: { Authorization: "Bearer low-entropy-secret" } });
	await h.start(); await h.search(); await h.stop();
	const keyPath = join(f.agentDir, "mcp-activation.key");
	assert.equal(readFileSync(keyPath).length, 32);
	const config = loadMcpConfig(f.root, false).servers[0];
	const unkeyed = configFingerprint(config, f.root);
	const legacy = createHash("sha256").update(unkeyed).update("\0").update("fixture\0lookup").digest("hex");
	const saved = JSON.stringify(h.manager.getBranch());
	assert.equal(saved.includes(unkeyed) || saved.includes(legacy) || saved.includes("low-entropy-secret"), false);
	const resumed = f.host(h.manager); await resumed.start(); await resumed.search("nothing-matches");
	assert.ok(resumed.active().includes(REMOTE), "the same machine key restores activation");
	await resumed.stop();
	writeFileSync(keyPath, Buffer.alloc(32, 7));
	const rekeyed = f.host(h.manager); await rekeyed.start(); await rekeyed.search("nothing-matches");
	assert.equal(rekeyed.active().includes(REMOTE), false, "a session copied to another key does not restore");
	await rekeyed.stop();
	rmSync(keyPath); mkdirSync(keyPath);
	assert.equal(loadActivationKey(keyPath), undefined);
	const keyless = f.host(); await keyless.start();
	assert.match(JSON.stringify(await keyless.search()), /Activated MCP tools/);
	assert.equal(activationRecords(keyless.manager).length, 0, "without a key, intent is not recorded");
});
