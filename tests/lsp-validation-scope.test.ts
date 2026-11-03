import assert from "node:assert/strict";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as path from "node:path";
import * as url from "node:url";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { Type } from "typebox";

const jiti = createJiti(import.meta.url);
const { loadRuntime } = await jiti.import<any>("../packages/lsp/src/adapters.ts");
const { selectDiagnosticRoutes } = await jiti.import<any>("../packages/lsp/src/routes.ts");
const { runDiagnostics, runFix } = await jiti.import<any>("../packages/lsp/src/runner.ts");
const { runNavigation } = await jiti.import<any>("../packages/lsp/src/navigation.ts");
const { LspClientPool } = await jiti.import<any>("../packages/lsp/src/client-pool.ts");
const { default: extension } = await jiti.import<any>("../packages/lsp/src/pi-lsp.ts");
const server = resolve("tests/fixtures/lsp-diagnostic-server.mjs");

function fixture(mode = "full") {
  const root = mkdtempSync(join(tmpdir(), "sp-lsp-scope-"));
  try {
    mkdirSync(join(root, ".sp/config"), { recursive: true });
    writeFileSync(join(root, "page.html"), "<script>const broken = ;</script>");
    writeFileSync(join(root, "example.ts"), "const n = 1;");
    writeFileSync(join(root, ".sp/config/pi-lsp.json"), JSON.stringify({ timeout: 2500, servers: { fixture: {
      command: [process.execPath, server, mode], extensions: [".ts"], pushDiagnosticsGraceMs: mode === "push-provisional" ? 250 : 60, diagnosticsSettleMs: 10,
    } } }));
    const runtime = loadRuntime(root, { projectTrusted: true });
    return { root, ...runtime, release() { assert.equal(dirname(root), tmpdir()); removeOwnedFixture(root); } };
  } catch (error) { removeOwnedFixture(root); throw error; }
}
function tools(boundary?: SessionExecutionBoundary, factory = extension) {
  const registered = new Map<string, any>(), events = new Map<string, any>();
  factory({ registerExecutionOwner: boundary ? (name: string, owner: any) => boundary.register(name, owner) : undefined, registerTool(tool: any) { registered.set(tool.name, tool); }, registerCommand() {}, on(name: string, fn: any) { events.set(name, fn); } });
  return { registered, events };
}

