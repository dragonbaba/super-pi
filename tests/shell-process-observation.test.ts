import assert from "node:assert/strict";
import test from "node:test";
import { createBashTool, createLocalShellOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { observedShellError, readShellExecution, shellProcessResultFromError } from "../packages/coding-agent/src/core/tools/shell-execution.ts";
import { executeBashWithOperations } from "../packages/coding-agent/src/core/bash-executor.ts";
import { Agent } from "../packages/agent/src/agent.ts";
import { ToolResultError, toolResultFromError } from "../packages/agent/src/tool-result-error.ts";
import { Type } from "typebox";
import fs, { realpathSync, existsSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import childProcess, { spawn } from "node:child_process";
import { setImmediate as tick } from "node:timers/promises";
import { waitForChildProcess, type ChildProcessObservation } from "../packages/coding-agent/src/utils/child-process.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

const operations = createLocalShellOperations("fixture", () => ({ shell: process.execPath, args: ["-e"] }));

for (const killExit of [0, 1, "spawn-error"] as const) test(`Windows cancellation awaits its tree killer after the shell exits: ${killExit}`, { skip: process.platform !== "win32" }, async t => {
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), signalCode: null });
  const killer = Object.assign(new EventEmitter(), { stdout: null, stderr: null, signalCode: null });
  const controller = new AbortController(); let kills = 0, settled = false, ready!: () => void;
  const spawned = new Promise<void>(resolve => { ready = resolve; });
  t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    if (command === "taskkill") { kills++; assert.deepEqual(args, ["/F", "/T", "/PID", "123"]); return killer; }
    assert.equal(command, process.execPath);
    setImmediate(() => { child.emit("spawn"); ready(); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const execution = operations.exec("fixture", process.cwd(), { onData() {}, signal: controller.signal });
  const checked = assert.rejects(execution, (error: unknown) => {
    settled = true;
    const result = shellProcessResultFromError(error); assert.equal(result?.termination, "cancelled");
    if (killExit === 0) assert.equal(result?.observationError, undefined);
    else assert.match(result?.observationError ?? "", /Process-tree cleanup failed/);
    return true;
  });
  await spawned; controller.abort();
  child.stdout.end(); child.stderr.end(); child.emit("exit", 1, null); child.emit("close", 1);
  await tick();
  try { assert.equal(settled, false, "shell exit must not release the task before tree cleanup finishes"); }
  finally {
    if (killExit === "spawn-error") killer.emit("error", new Error("fixture spawn failure"));
    else { killer.emit("exit", killExit, null); killer.emit("close", killExit); }
    await checked;
  }
  assert.equal(kills, 1);
  for (const process of [child, killer]) for (const event of ["error", "spawn", "exit", "close"]) assert.equal(process.listenerCount(event), 0);
});

for (const termination of ["exit", "signal", "not_started"] as const) test(`N3 direct and Session reject ${termination} contradictions without observation`, async () => {
  const backend = { async exec() { return { exitCode: termination === "exit" ? null : 0, termination }; } };
  const check = (error: unknown) => { const result = shellProcessResultFromError(error); assert.equal(result?.exitCode, null);
    assert.equal(result?.termination, "unknown"); assert.ok(result?.observationError); return true; };
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), backend), check);
  const { alphaHeadless, alphaModelRuntime } = await import("./helpers/alpha-session.ts"); const f = await alphaHeadless(alphaModelRuntime());
  try {
    await assert.rejects(f.session.executeBash("fixture", undefined, { operations: backend }), check);
    assert.equal(f.session.isBashRunning, false); assert.equal(f.session.messages.some(message => message.role === "bashExecution"), false);
  } finally { await f.release(); }
});

