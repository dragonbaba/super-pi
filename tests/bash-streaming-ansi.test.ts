import assert from "node:assert/strict";
import test from "node:test";
import { executeBashWithOperations } from "../packages/coding-agent/src/core/bash-executor.ts";
import type { BashOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { finished } from "node:stream/promises";
import { AnsiStreamFilter, stripAnsi } from "../packages/coding-agent/src/utils/ansi.ts";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RELEASE_COMPONENT_RENDER_CACHE, type TUI } from "@super-pi/tui";
import { sanitizeBinaryOutput } from "../packages/coding-agent/src/utils/shell.ts";
import { alphaSession } from "./helpers/alpha-session.ts";

test("interactive direct Bash renders adapter rejection as failed without inventing an exit code", async t => {
  const fixture = await alphaSession();
  t.mock.method(fixture.session, "executeBash", async () => { throw new Error("[SANDBOX_COLLECTION] limit exceeded; command exit=0"); });
  try {
    await fixture.internal.handleBashCommand("fixture");
    const rendered = fixture.internal.chatContainer.render(80).join("\n");
    assert.match(rendered, /\(failed\)/); assert.doesNotMatch(rendered, /\(exit 1\)/);
    assert.match(rendered, /SANDBOX_COLLECTION/);
    assert.equal(fixture.session.messages.some((message: any) => message.role === "bashExecution"), false);
  } finally { await fixture.release(); }
});

test("direct sandbox Bash uses the workspace adapter and releases authorization on success and failure", async () => {
  const boundary = new SessionExecutionBoundary(), controllers = new Set<AbortController>();
  const events: any[] = [], history: unknown[] = []; let authorized = 0, released = 0, executed = 0;
  let publicationFailure = false;
  const definition = { async execute() {
    executed++;
    return { isError: publicationFailure, content: [{ type: "text", text: "\x1b]0;hidden\x07\x1b[31m中文😀\x1b[0m\x00" }], details: { shellExecution: {
      version: 1, producer: "agent", started: true, executionStatus: "exited", sideEffects: "unknown", retryGuidance: "inspect_before_retry",
      cwd: process.cwd(), exitCode: 0, signal: null, termination: "exit", observationError: publicationFailure ? "publication failed" : undefined,
      output: { complete: true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" },
    } } };
  } };
  const owner: any = Object.create(AgentSession.prototype);
  Object.assign(owner, {
    _bashAbortControllers: controllers,
    _workspaceSandbox: { definition(name: string) { assert.equal(name, "bash"); return definition; } },
    _extensionRunner: { createContext() { return { cwd: process.cwd() }; } },
    _resourceLoader: { getExtensions() { return { runtime: { executionBoundary: boundary, nativePermissions: {
      async authorize(event: any, _ctx: any, selected: any, explicit: boolean) {
        authorized++; assert.equal(event.toolName, "bash"); assert.equal(selected, definition); assert.equal(explicit, true);
        return { consume(input: any, id: string, name: string, signal: AbortSignal) {
          assert.equal(input, event.input); assert.equal(id, event.toolCallId); assert.equal(name, "bash"); assert.equal(signal.aborted, false);
        }, release() { released++; } };
      },
    } } }; } },
    _emit(event: any) { events.push(event); }, recordBashResult(_command: string, result: unknown) { history.push(result); },
  });
  try {
    const result = await owner.executeBash("fixture", undefined, { id: "sandbox-direct" });
    assert.equal(result.output, "中文😀"); assert.equal(result.exitCode, 0); assert.equal(result.processCleanup, "complete");
    publicationFailure = true;
    await assert.rejects(owner.executeBash("fixture"), /中文😀/, "publication failure must use the direct command error path");
    await assert.rejects(owner.executeBash("fixture", undefined, { operations: {} }), /Custom host command operations/);
    publicationFailure = false;
    await assert.rejects(owner.executeBash("fixture", () => { throw new Error("observer failed"); }), /observer failed/);
    assert.equal(authorized, 3); assert.equal(released, 3); assert.equal(executed, 3); assert.equal(controllers.size, 0);
    assert.equal(history.length, 1); assert.equal(events[0].id, "sandbox-direct"); assert.equal(events[0].delta, "中文😀");
    initTheme("dark");
    const component = new BashExecutionComponent("fixture", { requestRender() {} } as TUI);
    component.setComplete(undefined, false, undefined, undefined, true);
    assert.match(component.render(80).join("\n"), /\(failed\)/);
    component[RELEASE_COMPONENT_RENDER_CACHE]();
  } finally { await boundary.dispose(); }
});

test("binary sanitizing preserves BMP and astral semantics without discarding valid surrogate pairs", () => {
  const input = Array.from({ length: 65536 }, (_, code) => String.fromCharCode(code)).join("") + "😀𐀀\ud800ok\udc00\t\r\n";
  let expected = "";
  for (const character of input) {
    const code = character.codePointAt(0)!;
    if ((code > 0x1f || code === 9 || code === 10 || code === 13) && !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0xfff9 && code <= 0xfffb)) expected += character;
  }
  assert.equal(sanitizeBinaryOutput(input), expected);
  assert.equal(sanitizeBinaryOutput("plain 中文😀"), "plain 中文😀");
});

