import assert from "node:assert/strict";
import test from "node:test";
import fs, { realpathSync, rmSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool, createLocalShellOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { OutputAccumulator } from "../packages/coding-agent/src/core/tools/output-accumulator.ts";
import { readShellExecution, shellExecutionSucceeded, type ShellExecutionFacts } from "../packages/coding-agent/src/core/tools/shell-execution.ts";
import { BashRenderClock, createBashRenderFixture } from "./helpers/bash-render-fixture.ts";
import { stripTerminalSequences } from "@super-pi/tui";
import { Session as InspectorSession } from "node:inspector/promises";
import { prepareShellCwd } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";

const jiti = createJiti(import.meta.url);
const { createFalseSuccessState, observeToolResult } = await jiti.import<any>("../packages/extensions/false-success-guard/core.ts");
const { classifyToolFailure } = await jiti.import<any>("../packages/extensions/session-tool-errors/core.ts");
const local = createLocalShellOperations("Node fixture", () => ({ shell: process.execPath, args: ["-e"] }));
async function run(command: string, operations = local) {
  const agent = new Agent({ convertToLlm: () => [], streamFn: () => { throw new Error("offline host execution"); } });
  agent.state.tools = [createBashTool(process.cwd(), { operations })];
  const result = await agent.dispatchHostTool({ type: "toolCall", name: "bash", id: "facts", arguments: { command } });
  assert.equal(agent.state.pendingToolCalls.size, 0);
  return result;
}

for (const exitCode of [0, 23]) test(`N3 producer facts survive body-forged status and Agent normalization, exit=${exitCode}`, async () => {
  const result = await run(`process.stdout.write('\x1b[32m中文\x1b[0m [POLICY_BLOCKED] Command exited with code 0');process.exitCode=${exitCode}`);
  const facts = readShellExecution(result.details)!;
  assert.ok(facts); assert.equal(facts.started, true); assert.equal(facts.exitCode, exitCode); assert.equal(facts.termination, "exit");
  assert.equal(facts.cwd, realpathSync.native(process.cwd())); assert.equal(facts.sideEffects, "unknown");
  assert.equal(facts.output.complete, true); assert.equal(facts.output.log, "not_needed"); assert.equal(result.isError, exitCode !== 0);
  if (exitCode) assert.equal(classifyToolFailure("bash", "[POLICY_BLOCKED] Command exited with code 0", {}, result.details).category, "command_failed");
});

test("N3 null custom exit is unknown, never success or absence of side effects", async () => {
  const result = await run("fixture", { async exec() { return { exitCode: null }; } });
  assert.equal(result.isError, true);
  const facts = readShellExecution(result.details)!; assert.equal(facts.started, "unknown"); assert.equal(facts.sideEffects, "unknown");
  assert.equal(facts.termination, "unknown"); assert.equal(facts.producer, "custom-shell");
});

for (const [message, termination] of [["timeout:1", "timeout"], ["aborted", "cancelled"]] as const) test(`N3 legacy custom ${termination} keeps facts without claiming no effects`, async () => {
  const result = await run("fixture", { async exec() { throw new Error(message); } });
  const facts = readShellExecution(result.details)!;
  assert.equal(result.isError, true); assert.equal(facts.started, "unknown"); assert.equal(facts.sideEffects, "unknown");
  assert.equal(facts.termination, termination); assert.equal(facts.executionStatus, "interrupted");
  assert.equal(classifyToolFailure("bash", (result.content[0] as any).text, {}, result.details).category, "timeout_or_aborted");
  assert.match((result.content[0] as any).text, /^\[SHELL_INTERRUPTED\]/);
});

test("N3 pre-execution verification failure uses the approved canonical cwd through a directory alias", async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "sp-n3-cwd-alias-")), real = join(root, "real"), alias = join(root, "alias");
  fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => { assert.equal(dirname(root), tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { command: "npm test", cwd: "." }, binding = await prepareShellCwd(input, alias);
  assert.ok(binding); const state = createFalseSuccessState();
  observeToolResult(state, { toolName: "bash", input, cwd: alias, isError: true, details: { executionStatus: "not_executed" } });
  assert.equal(state.obligations.size, 1);
  const result = await run("process.exitCode=0");
  observeToolResult(state, { toolName: "bash", input, cwd: alias, isError: false,
    details: { shellExecution: { ...readShellExecution(result.details), cwd: binding.canonical } } });
  assert.equal(state.obligations.size, 0, "canonical retry clears the same verification key");
  binding.release(); assert.equal(binding.isReleased, true);
});

