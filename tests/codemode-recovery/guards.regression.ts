import assert from "node:assert/strict";
import test from "node:test";
import { commands, workspace, permission, inspectBashResourceLifecycle, inspectHighRiskBashMutation,
  inspectBashPermissionScope, guard, guardExtension } from "./guard-fixture.ts";
import { shellHookFixture, assertFinalAuthorization } from "./shell-hook-fixture.ts";
import { body, sessionFixture } from "./fixture.ts";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";

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

for (const parentIsError of [true, false]) test(`F-S7 parent isError=${parentIsError} does not erase the repeated deterministic child failure`, async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  guardExtension({ on: (name: string, callback: (...args: any[]) => any) => hooks.set(name, callback),
    registerTool() {}, sendMessage() {} } as never);
  const context = { cwd: process.cwd() };
  let repeatedBlocked = false;
  hooks.get("agent_start")!();
  for (let round = 0; round < 3; round++) {
    hooks.get("turn_start")!();
    const parentId = `parent-${round}`;
    // Vary only the wrapper: the repeated child must reach admission without
    // the parent's independent failure count masking a lost child count.
    const parentInput = { code: `// wrapper ${round}\nawait callTool("fixture_operation",{kind:"failure"},${JSON.stringify({ allowFailure: !parentIsError })});` };
    for (const [id, toolName, input, parentToolCallId] of [
      [parentId, "codemode", parentInput, undefined], [`child-${round}`, "fixture_operation", { kind: "failure" }, parentId],
    ] as const) {
      const event = { type: "tool_call", toolCallId: id, toolName, input, parentToolCallId };
      const admission = await hooks.get("tool_call")!(event, context);
      if (toolName === "codemode") assert.notEqual(admission?.block, true, "distinct parent wrappers must remain admitted");
      if (admission?.block) {
        assert.equal(toolName, "fixture_operation");
        assert.equal(id, `child-${round}`);
        assert.equal(parentToolCallId, parentId);
        assert.match(admission.reason, /REPEATED_CALL_BLOCKED/);
        assert.equal(round, 2, "the child must be admitted twice before repeated-failure blocking");
        repeatedBlocked = true;
        break;
      }
    }
    if (repeatedBlocked) break;
    for (const [id, toolName, input, parentToolCallId] of [
      [`child-${round}`, "fixture_operation", { kind: "failure" }, parentId], [parentId, "codemode", parentInput, undefined],
    ] as const) {
      const isError = toolName === "fixture_operation" || parentIsError;
      await hooks.get("tool_result")!({ type: "tool_result", toolCallId: id, toolName, input, parentToolCallId,
        isError, content: [{ type: "text", text: isError ? "SyntaxError: deterministic fixture failure" : "handled child failure" }], details: {} }, context);
      hooks.get("tool_execution_end")!({ toolCallId: id, toolName, isError });
    }
  }
  assert.equal(repeatedBlocked, true, "the third child admission must be blocked after two identical deterministic child failures");
});

for (const policy of ["real guard", "third-admission block control"] as const) {
  test(`F-S7 allowFailure keeps the third blocked child recoverable in one agent run: ${policy}`, async t => {
    let executions = 0, admissions = 0, starts = 0, ends = 0;
    const alternatives: number[] = [];
    const observe: ExtensionFactory = pi => {
      pi.on("agent_start", async () => { starts++; });
      pi.on("agent_end", async () => { ends++; });
      pi.on("tool_call", async event => {
        if (event.toolName !== "fixture_operation") return;
        admissions++;
        if (policy === "third-admission block control" && admissions === 3) {
          return { block: true, reason: "[REPEATED_CALL_BLOCKED] deterministic third-admission fixture" };
        }
      });
    };
    const f = await sessionFixture(t, { g2: false,
      extensions: policy === "real guard" ? [observe, guardExtension] : [observe], customTools: [{
        name: "fixture_operation", label: "failure", description: "offline deterministic failure",
        parameters: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
        execute: async () => { executions++; return { isError: true, content: [{ type: "text", text: "SyntaxError: deterministic fixture failure" }], details: {} }; },
      }, {
        name: "fixture_alternative", label: "alternative", description: "offline successful alternative",
        parameters: { type: "object", properties: { round: { type: "integer" } }, required: ["round"] },
        execute: async (_id: string, args: { round: number }) => { alternatives.push(args.round); return { content: [{ type: "text", text: "alternative succeeded" }], details: {} }; },
      }] });
    const scripts = Array.from({ length: 3 }, (_, round) => `// distinct parent ${round}
      const outcome = await callTool("fixture_operation", {kind:"failure"}, {allowFailure:true});
      text({round:${round}, handled:outcome.isError, diagnostic:outcome.content});
      await tools.fixture_alternative({round:${round}}); store("lastRecoveredRound",${round}); text("continued after child");`);
    scripts.push('text({lastRecoveredRound:load("lastRecoveredRound") ?? null});');
    const { results } = await f.run(scripts);
    assert.deepEqual({ starts, ends, admissions }, { starts: 1, ends: 1, admissions: 3 });
    assert.equal(executions, 2, "the third deterministic child must be blocked before execution");
    assert.deepEqual(alternatives, [0, 1, 2], "all parents must continue to the alternative, including after blocking");
    assert.equal(results.length, 4);
    for (const [round, result] of results.slice(0, 3).entries()) {
      assert.equal(result.isError, false, body(result.content));
      assert.equal((result.details as any).codemode.scriptOk, true);
      assert.match(body(result.content), new RegExp(`"round":${round},"handled":true`));
      const facts = (result.details as any).codemode.calls;
      assert.deepEqual(facts.map((c: any) => [c.toolName, c.isError]), [["fixture_operation", true], ["fixture_alternative", false]]);
    }
    assert.match(body(results[2]!.content), /REPEATED_CALL_BLOCKED/, "the blocked outcome must be returned to the script");
    assert.match(body(results[3]!.content), /"lastRecoveredRound":2/, "the recovered third parent must commit its store");
  });
}

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
