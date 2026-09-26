import assert from "node:assert/strict";
import test from "node:test";
import { createLocalShellOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { shellProcessResultFromError } from "../packages/coding-agent/src/core/tools/shell-execution.ts";
import { Agent } from "../packages/agent/src/agent.ts";
import { ToolResultError } from "../packages/agent/src/tool-result-error.ts";
import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { waitForChildProcess, type ChildProcessObservation } from "../packages/coding-agent/src/utils/child-process.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

const operations = createLocalShellOperations("fixture", () => ({ shell: process.execPath, args: ["-e"] }));
for (const code of [0, 23]) test(`N3 local process observes actual start/exit/drain, exit=${code}`, async () => {
  let text = "";
  const result = await operations.exec(`process.stdout.write('中文');process.exitCode=${code}`, process.cwd(), { onData: data => { text += data; } });
  assert.equal(text, "中文"); assert.equal(result.exitCode, code); assert.equal(result.termination, "exit");
  assert.deepEqual(result.observation, { started: true, cwd: realpathSync.native(process.cwd()), spawnAttempted: true, exitCode: code, signal: null, outputDrained: true });
});

test("N3 native signal with null exit cannot become observed exit success", { skip: process.platform === "win32" }, async () => {
  const result = await operations.exec("process.kill(process.pid,'SIGTERM')", process.cwd(), { onData() {} });
  assert.equal(result.exitCode, null); assert.equal(result.termination, "signal"); assert.equal(result.observation?.signal, "SIGTERM");
});

for (const kind of ["timeout", "cancelled"]) test(`N3 ${kind} retains observed process facts in its thrown error`, async () => {
  const controller = new AbortController();
  const timer = kind === "cancelled" ? setTimeout(() => controller.abort(), 100) : undefined;
  try {
    await assert.rejects(operations.exec("setInterval(()=>{},1000)", process.cwd(), { onData() {}, signal: controller.signal, timeout: kind === "timeout" ? 0.1 : undefined }), (error: unknown) => {
      const result = shellProcessResultFromError(error); assert.ok(result); assert.equal(result.termination, kind);
      assert.equal(result.observation?.started, true); assert.equal(result.exitCode, result.observation?.exitCode); return true;
    });
  } finally { clearTimeout(timer); }
});

test("N3 nonexistent executable records no start and preserves OS launch error", async () => {
  const missing = createLocalShellOperations("missing", () => ({ shell: process.execPath + ".absent-fixture", args: [] }));
  await assert.rejects(missing.exec("", process.cwd(), { onData() {} }), (error: any) => {
    assert.equal(error.code, "ENOENT"); const result = shellProcessResultFromError(error);
    assert.equal(result?.termination, "not_started"); assert.equal(result?.observation?.started, false); return true;
  });
});

for (const earlyExit of [false, true]) test(`N3 real stdin transport settles errors/close with a slow reader or early exit, early=${earlyExit}`, async () => {
  const source = earlyExit ? "process.stdin.destroy();process.exit(0)" : "const c=require('crypto').createHash('sha256');process.stdin.on('data',b=>{c.update(b);process.stdin.pause();setTimeout(()=>process.stdin.resume(),1)});process.stdin.on('end',()=>process.stdout.write(c.digest('hex')))";
  const input = "中文 $() \\ literal\n".repeat(100000), expected = createHash("sha256").update(input).digest("hex");
  const stdin = createLocalShellOperations("stdin fixture", () => ({ shell: process.execPath, args: ["-e", source], commandTransport: "stdin" }));
  let output = "";
  const result = await stdin.exec(input, process.cwd(), { onData: data => { output += data; } });
  assert.equal(result.observation?.started, true); assert.equal(result.exitCode, 0);
  if (earlyExit) { assert.ok(result.inputError); assert.ok(result.inputError.length <= 1000); }
  else { assert.equal(result.inputError, undefined); assert.equal(output, expected); }
});

for (const real of [false, true]) test(`N3 inherited output pipe refreshes one idle timer and releases every wait listener, real=${real}`, { skip: real && process.platform === "win32" ? "Windows Node inherited socket reaches EOF when the parent exits; no later descendant pipe is observable in this fixture" : false }, async t => {
  const descendant = "let n=0;process.send('ready');const timer=setInterval(()=>{process.stdout.write('tail-'+n+'\\n');if(++n===12){clearInterval(timer);process.exit(0)}},25)";
  const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr,'ipc'],windowsHide:true});c.on('message',()=>{c.disconnect();c.unref();process.exit(0)})`;
  const child = real ? spawn(process.execPath, ["-e", parent], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    : Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), signalCode: null, exitCode: 0 }) as unknown as ReturnType<typeof spawn>;
  let text = "", allocations = 0, refreshes = 0;
  const onData = (data: Buffer) => { text += data; };
  child.stdout!.on("data", onData);
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout, timers = new Set<NodeJS.Timeout>();
  t.mock.method(globalThis, "setTimeout", function(callback: (...args: any[]) => void, delay?: number, ...args: any[]) {
    const timer = nativeSet(callback, delay, ...args);
    if (callback.name === "onIdle" && delay === 100) {
      allocations++; timers.add(timer); const refresh = timer.refresh;
      timer.refresh = function() { refreshes++; return refresh.call(this); };
    }
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", function(timer: any) { timers.delete(timer); return nativeClear(timer); });
  const observation: ChildProcessObservation = { started: false, exitCode: null, signal: null, outputDrained: false };
  t.after(() => { child.stdout!.removeListener("data", onData); if (real && child.exitCode === null && child.signalCode === null) child.kill(); });
  const pending = waitForChildProcess(child as ChildProcess, observation);
  if (!real) {
    child.emit("spawn"); child.emit("exit", 0, null);
    for (let n = 0; n < 12; n++) (child.stdout as PassThrough).write(`tail-${n}\n`);
    (child.stdout as PassThrough).end(); (child.stderr as PassThrough).end();
  }
  assert.equal(await pending, 0);
  assert.equal(observation.outputDrained, true); assert.equal(text, Array.from({ length: 12 }, (_, n) => `tail-${n}\n`).join(""));
  assert.equal(allocations, 1); assert.ok(refreshes >= 10); assert.equal(timers.size, 0);
  for (const event of ["error", "spawn", "exit", "close"]) assert.equal(child.listenerCount(event), 0, event);
  assert.equal(child.stdout!.listenerCount("data"), 1); assert.equal(child.stderr!.listenerCount("data"), 0);
  assert.equal(child.stdout!.listenerCount("end"), 0); assert.equal(child.stderr!.listenerCount("end"), 0);
  t.diagnostic(`idleTimerAllocations=${allocations}; refreshes=${refreshes}; pendingTimers=${timers.size}; waitListeners=0`);
});

for (const hookFailure of [false, true]) test(`N3 Agent retains producer result through thrown failure, observer failure=${hookFailure}`, async () => {
  const details = { shellExecution: { version: 1, started: true, exitCode: 23 }, marker: "producer facts" };
  const agent = new Agent({ convertToLlm: () => [], streamFn: () => { throw new Error("No provider in host fixture"); },
    afterToolCall: hookFailure ? () => { throw new Error("fixture observer failed"); } : undefined });
  agent.state.tools = [{ name: "fixture", label: "fixture", description: "fixture", parameters: Type.Object({}),
    async execute() { throw new ToolResultError("short runtime failure", { content: [{ type: "text", text: "captured tail" }], details }); } }];
  const result = await agent.dispatchHostTool({ type: "toolCall", name: "fixture", id: "observed", arguments: {} });
  assert.equal(result.isError, true); assert.deepEqual(result.details, details); assert.equal(result.content[0]?.type, "text");
  assert.equal((result.content[0] as any).text, "captured tail");
  if (hookFailure) assert.match(JSON.stringify(result.content), /TOOL_OBSERVATION_FAILED/);
  assert.equal(agent.state.pendingToolCalls.size, 0);
});