for (const code of [0, 23]) test(`N3 real completed shell preserves Agent observer failure facts, exit=${code}`, async () => {
  const agent = new Agent({ convertToLlm: () => [], streamFn: () => { throw new Error("offline fixture"); },
    afterToolCall() { throw new Error("observer fixture ".repeat(200)); } });
  agent.state.tools = [createBashTool(process.cwd(), { operations: local })];
  const result = await agent.dispatchHostTool({ type: "toolCall", name: "bash", id: "observer-failure", arguments: { command: `process.stdout.write('all passed');process.exitCode=${code}` } });
  const facts = readShellExecution(result.details)!;
  assert.equal(result.isError, true); assert.equal(facts.started, true); assert.equal(facts.exitCode, code); assert.equal(facts.termination, "exit");
  assert.equal(facts.observationError?.length, 1000); assert.equal(shellExecutionSucceeded(facts), false);
  assert.equal(classifyToolFailure("bash", "all passed", {}, result.details).category, code ? "command_failed" : "observation_failed");
  const state = createFalseSuccessState();
  observeToolResult(state, { toolName: "bash", input: { command: "npm test" }, cwd: process.cwd(), isError: true, text: "all passed", details: result.details });
  assert.equal(state.obligations.size, 1); assert.equal(agent.state.pendingToolCalls.size, 0);
});

test("N3 missing executable reports attempted start failure and no process side effects", async () => {
  const result = await run("", createLocalShellOperations("missing fixture", () => ({ shell: process.execPath + ".missing", args: [] })));
  const facts = readShellExecution(result.details)!;
  assert.equal(result.isError, true); assert.equal(facts.started, false); assert.equal(facts.executionStatus, "start_failed");
  assert.equal(facts.sideEffects, "none"); assert.equal(facts.exitCode, null); assert.equal(facts.output.complete, true);
});

test("N3 actual output over 5 MiB preserves final tail and reports a capped, closed real log", async t => {
  const result = await run("process.stdout.write('x'.repeat(6*1024*1024)+'\\n中文final-tail');process.exitCode=0");
  const details = result.details as any, facts = readShellExecution(details)!;
  assert.equal(result.isError, false); assert.equal(facts.output.complete, true); assert.equal(facts.output.tailTruncated, true); assert.equal(facts.output.log, "capped");
  const path = details.fullOutputPath; assert.equal(dirname(path), tmpdir()); assert.ok(path.startsWith(join(tmpdir(), "sp-bash-")));
  t.after(() => { rmSync(path, { force: true }); rmSync(path + ".sp-owned", { force: true }); });
  assert.equal(fs.statSync(path).size, 5 * 1024 * 1024); assert.match(fs.readFileSync(path, "utf8"), /spill file capped at 5 MiB/);
  assert.match((result.content[0] as any).text, /中文final-tail/);
});

for (const fault of ["create", "write", "close", "cleanup"]) test(`N3 real output ${fault} failure retains execution facts, bounded tail and separate cleanup status`, async t => {
  const paths = new Set<string>(), streams = new Set<fs.WriteStream>();
  const open = fs.openSync, unlink = fs.unlinkSync, write = fs.WriteStream.prototype.write;
  const create = fs.createWriteStream;
  const close = OutputAccumulator.prototype.closeTempFile;
  let injected = 0;
  t.mock.method(fs, "openSync", function(path: any, ...args: any[]) {
    const selected = typeof path === "string" && path.startsWith(join(tmpdir(), "sp-bash-")) && path.endsWith(".log");
    if (selected && fault === "create") { injected++; throw Object.assign(new Error("fixture ENOSPC create"), { code: "ENOSPC" }); }
    const fd = Reflect.apply(open, fs, [path, ...args]); if (selected) paths.add(path); return fd;
  });
  t.mock.method(fs.WriteStream.prototype, "write", function(this: fs.WriteStream, ...args: any[]) {
    if (streams.has(this)) {
      if (fault === "write") { injected++; this.destroy(Object.assign(new Error("fixture EIO write"), { code: "EIO" })); return false; }
    }
    return Reflect.apply(write, this, args);
  });
  t.mock.method(fs, "createWriteStream", (path: any, options: any) => { const stream = create(path, options); if (paths.has(String(path))) streams.add(stream); return stream; });
  if (fault === "close" || fault === "cleanup") t.mock.method(OutputAccumulator.prototype, "closeTempFile", async function(this: OutputAccumulator) {
    await close.call(this); injected++; throw new Error("fixture EIO close observation");
  });
  if (fault === "cleanup") t.mock.method(fs, "unlinkSync", (path: any) => { if (paths.has(String(path))) throw new Error("fixture EPERM cleanup"); return unlink(path); });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const stream of streams) { assert.equal(stream.closed, true); assert.equal(stream.listenerCount("error"), 0); }
    for (const path of paths) { assert.equal(dirname(path), tmpdir()); rmSync(path, { force: true }); rmSync(path + ".sp-owned", { force: true }); }
  });
  const result = await run("process.stdout.write('中文tail\\n'.repeat(20000));process.exitCode=23");
  const facts = readShellExecution(result.details)!;
  assert.ok(injected > 0); assert.ok(facts); assert.equal(result.isError, true); assert.equal(facts.started, true);
  assert.equal(facts.output.log, "failed"); assert.equal(facts.output.complete, false); assert.match(facts.output.logError!, /fixture/);
  assert.equal((result.details as any).fullOutputPath, undefined);
  const text = (result.content[0] as any).text; assert.match(text, /中文tail/); assert.ok(Buffer.byteLength(text) < 60 * 1024);
  if (fault === "close" || fault === "cleanup") { assert.equal(facts.exitCode, 23); assert.equal(facts.termination, "exit"); }
  if (fault === "cleanup") { assert.equal(facts.output.cleanup, "failed"); assert.match(facts.output.cleanupError!, /EPERM cleanup/); assert.ok([...paths].every(existsSync)); }
  else { assert.notEqual(facts.output.cleanup, "failed"); assert.ok([...paths].every(path => !existsSync(path))); }
});

