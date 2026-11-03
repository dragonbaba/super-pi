import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
// @ts-expect-error JavaScript extension package.
import { OwnedStdioTransport } from "../packages/mcp-bridge/src/stdio-transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// @ts-expect-error JavaScript extension package.
import * as bridge from "../packages/mcp-bridge/src/bridge.js";

test("owned MCP stdio confirms process-family exit and preserves Windows command arguments", { timeout: 12000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-mcp-owned-")), script = join(root, "server fixture.cjs");
  const code = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
let buffer=''; const held=process.argv[2]==='held';
if(held)setInterval(()=>{},1000);
function send(value){process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');}
process.stdin.on('end',()=>{if(!held)process.exit(0);});
process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\\n');if(end<0)return;const msg=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
if(msg.method==='initialize')send({id:msg.id,result:{protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});
else if(msg.method==='tools/list')send({id:msg.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}}]}});
else if(msg.method==='tools/call')send({id:msg.id,result:{content:[{type:'text',text:JSON.stringify({args:process.argv.slice(3),pid:child.pid})}]}});
}});`;
  writeFileSync(script, code);
  const command = join(root, "command fixture.cmd");
  if (process.platform === "win32") writeFileSync(command, `@"${process.execPath}" %*\r\n`);
  const expected = ["space value", "x&y", '"quoted"', "日本語"];
  let families = 0;
  try {
    for (const mode of ["normal", "held"]) {
      const runtime = new bridge.McpBridgeRuntime({ registerTool() {} }, root);
      const config = { id: "fixture", transport: "stdio", command: mode === "held" && process.platform === "win32" ? command : process.execPath,
        args: [script, mode, ...expected], cwd: root, env: {}, startupTimeoutMs: 2500, toolTimeoutMs: 1000, maxTools: 8 };
      try {
        const state = await runtime.connect(config);
        const result = await runtime.callRemoteTool(state, "echo", {});
        const value = JSON.parse(result.content[0].text);
        assert.deepEqual(value.args, expected);
        const stopping = runtime.close(); assert.equal(runtime.close(), stopping); await stopping;
        assert.throws(() => process.kill(value.pid, 0), /ESRCH/, "owned descendant must be gone after cleanup");
        assert.equal(runtime.cleanupComplete, true); assert.equal(state.transport, null); families++;
      } finally { await runtime.close(); }
    }
    if (process.platform === "win32") {
      const { windowsShellJobDiagnostics } = await import("@super-pi/coding-agent/internal/windows-shell-job");
      const counters = windowsShellJobDiagnostics();
      assert.equal(counters.handles, 0); assert.equal(counters.processHandles, 0);
    }
    t.diagnostic(JSON.stringify({ processFamilies: families, normalExit: 1, forcedExit: 1, commandArgumentsPreserved: expected.length, windowsJobHandlesAfterCleanup: process.platform === "win32" ? 0 : undefined }));
  } finally { removeOwnedFixture(root); }
});

test("owned MCP stdio delivery uses stable callbacks and retains unconfirmed cleanup", { timeout: 5000 }, async t => {
  const source = ts.createSourceFile("stdio-transport.js", readFileSync(new URL("../packages/mcp-bridge/src/stdio-transport.js", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let audited = 0;
  function walk(node: ts.Node) {
    if (ts.isPropertyDeclaration(node) && node.name.getText(source) === "#onData") {
      const callback = node.initializer as ts.ArrowFunction;
      function check(child: ts.Node) {
        assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isNewExpression(child), false, child.getText(source));
        ts.forEachChild(child, check);
      }
      check(callback.body); audited++;
    }
    ts.forEachChild(node, walk);
  }
  walk(source); assert.equal(audited, 1);
  assert.match(source.text, /this\._readBuffer\.append\(chunk\); this\.processReadBuffer\(\)/);
  // start/close and their bounded waits are lifecycle boundaries; ordinary bytes never allocate promises here.
  if (process.platform !== "win32") return;
  const { WindowsShellJob } = await import("@super-pi/coding-agent/internal/windows-shell-job");
  const original = WindowsShellJob.spawn, references: WeakRef<object>[] = [];
  let savedSignal: AbortSignal | undefined, delivered = 0, promises = 0;
  const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
  // Keep the SDK's required schema validation in both profiles; it dominates these allocations.
  const frame = Buffer.from('{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n');
  const baseline: any = new StdioClientTransport({ command: process.execPath });
  let baselineMessages = 0; baseline.onmessage = () => { baselineMessages++; };
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < 1000; index++) { baseline._readBuffer.append(frame); baseline.processReadBuffer(); }
  const baselineProfile = await profiler.post("HeapProfiler.stopSampling"); baseline._readBuffer.clear();
  let baselineBytes = 0; const baseNodes = [baselineProfile.profile.head]; while (baseNodes.length) { const node = baseNodes.pop()!; baselineBytes += node.selfSize; for (const child of node.children) baseNodes.push(child); }
  async function exercise() {
    const child: any = Object.assign(new EventEmitter(), { pid: 123, stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    child.stdin.end = () => {}; child.stderr.pipe = () => {}; child.stderr.unpipe = () => {};
    let ready!: () => void, deliver!: (job: unknown) => void;
    const entered = new Promise<void>(resolve => { ready = resolve; }), startup = new Promise(resolve => { deliver = resolve; });
    WindowsShellJob.spawn = (async (_command: string, _args: unknown, _cwd: unknown, _env: unknown, _stdin: unknown, signal: AbortSignal) => {
      savedSignal = signal; ready(); return await startup;
    }) as any;
    const transport = new OwnedStdioTransport({ command: process.execPath, args: [], stderr: "pipe" });
    transport.onerror = () => {}; transport.onmessage = () => { delivered++; };
    try {
      const starting = transport.start(); await entered;
      let done = false;
      const closing = transport.close().then(() => { done = true; });
      const rejected = assert.rejects(closing, /MCP_CLEANUP_UNCONFIRMED/);
      await tick(); assert.equal(done, false); assert.equal(savedSignal?.aborted, true);
      let cleanupConfirmed = false, cleanupAttempts = 0;
      deliver({ child, stop: async () => { cleanupAttempts++; return cleanupConfirmed ? undefined : "unconfirmed"; } }); await starting;
      const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
      hook.enable();
      try { for (let index = 0; index < 1000; index++) child.stdout.emit("data", frame); }
      finally { hook.disable(); }
      await rejected; assert.equal(done, false); assert.equal(transport.pid, 123);
      assert.equal(child.listenerCount("close"), 1);
      references.push(new WeakRef(transport), new WeakRef(child), new WeakRef(child.stdout.listeners("data")[0]));
      child.emit("error", new Error("late")); child.emit("exit", 0); child.emit("close", 0);
      await assert.rejects(transport.close(), /MCP_CLEANUP_UNCONFIRMED/, "root exit must not turn failed family cleanup into success");
      assert.equal(transport.pid, null);
      for (const stream of [child, child.stdin, child.stdout]) assert.deepEqual(stream.eventNames(), []);
      cleanupConfirmed = true;
      await transport.close();
      assert.ok(cleanupAttempts >= 2, "explicit close must retry the retained family after a transient failure");
    } finally { WindowsShellJob.spawn = original; }
  }
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await exercise();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
  for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
  assert.equal(delivered, 1000); assert.equal(promises, 0); assert.equal(references.filter(ref => ref.deref()).length, 0);
  assert.equal(savedSignal?.aborted, true);
  assert.equal(baselineMessages, 1000);
  t.diagnostic(JSON.stringify({ protocolMessages: delivered, baselineMessages, deliveryPromises: promises, releasedReferences: references.length, sampledBytes: sampled, sdkBaselineBytes: baselineBytes, startupSignalRetainedWithoutOwner: true }));
  assert.ok(sampled < 16 * 1024 * 1024 && sampled < baselineBytes + 2 * 1024 * 1024, "owned lifecycle overhead must stay within 2 MiB of the same SDK parser");
});

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
	return { client, server, clientTransport, serverTransport };
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
	let responseDelivered = false;
	const send = pair.serverTransport.send.bind(pair.serverTransport);
	pair.serverTransport.send = async (message, options) => {
		// The in-process server validates its own result before send. Only count
		// decoding on the client side of the production transport boundary.
		if ("result" in message) responseDelivered = true;
		return send(message, options);
	};
	globalThis.atob = (value) => { if (responseDelivered) decodes++; return original(value); };
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