for (const field of ["inputError", "observationError", "outputDrained", "termination"] as const) test(`N3 concurrent abort cannot erase direct or Session ${field}`, async () => {
  const controller = new AbortController(); let abort = () => controller.abort();
  const backend = { async exec() {
    abort(); return { exitCode: 0, termination: field === "termination" ? "unknown" as const : "exit" as const,
      inputError: field === "inputError" ? "input incomplete" : undefined,
      observationError: field === "observationError" ? "observation incomplete" : undefined,
      observation: { started: true, exitCode: 0, signal: null, outputDrained: field !== "outputDrained" } };
  } };
  const check = (error: any) => { const result = shellProcessResultFromError(error); assert.ok(result); assert.equal(result.exitCode, 0);
    if (field === "inputError" || field === "observationError") assert.equal(result[field], field === "inputError" ? "input incomplete" : "observation incomplete");
    else if (field === "outputDrained") assert.equal(result.observation?.outputDrained, false);
    else assert.equal(result.termination, "unknown"); return true; };
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), backend, { signal: controller.signal }), check);
  const { alphaHeadless, alphaModelRuntime } = await import("./helpers/alpha-session.ts"); const f = await alphaHeadless(alphaModelRuntime());
  abort = () => f.session.abortBash();
  try { await assert.rejects(f.session.executeBash("fixture", undefined, { operations: backend }), check);
    assert.equal(f.session.isBashRunning, false); assert.equal(f.session.messages.some(message => message.role === "bashExecution"), false);
  } finally { await f.release(); }
});

for (const cancelled of [false, true]) test(`N3 merge regression: empty input error survives direct and Session execution, cancelled=${cancelled}`, async () => {
  const controller = new AbortController(); let abort = () => controller.abort();
  const backend = { async exec() { if (cancelled) abort(); return { exitCode: 0, termination: "exit" as const, inputError: "" }; } };
  const check = (error: unknown) => { const facts = shellProcessResultFromError(error); assert.equal(facts?.inputError, ""); assert.equal(facts?.exitCode, 0); return true; };
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), backend, { signal: controller.signal }), check);
  const { alphaHeadless, alphaModelRuntime } = await import("./helpers/alpha-session.ts"); const f = await alphaHeadless(alphaModelRuntime());
  abort = () => f.session.abortBash();
  try {
    await assert.rejects(f.session.executeBash("fixture", undefined, { operations: backend }), check);
    assert.equal(f.session.isBashRunning, false); assert.equal(f.session.messages.some(message => message.role === "bashExecution"), false);
  } finally { await f.release(); }
});

for (const field of ["inputError", "observationError"] as const) test(`N3 direct and Session custom ${field} retains bounded diagnostics`, async () => {
  const original = { exitCode: 0, termination: "exit" as const, [field]: "诊断".repeat(1_000_000) }, backend = { async exec() { return original; } };
  const check = (error: any) => {
    assert.ok(error.message.length < 1200); const result = shellProcessResultFromError(error); assert.ok(result);
    assert.equal(result[field]?.length, 1000); assert.equal(result.exitCode, 0); assert.notEqual(result, original); return true;
  };
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), backend), check);
  const { alphaHeadless, alphaModelRuntime } = await import("./helpers/alpha-session.ts");
  const f = await alphaHeadless(alphaModelRuntime());
  try {
    await assert.rejects(f.session.executeBash("fixture", undefined, { operations: backend }), check);
    assert.equal(f.session.isBashRunning, false); assert.equal(f.session.messages.some(message => message.role === "bashExecution"), false);
    assert.equal(original[field], "诊断".repeat(1_000_000));
  } finally { await f.release(); }
});

test("N3 direct custom completion cannot contradict its observed exit", async () => {
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), { async exec() {
    return { exitCode: 0, termination: "exit", observation: { started: true, outputDrained: true, exitCode: 23, signal: null } };
  } }), (error: any) => { const result = shellProcessResultFromError(error); assert.equal(result?.exitCode, null); assert.equal(result?.termination, "unknown"); return true; });
});