test("LSP session transitions drain late acquisitions and own services independently", { timeout: 12000 }, async t => {
  const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
  const refs: WeakRef<object>[] = [];
  // Compiler/module initialization is cold setup, not the service lifecycle under measurement.
  const files = await jiti.import<any>("../packages/lsp/src/files.ts");
  const code = ts.transpileModule(readFileSync(new URL("../packages/lsp/src/pi-lsp.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  async function exercise() {
  const f = fixture(process.platform === "win32" ? "owned-descendant" : "full");
  const boundary = new SessionExecutionBoundary(), otherBoundary = new SessionExecutionBoundary();
  // Inject the same pool class at the module boundary; Jiti's lazy ESM imports use a separate cache.
  const module = { exports: {} as any };
  runInNewContext(code, { module, exports: module.exports, AbortController, AbortSignal, require(name: string) {
    if (name === "@super-pi/coding-agent") return { defineTool: (tool: unknown) => tool };
    if (name === "typebox") return { Type };
    if (name === "./limits.js") return { DEFAULT_FILE_LIMIT: 50, MAX_COLLECTED_FILES: 500, MAX_REQUESTED_PATHS: 100 };
    if (name === "./fix-authorization.js") return {};
    if (name === "./client-pool.js") return { LspClientPool };
    if (name === "./adapters.js") return { loadRuntime };
    if (name === "./files.js") return files;
    if (name === "./routes.js") return { selectDiagnosticRoutes };
    if (name === "./runner.js") return { runDiagnostics, textResult: (text: string, details: unknown) => ({ content: [{ type: "text", text }], details }) };
    throw new Error(name);
  } });
  const first = tools(boundary, module.exports.default), other = tools(otherBoundary, module.exports.default);
  for (const host of [first, other]) for (const tool of host.registered.values()) refs.push(new WeakRef(tool));
  const ctx = { cwd: f.root, isProjectTrusted: () => true, ui: { setStatus() {} } };
  const acquire = LspClientPool.prototype.acquire, captures: any[] = [];
  let wait: Promise<void> | undefined, ready: (() => void) | undefined;
  LspClientPool.prototype.acquire = async function(...args: unknown[]) {
    const lease = await acquire.apply(this, args); captures.push({ pool: this, lease }); refs.push(new WeakRef(this), new WeakRef(lease.client)); ready?.(); await wait; return lease;
  };
  const execute = (registration: ReturnType<typeof tools>) => registration.registered.get("lsp_diagnostics").execute("fixture", { paths: ["example.ts"] }, undefined, undefined, ctx);
  try {
    await execute(first); await execute(other);
    assert.notEqual(captures[0].pool, captures[1].pool, "extension instances must not share a process pool");
    let descendant: number | undefined;
    if (process.platform === "win32") descendant = Number((await captures[0].lease.client.workspaceSymbols("fixture"))[0].name);
    let resume!: () => void;
    wait = new Promise<void>(resolve => { resume = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const oldCall = execute(first), rejected = assert.rejects(oldCall, /cancel|abort|closed|stopping/i);
    await acquired;
    let published = false;
    const changing = boundary.transition(() => { published = true; });
    await tick(); assert.equal(published, false);
    await assert.rejects(execute(first), /closed/);
    wait = undefined; ready = undefined; resume();
    await rejected; await changing;
    assert.equal(captures[0].lease.client.running, false);
    assert.equal(captures[1].lease.client.running, true, "another session's service survives this transition");
    if (descendant) assert.throws(() => process.kill(descendant!, 0), /ESRCH/, "the owned Windows descendant must also exit");
    await execute(first);
    await first.events.get("session_shutdown")({}, ctx);
    await assert.rejects(execute(first), /closed/);
    assert.equal(captures[1].lease.client.running, true);
    const otherPool = captures[1].pool, shutdownAll = otherPool.shutdownAll;
    otherPool.shutdownAll = async () => { throw new Error("fixture cleanup unconfirmed"); };
    let failedPublished = false;
    try { await assert.rejects(otherBoundary.transition(() => { failedPublished = true; }), /unconfirmed/); }
    finally { otherPool.shutdownAll = shutdownAll; }
    assert.equal(failedPublished, false); await assert.rejects(execute(other), /closed/);
    await otherBoundary.transition(() => {});
    t.diagnostic(JSON.stringify({ sessionPools: 2, acquisitions: captures.length, transitions: 3, lateAcquisitionsDrained: 1, otherSessionPreserved: true, windowsDescendantExitObserved: descendant !== undefined }));
  } finally {
    wait = undefined; ready = undefined; LspClientPool.prototype.acquire = acquire;
    try { await first.events.get("session_shutdown")({}, ctx); await other.events.get("session_shutdown")({}, ctx); await boundary.dispose(); await otherBoundary.dispose(); }
    finally { captures.length = 0; for (const host of [first, other]) { host.registered.clear(); host.events.clear(); } f.release(); }
  }
  }
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await exercise();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
  assert.ok(sampled < 16 * 1024 * 1024, `sampled ${sampled} bytes including process setup`);
  for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  t.diagnostic(JSON.stringify({ serviceReferences: refs.length, liveReferences: 0, sampledBytesIncludingVmAndProcesses: sampled }));
});

test("LSP diagnostics and navigation await cancellation cleanup after late acquire", { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    for (const navigate of [false, true]) {
      const abort = new AbortController(); let acquired!: (lease: unknown) => void, close!: () => void;
      const pending = new Promise(resolve => { acquired = resolve; });
      const cleanup = new Promise<void>(resolve => { close = resolve; });
      let discards = 0, settled = false, effects = 0;
      const lease = { client: { didOpen() { effects++; } } };
      const pool = { acquire: () => pending, discard() { discards++; return cleanup; }, release() { throw new Error("cancelled lease released"); } };
      const work = navigate
        ? runNavigation(pool, f.adapters[0], { root: f.root, path: "example.ts", action: "workspace_symbols", query: "n" }, 100, abort.signal, { ui: { setStatus() {} } }, "lsp")
        : runDiagnostics(pool, f.adapters[0], { root: f.root, paths: ["example.ts"] }, 100, abort.signal, { ui: { setStatus() {} } }, "lsp");
      const result = assert.rejects(work, /cancel|abort/i).then(() => { settled = true; });
      abort.abort(); acquired(lease); await tick();
      assert.equal(discards, 1); assert.equal(effects, 0); assert.equal(settled, false);
      close(); await result;
    }
  } finally { f.release(); }
});

test("LSP cleanup retains failed processes, waits for close and releases bounded pool ownership", { timeout: 10000 }, async t => {
  const source = readFileSync(new URL("../packages/lsp/src/lsp-client.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const poolCode = ts.transpileModule(readFileSync(new URL("../packages/lsp/src/client-pool.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const inspector = new InspectorSession(); inspector.connect(); t.after(() => inspector.disconnect());
  const refs: WeakRef<object>[] = [];
  let publishes = 0, peakTimers = 0, settleCallbacks = 0, settleTimers = 0;
  async function exercise(kind: "normal" | "held" | "spawn-error" | "late-start" | "group-denied") {
    const timers = new Set<any>(), callbacks = new Set<Function>(), children: any[] = [];
    let kills = 0;
    let deliverJob!: (job: unknown) => void, startupSignal: AbortSignal | undefined;
    const jobReady = new Promise(resolve => { deliverJob = resolve; });
    function spawn() {
      const child: any = Object.assign(new EventEmitter(), { pid: kind === "spawn-error" ? undefined : 123, killed: false, exitCode: null, signalCode: null,
        stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill() { kills++; this.killed = true; if (kind === "held") throw new Error("signal denied"); return true; },
      });
      child.stdin.write = (frame: string) => {
        const message = JSON.parse(frame.slice(frame.indexOf("\r\n\r\n") + 4));
        if (message.method === "shutdown") {
          const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null });
          child.stdout.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
        }
        if (message.method === "exit" && kind !== "held") { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); }
        return true;
      };
      children.push(child); refs.push(new WeakRef(child)); return child;
    }
    const module = { exports: {} as any };
    runInNewContext(compiled, { module, exports: module.exports, Buffer, AbortController,
      require(name: string) {
        if (name === "node:child_process") return { spawn };
        if (name === "node:path") return { default: path };
        if (name === "node:process") return { default: { platform: kind === "late-start" ? "win32" : "linux", env: {}, kill() { throw Object.assign(new Error("fixture"), { code: kind === "group-denied" ? "EPERM" : "ESRCH" }); } } };
        if (name === "node:timers/promises") return { setTimeout: tick };
        if (name === "@super-pi/coding-agent/internal/windows-shell-job") return { WindowsShellJob: { spawn(_cmd: string, _args: unknown, _cwd: string, _env: unknown, _stdin: boolean, signal: AbortSignal) { startupSignal = signal; spawn(); return jobReady; } } };
        if (name === "node:url") return url;
        if (name === "./command.js") return { resolveCommandPath: () => "fixture", mergeEnvironment: () => ({}), commandPathValue() {} };
        if (name === "./collections.js") return { EMPTY_READONLY_ARRAY: [] };
        if (name === "./files.js") return { directoryUri: () => "file:///fixture/" };
        if (name === "./regex.js") return { COMMAND_SCRIPT_PATTERN: /\.(?:bat|cmd)$/iu, LSP_CONTENT_LENGTH_PATTERN: /Content-Length:\s*(\d+)/iu };
        if (name === "./text-edits.js") return {};
        throw new Error(name);
      },
      setTimeout(fn: Function, ms: number) { const timer = { fn, ms, refresh() { return this; } }; timers.add(timer); peakTimers = Math.max(peakTimers, timers.size); if (ms === 7) { callbacks.add(fn); settleTimers++; } return timer; },
      clearTimeout(timer: unknown) { timers.delete(timer); },
    });
    const client = new module.exports.LspClient({ name: "fixture", diagnosticsSettleMs: 7 }, { command: "fixture", args: [] }, ".", 10000);
    refs.push(new WeakRef(client));
    const starting = client.start();
    if (kind === "late-start") await tick();
    const child = children[0];
    if (kind === "late-start") {
      let completed = false;
      const stopping = client.shutdown().then(() => { completed = true; });
      await tick(); assert.equal(completed, false); assert.equal(startupSignal?.aborted, true);
      deliverJob({ child, stop: async () => undefined });
      await starting; await stopping; startupSignal = undefined;
    } else if (kind === "spawn-error") {
      const rejected = assert.rejects(starting, /failed to start/); child.emit("error", new Error("missing")); await rejected;
      child.emit("error", new Error("late")); child.emit("close", -1); await client.shutdown();
    } else {
      child.emit("spawn"); await starting;
      refs.push(new WeakRef(child.stdout.listeners("data")[0]));
      // Use the host's valid file URI: file:///fixture/... throws during every
      // canonicalization on Windows and profiles error construction, not LSP.
      const uri = url.pathToFileURL(path.resolve("fixture", "example.ts")).href, diagnostics = client.diagnostics(uri);
      const body = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
      const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      for (let i = 0; i < 1000; i++) { child.stdout.emit("data", frame); publishes++; }
      assert.equal(callbacks.size, 1, "one stable settle callback per diagnostic operation"); settleCallbacks += callbacks.size;
      const settle = [...timers].find(timer => timer.ms === 7); timers.delete(settle); settle.fn(); await diagnostics;
      let completed = false;
      const stopping = client.shutdown(); assert.equal(client.shutdown(), stopping, "concurrent cleanup shares ownership");
      const stopped = stopping.then(() => { completed = true; }, (error: unknown) => { throw error; });
      if (kind === "held") {
        const rejected = assert.rejects(stopped, /LSP_CLEANUP_UNCONFIRMED/);
        await tick(); child.exitCode = 0; child.emit("exit", 0); await tick(); assert.equal(completed, false, "exit without closed pipes is not cleanup");
        for (let i = 0; i < 3; i++) { const timer = [...timers].find(timer => timer.ms === 1000); assert.ok(timer); timers.delete(timer); timer.fn(); await tick(); }
        await rejected; assert.equal(kills, 2); assert.equal(client.running, false);
        assert.doesNotThrow(() => child.emit("error", new Error("late process error")));
        assert.equal(child.listenerCount("close"), 1, "failed cleanup retains its physical close observer");
        child.emit("close", 0); await client.shutdown();
      } else if (kind === "group-denied") {
        await assert.rejects(stopped, /LSP_CLEANUP_UNCONFIRMED/);
        await assert.rejects(client.shutdown(), /LSP_CLEANUP_UNCONFIRMED/, "failed family cleanup must remain closed");
      } else await stopped;
    }
    assert.equal(timers.size, 0);
    for (const stream of [child, child.stdin, child.stdout, child.stderr]) assert.deepEqual(stream.eventNames(), []);
    callbacks.clear(); children.length = 0;
  }
  async function exercisePool() {
    let blocked = true, starts = 0, shutdowns = 0;
    let holdInitialization = false, initialized: (() => void) | undefined;
    const clients: any[] = [], timers = new Set<any>();
    class Client {
      running = false;
      async start() { starts++; this.running = true; clients.push(this); refs.push(new WeakRef(this)); }
      async initialize() { if (holdInitialization) await new Promise<void>(resolve => { initialized = resolve; }); }
      async shutdown() { shutdowns++; if (blocked) throw new Error("cleanup unconfirmed"); this.running = false; initialized?.(); }
    }
    const module = { exports: {} as any };
    runInNewContext(poolCode, { module, exports: module.exports, require(name: string) { if (name === "node:fs") return { realpathSync: (root: string) => root }; if (name === "./lsp-client.js") return { LspClient: Client }; throw new Error(name); },
      setTimeout(fn: Function) { const timer = { fn, unref() {} }; timers.add(timer); return timer; }, clearTimeout(timer: unknown) { timers.delete(timer); },
    });
    const pool = new module.exports.LspClientPool(10), adapter = { name: "fixture", defaultCommand: { command: "fixture", args: [] } };
    refs.push(new WeakRef(pool));
    const lease = await pool.acquire(adapter, "root", 100);
    await assert.rejects(pool.discard(lease), /unconfirmed/);
    assert.throws(() => pool.reopen(), /still draining/);
    await assert.rejects(pool.acquire(adapter, "other", 100), /shutting down/); assert.equal(starts, 1);
    const shutdown = pool.shutdownAll(); assert.equal(pool.shutdownAll(), shutdown); await assert.rejects(shutdown, /unconfirmed/);
    blocked = false; await pool.shutdownAll(); pool.reopen();
    for (let i = 0; i < 8; i++) { const current = await pool.acquire(adapter, `root-${i}`, 100); pool.release(current); }
    await assert.rejects(pool.acquire(adapter, "overflow", 100), /limited to 8/);
    const timer = [...timers][0]; timers.delete(timer); blocked = true; timer.fn(); await tick();
    await assert.rejects(pool.acquire(adapter, "root-0", 100), /shutting down/);
    blocked = false; await pool.shutdownAll(); pool.reopen();
    holdInitialization = true;
    const initializing = assert.rejects(pool.acquire(adapter, "held-initialize", 100), /cancel|available/);
    await tick(); await pool.shutdownAll(); await initializing; pool.reopen(); initialized = undefined;
    assert.equal(starts, 10); assert.equal(shutdowns, 13); assert.equal(timers.size, 0); clients.length = 0;
  }
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (const kind of ["normal", "held", "spawn-error", "late-start", "group-denied"] as const) await exercise(kind);
  await exercisePool();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
  const leading: { name: string; url: string; bytes: number }[] = [], pending = [profile.head];
  while (pending.length) { const node = pending.pop()!; if (node.selfSize) leading.push({name:node.callFrame.functionName,url:node.callFrame.url,bytes:node.selfSize}); for (const child of node.children) pending.push(child); }
  t.diagnostic(JSON.stringify({ leading: leading.sort((a,b)=>b.bytes-a.bytes).slice(0,10), sampled }));
  assert.ok(sampled < 16 * 1024 * 1024, `sampled ${sampled} bytes including VM fixtures`);
  for (let i = 0; i < 3; i++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  assert.equal(settleTimers, 3);
  t.diagnostic(JSON.stringify({ publishes, settleCallbacks, settleTimers, peakTimers, references: refs.length, liveReferences: 0, timersAfterCleanup: 0, sampledBytesIncludingFixtures: sampled }));
});

test("configured route is explicit about zero files and unsupported HTML; no client acquisition", async () => {
  const f = fixture(); let acquired = 0;
  try {
    assert.throws(() => selectDiagnosticRoutes(f.adapters, { root: f.root, paths: ["page.html"] }, 50), /No supported files/);
    const result = await runDiagnostics({ acquire() { acquired++; throw new Error("unexpected spawn"); } }, f.adapters[0], { root: f.root, files: [] }, 100, undefined, { ui: { setStatus() {} } }, "lsp");
    assert.equal(result.isError, true); assert.equal(result.details.status, "not_checked"); assert.equal(acquired, 0);
    assert.equal(result.details.summary.files, 0);
    const missing = { ...f.adapters[0], isDefault: true, defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] } };
    const routes = selectDiagnosticRoutes([missing], { root: f.root, paths: ["example.ts"] }, 50);
    assert.equal(routes.routes.length, 0); assert.equal(routes.skipped.length, 1);
    assert.deepEqual(routes.skipped[0].files, [join(f.root, "example.ts")]);
    assert.throws(() => selectDiagnosticRoutes([missing], { root: f.root, paths: ["page.html"] }, 50), /No supported files/);
  } finally { f.release(); }
});

test("a capped skipped route remains incomplete after its known files overlap a live route", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "a.ts"), "const a = 1;"); writeFileSync(join(f.root, "z.py"), "x = 1");
    const broad = { ...f.adapters[0], isDefault: true, name: "missing-broad", extensions: [".ts", ".py"],
      isSupportedFile(file: string) { return file.endsWith(".ts") || file.endsWith(".py"); },
      defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] } };
    const limited = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "z.py"], limit: 1 }, 50);
    assert.deepEqual(limited.uncoveredFiles, []);
    assert.equal(limited.skippedScopeLimited, true);
    assert.equal(limited.incomplete, true, "known overlap is not proof of coverage beyond the cap");
    const exhausted = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts"], limit: 1 }, 50);
    assert.equal(exhausted.skippedScopeLimited, false);
    assert.equal(exhausted.incomplete, false, "a fully collected overlapping skipped route does not create missing scope");
    mkdirSync(join(f.root, "single")); writeFileSync(join(f.root, "single", "one.ts"), "const one = 1;");
    const exactDirectory = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["single"], limit: 1 }, 50);
    assert.equal(exactDirectory.skippedScopeLimited, false, "the final entry can exactly fill the cap without truncation");
    const repeated = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "a.ts"], limit: 1 }, 50);
    assert.equal(repeated.skippedScopeLimited, false);
    const remaining = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "a.ts", "z.py"], limit: 1 }, 50);
    assert.equal(remaining.skippedScopeLimited, true);
    const unrelated = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "page.html"], limit: 1 }, 50);
    assert.equal(unrelated.skippedScopeLimited, false, "a known unsupported explicit file does not truncate a skipped route");
  } finally { f.release(); }
});

