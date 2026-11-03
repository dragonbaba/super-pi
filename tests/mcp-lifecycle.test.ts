import assert from "node:assert/strict";
import test from "node:test";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { readFileSync } from "node:fs";
import ts from "typescript";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime, convertMcpResult, fetchWithHeaders } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension package.
import { McpRuntimeLifecycle } from "../packages/mcp-bridge/src/lifecycle.js";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

test("MCP HTTP owners await late responses and stream cancellation without retaining closed readers", { timeout: 5000 }, async t => {
  const source = ts.createSourceFile("bridge.js", readFileSync(new URL("../packages/mcp-bridge/src/bridge.js", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let audited = 0;
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !["McpResponseLimiter", "McpBoundedResponseSource", "McpHttpOwner"].includes(statement.name?.text ?? "")) continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !["check", "pull", "finish"].includes(member.name.getText(source))) continue;
      function visit(node: ts.Node) {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node), false, node.getText(source));
        if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error");
        ts.forEachChild(node, visit);
      }
      visit(member.body!); audited++;
    }
  }
  assert.equal(audited, 4);
  assert.match(source.text, /this\.pending \+ this\.sources\.size >= 32/);
  const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
  const references: WeakRef<object>[] = [], signals: AbortSignal[] = [];
  let cancellations = 0, chunks = 0;
  const originalFetch = globalThis.fetch;
  async function exercise(kind: "late" | "late-failed" | "stream" | "failed" | "complete") {
    let entered!: () => void, deliver!: (response: Response) => void, releaseCancel!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const responseReady = new Promise<Response>(resolve => { deliver = resolve; });
    const cancelled = new Promise<void>(resolve => { releaseCancel = resolve; });
    const chunk = new TextEncoder().encode("data: fixture\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "complete") { for (let i = 0; i < 1000; i++) controller.enqueue(chunk); controller.close(); }
      },
      cancel() { cancellations++; if (kind === "failed" || kind === "late-failed") return Promise.reject(new Error("CANARY_CANCEL_SECRET")); return cancelled; },
    });
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => { signals.push(init.signal!); entered(); return await responseReady; }) as typeof fetch;
    const fetcher = fetchWithHeaders({}, "https://fixture.invalid/mcp");
    references.push(new WeakRef(fetcher), new WeakRef(body));
    const fetching = fetcher("https://fixture.invalid/mcp");
    await ready;
    if (kind === "late" || kind === "late-failed") {
      const rejected = assert.rejects(fetching, /abort/i);
      let done = false; const close = fetcher.close().then(() => { done = true; });
      const failedClose = kind === "late-failed" ? assert.rejects(close, /MCP_CLEANUP_UNCONFIRMED/) : undefined;
      await tick(); assert.equal(done, false);
      deliver(new Response(body)); await tick(); assert.equal(done, false);
      releaseCancel(); await rejected; if (failedClose) await failedClose; else await close;
    } else {
      deliver(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      const response = await fetching, reader = response.body!.getReader();
      references.push(new WeakRef(reader), new WeakRef(response));
      if (kind === "complete") {
        for (;;) { const item = await reader.read(); if (item.done) break; chunks++; }
        reader.releaseLock(); assert.equal(body.locked, false); await fetcher.close();
      } else {
        const read = reader.read(); let done = false;
        const close = fetcher.close().then(() => { done = true; });
        if (kind === "failed") {
          await assert.rejects(close, error => { assert.match(String(error), /MCP_CLEANUP_UNCONFIRMED/); assert.doesNotMatch(String(error), /CANARY/); return true; });
          await assert.rejects(fetcher.close(), /MCP_CLEANUP_UNCONFIRMED/);
        } else {
          await tick(); assert.equal(done, false); releaseCancel(); await close;
          assert.equal(body.locked, false);
        }
        await read; reader.releaseLock();
      }
    }
    await assert.rejects(fetcher("https://fixture.invalid/mcp"), /abort/i);
    globalThis.fetch = originalFetch;
  }
  try {
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (const kind of ["late", "late-failed", "stream", "failed", "complete"] as const) await exercise(kind);
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
    for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
    assert.equal(references.filter(ref => ref.deref()).length, 0); assert.equal(signals.every(signal => signal.aborted), true);
    assert.equal(chunks, 1000); assert.equal(cancellations, 4); assert.ok(sampled < 16 * 1024 * 1024);
    t.diagnostic(JSON.stringify({ responses: 5, streamedChunks: chunks, cancellations, releasedReferences: references.length, sampledBytesIncludingWebStreams: sampled }));
  } finally { globalThis.fetch = originalFetch; }
});

