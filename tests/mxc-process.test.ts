import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { MxcOutputTail, MxcProcess } from "../packages/coding-agent/src/core/sandbox/mxc-process.ts";
import { ExecFixture, installExecFixture } from "./helpers/extension-exec-fixture.ts";

test("MXC output preserves split UTF-8 and bounds the retained tail across wrap and oversized chunks", () => {
  const text = Buffer.from("甲乙丙丁abc");
  for (const capacity of [1, 4, 7, 8, 15, 32]) {
    for (const step of [1, 2, 5, 20]) {
      const tail = new MxcOutputTail(capacity);
      for (let start = 0; start < text.length; start += step) tail.append(text.subarray(start, start + step));
      let start = Math.max(0, text.length - capacity);
      while (start < text.length && (text[start]! & 0xc0) === 0x80) start++;
      assert.equal(tail.finish(), text.toString("utf8", start));
      assert.equal(tail.truncated, capacity < text.length);
      assert.equal(tail.seen, text.length);
    }
  }
});

test("MXC process returns actual nonzero status and releases output and abort listeners", async () => {
  const child = new ExecFixture(), restore = installExecFixture(child), owner = new MxcProcess(), signal = new AbortController().signal;
  try {
    const pending = owner.run("fixture", [], process.cwd(), {}, signal, 1000, 8);
    await child.ready;
    child.stdout.emit("data", Buffer.from("discard尾部")); child.stderr.emit("data", Buffer.from("detail")); child.finish(7);
    const result = await pending;
    assert.equal(result.code, 7); assert.equal(result.stdout, "rd尾部"); assert.equal(result.stderr, "detail");
    assert.equal(result.truncated, true); assert.equal(result.timedOut, false);
    assert.equal(getEventListeners(signal, "abort").length, 0); child.assertReleased(); owner.assertStopped();
    assert.equal(owner.diagnostics.retainedStreams, 0); assert.equal(owner.diagnostics.job, false);
  } finally { restore(); }
});

test("MXC cancellation waits for physical job cleanup before admitting the next call", async () => {
  const child = new ExecFixture(), restore = installExecFixture(child), owner = new MxcProcess(), controller = new AbortController();
  let release!: (value: string | undefined) => void;
  child.cleanupGate = new Promise(resolve => { release = resolve; });
  try {
    const pending = owner.run("fixture", [], process.cwd(), {}, controller.signal, 1000);
    const rejected = assert.rejects(pending, /cancel fixture/);
    await child.ready; controller.abort(new Error("cancel fixture")); await nextTurn();
    assert.equal(owner.diagnostics.active, true); assert.equal(child.stopCount, 1);
    await assert.rejects(owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 1000), /MXC_BUSY/);
    release(undefined); await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0); child.assertReleased(); owner.assertStopped();
    assert.equal(owner.diagnostics.retainedStreams, 0);
  } finally { release(undefined); restore(); }
});

test("MXC cleanup failure blocks reuse and resource deletion", async () => {
  const child = new ExecFixture(), restore = installExecFixture(child), owner = new MxcProcess();
  child.cleanupFailure = "fixture cleanup failure";
  try {
    const pending = owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 1000);
    const rejected = assert.rejects(pending, /fixture cleanup failure/);
    await child.ready; child.finish(); await rejected;
    assert.throws(() => owner.assertStopped(), /fixture cleanup failure/);
    await assert.rejects(owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 1000), /fixture cleanup failure/);
    child.assertReleased(); assert.equal(owner.diagnostics.retainedStreams, 0);
  } finally { restore(); }
});

test("MXC process error waits in finally for physical cleanup and permits a fresh next call", async () => {
  const child = new ExecFixture(), restore = installExecFixture(child), owner = new MxcProcess();
  let release!: (value: string | undefined) => void;
  child.cleanupGate = new Promise(resolve => { release = resolve; });
  try {
    let settled = false;
    const pending = owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 1000);
    const rejected = assert.rejects(pending, /fixture process error/).then(() => { settled = true; });
    await child.ready; child.emit("error", new Error("fixture process error")); await nextTurn();
    assert.equal(settled, false); assert.equal(owner.diagnostics.active, true); assert.equal(child.stopCount, 1);
    release(undefined); await rejected; child.assertReleased(); owner.assertStopped();
    assert.equal(owner.diagnostics.retainedStreams, 0);
  } finally { release(undefined); restore(); }
  const next = new ExecFixture(), restoreNext = installExecFixture(next);
  try {
    const pending = owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 1000);
    await next.ready; next.finish(); assert.equal((await pending).code, 0);
    next.assertReleased(); owner.assertStopped();
  } finally { restoreNext(); }
});

test("MXC deadline kills its owned process and reports the timeout", async () => {
  const child = new ExecFixture(), restore = installExecFixture(child), owner = new MxcProcess();
  try {
    const result = await owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 1);
    assert.equal(result.timedOut, true); assert.equal(child.stopCount, 1); child.assertReleased(); owner.assertStopped();
  } finally { restore(); }
});

test("controlled file RPC has no shell deadline and remains cancellable through physical cleanup", async () => {
  const child = new ExecFixture(), restore = installExecFixture(child), owner = new MxcProcess(), controller = new AbortController();
  try {
    const pending = owner.run("fixture", [], process.cwd(), {}, controller.signal, 0);
    const rejected = assert.rejects(pending, /file cancellation/);
    await child.ready; await nextTurn(); await nextTurn();
    assert.equal(child.stopCount, 0); assert.equal(owner.diagnostics.active, true);
    controller.abort(new Error("file cancellation")); await rejected;
    child.assertReleased(); owner.assertStopped(); assert.equal(owner.diagnostics.retainedStreams, 0);
  } finally { restore(); }
});
