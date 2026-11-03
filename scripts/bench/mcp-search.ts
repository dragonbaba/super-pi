import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import mcpBridge from "../../packages/mcp-bridge/src/index.js";
import { McpBridgeRuntime } from "../../packages/mcp-bridge/src/bridge.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";

// One loopback fixture and 32 explicit searches (or --sync-plan catalog updates)
// through the actual extension/runtime. The directory API is a fixture, not AgentSession.
// No OAuth, real server, model, browser, CI matrix, or retained report.
assert.ok(global.gc, "requires --expose-gc");
const syncPlan = process.argv.includes("--sync-plan");
const root = mkdtempSync(join(tmpdir(), "sp-mcp-search-bench-"));
console.error(`ownedFixture=${root}`);
const previousDir = process.env.SP_CODING_AGENT_DIR, previousEntry = process.argv[1];
const tools = new Map<string, any>(), handlers = new Map<string, any>();
const manager = SessionManager.inMemory(root), refs: WeakRef<object>[] = [];
let active = ["read"], catalogReads = 0, activeReads = 0, budgetReads = 0, excludedBudgetReads = 0, setArguments = 0;
let runtime: any, selectionMode = "default", activeWrites = 0, broadenedSelections = 0;
const originalSearch = McpBridgeRuntime.prototype.searchTools, originalBytes = McpBridgeRuntime.prototype.toolSchemaBytes;
const allowed = (name: string) => !name.includes("blocked");
const remoteTools = Array.from({ length: 17 }, (_, i) => ({ name: i < 9 ? `blocked_${i}` : `allowed_${i}`, description: "candidate", inputSchema: { type: "object", properties: {} } }));
const server = createServer((request, response) => {
	if (request.method !== "POST") { response.writeHead(405).end(); return; }
	let body = "";
	request.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => {
		const message = JSON.parse(body);
		if (message.method.startsWith("notifications/")) { response.writeHead(202).end(); return; }
		const result = message.method === "initialize"
			? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "search-fixture", version: "1" } }
			: { tools: remoteTools };
		response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
});
const ctx = { cwd: root, isProjectTrusted: () => false, hasUI: false, sessionManager: manager, ui: { notify() {} } };
const profiler = new Session();
try {
	process.env.SP_CODING_AGENT_DIR = root;
	process.argv[1] = resolve("packages/coding-agent/dist/cli.js");
	mkdirSync(join(root, "config"));
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	writeFileSync(join(root, "config", "mcp.json"), JSON.stringify({ version: 1, servers: { fixture: { enabled: true, transport: "http", url: `http://127.0.0.1:${address.port}/mcp` } } }));
	McpBridgeRuntime.prototype.searchTools = function (query: string, limit: number, eligible?: Set<string>) {
		runtime = this;
		if (eligible) { setArguments++; refs.push(new WeakRef(eligible)); }
		return originalSearch.call(this, query, limit, eligible);
	};
	McpBridgeRuntime.prototype.toolSchemaBytes = function (name: string) {
		budgetReads++; if (!allowed(name)) excludedBudgetReads++;
		return originalBytes.call(this, name);
	};
	mcpBridge({
		on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand() {},
		registerTool(tool: any) { tools.set(tool.name, tool); if (!active.includes(tool.name) && allowed(tool.name)) active.push(tool.name); },
		getActiveTools() { activeReads++; return active; }, setActiveTools(names: string[]) { activeWrites++; active = names.filter(allowed); },
		getToolCatalog() {
			catalogReads++;
			const snapshot = { tools: [...tools.values()].filter(tool => allowed(tool.name)), activeTools: [...active], selectionMode };
			refs.push(new WeakRef(snapshot), new WeakRef(snapshot.tools), new WeakRef(snapshot.activeTools));
			return snapshot;
		},
		appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
	});
	await handlers.get("session_start")({}, ctx);
	const search = tools.get("mcp_search_tools");
	await search.execute("first", { query: "candidate" });
	const planSelection = ["read"];
	if (syncPlan) { selectionMode = "plan"; active = planSelection; }
	catalogReads = activeReads = budgetReads = excludedBudgetReads = setArguments = activeWrites = 0; refs.length = 0;
	profiler.connect(); global.gc();
	await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	for (let i = 0; i < 32; i++) {
		if (syncPlan) {
			active = planSelection;
			runtime.onToolsChanged();
			if (active.length !== planSelection.length) broadenedSelections++;
		} else await search.execute(`warm-${i}`, { query: "candidate" });
	}
	const { profile } = await profiler.post("HeapProfiler.stopSampling");
	let sampledBytes = 0;
	const sites: { site: string; bytes: number }[] = [], nodes = [profile.head];
	while (nodes.length) {
		const node = nodes.pop()!; sampledBytes += node.selfSize;
		if (node.selfSize) sites.push({ site: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
		for (const child of node.children) nodes.push(child);
	}
	sites.sort((a, b) => b.bytes - a.bytes);
	for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
	let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
	assert.equal(retained, 0, "the live extension/runtime must release snapshots and eligibility sets");
	console.log(JSON.stringify({ searches: syncPlan ? 0 : 32, planCatalogUpdates: syncPlan ? 32 : 0,
		catalogReads, activeReads, activeWrites, broadenedSelections, budgetReads, excludedBudgetReads, setArguments,
		trackedReferences: refs.length, retainedWithRuntimeAlive: retained, sampledBytes, bytesPerOperation: sampledBytes / 32, leadingSites: sites.slice(0, 6) }));
} finally {
	profiler.disconnect();
	try { await handlers.get("session_shutdown")?.({}, ctx); }
	finally {
		McpBridgeRuntime.prototype.searchTools = originalSearch; McpBridgeRuntime.prototype.toolSchemaBytes = originalBytes;
		server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
		if (previousDir === undefined) Reflect.deleteProperty(process.env, "SP_CODING_AGENT_DIR"); else process.env.SP_CODING_AGENT_DIR = previousDir;
		process.argv[1] = previousEntry;
		assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
	}
}