for (const reason of ["input", "observation", "termination"]) for (const cleanupFailure of [false, true]) test(`N3 direct rejected completion closes its exact spill: ${reason}, cleanupFailure=${cleanupFailure}`, async t => {
  const create = fs.createWriteStream, streams: fs.WriteStream[] = [];
  t.mock.method(fs, "createWriteStream", function(...args: any[]) {
    const stream = Reflect.apply(create, fs, args); streams.push(stream); return stream;
  });
  const unlink = fsPromises.unlink;
  if (cleanupFailure) t.mock.method(fsPromises, "unlink", async function(path: any) {
    if (streams.some(stream => stream.path === path)) throw Object.assign(new Error("owned unlink denied"), { code: "EACCES" });
    return unlink(path);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); for (const stream of streams) if (existsSync(stream.path)) rmSync(stream.path); });
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, options) {
    options.onData(Buffer.from("real-spill\n".repeat(20000)));
    return { exitCode: 0, inputError: reason === "input" ? "incomplete stdin" : undefined,
      observationError: reason === "observation" ? "incomplete observation" : undefined, termination: reason === "termination" ? "unknown" : "exit" };
  } }), (error: any) => {
    assert.equal(shellProcessResultFromError(error)?.exitCode, 0);
    if (cleanupFailure) { assert.equal(error.fullOutputPath, streams[0].path); assert.ok(error.message.includes(String(streams[0].path))); assert.ok(error.cause); }
    return true;
  });
  assert.equal(streams.length, 1); assert.equal(streams[0].closed, true); assert.equal(existsSync(streams[0].path), cleanupFailure);
  if (cleanupFailure) assert.equal(fs.readFileSync(streams[0].path, "utf8"), "real-spill\n".repeat(20000));
});

test("N3 a typed progress observer failure cannot replace a completed producer result", async () => {
  const details = { shellExecution: { version: 1, started: true, exitCode: 0 }, marker: "completed producer" };
  let completed = false, updates = 0;
  const agent = new Agent({ convertToLlm: () => [], streamFn: () => { throw new Error("offline"); } });
  agent.state.tools = [{ name: "fixture", label: "fixture", description: "fixture", parameters: Type.Object({}),
    async execute(_id, _args, _signal, update) { update?.({ content: [{ type: "text", text: "progress" }], details: {} }); completed = true; return { content: [{ type: "text", text: "real completed output" }], details }; } }];
  const unsubscribe = agent.subscribe(async event => {
    if (event.type !== "tool_execution_update") return;
    updates++; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(completed, true);
    throw new ToolResultError("typed observer failure", { content: [{ type: "text", text: "forged replacement" }], details: { marker: "forged" } });
  });
  try {
    const result = await agent.dispatchHostTool({ type: "toolCall", name: "fixture", id: "completed", arguments: {} });
    assert.equal(updates, 1); assert.equal(result.isError, true); assert.equal(result.details.marker, "completed producer");
    assert.equal(result.details.shellExecution.exitCode, 0); assert.equal(result.details.shellExecution.observationError, "typed observer failure");
    assert.equal((result.content[0] as any).text, "real completed output"); assert.ok(!JSON.stringify(result).includes("forged replacement"));
    assert.equal(agent.state.pendingToolCalls.size, 0);
  } finally { unsubscribe(); agent.abort(); }
});
test("N3 frozen/sealed failure reasons preserve the cause and actual process observation", async () => {
  for (const freeze of [Object.freeze, Object.seal]) {
    const original = freeze(new Error("immutable beforeSpawn reason"));
    await assert.rejects(operations.exec("process.exit(0)", process.cwd(), { onData() {}, beforeSpawn() { throw original; } }), (error: any) => {
      assert.equal(error.message, original.message); assert.equal(error.cause, original);
      assert.equal(shellProcessResultFromError(error)?.observation?.started, false);
      assert.equal(shellProcessResultFromError(error)?.termination, "not_started"); return true;
    });
  }
  const original = new Error("existing immutable observation");
  Object.defineProperty(original, Symbol.for("pi.shell-process-result.v1"), { value: { exitCode: 9 } });
  const wrapped = observedShellError(original, { exitCode: 23 });
  assert.equal(wrapped.cause, original); assert.equal(shellProcessResultFromError(wrapped)?.exitCode, 23);
  const controller = new AbortController(), reason = Object.freeze(new Error("frozen abort during preflight"));
  const aborted = createLocalShellOperations("frozen abort", () => { controller.abort(reason); return { shell: process.execPath, args: ["-e"] }; });
  await assert.rejects(aborted.exec("process.exit(0)", process.cwd(), { onData() {}, signal: controller.signal }), (error: any) => {
    assert.equal(error.cause, reason); assert.equal(error.message, reason.message);
    assert.equal(shellProcessResultFromError(error)?.observation?.spawnAttempted, undefined);
    assert.equal(shellProcessResultFromError(error)?.termination, "cancelled"); return true;
  });
});

