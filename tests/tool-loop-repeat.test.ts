import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { callKey, IdentityCounters, MAX_IDENTITY_CHARACTERS } from "../packages/extensions/tool-loop-guardrails/call-identity.ts";
import { CallLedger, MAX_PENDING_CALLS, MAX_RELEASED_CALLS } from "../packages/extensions/tool-loop-guardrails/call-ledger.ts";
import { CLI_EXTENSION_HOST_POLICY } from "../packages/coding-agent/src/core/extension-host-policy.ts";
const jiti = createJiti(import.meta.url);
const core = await jiti.import<typeof import("../packages/extensions/tool-loop-guardrails/core.ts")>("../packages/extensions/tool-loop-guardrails/core.ts");
const { default: guard } = await jiti.import<typeof import("../packages/extensions/tool-loop-guardrails/index.ts")>("../packages/extensions/tool-loop-guardrails/index.ts");
const { parseRetryPolicy, DEFAULT_RETRY_POLICY, MAX_RETRY_DELAY_MS } = await jiti.import<typeof import("../packages/extensions/tool-loop-guardrails/transient-retry.ts")>("../packages/extensions/tool-loop-guardrails/transient-retry.ts");

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
  assert.equal(reason.retryable, false);
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

for (const command of ["rg", "git"]) test(`structured ${command} timeout_or_aborted uses bounded recovery without deterministic lockout`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), input = { command, args: command === "rg" ? ["pattern", "."] : ["status"], timeoutMs: 10 };
  const text = JSON.stringify({ ok: false, category: "timeout_or_aborted", command, stateChanged: false, killed: true, retryable: true, output: "" });
  assert.equal(core.classifyFailureText(text, input, "structured_readonly_command"), "timeout_or_aborted");
  for (let i = 0; i < 5; i++) {
    const admission = f.call(`interrupted${i}`, input, `parent${i}`, "structured_readonly_command");
    if (i) { await setImmediate(); t.mock.timers.tick(1000 * 2 ** (i - 1)); }
    assert.equal(await admission, undefined);
    await f.result(`interrupted${i}`, input, text, true, "structured_readonly_command");
  }
  const refusal = JSON.parse((await f.call("sixth", input, "last", "structured_readonly_command")).reason);
  assert.equal(refusal.category, "TRANSIENT_RETRY_EXHAUSTED");
  assert.equal(refusal.attempts, 5); assert.equal(refusal.waitMs, 15000);
  f.close();
  const cancelled = fixture();
  await cancelled.call("initial", input, "p1", "structured_readonly_command");
  await cancelled.result("initial", input, text, true, "structured_readonly_command");
  const waiting = cancelled.call("wait", input, "p2", "structured_readonly_command"); await setImmediate();
  cancelled.controller.abort(); assert.match((await waiting).reason, /aborted/); cancelled.close();
  const state = core.createGuardState();
  core.recordResult(state, "structured_readonly_command", input, true, "Operation aborted");
  assert.equal(state.retry.operations.size + state.failuresBySignature.size + state.failuresByTool.size, 0);
});

test("DNS and common transport error forms receive bounded retries across parents", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["getaddrinfo ENOTFOUND example.test", "getaddrinfo failed", "ENOTFOUND", "connection refused", "connection lost", "connection error", "socket connection was closed", "reset before headers", "other side closed", "websocket closed", "upstream connect failure"]) {
    const f = fixture('{"baseDelayMs":1,"maxDelayMs":1}'), input = { url: "https://example.test" };
    for (let i = 0; i < 5; i++) {
      const admission = f.call(`c${i}`, input, `p${i}`);
      if (i) { await setImmediate(); t.mock.timers.tick(1); }
      assert.equal(await admission, undefined, failure);
      await f.result(`c${i}`, input, failure, true);
    }
    const refusal = JSON.parse((await f.call("sixth", input, "last")).reason);
    assert.equal(refusal.category, "TRANSIENT_RETRY_EXHAUSTED", failure);
    assert.equal(refusal.attempts, 5); assert.equal(refusal.waitMs, 4);
    f.close();
  }
});