async function capture(chunks: Buffer[], cancelled = false) {
  const controller = new AbortController();
  const updates: string[] = [];
  const operations: BashOperations = { async exec(_command, _cwd, { onData }) {
    for (const chunk of chunks) onData(chunk);
    if (cancelled) { controller.abort(); throw new Error("aborted"); }
    return { exitCode: 0 };
  } };
  const result = await executeBashWithOperations("fixture", process.cwd(), operations,
    { signal: controller.signal, onChunk: text => updates.push(text) });
  return { result, updates };
}

const cases = [
  ["CSI colors", "before\x1b[38;2;1;2;3m中文😀\x1b[0mafter", "before中文😀after"],
  ["OSC BEL", "a\x1b]0;window title\x07b", "ab"],
  ["OSC ST", "a\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\b", "alinkb"],
  ["C1 CSI", "a\u009b31mred\u009b0mb", "aredb"],
  ["C1 OSC/ST", "a\u009d0;title\u009cb", "ab"],
  ["ESC intermediate", "a\x1b(Bb\x1b#8c", "abc"],
  ["malformed and restarted", "a\x1b[12\n中文\x1b[2\x1b[31mx\x1b[0m", "a\n中文x"],
  ["cancelled CSI", "a\x1b[12\x18b\x1b[\x1ac", "abc"],
  ["OSC embedded ESC", "a\x1b]title\x1bx\x1b\x1b\\b", "ab"],
  ["unfinished CSI", "a\x1b[38;2;", "a"],
  ["unfinished OSC", "a\x1b]0;unfinished", "a"],
] as const;

test("stateless ANSI stripping preserves legacy output without quadratic OSC suffix scans", t => {
  const legacy = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
  const inputs = cases.map(entry => entry[1]);
  const alphabet = ["\x1b", "]", "[", ";", "1", "m", "中", "\x07", "\x9c", "\\", "\x9b", "x"];
  let seed = 12345;
  for (let i = 0; i < 1000; i++) {
    let value = "";
    for (let j = 0; j < 80; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += alphabet[seed % alphabet.length]; }
    inputs.push(value as typeof inputs[number]);
  }
  for (const input of inputs) assert.equal(stripAnsi(input), input.replace(legacy, ""));
  const input = "\x1b]".repeat(65536), original = String.prototype.charCodeAt;
  let reads = 0;
  const mock = t.mock.method(String.prototype, "charCodeAt", function(this: string, index: number) { reads++; return original.call(this, index); });
  try { assert.equal(stripAnsi(input), input); } finally { mock.mock.restore(); }
  assert.ok(reads <= input.length * 4 + 8);
  t.diagnostic(JSON.stringify({ compatibilityInputs: inputs.length, inputCodeUnits: input.length, characterReads: reads, maximumReadsPerCodeUnit: 4 }));
});
for (const [name, input, expected] of cases) test(`streamed bash ${name} is independent of every byte split`, async () => {
  const bytes = Buffer.from(input);
  for (let split = 0; split <= bytes.length; split++) {
    const { result, updates } = await capture([bytes.subarray(0, split), bytes.subarray(split)]);
    assert.equal(result.output, expected, `split=${split}`);
    assert.equal(updates.join(""), expected, `progress split=${split}`);
  }
  assert.equal((await capture([...bytes].map(byte => Buffer.from([byte])))).result.output, expected);
});

