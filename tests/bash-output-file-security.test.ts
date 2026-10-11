import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setImmediate as tick } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { executeBashWithOperations } from "../packages/coding-agent/src/core/bash-executor.ts";
import { createLocalShellOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { observedShellError, shellProcessResultFromError } from "../packages/coding-agent/src/core/tools/shell-execution.ts";

const payload = Buffer.from("private output 中文\n".repeat(5000));

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-output-security-"));
  const path = join(directory, "output.log");
  const create = fs.createWriteStream, streams: fs.WriteStream[] = [];
  const calls: { path: fs.PathLike; options: any }[] = [];
  let configure = (options: any): any => options;
  t.mock.method(fs, "createWriteStream", (candidate: fs.PathLike, options: any) => {
    calls.push({ path: candidate, options });
    // Redirect only this command's new stream into an exactly owned test directory.
    const stream = create(path, configure(options));
    streams.push(stream);
    return stream;
  });
  // Production cleanup uses the generated name, not the redirected stream path.
  const unlink = fsPromises.unlink;
  t.mock.method(fsPromises, "unlink", async (candidate: any) => {
    assert.ok(calls.some(call => call.path === candidate));
    return unlink(path);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const stream of streams) {
      stream.destroy();
      try { await finished(stream, { cleanup: true }); } catch {}
      if (!stream.closed) await new Promise<void>(resolve => stream.once("close", resolve));
    }
    fs.rmSync(directory, { recursive: true });
  });
  return { path, streams, calls, configure(fn: typeof configure) { configure = fn; } };
}

for (const cancelled of [false, true]) test(`bash output requests exclusive creation with POSIX mode 0600 and transfers a closed log, cancel=${cancelled}`, async t => {
  const f = fixture(t), controller = new AbortController();
  const result = await executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    onData(payload); onData(Buffer.from("last line\n"), "stderr");
    if (cancelled) { controller.abort(); throw new Error("cancelled"); }
    return { exitCode: 0 };
  } }, { signal: controller.signal });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options?.flags, "wx");
  assert.equal(f.calls[0].options?.mode, 0o600);
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.streams[0].writableFinished, true);
  assert.equal(result.fullOutputPath, f.calls[0].path);
  assert.equal(result.cancelled, cancelled);
  assert.equal(fs.readFileSync(f.path, "utf8"), payload.toString() + "last line\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  for (const event of ["open", "error", "close", "finish"]) assert.equal(f.streams[0].listenerCount(event), 0);
});

for (const symlink of [false, true]) for (const aborted of [false, true]) test(`bash open collision preserves the existing ${symlink ? "symlink" : "file"}, abort=${aborted}`, async t => {
  const f = fixture(t), target = join(f.path, "..", "target.log"), secret = "existing private contents";
  if (symlink) {
    fs.writeFileSync(target, secret);
    try { fs.symlinkSync(target, f.path, "file"); }
    catch (error: any) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows symlink privilege unavailable"); return; } throw error; }
  } else fs.writeFileSync(f.path, secret);
  const controller = new AbortController(); let progress = 0;
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    onData(payload);
    await tick();
    onData(payload);
    if (aborted) { controller.abort(); throw new Error("cancelled"); }
    return { exitCode: 0 };
  } }, { signal: controller.signal, onChunk() { progress++; } }), { code: "EEXIST" });
  assert.equal(f.calls.length, 1);
  assert.equal(progress, 2);
  assert.equal(fs.readFileSync(f.path, "utf8"), secret);
  if (symlink) { assert.equal(fs.lstatSync(f.path).isSymbolicLink(), true); assert.equal(fs.readFileSync(target, "utf8"), secret); }
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.streams[0].listenerCount("error"), 0);
});

for (const failure of ["construct", "open", "write", "close"] as const) test(`bash ${failure} failure rejects, releases the stream, and removes only its owned file`, async t => {
  const f = fixture(t), expected = Object.assign(new Error(`fixture ${failure} failed`), { code: "EIO" });
  f.configure(options => {
    if (failure === "construct") throw expected;
    return { ...options, fs: {
      open(path: fs.PathLike, flags: any, mode: any, callback: any) {
        if (failure === "open") { setImmediate(callback, expected); return; }
        fs.open(path, flags, mode, callback);
      },
      write(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: any) {
        if (failure === "write") { setImmediate(callback, expected); return; }
        fs.write(fd, buffer, offset, length, position, callback);
      },
      close(fd: number, callback: any) { fs.close(fd, error => callback(error ?? (failure === "close" ? expected : null))); },
    } };
  });
  let late!: (data: Buffer) => void, progress = 0;
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    late = onData; onData(payload); await tick(); onData(Buffer.from("tail"));
    return { exitCode: 0 };
  } }, { onChunk() { progress++; } }), error => error === expected);
  assert.equal(f.calls.length, 1); assert.equal(fs.existsSync(f.path), false);
  late(payload); assert.equal(progress, 2);
  for (const stream of f.streams) {
    assert.equal(stream.closed, true);
    assert.equal(stream.writableLength, 0);
    for (const event of ["open", "error", "close", "finish"]) assert.equal(stream.listenerCount(event), 0);
  }
});

test("bash waits for physical file close before reporting success", async t => {
  const f = fixture(t); let release!: () => void, entered!: () => void, settled = false;
  const closing = new Promise<void>(resolve => { entered = resolve; });
  f.configure(options => ({ ...options, fs: { open: fs.open, write: fs.write, close(fd: number, callback: any) {
    release = () => fs.close(fd, callback); entered();
  } } }));
  const execution = executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    onData(payload); return { exitCode: 0 };
  } });
  execution.then(() => { settled = true; }, () => { settled = true; });
  await closing;
  try { await tick(); assert.equal(settled, false); }
  finally { release(); await execution; }
  assert.equal(f.streams[0].closed, true);
});

test("bash storage failure cannot hide an observed producer failure", async t => {
  const f = fixture(t); fs.writeFileSync(f.path, "untouched");
  const expected = observedShellError(new Error("producer lost observation"), { exitCode: 0, observationError: "lost" });
  await assert.rejects(executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    onData(payload); await tick(); throw expected;
  } }), error => error === expected && shellProcessResultFromError(error)?.observationError === "lost");
  assert.equal(fs.readFileSync(f.path, "utf8"), "untouched");
  assert.equal(f.streams[0].closed, true);
});

test("real local process drains after file-open failure without an uncaught data/error event", async t => {
  const f = fixture(t); fs.writeFileSync(f.path, "untouched");
  const operations = createLocalShellOperations("fixture", () => ({ shell: process.execPath, args: ["-e"] }));
  let received = 0;
  await assert.rejects(executeBashWithOperations(
    'process.stdout.write("x".repeat(100000)); setTimeout(() => process.stderr.write("last"), 20);',
    process.cwd(), operations, { onChunk(text) { received += text.length; } },
  ), { code: "EEXIST" });
  assert.equal(received, 100004);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.path, "utf8"), "untouched");
  assert.equal(f.streams[0].closed, true);
});

test("line-count truncation below byte threshold still creates exactly one completed log", async t => {
  const f = fixture(t), text = "x\n".repeat(2100);
  const result = await executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
    onData(Buffer.from(text)); return { exitCode: 0 };
  } });
  assert.equal(result.truncated, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.streams[0].closed, true);
  assert.equal(fs.readFileSync(f.path, "utf8"), text);
});
