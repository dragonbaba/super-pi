import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { callKey, IdentityCounters, MAX_IDENTITY_CHARACTERS } from "../packages/extensions/tool-loop-guardrails/call-identity.ts";
import { CallLedger, MAX_PENDING_CALLS, MAX_RELEASED_CALLS } from "../packages/extensions/tool-loop-guardrails/call-ledger.ts";
const jiti = createJiti(import.meta.url);
const core = await jiti.import<typeof import("../packages/extensions/tool-loop-guardrails/core.ts")>("../packages/extensions/tool-loop-guardrails/core.ts");
const { default: guard } = await jiti.import<typeof import("../packages/extensions/tool-loop-guardrails/index.ts")>("../packages/extensions/tool-loop-guardrails/index.ts");
const { parseRetryPolicy, DEFAULT_RETRY_POLICY } = await jiti.import<typeof import("../packages/extensions/tool-loop-guardrails/transient-retry.ts")>("../packages/extensions/tool-loop-guardrails/transient-retry.ts");

function fixture(config?: string) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const messages: any[] = [];
  const controller = new AbortController();
  guard({ on(name: string, hook: any) { hooks.set(name, hook); }, registerTool() {}, registerFlag() {},
    getFlag() { return config; }, sendMessage(message: any) { messages.push(message); } } as any);
  const ctx = { cwd: process.cwd(), signal: controller.signal };
  hooks.get("agent_start")!();
  return { hooks, messages, controller,
    async call(id: string, input: object, parent?: string, toolName = "fixture_operation") {
      return hooks.get("tool_call")!({ toolCallId: id, toolName, input, parentToolCallId: parent }, ctx);
    },
    async result(id: string, input: object, text = "ok", isError = false, toolName = "fixture_operation") {
      return hooks.get("tool_result")!({ toolCallId: id, toolName, input, isError, content: [{ type: "text", text }], details: {} }, ctx);
    },
    end(id: string) { hooks.get("tool_execution_end")!({ toolCallId: id }); },
    turn() { hooks.get("turn_start")!(); },
    close() { hooks.get("agent_end")!(); },
  };
}

test("complete identity distinguishes every long middle, full name/key and typed value", () => {
  for (const tool of ["bash", "codemode"]) {
    const head = "a".repeat(2100), tail = "z".repeat(2100);
    assert.notEqual(callKey(tool, { code: head + "bad" + tail }), callKey(tool, { code: head + "fix" + tail }));
  }
  const key = "k".repeat(5000);
  assert.notEqual(callKey("t", { [key + "a"]: 1 }), callKey("t", { [key + "b"]: 1 }));
  assert.notEqual(callKey("t".repeat(81) + "a", {}), callKey("t".repeat(81) + "b", {}));
  assert.notEqual(callKey("t", { a: undefined }), callKey("t", {}));
  assert.notEqual(callKey("t", [1, 2]), callKey("t", { 0: 1, 1: 2 }));
  assert.notEqual(callKey("t", "\ud800"), callKey("t", "\ud801"));
  assert.equal(callKey("t", { b: [1, "2"], a: null }), callKey("t", { a: null, b: [1, "2"] }));
  const many = Array.from({ length: 4096 }, (_, i) => i);
  assert.notEqual(callKey("t", many), callKey("t", [...many.slice(0, -1), -1]));
});

test("actual hash counters cover all code units once without evaluating accessors or accepting lossy limits", () => {
  const counters = new IdentityCounters(), value = "x".repeat(1024 * 1024) + "\ud800";
  callKey("fixture", { code: value }, counters);
  assert.equal(counters.calls, 1);
  assert.equal(counters.characters, "fixture".length + "code".length + value.length);
  assert.equal(counters.nodes, 2);
  assert.equal(counters.hashUpdates, 2 + Math.ceil(value.length / 2048));
  let getters = 0;
  assert.throws(() => callKey("t", { get code() { getters++; return "x"; } }), /accessors/);
  assert.equal(getters, 0);
  const cycle: any = {}; cycle.self = cycle;
  assert.throws(() => callKey("t", cycle), /Cyclic/);
  assert.throws(() => callKey("t", "x".repeat(MAX_IDENTITY_CHARACTERS)), /character limit/);
});

