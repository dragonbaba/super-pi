import assert from "node:assert/strict";
import test from "node:test";
import { commands, workspace, permission, inspectBashResourceLifecycle, inspectHighRiskBashMutation,
  inspectBashPermissionScope, guard, guardExtension } from "./guard-fixture.ts";
import { shellHookFixture, assertFinalAuthorization } from "./shell-hook-fixture.ts";

// Layer checks diagnose a failure; only the real extension-hook checks below
// establish final authorization. Command strings are never executed.
for (const [name, command] of commands) {
  test(`F-S1/S4 D3 ${name}: all decision layers admit the authorized foreground command`, async t => {
    const cwd = workspace(t), input = { command };
    await t.test("lifecycle preflight", () => assert.equal(inspectBashResourceLifecycle(input), undefined));
    await t.test("high-risk analysis does not invent an unverifiable mutation target", () => {
      const scan = inspectHighRiskBashMutation(input, cwd);
      assert.notEqual(scan?.unverifiableScope, true, JSON.stringify(scan));
    });
    await t.test("scope remains opaque rather than silently readonly", () => {
      assert.equal(inspectBashPermissionScope(input, cwd)?.kind, "opaque-script");
    });
    await t.test("full-access + never-ask authorizes without a dialog", async () => {
      const f = await permission(cwd, "full-access");
      assert.equal(await f.authorize(command), undefined); assert.equal(f.dialogs(), 0);
    });
    await t.test("workspace-write asks once and then honors that authorization", async () => {
      const f = await permission(cwd, "workspace-write");
      const outcome = await f.authorize(command);
      assert.deepEqual({ block: outcome, dialogs: f.dialogs() }, { block: undefined, dialogs: 1 });
    });
    for (const mode of ["full-access", "workspace-write"] as const) {
      await t.test(`complete tool_call hook: ${mode} returns consumable finalAuthorization`, async child => {
        const f = await shellHookFixture(child, mode);
        assertFinalAuthorization(await f.authorize(command));
        assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
      });
    }
  });
}

function longInputs(tool: "bash" | "codemode", length: number) {
  const prefix = tool === "bash" ? 'node -e "//' : "// ";
  const tail = tool === "bash" ? '\n//' + "b".repeat(2200) + '"' : '\n// ' + "b".repeat(2200);
  const bad = "JSON.parse('!');", fixed = "JSON.parse('1');";
  const head = prefix + "a".repeat(length - prefix.length - tail.length - bad.length - 1) + "\n";
  const a = head + bad + tail, b = head + fixed + tail;
  assert.equal(a.length, length); assert.equal(b.length, length); assert.notEqual(a, b);
  return tool === "bash" ? [{ command: a }, { command: b }] as const : [{ code: a }, { code: b }] as const;
}

for (const tool of ["bash", "codemode"] as const) for (const length of [5024, 5564]) {
  test(`F-S6 ${tool} ${length}: a corrected middle is admitted after two failures`, () => {
    const [bad, fixed] = longInputs(tool, length), state = guard.createGuardState();
    for (let i = 0; i < 2; i++) {
      assert.equal(guard.inspectBeforeCall(state, tool, bad), undefined);
      guard.recordResult(state, tool, bad, true, "SyntaxError: invalid JSON");
    }
    assert.equal(guard.inspectBeforeCall(state, tool, fixed), undefined, "the corrected call must get a distinct complete-content identity");
  });
  test(`F-S6 ${tool} ${length}: distinct siblings do not collide`, () => {
    const [bad, fixed] = longInputs(tool, length), state = guard.createGuardState();
    assert.equal(guard.inspectBatchCall(state, tool, bad), undefined);
    assert.equal(guard.inspectBatchCall(state, tool, fixed), undefined);
  });
}

test("F-S7 parent result events do not erase the repeated deterministic child failure", async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  guardExtension({ on: (name: string, callback: (...args: any[]) => any) => hooks.set(name, callback),
    registerTool() {}, sendMessage() {} } as never);
  const context = { cwd: process.cwd() };
  const parentInput = { code: 'await tools.fixture_operation({kind:"failure"});' };
  let repeatedBlocked = false;
  hooks.get("agent_start")!();
  for (let round = 0; round < 3; round++) {
    hooks.get("turn_start")!();
    const parentId = `parent-${round}`;
    for (const [id, toolName, input, parentToolCallId] of [
      [parentId, "codemode", parentInput, undefined], [`child-${round}`, "fixture_operation", { kind: "failure" }, parentId],
    ] as const) {
      const event = { type: "tool_call", toolCallId: id, toolName, input, parentToolCallId };
      const admission = await hooks.get("tool_call")!(event, context);
      if (admission?.block) { assert.match(admission.reason, /REPEATED_CALL_BLOCKED/); repeatedBlocked = true; break; }
    }
    if (repeatedBlocked) break;
    for (const [id, toolName, input, parentToolCallId] of [
      [`child-${round}`, "fixture_operation", { kind: "failure" }, parentId], [parentId, "codemode", parentInput, undefined],
    ] as const) {
      await hooks.get("tool_result")!({ type: "tool_result", toolCallId: id, toolName, input, parentToolCallId,
        isError: true, content: [{ type: "text", text: "SyntaxError: deterministic fixture failure" }], details: {} }, context);
      hooks.get("tool_execution_end")!({ toolCallId: id, toolName, isError: true });
    }
  }
  assert.equal(repeatedBlocked, true, "three identical deterministic failures must not disappear between child and parent events");
});

test("F-S8 two transient HTTP 503 responses still allow a successful third attempt", () => {
  const state = guard.createGuardState(), input = { resource: "offline-fixture" };
  for (let i = 0; i < 2; i++) {
    assert.equal(guard.inspectBeforeCall(state, "http_read", input), undefined);
    guard.recordResult(state, "http_read", input, true, "HTTP 503 Service Unavailable");
  }
  assert.equal(guard.inspectBeforeCall(state, "http_read", input), undefined);
  guard.recordResult(state, "http_read", input, false, "recovered");
  assert.equal(state.activeFailureCount, 0);
});