test("unavailable policies share one real directory traversal without changing per-policy scope", () => {
  const f = fixture();
  const scan = join(f.root, "scan");
  mkdirSync(join(scan, "sub"), { recursive: true });
  writeFileSync(join(scan, "a.ts"), "const a = 1;");
  writeFileSync(join(scan, "sub", "b.ts"), "const b = 1;");
  try {
    // Instrument before module loading in a private process, including cached Jiti imports.
    const child = spawnSync(process.execPath, [resolve("tests/fixtures/lsp-shared-scan.mjs"), f.root], {
      encoding: "utf8", env: { ...process.env, SP_CODING_AGENT_DIR: join(f.root, "isolated-agent") },
    });
    assert.equal(child.status, 0, child.stderr);
    const selected = JSON.parse(child.stdout);
    assert.equal(selected.routes, 1); assert.equal(selected.skipped, 0);
    assert.equal(selected.incomplete, false);
    assert.equal(selected.directoryReads, 2, "directory IO must not multiply by unavailable server count");
  } finally { f.release(); }
});

test("shared route traversal preserves each policy's skipped subtrees and explicit paths", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "scan", "skip-live"), { recursive: true });
    mkdirSync(join(f.root, "scan", "skip-missing"));
    writeFileSync(join(f.root, "scan", "a.ts"), "const a = 1;");
    writeFileSync(join(f.root, "scan", "skip-live", "b.ts"), "const b = 1;");
    writeFileSync(join(f.root, "scan", "skip-live", "c.py"), "x = 1");
    writeFileSync(join(f.root, "scan", "skip-missing", "d.py"), "x = 2");
    const live = { ...f.adapters[0], skipDirectories: new Set(["skip-live"]) };
    const missing = { ...f.adapters[0], name: "missing", isDefault: true, extensions: [".py"], skipDirectories: new Set(["skip-missing"]),
      isSupportedFile(file: string) { return file.endsWith(".py"); }, defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] } };
    const selected = selectDiagnosticRoutes([live, missing], { root: f.root, paths: ["scan"] }, 50);
    assert.deepEqual(selected.routes[0].files, [join(f.root, "scan", "a.ts")]);
    assert.deepEqual(selected.uncoveredFiles, [join(f.root, "scan", "skip-live", "c.py")]);
    const explicit = selectDiagnosticRoutes([live, missing], { root: f.root, paths: ["scan/skip-missing/d.py"] }, 50);
    assert.deepEqual(explicit.uncoveredFiles, [join(f.root, "scan", "skip-missing", "d.py")]);
  } finally { f.release(); }
});