test("explicit cancellation cannot add or evict failure summaries", () => {
  const state = core.createGuardState();
  core.recordResult(state, "genuine_failure", {}, true, "SyntaxError");
  for (let i = 0; i < 65; i++) core.recordResult(state, `cancelled${i}`, {}, true, "Operation aborted");
  assert.deepEqual([...state.failuresByTool], [["genuine_failure", 1]]);
  assert.equal(state.failuresBySignature.size, 1);
  assert.equal(state.retry.operations.size, 0);
  assert.match(core.guardStatus(state), /trackedTools=1/);
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
  const refusal = JSON.parse((await f.call("overlap", input, "r")).reason);
  assert.match(refusal.cause, /already waiting or executing/);
  assert.equal(refusal.category, "TRANSIENT_RETRY_IN_FLIGHT");
  assert.equal(refusal.retryable, true);
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

for (const finish of ["result", "success", "cancel"] as const) test(`an earlier unreserved sibling ${finish} cannot release another parent's retry`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), input = { x: 1 };
  await f.call("a", input, "pa"); await f.call("b", input, "pb");
  await f.result("a", input, "HTTP 503", true);
  const waiting = f.call("retry", input, "pc"); await setImmediate();
  if (finish === "result") await f.result("b", input, "HTTP 503", true);
  else if (finish === "success") await f.result("b", input);
  else f.end("pb");
  const overlap = f.call("overlap", input, "pd"); await setImmediate();
  t.mock.timers.tick(15000);
  assert.equal(await waiting, undefined);
  assert.match((await overlap).reason, /already waiting or executing/);
  f.close();
});

for (const outcome of ["success", "failure"] as const) test(`a stale retry ${outcome} cannot erase or release a newer generation`, () => {
  const state = core.createGuardState(), input = { x: 1 }, key = core.callKey("child", input);
  core.recordResult(state, "child", input, true, "HTTP 503", key);
  const old = state.retry.operations.get(key)!;
  core.recordResult(state, "child", input, false, "ok", key, undefined, old);
  core.recordResult(state, "child", input, true, "HTTP 503", key);
  const current = state.retry.operations.get(key)!;
  assert.notEqual(current, old);
  current.inFlight = true; current.attempts++; current.waitMs = 1000;
  core.recordResult(state, "child", input, outcome === "failure", "HTTP 503", key, undefined, old);
  assert.equal(state.retry.operations.get(key), current);
  assert.equal(current.inFlight, true);
  assert.equal(current.attempts, outcome === "failure" ? 3 : 2);
  assert.equal(current.waitMs, 1000);
  assert.match(core.inspectBeforeCall(state, "child", input)!, /already waiting or executing/);
  // The stale success also cannot erase accounting after the new owner settles.
  current.inFlight = false;
  core.recordResult(state, "child", input, false, "ok", key, undefined, old);
  assert.equal(state.retry.operations.get(key), current);
  core.recordResult(state, "child", input, false, "ok", key, undefined, current);
  assert.equal(state.retry.operations.has(key), false);
});

test("camelCase and JSON HTTP 5xx use the transient ledger without changing deterministic refusals", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const text of ['{"statusCode":503}', "Request failed with statusCode: 503", '{"status":502}', "status code = 504"]) {
    const f = fixture('{"baseDelayMs":1,"maxDelayMs":1}'), input = { url: "offline" };
    for (let i = 0; i < 5; i++) {
      const admission = f.call(`c${i}`, input, `p${i}`);
      if (i) { await setImmediate(); t.mock.timers.tick(1); }
      assert.equal(await admission, undefined, text);
      await f.result(`c${i}`, input, text, true);
    }
    const refused = JSON.parse((await f.call("last", input, "last-parent")).reason);
    assert.equal(refused.category, "TRANSIENT_RETRY_EXHAUSTED", text);
    assert.equal(refused.attempts, 5); assert.equal(refused.waitMs, 4);
    f.close();
  }
  for (const text of ['{"statusCode":400}', "SyntaxError: statusCode: 503"]) {
    const state = core.createGuardState();
    for (let i = 0; i < 2; i++) core.recordResult(state, "bash", {}, true, text);
    assert.equal(state.retry.operations.size, 0);
    assert.match(core.inspectBeforeCall(state, "bash", {})!, /REPEATED_CALL_BLOCKED/);
  }
});