test("MCP suspension waits for admitted calls, retains failed ownership and reuses only cleaned catalogs", { timeout: 5000 }, async t => {
  const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
  const refs: WeakRef<object>[] = [], retainedSignals: AbortSignal[] = [];
  async function exercise() {
    let completeCall!: (value: unknown) => void, completeOAuth!: () => void, completeDiscovery!: () => void;
    let options: any, failTransport = true, updates = 0;
    const call = new Promise(resolve => { completeCall = resolve; });
    const oauth = new Promise<void>(resolve => { completeOAuth = resolve; });
    const discovery = new Promise<void>(resolve => { completeDiscovery = resolve; });
    const client = { callTool(_args: unknown, _schema: unknown, value: any) { options = value; return call; }, async close() {} };
    const transport = { async close() { if (failTransport) throw new Error("CANARY_CLEANUP_SECRET"); } };
    const runtime = new McpBridgeRuntime({ registerTool() {} }, "fixture");
    const lifecycle = new McpRuntimeLifecycle(() => {}), token = await lifecycle.begin();
    retainedSignals.push(token.signal);
    await lifecycle.attach(token, runtime); lifecycle.publish(token, runtime);
    const state = { status: "connected", catalogReady: true, config: { id: "fixture", enabled: true, toolTimeoutMs: 1000 }, client, transport, oauth: { close: () => oauth }, tools: new Map() };
    state.tools.set("lookup", {}); runtime.states.set("fixture", state);
    runtime.registerRemoteTool(state, { name: "lookup", inputSchema: { type: "object" } });
    const catalog = state.tools;
    const context = { updateCount: 0 }, onUpdate = () => { context.updateCount++; updates++; };
    const request = assert.rejects(runtime.callRemoteTool(state, "lookup", {}, undefined, onUpdate), { code: "aborted" });
    for (let i = 0; i < 1000; i++) options.onprogress({ progress: i });
    const preparingState = { status: "cached", config: { id: "preparing" }, connectPromise: discovery, tools: new Map() };
    runtime.states.set("preparing", preparingState);
    const preparing = assert.rejects(runtime.callRemoteTool(preparingState, "lookup", {}), { code: "aborted" });
    assert.equal(runtime.pendingCalls, 2);
    retainedSignals.push(options.signal);
    let done = false;
    const closing = lifecycle.suspend().then(() => { done = true; });
    const failed = assert.rejects(closing, error => { assert.match(String(error), /MCP_CLEANUP_UNCONFIRMED/); assert.doesNotMatch(String(error), /CANARY/); return true; });
    await preparing; await tick();
    assert.equal(runtime.activeCalls.size, 1); assert.equal(runtime.pendingCalls, 1); assert.equal(done, false);
    assert.equal(state.client, client); assert.equal(state.transport, transport);
    options.onprogress({ progress: 1001 }); assert.equal(updates, 1000);
    completeDiscovery(); preparingState.connectPromise = null as any; completeOAuth(); await tick(); assert.equal(done, false, "a local abort is not request completion");
    completeCall({ content: [] }); await request; await failed;
    assert.equal(lifecycle.current, runtime); assert.equal(runtime.cleanupComplete, false);
    assert.equal(state.oauth, null); assert.equal(state.client, client); assert.equal(state.transport, transport);
    assert.throws(() => lifecycle.resume(), /cleanup/);
    await assert.rejects(runtime.callRemoteTool(state, "lookup", {}), { code: "aborted" });
    failTransport = false; await lifecycle.suspend();
    assert.equal(lifecycle.current, runtime); assert.equal(runtime.cleanupComplete, true);
    assert.equal(state.client, null); assert.equal(state.transport, null);
    assert.equal(runtime.activeCalls.size, 0); assert.equal(runtime.pendingCalls, 0); assert.equal(runtime.callsIdle, null);
    lifecycle.resume();
    assert.equal(runtime.closed, false); assert.equal(state.status, "cached"); assert.equal(state.tools, catalog);
    assert.deepEqual(runtime.searchTools("lookup"), ["mcp__fixture__lookup"]);
    await lifecycle.suspend(); await lifecycle.shutdown();
    assert.equal(lifecycle.current, null); assert.equal(catalog.size, 0); assert.equal(runtime.registeredNames.size, 0);
    assert.throws(() => runtime.resume(), /cleanup/);
    for (const value of [runtime, lifecycle, state, client, transport, context, onUpdate]) refs.push(new WeakRef(value));
    options = undefined;
  }
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await exercise();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
  for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
  assert.equal(retainedSignals.every(signal => signal.aborted), true); assert.equal(refs.filter(ref => ref.deref()).length, 0);
  assert.ok(sampled < 4 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ admittedCalls: 2, progressUpdates: 1000, idleDeferreds: 1, liveOwnersAfterCleanup: 0, weakReferences: refs.length, sampledBytes: sampled }));
});

