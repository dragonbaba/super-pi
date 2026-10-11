import assert from "node:assert/strict";
import test from "node:test";
import { executeBashWithOperations } from "../packages/coding-agent/src/core/bash-executor.ts";
import type { BashOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { finished } from "node:stream/promises";
import { AnsiStreamFilter } from "../packages/coding-agent/src/utils/ansi.ts";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RELEASE_COMPONENT_RENDER_CACHE, type TUI } from "@super-pi/tui";

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
  const owner = {
    _bashAbortControllers: controllers,
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
        return { exitCode: 0 };
      } } });
    component?.setComplete(result.exitCode, result.cancelled);
    assert.equal(result.output, "diagnostic\n中文😀\nend"); assert.equal(controllers.size, 0); assert.deepEqual(history, [result]);
    const updates = events.map(event => JSON.parse(event));
    assert.equal(updates.map(event => event.delta).join(""), result.output);
    assert.ok(updates.every(event => event.type === "bash_execution_update" && event.id === "rpc-fixture" && event.delta));
    if (component) { assert.equal(component.getOutput(), result.output); assert.ok(component.render(80).join("\n").includes("中文😀")); }
  } finally { component?.setComplete(undefined, true); component?.[RELEASE_COMPONENT_RENDER_CACHE](); }
});