for (const mode of ["full", "push-empty", "push-provisional", "push-silent", "push-missing-report", "push-null-report", "missing-report", "error"]) {
  test(`real protocol process: ${mode} preserves diagnostic status (not a language-capability test)`, async () => {
    const f = fixture(mode), pool = new LspClientPool();
    try {
      const work = runDiagnostics(pool, f.adapters[0], { root: f.root, paths: ["example.ts"] }, 2500, undefined, { ui: { setStatus() {} } }, "lsp");
      if (mode === "full" || mode === "push-empty" || mode === "push-provisional") {
        const result = await work;
        assert.equal(result.details.status, "diagnostics_received"); assert.equal(result.details.summary.files, 1);
        assert.equal(result.details.summary.diagnostics, mode === "push-provisional" ? 1 : 0);
      } else await assert.rejects(work, /unconfirmed|synthetic diagnostic failure/);
    } finally { try { await pool.shutdownAll(); } finally { f.release(); } }
  });
}

test("tool uses session cwd, preserves received count and discloses unverified embedded languages", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    for (const name of ["subproject", " subproject", ...(process.platform === "win32" ? [] : ["subproject "])]) {
      mkdirSync(join(f.root, name)); writeFileSync(join(f.root, name, "example.ts"), "const n = 1;");
    }
    for (const root of [undefined, "   ", "subproject", " subproject", ...(process.platform === "win32" ? [] : ["subproject "])]) {
      const result = await registration.registered.get("lsp_diagnostics").execute("scope", { root, paths: ["example.ts"] }, undefined, undefined, ctx);
      assert.equal(result.details.root, root?.trim() ? join(f.root, root) : f.root);
      assert.equal(result.details.submittedFiles, 1);
      assert.equal(result.details.status, "diagnostics_received");
      assert.match(result.content[0].text, /Embedded languages.*not established/);
      assert.equal(result.isError, false);
    }
  } finally { try { await registration.events.get("session_shutdown")({}, ctx); } finally { f.release(); } }
});