test("N3 direct executor and actual Session reject incomplete stdin despite real zero exit", async () => {
  const input = "中文 $() literal\n".repeat(100000);
  const stdin = createLocalShellOperations("direct stdin", () => ({ shell: process.execPath, args: ["-e", "process.stdin.destroy();process.exit(0)"], commandTransport: "stdin" }));
  const check = (error: unknown) => {
    const result = shellProcessResultFromError(error); assert.equal(result?.exitCode, 0);
    assert.equal(result?.observation?.started, true); assert.ok(result?.inputError);
    assert.match((error as Error).message, /SHELL_INPUT_FAILED/); return true;
  };
  await assert.rejects(executeBashWithOperations(input, process.cwd(), stdin), check);
  const { alphaHeadless, alphaModelRuntime } = await import("./helpers/alpha-session.ts");
  const f = await alphaHeadless(alphaModelRuntime());
  try {
    await assert.rejects(f.session.executeBash(input, undefined, { operations: stdin }), check);
    assert.equal(f.session.isBashRunning, false);
    assert.equal(f.session.messages.some(message => message.role === "bashExecution"), false);
    const clean = await f.session.executeBash("process.stdout.write('complete');process.exitCode=23", undefined, { operations });
    assert.equal(clean.exitCode, 23); assert.equal(clean.output, "complete");
    assert.equal(f.session.messages.filter(message => message.role === "bashExecution").length, 1);
  } finally { await f.release(); }
});
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