for (const cancelled of [false, true]) test(`streamed bash flushes incomplete UTF-8 and drops unfinished controls, cancel=${cancelled}`, async () => {
  const { result, updates } = await capture([Buffer.from("ok😀"), Buffer.from([0xe4, 0xb8])], cancelled);
  assert.equal(result.output, "ok😀�"); assert.equal(updates.join(""), result.output);
  assert.equal(result.cancelled, cancelled);
  assert.equal((await capture([Buffer.from("ok\x1b]unfinished")], cancelled)).result.output, "ok");
});

test("parser state is constant for huge unfinished controls and independent across instances", () => {
  for (const intro of ["\x1b]", "\x1b["]) {
    const parser = new AnsiStreamFilter(), other = new AnsiStreamFilter();
    assert.equal(parser.write(`start${intro}`), "start");
    const payload = (intro === "\x1b]" ? "secret😀" : "1;").repeat(8192);
    for (let index = 0; index < 128; index++) {
      assert.equal(parser.write(payload), "");
      assert.equal(other.write("plain"), "plain");
      assert.equal(Object.values(parser).length, 1);
      assert.equal(typeof Object.values(parser)[0], "number");
    }
    assert.equal(parser.write(intro === "\x1b]" ? "\x07end" : "mend"), "end");
    parser.write(intro); parser.reset(); assert.equal(parser.write("fresh"), "fresh");
  }
});

test("mixed text and controls survive deterministic random byte partitions", async () => {
  const input = Buffer.from(cases.map(entry => entry[1] + "\x1b\\\n").join(""));
  const expected = (await capture([input])).result.output;
  let random = 42;
  for (let trial = 0; trial < 100; trial++) {
    const chunks: Buffer[] = [];
    for (let at = 0; at < input.length;) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const end = Math.min(input.length, at + 1 + random % 17);
      chunks.push(input.subarray(at, end)); at = end;
    }
    const { result, updates } = await capture(chunks);
    assert.equal(result.output, expected); assert.equal(updates.join(""), expected);
    assert.ok(updates.every(text => text.length > 0));
  }
});

test("control-only chunks produce no progress or log, including huge unterminated OSC", async () => {
  const chunk = Buffer.from("hidden".repeat(10000));
  const { result, updates } = await capture([Buffer.from("\x1b]"), ...Array(128).fill(chunk)]);
  assert.equal(result.output, ""); assert.equal(result.fullOutputPath, undefined); assert.deepEqual(updates, []);
});

test("large visible output retains the same tail regardless of oversized chunk boundaries", async t => {
  const create = fs.createWriteStream, streams: fs.WriteStream[] = [];
  t.mock.method(fs, "createWriteStream", function(...args: Parameters<typeof create>) {
    const stream = create(...args); streams.push(stream); return stream;
  });
  syncBuiltinESMExports();
  const bytes = Buffer.from("中文😀".repeat(40000) + "\x1b[31mend\x1b[0m");
  try {
    const whole = (await capture([bytes])).result;
    for (const split of [1, 51001, bytes.length - 16, bytes.length - 4]) {
      const result = (await capture([bytes.subarray(0, split), bytes.subarray(split)])).result;
      assert.equal(result.output, whole.output, `split=${split}`);
      assert.equal(result.truncated, true);
    }
    for (const stream of streams) {
      await finished(stream, { cleanup: true });
      assert.equal(fs.readFileSync(stream.path, "utf8"), "中文😀".repeat(40000) + "end");
    }
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const stream of streams) { if (!stream.closed) await finished(stream, { cleanup: true }); fs.rmSync(stream.path, { force: true }); }
  }
});