test("strict validation can fail for silence while source fixes retain an empty diagnostic context", async () => {
  const f = fixture("push-silent"), pool = new LspClientPool();
  const ctx = { ui: { setStatus() {} } };
  try {
    await assert.rejects(runDiagnostics(pool, f.adapters[0], { root: f.root, paths: ["example.ts"] }, 2500, undefined, ctx, "lsp"), /unconfirmed/);
    const result = await runFix(pool, f.adapters[0], { root: f.root, path: "example.ts", write: false }, 2500, undefined, ctx, "lsp");
    assert.equal(result.details.changed, true);
    assert.equal(result.details.editCount, 1);
    assert.match(result.content[0].text, /const n = 2/);
    assert.equal(readFileSync(join(f.root, "example.ts"), "utf8"), "const n = 1;", "preview is not a write or a validation pass");
  } finally { try { await pool.shutdownAll(); } finally { f.release(); } }
});

test("native host-write policy authorizes the registered LSP tool to commit its exact file", { skip: process.arch !== "x64" || !["win32", "linux"].includes(process.platform) }, async () => {
 const f = fixture("push-silent"), runtime = createExtensionRuntime(), registration = tools(runtime.executionBoundary);
 const policy = new SessionExecutionPolicy(runtime, "trusted-host", {}, "host-write");
 const ctx: any = { cwd: f.root, hasUI: false, isProjectTrusted() { return true; }, ui: { setStatus() {} },
  sessionManager: { getSessionId: () => "native-lsp", getLeafEntry: () => undefined } };
 try {
  await registration.events.get("session_start")({}, ctx);
  const input = { root: ".", path: "example.ts", write: true };
  const authorization = await policy.authorize({ type: "tool_call", toolName: "lsp_fix", toolCallId: "native-fix", input } as any, ctx);
  try {
   const result = await registration.registered.get("lsp_fix").execute("native-fix", input, undefined, undefined, ctx);
   assert.equal(result.isError, undefined); assert.equal(result.details.changed, true);
   assert.equal(readFileSync(join(f.root, "example.ts"), "utf8"), "const n = 2;");
  } finally { authorization.release(); }
 } finally {
  policy.dispose();
  try { await registration.events.get("session_shutdown")({}, ctx); await runtime.executionBoundary.dispose(); }
  finally { const native = await import("@super-pi/coding-agent/internal/files/native-file-client"); await native.disposeNativeFileWorker(); f.release(); }
 }
});