for (const reason of ["timeout", "cancelled"]) test(`N3 ${reason} stops active descendant output after the actual parent exits`, { skip: process.platform === "win32" ? "Windows inherited socket closes at parent exit in this fixture" : false, timeout: 10000 }, async () => {
  const controller = new AbortController(); let text = "";
  const descendant = "process.stdout.write(JSON.stringify({ownedPid:process.pid})+'\\n');process.send('ready');let n=0;setInterval(()=>process.stdout.write('tail-'+n+++'\\n'),25);setTimeout(()=>process.exit(0),4000)";
  const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr,'ipc']});c.on('message',()=>{c.disconnect();c.unref();process.exit(0)})`;
  const start = performance.now();
  await assert.rejects(operations.exec(parent, process.cwd(), { signal: controller.signal, timeout: reason === "timeout" ? 1 : undefined,
    onData(data) { text += data; if (reason === "cancelled" && text.includes("tail-8\n")) controller.abort(); } }), (error: unknown) => {
    const result = shellProcessResultFromError(error); assert.equal(result?.termination, reason);
    assert.equal(result?.exitCode, 0, "the parent exited normally before its descendant was stopped");
    assert.equal(result?.observation?.outputDrained, false); return true;
  });
  assert.ok(performance.now() - start < 3000); assert.ok(text.includes("tail-"));
  const pid = JSON.parse(text.slice(0, text.indexOf("\n"))).ownedPid; assert.ok(Number.isSafeInteger(pid));
  // A reparented killed process may briefly remain a zombie until init reaps it.
  let running = true;
  for (let attempt = 0; attempt < 100 && running; attempt++) {
    try { running = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") running = false; else throw error; }
    if (running) await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  assert.equal(running, false, "recorded descendant no longer executes");
});

test("N3 spill failure stops active inherited output after the parent exited", { skip: process.platform === "win32" ? "Windows inherited socket closes at parent exit in this fixture" : false, timeout: 10000 }, async t => {
  const create = fs.createWriteStream, streams: fs.WriteStream[] = []; let text = "";
  t.mock.method(fs, "createWriteStream", function(...args: any[]) {
    const stream = Reflect.apply(create, fs, args); streams.push(stream);
    setImmediate(() => stream.destroy(new Error("descendant spill failure"))); return stream;
  });
  syncBuiltinESMExports();
  const descendant = "process.stdout.write(JSON.stringify({ownedPid:process.pid})+'\\n');process.send('ready');let large=false;setInterval(()=>process.stdout.write(large?'x'.repeat(65536):'tail\\n'),25);setTimeout(()=>{large=true},250);setTimeout(()=>process.exit(0),4000)";
  const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr,'ipc']});c.on('message',()=>{c.disconnect();c.unref();process.exit(0)})`;
  const tool = createBashTool(process.cwd(), { operations, exposeSessionEnvironment: false }), start = performance.now();
  const update = (result: any) => { if (!text && result.content[0]?.type === "text") text = result.content[0].text; };
  const onUpdate = Object.assign(update, { awaited: async (result: any) => { update(result); } });
  try {
    await assert.rejects(tool.execute("descendant-spill", { command: parent }, undefined, onUpdate), (error: any) => {
      const facts = readShellExecution(toolResultFromError(error)?.details); assert.equal(facts?.termination, "output_failure", error.message);
      assert.equal(facts?.exitCode, 0); assert.equal(facts?.output.complete, false); return true;
    });
    assert.ok(performance.now() - start < 3000); assert.ok(streams.length > 0);
    for (const stream of streams) { assert.equal(stream.closed, true); assert.equal(existsSync(stream.path), false); }
    const pid = JSON.parse(text.slice(0, text.indexOf("\n"))).ownedPid; assert.ok(Number.isSafeInteger(pid));
    let running = true;
    for (let attempt = 0; attempt < 100 && running; attempt++) {
      try { running = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") running = false; else throw error; }
      if (running) await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    assert.equal(running, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
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
  const originalStdoutEnd = child.stdout!.listeners("end"), originalStderrEnd = child.stderr!.listeners("end");
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
  // Real Node pipe sockets own an internal end listener. Check that the wait
  // releases its own listeners without requiring Node's listener to disappear.
  for (const listener of child.stdout!.listeners("end")) assert.ok(originalStdoutEnd.includes(listener));
  for (const listener of child.stderr!.listeners("end")) assert.ok(originalStderrEnd.includes(listener));
  t.diagnostic(`idleTimerAllocations=${allocations}; refreshes=${refreshes}; pendingTimers=${timers.size}; waitListeners=0`);
});

for (const hookFailure of [false, true]) test(`N3 Agent retains producer result through thrown failure, observer failure=${hookFailure}`, async () => {
  const details = { shellExecution: { version: 1, started: true, exitCode: 23 }, marker: "producer facts" };
  const agent = new Agent({ convertToLlm: () => [], streamFn: () => { throw new Error("No provider in host fixture"); },
    afterToolCall: hookFailure ? () => { throw new Error("fixture observer failed"); } : undefined });
  agent.state.tools = [{ name: "fixture", label: "fixture", description: "fixture", parameters: Type.Object({}),
    async execute() { throw new ToolResultError("short runtime failure", { content: [{ type: "text", text: "captured tail" }], details }); } }];
  const result = await agent.dispatchHostTool({ type: "toolCall", name: "fixture", id: "observed", arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, hookFailure ? { ...details, shellExecution: { ...details.shellExecution, observationError: "fixture observer failed",
    secondaryObservationError: undefined, observationErrorsOmitted: undefined } } : details);
  assert.equal((details.shellExecution as any).observationError, undefined, "producer details are not mutated");
  assert.equal(result.content[0]?.type, "text");
  assert.equal((result.content[0] as any).text, "captured tail");
  if (hookFailure) assert.match(JSON.stringify(result.content), /TOOL_OBSERVATION_FAILED/);
  assert.equal(agent.state.pendingToolCalls.size, 0);
});
