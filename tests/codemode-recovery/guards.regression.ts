import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { inspectBashResourceLifecycle, inspectHighRiskBashMutation } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/core.ts")>("../../packages/extensions/resource-lifecycle-guard/core.ts");
const { inspectPowerShellResourceLifecycle } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/powershell-lifecycle.ts")>("../../packages/extensions/resource-lifecycle-guard/powershell-lifecycle.ts");
const { inspectBashPermissionScope } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/permission-bash.ts")>("../../packages/extensions/resource-lifecycle-guard/permission-bash.ts");
const { SessionPermissionController } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/permission-controller.ts")>("../../packages/extensions/resource-lifecycle-guard/permission-controller.ts");
const guard = await jiti.import<typeof import("../../packages/extensions/tool-loop-guardrails/core.ts")>("../../packages/extensions/tool-loop-guardrails/core.ts");
const { default: guardExtension } = await jiti.import<typeof import("../../packages/extensions/tool-loop-guardrails/index.ts")>("../../packages/extensions/tool-loop-guardrails/index.ts");

const commands = [
  ["Python heredoc", "python - <<'EOF'\nprint(1)\nEOF"],
  ["redirected heredoc", "cat > f <<'EOF'\nhello\nEOF"],
  ["git commit stdin", "git commit -F - <<'EOF'\nfixture message\nEOF"],
  ["variable executable", '"$FFMPEG" -version'],
  ["substitution", "x=$(git rev-parse HEAD)"],
  ["PATH assignment", "export PATH=/usr/bin:$PATH; node -v"],
  ["environment activation", "source .venv/bin/activate && python --version"],
  ["subshell cwd", "( cd sub && make )"],
  ["Python -c control", 'python -c "print(1)"'],
  ["Node heredoc control", "node <<'EOF'\nconsole.log(1)\nEOF"],
] as const;

function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sp-r0-permissions-"));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return root;
}

async function permission(cwd: string, mode: "full-access" | "workspace-write") {
  let dialogs = 0;
  const audit: unknown[] = [];
  const controller = new SessionPermissionController({ appendEntry: (_kind: string, data: unknown) => audit.push(data) } as never);
  const ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => [], getSessionId: () => `r0-${mode}` },
    ui: { setStatus() {}, select: async (_title: string, choices: string[]) => {
      dialogs++; assert.ok(choices.includes("仅允许本次")); return "仅允许本次";
    } } };
  await controller.restore(ctx as never);
  controller.state.setMode(mode); controller.state.setApprovalPolicy(mode === "full-access" ? "never-ask" : "ask");
  return { dialogs: () => dialogs, audit, async authorize(command: string, toolName = "bash") {
    return controller.authorizeToolCall({ type: "tool_call", toolName, toolCallId: "fixture", input: { command } } as never, ctx as never);
  } };
}

// Commands are parser/authorization input only; this file has no command executor.
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
  });
}

for (const command of ["npm run dev &", "nohup node server.js", "docker run -d alpine"]) {
  test(`control: unmanaged lifecycle remains blocked: ${command}`, () => {
    assert.ok(inspectBashResourceLifecycle({ command }));
  });
}
test("control: PowerShell Start-Process without -Wait remains blocked", () => {
  assert.ok(inspectPowerShellResourceLifecycle({ command: 'Start-Process -FilePath "node" -ArgumentList "server.js"' }));
});
for (const [toolName, command] of [["bash", 'rm -rf "$X"'], ["powershell", "Remove-Item -Recurse $x"]]) {
  test(`control: a recognized recursive deletion with unknown targets is still blocked (${toolName})`, async t => {
    const cwd = workspace(t), f = await permission(cwd, "full-access");
    const decision = await f.authorize(command!, toolName);
    assert.equal(decision?.block, true); assert.equal(f.dialogs(), 0);
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

test("control: a third identical deterministic failure remains blocked", () => {
  const state = guard.createGuardState(), input = { path: "missing-fixture" };
  for (let i = 0; i < 2; i++) {
    assert.equal(guard.inspectBeforeCall(state, "read", input), undefined);
    guard.recordResult(state, "read", input, true, "ENOENT: no such file or directory");
  }
  assert.match(guard.inspectBeforeCall(state, "read", input)!, /REPEATED_CALL_BLOCKED/);
});