test("production hook scans one admitted input; result and unadmitted results perform no hash updates", async () => {
  const f = fixture(), input = { code: "x".repeat(100_000) };
  const prototype = Object.getPrototypeOf(createHash("sha256")), original = prototype.update;
  let scanned = 0;
  prototype.update = function(value: any, encoding?: string) {
    if (encoding === "utf16le") scanned += value.length;
    return original.call(this, value, encoding);
  };
  try {
    assert.equal(await f.call("one", input), undefined);
    assert.equal(scanned, "fixture_operation".length + "code".length + input.code.length);
    const atAdmission = scanned;
    await f.result("one", input, "SyntaxError", true);
    await f.result("unknown", input, "SyntaxError", true);
    assert.equal(scanned, atAdmission);
  } finally { prototype.update = original; f.close(); }
});

test("per-operation deterministic counts survive other categories, parents, cancellation and unrelated success", () => {
  const s = core.createGuardState(), input = { x: 1 };
  for (let i = 0; i < 2; i++) {
    assert.equal(core.inspectBeforeCall(s, "child", input), undefined);
    core.recordResult(s, "child", input, true, "SyntaxError: bad");
    core.recordResult(s, "codemode", { code: `wrapper ${i}` }, false);
    core.recordResult(s, "child", { x: 2 }, false);
    core.recordResult(s, "child", input, true, "Operation aborted");
  }
  assert.match(core.inspectBeforeCall(s, "child", input)!, /REPEATED_CALL_BLOCKED/);
  core.recordResult(s, "child", input, false);
  assert.equal(core.inspectBeforeCall(s, "child", input), undefined);
  core.resetGuardState(s);
  assert.equal(s.failuresBySignature.size + s.retry.operations.size + s.batchCalls.size, 0);
});

test("full parent cancellation releases a pending child without erasing earlier child failures", async () => {
  const f = fixture(), input = { x: 1 };
  assert.equal(await f.call("first", input, "p1"), undefined);
  await f.result("first", input, "SyntaxError: bad", true); f.end("p1");
  assert.equal(await f.call("cancelled", input, "p2"), undefined);
  f.end("p2");
  assert.equal(await f.call("second", input, "p3"), undefined);
  await f.result("second", input, "SyntaxError: bad", true); f.end("p3");
  assert.match((await f.call("third", input, "p4")).reason, /REPEATED_CALL_BLOCKED/);
  f.close();
  assert.equal(await f.call("fresh", input, "p5"), undefined);
  f.close();
});

test("continuous HTTP 503 stops at five executions across different parents and at 15s scheduled waiting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), input = { resource: "offline" };
  let executions = 0, waited = 0;
  for (let i = 0; i < 5; i++) {
    const admission = f.call(`c${i}`, input, `p${i}`);
    if (i) { await setImmediate(); const delay = 1000 * 2 ** (i - 1); waited += delay; t.mock.timers.tick(delay); }
    assert.equal(await admission, undefined);
    executions++;
    await f.result(`c${i}`, input, "HTTP 503 Service Unavailable", true);
    f.end(`p${i}`);
    await f.result(`unrelated${i}`, {}, "ok");
  }
  const blocked = await f.call("last", input, "another-parent");
  const reason = JSON.parse(blocked.reason);
  assert.deepEqual({ executions, waited, attempts: reason.attempts, waitMs: reason.waitMs }, { executions: 5, waited: 15000, attempts: 5, waitMs: 15000 });
  assert.equal(reason.category, "TRANSIENT_RETRY_EXHAUSTED");
  assert.equal(reason.retryable, true);
  f.close();
});

test("two transient errors can recover, success clears only that operation, and cumulative wait caps stop early", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture('{"maxWaitMs":3000}'), input = { resource: "offline" };
  for (let i = 0; i < 3; i++) {
    const promise = f.call(`c${i}`, input, `p${i}`);
    if (i) { await setImmediate(); t.mock.timers.tick(i * 1000); }
    assert.equal(await promise, undefined);
    await f.result(`c${i}`, input, i === 2 ? "ok" : "fetch failed", i !== 2);
  }
  assert.equal(await f.call("after-success", input, "p4"), undefined);
  await f.result("after-success", input, "HTTP 503", true);
  const second = f.call("f2", input, "p5"); await setImmediate(); t.mock.timers.tick(1000); await second;
  await f.result("f2", input, "HTTP 503", true);
  const third = f.call("f3", input, "p6"); await setImmediate(); t.mock.timers.tick(2000); await third;
  await f.result("f3", input, "HTTP 503", true);
  assert.match((await f.call("fourth", input, "p7")).reason, /TRANSIENT_RETRY_EXHAUSTED/);
  f.close();
});

for (const cancel of ["signal", "parent", "agent"] as const) test(`backoff ${cancel} cancellation releases timers and pending state`, async () => {
  const f = fixture(), input = { resource: "offline" };
  assert.equal(await f.call("first", input, "p"), undefined);
  await f.result("first", input, "HTTP 503", true);
  const promise = f.call("waiting", input, "q");
  await setImmediate();
  if (cancel === "signal") f.controller.abort(); else if (cancel === "parent") f.end("q"); else f.close();
  assert.match((await promise).reason, /aborted/);
  f.close();
});