test("accepted retry delays remain well below the standard safety-hook deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.ok(MAX_RETRY_DELAY_MS <= CLI_EXTENSION_HOST_POLICY.hookTimeouts.safety.timeoutMs / 3);
  const config = JSON.stringify({ baseDelayMs: MAX_RETRY_DELAY_MS, maxDelayMs: MAX_RETRY_DELAY_MS });
  assert.equal(parseRetryPolicy(config).maxDelayMs, MAX_RETRY_DELAY_MS);
  const f = fixture(config), input = { x: 1 };
  await f.call("first", input, "p1"); await f.result("first", input, "HTTP 503", true);
  const retry = f.call("retry", input, "p2"); await setImmediate();
  t.mock.timers.tick(MAX_RETRY_DELAY_MS); assert.equal(await retry, undefined);
  f.close();
});

test("65 different deterministic failures evict FIFO and still admit a fresh read", () => {
  const state = core.createGuardState();
  for (let i = 0; i < 65; i++) core.recordResult(state, "child", { i }, true, "SyntaxError");
  assert.equal(state.failuresBySignature.size, 64);
  assert.equal(state.failureEvictions, 1);
  assert.equal(core.inspectBeforeCall(state, "read", { path: "src/index.ts" }), undefined);
  assert.equal(core.inspectBeforeCall(state, "child", { i: 0 }), undefined);
  core.recordResult(state, "child", { i: 1 }, true, "SyntaxError");
  assert.match(core.inspectBeforeCall(state, "child", { i: 1 })!, /REPEATED_CALL_BLOCKED/);
  assert.equal(state.failureEvictions, 1);
});

test("a full retry ledger preserves owners, admits fresh calls and caps overflow failures at two", () => {
  const state = core.createGuardState();
  for (let i = 0; i < 64; i++) core.recordResult(state, "child", { i }, true, "HTTP 503");
  const first = state.retry.operations.get(core.callKey("child", { i: 0 }))!;
  first.inFlight = true; first.attempts = 4; first.waitMs = 7000;
  assert.equal(core.inspectBeforeCall(state, "child", { i: 64 }), undefined);
  core.recordResult(state, "child", { i: 64 }, true, "HTTP 503");
  assert.equal(state.retry.operations.size, 64);
  assert.equal(state.retry.operations.get(core.callKey("child", { i: 0 })), first);
  assert.deepEqual({ attempts: first.attempts, waitMs: first.waitMs, inFlight: first.inFlight }, { attempts: 4, waitMs: 7000, inFlight: true });
  assert.equal(core.inspectBeforeCall(state, "read", { path: "src/index.ts" }), undefined);
  assert.equal(core.inspectBeforeCall(state, "child", { i: 64 }), undefined);
  // Freeing a slot cannot promote the overflow identity into a fresh five-attempt budget.
  core.recordResult(state, "child", { i: 1 }, false);
  core.recordResult(state, "child", { i: 64 }, true, "Operation timed out");
  assert.equal(state.retry.overflowFailures, 2);
  const refusal = JSON.parse(core.inspectBeforeCall(state, "child", { i: 64 })!);
  assert.equal(refusal.category, "REPEATED_CALL_BLOCKED");
  assert.equal(refusal.failureCount, 2);
  assert.equal(state.retry.operations.has(core.callKey("child", { i: 64 })), false);
  assert.equal(core.inspectBeforeCall(state, "child", { i: 65 }), undefined);
  core.resetGuardState(state);
  assert.equal(core.inspectBeforeCall(state, "child", { i: 64 }), undefined);
  core.recordResult(state, "child", { i: 64 }, true, "HTTP 503");
  assert.equal(state.retry.operations.size, 1);
});

for (const failure of ["SyntaxError", "HTTP 503"]) test(`real hooks admit a new read after 65 distinct ${failure} failures`, async () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) {
    const input = { i };
    assert.equal(await f.call(`call${i}`, input, `parent${i}`), undefined);
    await f.result(`call${i}`, input, failure, true);
    f.end(`parent${i}`);
  }
  assert.equal(await f.call("read", { path: "src/index.ts" }, "fresh-parent", "read"), undefined);
  f.close();
});