test("LSP fixes require current exact-target authorization after asynchronous server replies", { skip: process.arch !== "x64" || !["win32", "linux"].includes(process.platform) }, async () => {
 const f = fixture(), ctx = { ui: { setStatus() {} } };
 const file = join(f.root, "example.ts");
 try {
  await assert.rejects(tools().registered.get("lsp_fix").execute("missing", { path: "example.ts", write: true }, undefined, undefined,
   { cwd: f.root, isProjectTrusted() { return true; }, ...ctx }), /authorization is missing/);
  for (const boundary of ["missing", "current", "revoked", "changed-target", "edited", "aborted-acquire"]) {
   writeFileSync(file, "const n = 1;");
   let current = true, acquired = 0, released = 0, discarded = 0;
   const cancellation = new AbortController(), signal = cancellation.signal;
   const authorization = boundary === "missing" ? undefined : {
    schemaVersion: 1, operation: "lsp_fix", toolCallId: "fix", sequence: 0, requestHash: "fixture",
    canonicalTarget: boundary === "changed-target" ? join(f.root, "other.ts") : realpathSync.native(file), protectedRoots: [],
    revocationSignal: signal, assertCurrent() { if (!current) throw new Error("Permission authority changed after approval."); },
   };
   const client = {
    didOpen() {}, didClose() {}, async diagnostics() { return []; },
    async codeActions(uri: string) { return [{ title: "fix", kind: "source.fixAll", edit: { changes: { [uri]: [
     { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: "2" },
    ] } } }]; },
    async resolveActions(actions: unknown) {
     if (boundary === "revoked") current = false;
     if (boundary === "edited") writeFileSync(file, "const n = 9;");
     return actions;
    },
   };
   const pool = { async acquire() { acquired++; if (boundary === "aborted-acquire") cancellation.abort(); return { client }; }, release() { released++; },
    async discard() { await new Promise<void>(resolve => setImmediate(resolve)); discarded++; } };
   const pending = runFix(pool, f.adapters[0], { root: f.root, path: "example.ts", write: true }, 2500, undefined, ctx, "lsp", authorization);
   if (boundary === "current") { assert.equal((await pending).details.changed, true); assert.equal(readFileSync(file, "utf8"), "const n = 2;"); }
   else if (boundary === "edited") { const result = await pending; assert.equal(result.isError, true); assert.equal(result.details.commit.outcome, "not_committed"); assert.equal(readFileSync(file, "utf8"), "const n = 9;"); }
   else { await assert.rejects(pending, /authorization|authority changed|aborted/i); assert.equal(readFileSync(file, "utf8"), "const n = 1;"); }
   assert.equal(acquired, boundary === "missing" || boundary === "changed-target" ? 0 : 1);
   assert.equal(discarded, boundary === "aborted-acquire" ? 1 : 0); assert.equal(released + discarded, acquired);
  }
 } finally {
  const native = await import("@super-pi/coding-agent/internal/files/native-file-client");
  try { assert.equal((await native.nativeFileRequest("stats")).activeHandles, 0); }
  finally { try { await native.disposeNativeFileWorker(); } finally { f.release(); } }
 }
});