test("identical retry reservations cannot be doubled through another parent", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), input = { x: 1 };
  await f.call("first", input, "p"); await f.result("first", input, "HTTP 503", true);
  const wait = f.call("wait", input, "q"); await setImmediate();
  assert.match((await f.call("overlap", input, "r")).reason, /already waiting or executing/);
  t.mock.timers.tick(1000); assert.equal(await wait, undefined);
  await f.result("wait", input, "ok"); f.close();
});

test("cancelled or vetoed retries consume the attempt reservation even without a tool_result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture('{"baseDelayMs":1,"maxDelayMs":1}'), input = { x: 1 };
  await f.call("first", input, "p0"); await f.result("first", input, "HTTP 503", true);
  for (let i = 1; i < 5; i++) {
    const admission = f.call(`cancelled${i}`, input, `p${i}`);
    await setImmediate(); t.mock.timers.tick(1); assert.equal(await admission, undefined);
    // A later hook vetoes, or an executing tool is cancelled before result observation.
    f.end(`p${i}`);
  }
  const blocked = JSON.parse((await f.call("sixth", input, "p6")).reason);
  assert.equal(blocked.attempts, 5);
  assert.equal(blocked.category, "TRANSIENT_RETRY_EXHAUSTED");
  f.close();
});

test("failure and retry eviction is counted and cannot renew an evicted allowance", () => {
  for (const text of ["SyntaxError", "HTTP 503"]) {
    const s = core.createGuardState();
    for (let i = 0; i < 65; i++) core.recordResult(s, "child", { i }, true, text);
    assert.ok(s.failuresBySignature.size <= 64 && s.retry.operations.size <= 64);
    assert.equal(s.failureEvictions + s.retry.evictions, 1);
    assert.match(core.inspectBeforeCall(s, "child", { i: 0 })!, /capacity|evicted/);
    core.recordResult(s, "codemode", { code: "new parent" }, false);
    assert.ok(core.inspectBeforeCall(s, "child", { i: 0 }));
    core.resetGuardState(s);
    assert.equal(core.inspectBeforeCall(s, "child", { i: 0 }), undefined);
  }
});

test("pending/release tables have hard bounds and parent/end cleanup", () => {
  const ledger = new CallLedger();
  for (let i = 0; i < MAX_PENDING_CALLS; i++) { assert.equal(ledger.canAdmit(`c${i}`, "p"), true); ledger.remember(`c${i}`, "fixed-key", "p"); }
  assert.equal(ledger.canAdmit("overflow", "q"), false);
  ledger.end("p"); assert.equal(ledger.pending.size, 0);
  for (let i = 0; i < MAX_RELEASED_CALLS; i++) {
    const pending = ledger.remember(`c${i}`, "key", "p"); pending.nestedKey = `p:${i}`; ledger.nested.set(pending.nestedKey, true); ledger.finish(`c${i}`);
  }
  assert.equal(ledger.canAdmit("overflow", "new-parent"), false);
  assert.equal(ledger.releasedCount, MAX_RELEASED_CALLS);
  ledger.end("p");
  assert.equal(ledger.pending.size + ledger.nested.size + ledger.released.size + ledger.releasedCount, 0);
});

test("configuration defaults match the user choice and malformed budgets fail closed", async () => {
  assert.deepEqual(DEFAULT_RETRY_POLICY, { maxAttempts: 5, maxWaitMs: 15000, baseDelayMs: 1000, maxDelayMs: 8000 });
  for (const value of ['{"maxAttempts":0}', '{"maxWaitMs":120001}', '{"other":1}', "[]", "null", '{"baseDelayMs":9000}']) {
    assert.throws(() => parseRetryPolicy(value));
    const f = fixture(value); assert.match((await f.call("blocked", {})).reason, /TOOL_RETRY_CONFIG/); f.close();
  }
});

test("known limitation: a post-admission generic argument rewrite is accounted to the admitted identity", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.turn(); const input = { value: "admitted" };
    assert.equal(await f.call(`c${i}`, input), undefined);
    input.value = "changed by a later extension";
    await f.result(`c${i}`, input, "SyntaxError", true);
  }
  f.turn(); assert.match((await f.call("blocked-original", { value: "admitted" })).reason, /REPEATED_CALL_BLOCKED/);
  f.turn(); assert.equal(await f.call("changed", { value: "changed by a later extension" }), undefined);
  f.close();
});