for (const mutation of ["edit", "write", "bash", "powershell"]) test(`npm test twice → ${mutation} leaf success → test admission recovers`, async () => {
  const f = fixture(), input = { command: "npm test" };
  for (let i = 0; i < 2; i++) {
    assert.equal(await f.call(`test${i}`, input, `parent${i}`, "bash"), undefined);
    await f.result(`test${i}`, input, "Command exited with code 1", true, "bash");
  }
  const blocked = JSON.parse((await f.call("blocked", input, "parent2", "bash")).reason);
  assert.equal(blocked.failureCategory, "test_failed");
  const edit = mutation === "bash" || mutation === "powershell" ? { command: "echo repaired" } : { path: "src/index.ts", content: "repaired" };
  assert.equal(await f.call("repair", edit, "repair-parent", mutation), undefined);
  await f.result("repair", edit, "ok", false, mutation);
  assert.equal(await f.call("after-repair", input, "parent3", "bash"), undefined);
  f.close();
});

test("parent success and failed mutations preserve failures; mutation success preserves unrelated retry accounting", async () => {
  const f = fixture(), input = { command: "npm test" };
  for (let i = 0; i < 2; i++) {
    await f.call(`test${i}`, input, `p${i}`, "bash");
    await f.result(`test${i}`, input, "Command exited with code 1", true, "bash");
  }
  const parentInput = { command: "echo parent" };
  await f.call("parent", parentInput, "outer", "bash");
  await f.call("child", {}, "parent"); await f.result("child", {}); f.end("child");
  await f.result("parent", parentInput, "ok", false, "bash");
  await f.call("failed-edit", {}, "pedit", "edit"); await f.result("failed-edit", {}, "edit failed", true, "edit");
  assert.match((await f.call("blocked", input, "p3", "bash")).reason, /REPEATED_CALL_BLOCKED/);
  f.close();
  for (const mutation of ["edit", "write", "bash", "powershell"]) {
    const state = core.createGuardState(), key = core.callKey("http_read", {});
    core.recordResult(state, "http_read", {}, true, "HTTP 503", key);
    const retry = state.retry.operations.get(key)!;
    retry.attempts = 5; retry.waitMs = 15000;
    core.recordResult(state, mutation, {}, false);
    assert.equal(state.retry.operations.get(key), retry);
    const reason = JSON.parse(core.inspectBeforeCall(state, "http_read", {})!);
    assert.equal(reason.attempts, 5); assert.equal(reason.waitMs, 15000);
  }
});

test("capacity refusals include the bounded operation name", async () => {
  const state = core.createGuardState();
  for (let i = 0; i < 256; i++) core.inspectBatchCall(state, "child", { i });
  assert.equal(JSON.parse(core.inspectBatchCall(state, "read", {})!).operation, "read");
  const f = fixture();
  const refusal = JSON.parse((await f.call("x".repeat(513), {}, undefined, "read")).reason);
  assert.equal(refusal.operation, "read"); assert.equal(refusal.category, "GUARD_CAPACITY");
  f.close();
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
  for (const value of ['{"maxAttempts":0}', '{"maxWaitMs":120001}', '{"other":1}', "[]", "null", '{"baseDelayMs":9000}', '{"maxDelayMs":10001}', '{"baseDelayMs":30000,"maxDelayMs":30000}']) {
    assert.throws(() => parseRetryPolicy(value));
    const f = fixture(value); assert.match((await f.call("blocked", {})).reason, /TOOL_RETRY_CONFIG/); f.close();
  }
});

test("loaded CLI policy survives session replacement without calling a stale extension API", async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  let reads = 0;
  guard({ on(name: string, hook: any) { hooks.set(name, hook); }, registerTool() {}, registerFlag() {}, sendMessage() {},
    getFlag() { if (++reads > 1) throw new Error("stale extension API"); return '{"maxAttempts":3}'; } } as any);
  hooks.get("session_start")!();
  for (let run = 0; run < 3; run++) {
    hooks.get("agent_start")!();
    assert.equal(await hooks.get("tool_call")!({ toolName: "fixture", toolCallId: `run${run}`, input: {} }, { cwd: process.cwd() }), undefined);
    hooks.get("agent_end")!();
  }
  assert.equal(reads, 1);
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
