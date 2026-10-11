import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { executeBashWithOperations } from "../packages/coding-agent/src/core/bash-executor.ts";
import { createLocalShellOperations } from "../packages/coding-agent/src/core/tools/bash.ts";

for (const source of ["stdout", "stderr"] as const) {
  for (const control of ["OSC", "CSI"] as const) {
    test(`${source} split ${control} cannot consume the other stream`, async () => {
      const other = source === "stdout" ? "stderr" : "stdout";
      const updates: string[] = [];
      const result = await executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
        onData(Buffer.from(control === "OSC" ? "\x1b]0;private" : "\x1b[3"), source);
        onData(Buffer.from("ERROR: diagnostic\n"), other);
        onData(Buffer.from(control === "OSC" ? "\x1b" : "1"), source);
        onData(Buffer.from("second diagnostic\n"), other);
        onData(Buffer.from(control === "OSC" ? "\\visible" : "mvisible"), source);
        return { exitCode: 0 };
      } }, { onChunk: text => updates.push(text) });
      assert.equal(result.output, "ERROR: diagnostic\nsecond diagnostic\nvisible");
      assert.equal(updates.join(""), result.output);
    });
  }
}

for (const outcome of ["success", "cancel", "error"] as const) test(`independent incomplete controls/UTF-8 and late callbacks: ${outcome}`, async () => {
  const controller = new AbortController(), updates: string[] = [];
  let late: ((data: Buffer, source?: "stdout" | "stderr") => void) | undefined;
  const pending = executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    late = onData;
    onData(Buffer.from([0xe4]), "stdout"); // First byte of 中.
    onData(Buffer.from([0xf0, 0x9f]), "stderr"); // First half of 😀.
    onData(Buffer.from([0xb8, 0xad]), "stdout");
    onData(Buffer.from([0x98, 0x80]), "stderr");
    onData(Buffer.from("\x1b]unfinished"), "stdout");
    onData(Buffer.from("ERROR"), "stderr");
    onData(Buffer.from([0xe4, 0xb8]), "stderr");
    if (outcome === "cancel") { controller.abort(); throw new Error("aborted"); }
    if (outcome === "error") throw new Error("producer failed");
    return { exitCode: 0 };
  } }, { signal: controller.signal, onChunk: text => updates.push(text) });
  if (outcome === "error") await assert.rejects(pending, /producer failed/);
  else {
    const result = await pending;
    assert.equal(result.output, "中😀ERROR�"); assert.equal(result.cancelled, outcome === "cancel");
  }
  assert.equal(updates.join(""), outcome === "error" ? "中😀ERROR" : "中😀ERROR�");
  const count = updates.length;
  for (const source of [undefined, "stdout", "stderr"] as const) late!(Buffer.from("late"), source);
  assert.equal(updates.length, count);
});

test("unlabelled custom output remains one backwards-compatible stream", async () => {
  const result = await executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    onData(Buffer.from("\x1b[3")); onData(Buffer.from("1mplain\x1b[0m")); return { exitCode: 0 };
  } });
  assert.equal(result.output, "plain");
});

test("local pipe fanout preserves source identity, ordering and listener cleanup", async t => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null });
  let delivered = false;
  // Trigger only after both local source callbacks and wait listeners exist.
  child.on("newListener", event => {
    if (event === "close" && !delivered) {
      delivered = true;
      setImmediate(() => {
        child.emit("spawn");
        stdout.write("\x1b]0;hidden"); stderr.write("diagnostic\n"); stdout.write("\x1b");
        stderr.write("\x1b[3"); stdout.write("\\out\n"); stderr.write("1merr\x1b[0m\n");
        stdout.end(); stderr.end();
        setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); });
      });
    }
  });
  t.mock.method(childProcess, "spawn", () => child as unknown as ChildProcess); syncBuiltinESMExports();
  const operations = createLocalShellOperations("fixture", () => ({ shell: process.execPath, args: [] }));
  try {
    const result = await executeBashWithOperations("fixture", process.cwd(), operations);
    assert.equal(result.output, "diagnostic\nout\nerr\n");
    assert.equal(stdout.listenerCount("data"), 0); assert.equal(stderr.listenerCount("data"), 0);
    for (const event of ["spawn", "exit", "close", "error"]) assert.equal(child.listenerCount(event), 0, event);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); stdout.destroy(); stderr.destroy(); }
});

test("real local process emits both tagged byte streams and accepts a legacy observer", async () => {
  const operations = createLocalShellOperations("node fixture", () => ({ shell: process.execPath, args: ["-e"] }));
  let stdout = "", stderr = ""; const sources: Array<string | undefined> = [];
  const result = await operations.exec("process.stdout.write('out中');process.stderr.write('err😀')", process.cwd(), {
    onData(data, source) { sources.push(source); if (source === "stdout") stdout += data; else stderr += data; },
  });
  assert.ok(sources.every(source => source === "stdout" || source === "stderr"));
  assert.equal(result.exitCode, 0); assert.equal(stdout, "out中"); assert.equal(stderr, "err😀");
  let legacy = "";
  await operations.exec("process.stdout.write('out');process.stderr.write('err')", process.cwd(), { onData(data) { legacy += data; } });
  assert.ok(legacy.includes("out") && legacy.includes("err"));
});