for (const outcome of ["success", "error", "abort", "dispose"]) {
	test(`four parallel MCP calls release progress on ${outcome}`, async () => {
		const pending: any[] = [];
		const runtime = new McpBridgeRuntime({ registerTool() {} }, "parallel-workspace");
		const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
			callTool(_params: any, _schema: any, options: any) {
				return new Promise((resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
					pending.push({ options, resolve, reject });
				});
			}, async close() {},
		} };
		const controller = new AbortController();
		const updates = [0, 0, 0, 0];
		const results = Array.from({ length: 4 }, (_, index) => runtime.callRemoteTool(state, "fixture", { index }, controller.signal, () => { updates[index]!++; }));
		const settled = Promise.allSettled(results);
		assert.equal(runtime.activeCalls.size, 4);
		for (const call of pending) { call.options.onprogress({ progress: 1 }); call.options.onprogress({ progress: 2 }); }
		assert.deepEqual(updates, [2, 2, 2, 2]);
		if (outcome === "abort") controller.abort();
		else if (outcome === "dispose") await runtime.close();
		else for (let index = 0; index < pending.length; index++) {
			if (outcome === "error") pending[index].reject(new Error("CANARY_PROTOCOL_SECRET"));
			else pending[index].resolve({ content: [{ type: "text", text: String(index) }] });
		}
		const final = await settled;
		assert.equal(runtime.activeCalls.size, 0);
		for (const call of pending) call.options.onprogress({ progress: 3, message: "CANARY_LATE_SECRET" });
		assert.deepEqual(updates, [2, 2, 2, 2]);
		assert.equal(final.length, 4);
		for (let index = 0; index < final.length; index++) {
			const result = final[index]!;
			assert.equal(result.status, outcome === "success" ? "fulfilled" : "rejected");
			if (result.status === "fulfilled") assert.equal(result.value.content[0].text, String(index));
			else assert.equal(String(result.reason).includes("CANARY"), false);
		}
		await runtime.close();
	});
}

test("typed MCP recovery stays in session and active branch across restore", () => {
	const source = { type: "resource", resource: { uri: "fixture://blob", blob: "YQ==", mimeType: "application/octet-stream" } };
	const content = convertMcpResult({ content: [source] });
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "session-a")!;
	const foreign = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "session-b")!;
	try {
		const view = owner.create(content, "call-a");
		if (view?.version !== 2 || !view.artifact) assert.fail("artifact missing");
		const messages = JSON.parse(JSON.stringify([{ role: "toolResult", toolCallId: "call-a", content }]));
		owner.clearProjectionRecords();
		const restored = owner.readArtifact(view.artifact.id, messages);
		assert.equal((restored.content[0] as any).mcpSource.value.resource.blob, "YQ==");
		assert.throws(() => foreign.readArtifact(view.artifact!.id, messages));
		assert.throws(() => owner.readArtifact(view.artifact!.id, []));
		assert.throws(() => owner.readArtifact(view.artifact!.id, [{ role: "toolResult", toolCallId: "foreign-call", content }]));
	} finally { owner.dispose(); foreign.dispose(); }
});

test("MCP refreshed schemas replace stale registrations and removed tools never call the server", async () => {
	const registrations: any[] = [];
	let calls = 0;
	const runtime = new McpBridgeRuntime({ registerTool(tool: any) { registrations.push(tool); } }, "catalog-fixture");
	const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, tools: new Map([["lookup", {}]]), client: {
		async callTool() { calls++; return { content: [] }; }, async close() {},
	} };
	const first = { name: "lookup", description: "first", inputSchema: { type: "object", properties: { old: { type: "string" } } } };
	try {
		runtime.registerRemoteTool(state, first);
		runtime.registerRemoteTool(state, structuredClone(first));
		assert.equal(registrations.length, 1, "unchanged catalogs keep definition identity");
		runtime.registerRemoteTool(state, { ...first, description: "updated", inputSchema: { type: "object", properties: { next: { type: "number" } } } });
		assert.equal(registrations.length, 2);
		assert.equal(registrations[1].parameters.properties.next.type, "number");
		await runtime.callRemoteTool(state, "lookup", {});
		state.tools.clear();
		await assert.rejects(runtime.callRemoteTool(state, "lookup", {}), /no longer/);
		assert.equal(calls, 1);
	} finally { await runtime.close(); }
	assert.equal(runtime.registeredSchemas.size, 0);
});