test("actual tool reports live-route truncation as partial and exact-cap exhaustion as complete", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    writeFileSync(join(f.root, "second.ts"), "const second = 2;");
    const partial = await registration.registered.get("lsp_diagnostics").execute("limited", { paths: ["example.ts", "second.ts"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(partial.details.submittedFiles, 1);
    assert.equal(partial.details.routedScopeLimited, true);
    assert.equal(partial.details.status, "partial"); assert.equal(partial.isError, true);
    assert.match(partial.content[0].text, /available route.*unvisited/i);
    const complete = await registration.registered.get("lsp_diagnostics").execute("complete", { paths: ["example.ts"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(complete.details.routedScopeLimited, false);
    assert.equal(complete.details.status, "diagnostics_received"); assert.equal(complete.isError, false);
    const unrelated = await registration.registered.get("lsp_diagnostics").execute("unrelated", { paths: ["example.ts", "page.html"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(unrelated.details.routedScopeLimited, false);
    assert.equal(unrelated.details.status, "diagnostics_received"); assert.equal(unrelated.isError, false);
    mkdirSync(join(f.root, "later.html")); writeFileSync(join(f.root, "later.html", "more.ts"), "const more = 1;");
    const directory = await registration.registered.get("lsp_diagnostics").execute("directory", { paths: ["example.ts", "later.html"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(directory.details.routedScopeLimited, true, "an unsupported-looking directory still has unvisited scope");
    assert.equal(directory.details.status, "partial"); assert.equal(directory.isError, true);
  } finally { try { await registration.events.get("session_shutdown")({}, ctx); } finally { f.release(); } }
});

test("actual tool classifies capped directory symlinks before declaring omitted scope", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    const scan = join(f.root, "scan"); mkdirSync(scan);
    writeFileSync(join(scan, "a.ts"), "const a = 1;");
    symlinkSync(join(f.root, "page.html"), join(scan, "z.html"), "file");
    const tool = registration.registered.get("lsp_diagnostics");
    const complete = await tool.execute("unsupported-link", { paths: ["scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(complete.details.status, "diagnostics_received");
    assert.equal(complete.details.routedScopeLimited, false); assert.equal(complete.isError, false);
    symlinkSync(join(f.root, "absent.html"), join(scan, "z-dangling.html"), "file");
    const dangling = await tool.execute("dangling-link", { paths: ["scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(dangling.details.status, "diagnostics_received"); assert.equal(dangling.isError, false);
      // This Windows runtime cannot unlink a dangling file link. Restore only
      // this fixture-owned target after the dangling-link assertion.
      writeFileSync(join(f.root, "absent.html"), "fixture cleanup target");
    symlinkSync(join(f.root, "example.ts"), join(scan, "z.ts"), "file");
    const supported = await tool.execute("supported-link", { paths: ["scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(supported.details.status, "partial"); assert.equal(supported.isError, true);
    const directoryScan = join(f.root, "directory-scan"); mkdirSync(directoryScan);
    writeFileSync(join(directoryScan, "a.ts"), "const a = 1;");
    symlinkSync(scan, join(directoryScan, "z.html"), process.platform === "win32" ? "junction" : "dir");
    const directory = await tool.execute("directory-link", { paths: ["directory-scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(directory.details.status, "partial"); assert.equal(directory.isError, true);
  } finally { try { await registration.events.get("session_shutdown")({}, ctx); } finally { f.release(); } }
});

test("actual tool recognizes a capped directory already exhausted through an earlier symlink", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    const scan = join(f.root, "alias-scan"), target = join(scan, "z-real");
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, "only.ts"), "const only = 1;");
    symlinkSync(target, join(scan, "a-link"), process.platform === "win32" ? "junction" : "dir");
    const tool = registration.registered.get("lsp_diagnostics");
    const complete = await tool.execute("visited-directory", { paths: ["alias-scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(complete.details.status, "diagnostics_received");
    assert.equal(complete.details.submittedFiles, 1); assert.equal(complete.isError, false);
    writeFileSync(join(target, "second.ts"), "const second = 2;");
    const partial = await tool.execute("incomplete-visited-directory", { paths: ["alias-scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(partial.details.status, "partial"); assert.equal(partial.isError, true);
  } finally { try { await registration.events.get("session_shutdown")({}, ctx); } finally { f.release(); } }
});

test("mixed available and unavailable matching default routes retain uncovered files and return partial", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "uncovered.py"), "x = 1\n");
    const binary = createRequire(import.meta.url).resolve(`@biomejs/cli-${process.platform}-${process.arch}/biome${process.platform === "win32" ? ".exe" : ""}`);
    const privatePath = dirname(binary);
    const child = spawnSync(process.execPath, [resolve("tests/fixtures/lsp-skipped-tool.mjs"), f.root, "mixed"], {
      encoding: "utf8", env: { ...process.env, PATH: privatePath, Path: privatePath, SP_CODING_AGENT_DIR: join(f.root, "isolated-agent") },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.isError, true);
    assert.equal(result.details.status, "partial", JSON.stringify(result));
    assert.equal(result.details.submittedFiles, 1);
    assert.deepEqual(result.details.uncoveredFiles, [join(f.root, "uncovered.py")]);
    assert.deepEqual(result.details.skipped[0].files, [join(f.root, "uncovered.py")]);
  } finally { f.release(); }
});

test("all unavailable default commands return not_checked from the actual tool in a private process", () => {
  const f = fixture();
  try {
    const child = spawnSync(process.execPath, [resolve("tests/fixtures/lsp-skipped-tool.mjs"), f.root], {
      encoding: "utf8", env: { ...process.env, PATH: f.root, Path: f.root, SP_CODING_AGENT_DIR: join(f.root, "isolated-agent") },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.isError, true);
    assert.equal(result.details.status, "not_checked");
    assert.equal(result.details.submittedFiles, 0);
    assert.match(result.content[0].text, /No validation pass/);
  } finally { f.release(); }
});

test("available real Biome diagnoses standalone JS; HTML route alone does not prove embedded JS coverage", async t => {
  const f = fixture(), pool = new LspClientPool();
  try {
    const biome = resolve("node_modules/@biomejs/biome/bin/biome");
    writeFileSync(join(f.root, ".sp/config/pi-lsp.json"), JSON.stringify({ servers: { biome: { command: [process.execPath, biome, "lsp-proxy"], extensions: [".js", ".html"] } } }));
    writeFileSync(join(f.root, "broken.js"), "const broken = ;");
    const { adapters } = loadRuntime(f.root, { projectTrusted: true });
    const js = await runDiagnostics(pool, adapters[0], { root: f.root, paths: ["broken.js"] }, 10000, undefined, { ui: { setStatus() {} } }, "lsp");
    assert.ok(js.details.summary.diagnostics > 0, "real malformed JS must be detected");
    const html = await runDiagnostics(pool, adapters[0], { root: f.root, paths: ["page.html"] }, 10000, undefined, { ui: { setStatus() {} } }, "lsp");
    // This records the observed server result; no assertion treats zero as HTML validity.
    t.diagnostic(JSON.stringify({ server: "repository-installed Biome", standaloneJsDiagnostics: js.details.summary.diagnostics, htmlDiagnostics: html.details.summary.diagnostics,
      htmlMessages: html.details.files.flatMap((file: any) => file.diagnostics.map((diagnostic: any) => diagnostic.message)), embeddedJsCoverage: "not established by route" }));
  } finally { try { await pool.shutdownAll(); } finally { f.release(); } }
});
