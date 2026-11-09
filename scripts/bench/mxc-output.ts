import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MxcProcess } from "../../packages/coding-agent/src/core/sandbox/mxc-process.ts";
import { ExecFixture, installExecFixture } from "../../tests/helpers/extension-exec-fixture.ts";

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const chunks = 16384, capacity = 32768;
let delivery = false, promises = 0, buffers = 0, views = 0, strings = 0;
const hook = createHook({ init(_id, type) { if (delivery && type === "PROMISE") promises++; } });
const allocate = Buffer.allocUnsafe, subarray = Buffer.prototype.subarray, stringify = Buffer.prototype.toString;
Buffer.allocUnsafe = size => { if (delivery) buffers++; return allocate(size); };
Buffer.prototype.subarray = function(start, end) { if (delivery) views++; return subarray.call(this, start, end); };
Buffer.prototype.toString = function(encoding, start, end) { if (delivery) strings++; return stringify.call(this, encoding, start, end); };
const child = new ExecFixture(), restore = installExecFixture(child);
let owner: MxcProcess | undefined = new MxcProcess(), payload: Buffer | undefined = Buffer.alloc(64, 120);
const ownerRef = new WeakRef(owner), payloadRef = new WeakRef(payload);
let pending: ReturnType<MxcProcess["run"]> | undefined;
hook.enable();
try {
  pending = owner.run("fixture", [], process.cwd(), {}, new AbortController().signal, 10000, capacity);
  await child.ready;
  delivery = true;
  for (let i = 0; i < chunks; i++) child.stdout.emit("data", payload);
  delivery = false; child.finish();
  const result = await pending;
  assert.equal(result.stdout.length, capacity); assert.equal(result.stdout, "x".repeat(capacity));
  assert.equal(result.truncated, true); assert.equal(promises, 0); assert.equal(buffers, 0);
  assert.equal(views, 0); assert.equal(strings, 0); child.assertReleased();
  assert.equal(owner.diagnostics.retainedStreams, 0); owner.assertStopped();
} finally {
  delivery = false; hook.disable(); restore();
  Buffer.allocUnsafe = allocate; Buffer.prototype.subarray = subarray; Buffer.prototype.toString = stringify;
  pending = undefined; owner = undefined; payload = undefined;
}
for (let i = 0; i < 4; i++) { await nextTurn(); globalThis.gc!(); }
assert.equal(ownerRef.deref(), undefined); assert.equal(payloadRef.deref(), undefined);
console.log(JSON.stringify({ inputChunks: chunks, inputBytes: chunks * 64, retainedOutputBytes: capacity,
  promisesDuringDelivery: promises, payloadBufferAllocationsDuringDelivery: buffers,
  bufferViewsDuringDelivery: views, stringMaterializationsDuringDelivery: strings,
  remainingDataListeners: child.stdout.listenerCount("data") + child.stderr.listenerCount("data"),
  retainedOwnerAfterFourGC: Number(!!ownerRef.deref()), retainedInputAfterFourGC: Number(!!payloadRef.deref()) }));
