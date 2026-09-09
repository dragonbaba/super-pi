import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";
import { getShellConfig } from "../packages/coding-agent/src/utils/shell.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { extractCommandSubstitutions } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
const jiti = createJiti(import.meta.url);
const { default: guard } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { failureRecoveryHint, classifyFailureText } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const shellPath = process.platform === "win32" && existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : getShellConfig().shell;

async function fixture(t: test.TestContext) {
 const cwd = mkdtempSync(join(tmpdir(), "pi-lifecycle-postmerge-"));
 const runtime = createExtensionRuntime();
 const extension = await loadExtensionFromFactory(pi => { pi.appendEntry = () => {}; guard(pi); }, cwd, createEventBus(), runtime);
 const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), {} as never);
 let approvals = 0, spawns = 0, providers = 0, deny = false;
 let approvalAction: (() => void) | undefined, effectiveArgs: any;
 const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); },
  beforeToolCall: ({ args }) => { effectiveArgs = args; return runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "fixture", input: args } as never); } });
 runner.bindCore({} as never, { getSignal: () => undefined } as never);
 runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => { approvals++; await Promise.resolve(); approvalAction?.(); return deny ? choices.at(-1) : choices[0]; } }, "tui");
 await runner.emit({ type: "session_start" } as never);
 agent.state.tools = [createBashTool(cwd, { shellPath, exposeSessionEnvironment: false })];
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") spawns++; } });
 hook.enable();
 t.after(() => { hook.disable(); runner.invalidate(); agent.abort(); rmSync(cwd, { recursive: true }); assert.equal(existsSync(cwd), false); });
 return { cwd, deny: () => { deny = true; }, mutateAtApproval: (replacement = "sleep 10 &") => { approvalAction = () => { effectiveArgs.command = replacement; }; }, counts: () => ({ approvals, spawns }), async call(command: string) {
  const result = await agent.dispatchHostTool({ type: "toolCall", id: "call", name: "bash", arguments: { command } });
  await agent.waitForIdle(); assert.equal(agent.state.pendingToolCalls.size, 0); assert.equal(providers, 0);
  effectiveArgs = undefined; approvalAction = undefined;
  return { error: result.isError, text: result.content.filter(c => c.type === "text").map(c => c.text).join("\n") };
 } };
}

for (const [command, expected] of [["env LABEL=sh printenv LABEL", "sh"], ["echo bash; env echo safe", "bash\nsafe"], [String.raw`bash -c "echo \&"`, "&"]]) {
 test(`postmerge approved dispatch: ${command}`, async t => {
  const f = await fixture(t); const result = await f.call(command);
  assert.equal(result.error, false, result.text); assert.equal(result.text.trim().replaceAll("\r", ""), expected);
  assert.equal(f.counts().spawns, 1);
 });
}

test("postmerge uncertainty is not a syntax fact or an approval request", async t => {
 const command = 'echo "$(time echo safe)"';
 const scan = extractCommandSubstitutions(command);
 assert.equal(scan.unterminated, false);
 assert.equal((scan as any).unsupported, true);
 assert.ok(!inspectHighRiskBashMutation({ command }, process.cwd())?.primitives.includes("unterminated_command_substitution"));
 assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
 const f = await fixture(t); const result = await f.call(command);
 assert.equal(result.error, true); assert.match(result.text, /uncertain\/uninspectable/);
 assert.deepEqual(f.counts(), { approvals: 0, spawns: 0 });
});

test("postmerge permission denial still prevents a lifecycle-compatible launcher", async t => {
 const f = await fixture(t); f.deny(); const result = await f.call("env LABEL=sh printenv LABEL");
 assert.equal(result.error, true); assert.deepEqual(f.counts(), { approvals: 1, spawns: 0 });
});

test("postmerge unrelated shell text never changes a literal launcher segment verdict", () => {
 for (const command of ["env echo safe", "sudo echo safe", "nice echo safe", "timeout 1 echo safe", "command echo safe", "exec echo safe"]) {
  assert.equal(inspectBashResourceLifecycle({ command: `echo bash; ${command}` }), inspectBashResourceLifecycle({ command }), command);
 }
});