for (const outcome of ["success", "cancel", "error"] as const) test(`split ANSI log is clean and its lifecycle is preserved: ${outcome}`, async t => {
  const create = fs.createWriteStream, streams: fs.WriteStream[] = [];
  t.mock.method(fs, "createWriteStream", function(...args: Parameters<typeof create>) {
    const stream = create(...args); streams.push(stream); return stream;
  });
  syncBuiltinESMExports();
  const text = "中文 visible\n".repeat(5000), controller = new AbortController();
  const chunks = [Buffer.from("\x1b[3"), Buffer.from(`1m${text}\x1b]hidden`), Buffer.from("\x1b"), Buffer.from("\\tail")];
  let late: ((data: Buffer) => void) | undefined, progress = "";
  try {
    const pending = executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
      late = onData;
      for (let index = 0; index < chunks.length; index++) {
        onData(chunks[index], "stdout");
        if (index === 1) onData(Buffer.from("ERROR\n"), "stderr");
      }
      if (outcome === "cancel") { controller.abort(); throw new Error("aborted"); }
      if (outcome === "error") throw new Error("producer failed");
      return { exitCode: 0 };
    } }, { signal: controller.signal, onChunk: chunk => { progress += chunk; } });
    if (outcome === "error") await assert.rejects(pending, /producer failed/);
    else {
      const result = await pending;
      assert.equal(result.cancelled, outcome === "cancel"); assert.equal(result.truncated, true);
      assert.equal(result.fullOutputPath, streams[0].path);
      await finished(streams[0], { cleanup: true });
      assert.equal(fs.readFileSync(result.fullOutputPath!, "utf8"), text + "ERROR\ntail");
      assert.ok(result.output.endsWith("tail"));
    }
    assert.equal(progress, text + "ERROR\ntail");
    late!(Buffer.from("late")); assert.equal(progress, text + "ERROR\ntail");
    assert.equal(streams.length, 1); assert.equal(streams[0].closed, true);
    if (outcome === "error") assert.equal(fs.existsSync(streams[0].path), false);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const stream of streams) { if (!stream.closed) await finished(stream, { cleanup: true }); fs.rmSync(stream.path, { force: true }); }
  }
});

for (const cancelled of [false, true]) test(`UTF-8 flush observer failure still rejects, cancel=${cancelled}`, async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    calls++; onData(Buffer.from([0xe4]));
    if (cancelled) { controller.abort(); throw new Error("aborted"); }
    return { exitCode: 0 };
  } }, { signal: controller.signal, onChunk() { throw new Error("flush observer failed"); } }), /flush observer failed/);
  assert.equal(calls, 1);
});

for (const interactive of [false, true]) test(`AgentSession delivers clean output to ${interactive ? "interactive component" : "RPC event consumer"}`, async () => {
  initTheme("dark");
  const component = interactive ? new BashExecutionComponent("fixture", { requestRender() {} } as TUI) : undefined;
  const events: string[] = [], history: unknown[] = [], controllers = new Set<AbortController>();
  const boundary = new SessionExecutionBoundary();
  const owner = {
    _bashAbortControllers: controllers,
    _unconfirmedBashOwners: new Map(),
    _resourceLoader: { getExtensions: () => ({ runtime: { executionBoundary: boundary } }) },
    settingsManager: { getShellCommandPrefix() {}, getShellPath() {} },
    sessionManager: { getCwd: () => process.cwd() },
    _emit(event: unknown) { events.push(JSON.stringify(event)); },
    recordBashResult(_command: string, result: unknown) { history.push(result); },
  } as unknown as AgentSession;
  try {
    const result = await AgentSession.prototype.executeBash.call(owner, "fixture", component ? text => component.appendOutput(text) : undefined,
      { id: "rpc-fixture", operations: { async exec(_command, _cwd, { onData }) {
        onData(Buffer.from("\x1b]0;hidden"), "stdout");
        onData(Buffer.from("diagnostic\n"), "stderr");
        onData(Buffer.from("\x07"), "stdout");
        for (const byte of Buffer.from("\x1b[31m中文😀\x1b[0m\x1b]0;title\x07\nend")) onData(Buffer.from([byte]), "stdout");
        return { exitCode: 0, processCleanup: "complete" };
      } } });
    component?.setComplete(result.exitCode, result.cancelled);
    assert.equal(result.output, "diagnostic\n中文😀\nend"); assert.equal(controllers.size, 0); assert.deepEqual(history, [result]);
    const updates = events.map(event => JSON.parse(event));
    assert.equal(updates.map(event => event.delta).join(""), result.output);
    assert.ok(updates.every(event => event.type === "bash_execution_update" && event.id === "rpc-fixture" && event.delta));
    if (component) { assert.equal(component.getOutput(), result.output); assert.ok(component.render(80).join("\n").includes("中文😀")); }
  } finally { component?.setComplete(undefined, true); component?.[RELEASE_COMPONENT_RENDER_CACHE](); }
});