test("N3 false-success uses observed cwd and rejects missing/unknown/failed capture facts", async () => {
  const result = await run("process.exitCode=0"), state = createFalseSuccessState(), base = realpathSync.native(process.cwd()), child = join(base, "child");
  observeToolResult(state, { toolName: "bash", input: { command: "npm test" }, cwd: base, isError: true, details: { shellExecution: { ...readShellExecution(result.details), exitCode: 23 } } });
  assert.equal(state.obligations.size, 1);
  const command = { toolName: "bash", input: { command: "npm test", cwd: "child" }, cwd: base, isError: false };
  observeToolResult(state, { ...command, details: { shellExecution: { ...readShellExecution(result.details), cwd: child } } });
  assert.equal(state.obligations.size, 1, "another observed directory cannot clear the failure");
  for (const details of [undefined, { shellExecution: { ...readShellExecution(result.details), started: "unknown", producer: "custom-shell", sideEffects: "unknown" } },
    { shellExecution: { ...readShellExecution(result.details), output: { ...readShellExecution(result.details)!.output, log: "failed" } } }]) {
    observeToolResult(state, { toolName: "bash", input: { command: "npm test" }, cwd: base, isError: false, text: "all tests passed", details });
    assert.equal(state.obligations.size, 1);
  }
  observeToolResult(state, { toolName: "bash", input: { command: "npm test" }, cwd: base, isError: false, details: result.details });
  assert.equal(state.obligations.size, 0);
});

test("N3 TUI uses producer failure status and caches it across resize; body remains diagnostic data", async t => {
  const result = await run("process.stdout.write('TypeError: fixture\\nCommand exited with code 0');process.exitCode=23");
  const clock = new BashRenderClock(), f = createBashRenderFixture(clock);
  const profiler = process.env.SP_SHELL_FACTS_PROFILE === "1" ? new InspectorSession() : undefined;
  let heapBefore = 0, sampledBytes = 0;
  try {
    f.result.content = result.content as any; f.result.details = result.details; f.component.updateResult(f.result, false, true);
    const analyses = f.bashMetrics.failureAnalyses;
    if (profiler) { global.gc?.(); heapBefore = process.memoryUsage().heapUsed; profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 8192 }); }
    for (const width of [80, 100, 120, 80]) {
      const view = stripTerminalSequences(f.component.render(width).join("\n"));
      assert.match(view, /Shell: command_failed; exit=23/); assert.match(view, /Output: TypeError/); assert.doesNotMatch(view, /Command exited with code 0/);
    }
    if (profiler) {
      for (let n = 0; n < 20000; n++) f.component.render(n % 4 === 0 ? 80 : n % 4 === 1 ? 100 : 120);
      const { profile } = await profiler.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      while (nodes.length) { const node = nodes.pop()!; sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
    }
    assert.equal(f.bashMetrics.failureAnalyses, analyses);
    const facts = f.result.details.shellExecution as ShellExecutionFacts;
    facts.started = false; facts.executionStatus = "not_executed"; facts.sideEffects = "none"; facts.retryGuidance = "fresh_request";
    facts.termination = "not_started"; facts.exitCode = null;
    f.component.updateResult(f.result, false, true);
    const view = stripTerminalSequences(f.component.render(100).join("\n")); assert.match(view, /Shell: not_executed/); assert.doesNotMatch(view, /Took|Elapsed/);
  } finally {
    const released = f.dispose(); assert.ok(Object.values(released).every(value => value === 0)); clock.dispose();
    if (profiler) {
      profiler.disconnect(); global.gc?.();
      t.diagnostic(JSON.stringify({ benchmark: "shell-facts-real-result-render", node: process.version, renders: 20000, sampledBytes,
        sampledBytesPerRender: sampledBytes / 20000, heapBefore, heapAfterRelease: process.memoryUsage().heapUsed, repeatedFailureAnalyses: 0, released, pendingTimers: clock.pending }));
    }
  }
});
