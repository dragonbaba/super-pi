import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTask } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// @ts-expect-error JavaScript extension package.
import { createMcpClient } from "../../packages/mcp-bridge/src/client.js";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../../packages/mcp-bridge/src/bridge.js";

const mode = process.argv[2] ?? "counts";
const sourceHash = createHash("sha256").update(readFileSync(new URL("../../packages/mcp-bridge/src/client.js", import.meta.url))).digest("hex");
const host = { registerTool() {} };

async function cycle(pageCount: number, outcome = "success", count = false, collect = false) {
	const client = createMcpClient(), caller = new AbortController();
	const refs: WeakRef<object>[] = [], metrics = { pages: 0, tools: 0, metadataCalls: 0, metadataTools: 0,
		toolSerializations: 0, schemaSerializations: 0, growingPrefixSerializations: 0, promises: 0, controllers: 0, maxParentListeners: 0 };
	const server = new Server({ name: "catalog-bench", version: "1" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async request => {
		const page = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
		metrics.pages++;
		metrics.maxParentListeners = Math.max(metrics.maxParentListeners, getEventListeners(caller.signal, "abort").length);
		if (page === 2 && outcome === "failure") throw new Error("fixture page failure");
		if (page === 2 && outcome === "abort") caller.abort();
		const tools = [];
		for (let index = page * (128 / pageCount); index < (page + 1) * (128 / pageCount); index++) {
			tools.push({ name: `tool_${index}`, inputSchema: { type: "object" as const, properties: { input: { type: "string" } } },
				outputSchema: { type: "object" as const, properties: { output: { type: "number" } } } });
		}
		return { tools, nextCursor: page + 1 === pageCount ? undefined : String(page + 1) };
	});
	const [local, remote] = InMemoryTransport.createLinkedPair();
	await server.connect(remote); await client.connect(local);
	const metadata = client.cacheToolMetadata;
	client.cacheToolMetadata = function (tools: any[]) {
		metrics.metadataCalls++; metrics.metadataTools += tools.length;
		if (collect) for (const tool of tools) refs.push(new WeakRef(tool.inputSchema), new WeakRef(tool.outputSchema));
		return metadata.call(this, tools);
	};
	if (collect) {
		const request = client.request;
		client.request = async function (...args: any[]) {
			if (args[1] && args[2]?.signal) refs.push(new WeakRef(args[2].signal));
			const page = await request.apply(this, args);
			if (page.tools) {
				refs.push(new WeakRef(page), new WeakRef(page.tools));
				for (const tool of page.tools) refs.push(new WeakRef(tool));
			}
			return page;
		};
		refs.push(new WeakRef(client), new WeakRef(caller.signal));
	}
	const originalStringify = JSON.stringify, OriginalController = globalThis.AbortController;
	const hook = createHook({ init(_id, type) { if (type === "PROMISE") metrics.promises++; } });
	if (count) {
		JSON.stringify = function (value: any, ...args: any[]) {
			if (value?.inputSchema && value?.name) metrics.toolSerializations++;
			else if (value?.type === "object" && value.properties) metrics.schemaSerializations++;
			else if (Array.isArray(value) && value[0]?.inputSchema) metrics.growingPrefixSerializations++;
			return (originalStringify as any)(value, ...args);
		};
		globalThis.AbortController = class extends OriginalController { constructor() { super(); metrics.controllers++; } };
		hook.enable();
	}
	const runtime = new McpBridgeRuntime(host, "catalog-benchmark");
	runtime.states.set("fixture", { client, tools: new Map(), status: "connected" });
	try {
		const pending = client.listAllTools(128, { signal: caller.signal });
		if (outcome === "success") {
			const catalog = await pending;
			metrics.tools = catalog.tools.length;
			const state = runtime.states.get("fixture");
			for (const tool of catalog.tools) state.tools.set(tool.name, tool);
			assert.equal(catalog.tools.length, 128);
			assert.ok(client.getToolOutputValidator("tool_0"));
			assert.ok(client.getToolOutputValidator("tool_127"));
		} else await assert.rejects(pending);
	} finally {
		hook.disable(); JSON.stringify = originalStringify; globalThis.AbortController = OriginalController;
		await runtime.close(); await server.close();
	}
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.equal(runtime.states.get("fixture").client, null);
	assert.equal(runtime.states.get("fixture").tools.size, 0);
	return { metrics, refs, runtime };
}

if (mode === "counts") {
	const runs: Array<Awaited<ReturnType<typeof cycle>>["metrics"]> = [];
	for (const pages of [1, 8, 128]) {
		const { metrics } = await cycle(pages, "success", true);
		assert.equal(metrics.pages, pages);
		assert.equal(metrics.metadataCalls, 1);
		assert.equal(metrics.metadataTools, 128);
		assert.equal(metrics.toolSerializations, 128);
		assert.equal(metrics.schemaSerializations, 256);
		assert.equal(metrics.growingPrefixSerializations, 0);
		assert.equal(metrics.maxParentListeners, 1);
		assert.equal(metrics.controllers, pages * 2 + 1, "one active-page controller, one SDK server controller per page, one runtime controller");
		runs.push(metrics);
		console.log(JSON.stringify({ mode, sourceHash, ...metrics }));
	}
	assert.equal((runs[2].promises - runs[0].promises) * 7, (runs[1].promises - runs[0].promises) * 127,
		"request Promise allocation must be linear in pages, independent of prior-page tools");
} else if (mode === "gc") {
	assert.ok(global.gc, "requires --expose-gc");
	for (const outcome of ["success", "failure", "abort"]) {
		const { refs, runtime } = await cycle(8, outcome, false, true);
		for (let index = 0; index < 8; index++) { await nextTask(); global.gc(); }
		const retained = refs.reduce((count, ref) => count + Number(ref.deref() !== undefined), 0);
		assert.equal(retained, 0, outcome);
		assert.equal(runtime.states.get("fixture").tools.size, 0, "closed runtime stays reachable");
		console.log(JSON.stringify({ mode, sourceHash, outcome, weakRefs: refs.length, retained }));
	}
} else if (mode === "allocation") {
	const inspector = new Session(); inspector.connect();
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
	const initialHeap = process.memoryUsage().heapUsed;
	let peakHeap = initialHeap;
	const samples: number[] = [];
	for (let index = 0; index < 20; index++) {
		const start = performance.now(); await cycle(8); samples.push(performance.now() - start);
		peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
	const { profile } = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	const sites = new Map<string, number>();
	function visit(node: typeof profile.head) {
		const label = `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
		sites.set(label, (sites.get(label) ?? 0) + node.selfSize);
		for (const child of node.children ?? []) visit(child);
	}
	visit(profile.head); samples.sort((left, right) => left - right);
	console.log(JSON.stringify({ mode, sourceHash, catalogs: 20, pagesPerCatalog: 8, toolsPerCatalog: 128, initialHeap, peakHeap,
		finalHeap: process.memoryUsage().heapUsed, p50Ms: samples[9], p95Ms: samples[18],
		sites: [...sites].sort((left, right) => right[1] - left[1]).slice(0, 10) }));
} else throw new Error("unknown benchmark mode");