test("postmerge a changed command cannot reuse a pre-approval lifecycle verdict", async t => {
 const f = await fixture(t); f.mutateAtApproval(); const result = await f.call("env LABEL=sh printenv LABEL");
 assert.equal(result.error, true); assert.match(result.text, /unmanaged/);
 assert.deepEqual(f.counts(), { approvals: 1, spawns: 0 });
});

test("postmerge lifecycle-compatible replacement requires its own permission", async t => {
 const f = await fixture(t); f.mutateAtApproval("printf UNAPPROVED");
 const result = await f.call("env LABEL=sh printenv LABEL");
 assert.equal(result.error, true, result.text);
 assert.deepEqual(f.counts(), { approvals: 1, spawns: 0 });
});

test("postmerge bounded launcher and dynamic-wrapper negatives never spawn", async t => {
 const f = await fixture(t);
 for (const command of ["env -- LABEL=sh bash -c 'sleep 10 &'", "sudo LABEL=sh bash -c 'sleep 10 &'", "echo bash; timeout 1 bash -c 'sleep 10 &'", "env -S 'bash -c x'", 'bash -c "$SCRIPT"', "command bash -c 'sleep 10 &'", 'echo "$(coproc echo safe)"', 'echo "$(echo safe', "cat <<'EOF'\nx\nEOF"]) {
  const result = await f.call(command); assert.equal(result.error, true, command);
 }
 assert.deepEqual(f.counts(), { approvals: 0, spawns: 0 });
});

test("postmerge one-layer escapes and line continuations preserve target consumers", async t => {
 const f = await fixture(t);
 const continued = await f.call('bash -c "echo sa\\\nfe"');
 assert.equal(continued.error, false); assert.equal(continued.text.trim(), "safe");
 for (const command of [String.raw`rm -rf "target\&name"`, 'rm -rf "target\\\nname"']) {
  const mutation = inspectHighRiskBashMutation({ command }, f.cwd)!;
  const scope = inspectBashPermissionScope({ command }, f.cwd)!;
  assert.ok(mutation.primitives.includes("rm_recursive"));
  assert.deepEqual(mutation.targets, scope.targets);
  assert.equal(scope.kind, "known-mutation");
 }
 const mixed = inspectHighRiskBashMutation({ command: 'echo "$(time echo safe)"; rm -rf victim' }, f.cwd)!;
 assert.ok(mixed.primitives.includes("rm_recursive")); assert.ok(mixed.unverifiableScope);
 assert.ok(!mixed.primitives.includes("unterminated_command_substitution"));
 assert.equal(extractCommandSubstitutions('echo "$(echo safe').unterminated, true);
 assert.equal(inspectBashPermissionScope({ command: 'echo "$(time rm victim)"' }, f.cwd)?.kind, "opaque-script");
});

test("postmerge uncertain refusal has bounded policy recovery", async () => {
 const reason = inspectBashResourceLifecycle({ command: "cat <<'EOF'\nSECRET_PAYLOAD\nEOF" })!;
 assert.equal(classifyFailureText(reason, {}, "bash"), "policy_blocked");
 const hint = await failureRecoveryHint("bash", { command: "SECRET_PAYLOAD" }, reason, process.cwd());
 assert.match(hint, /Lifecycle recovery/); assert.match(hint, /before execution/); assert.match(hint, /permission/i);
 assert.ok(hint.length < 700); assert.doesNotMatch(hint, /SECRET_PAYLOAD/);
 assert.equal(classifyFailureText("ordinary runtime failure: blocked buffer", {}, "bash"), "runtime_error");
});

test("postmerge unsupported dispatch refuses before irrelevant approval", async t => {
 const f = await fixture(t); const result = await f.call('echo "$(time echo safe)"');
 assert.match(result.text, /uncertain\/uninspectable/);
 assert.deepEqual(f.counts(), { approvals: 0, spawns: 0 });
});
