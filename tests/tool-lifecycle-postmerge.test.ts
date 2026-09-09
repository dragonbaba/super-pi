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
 let approvals = 0, spawns = 0, providers = 0;
 const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); },
  beforeToolCall: ({ args }) => runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "fixture", input: args } as never) });
 runner.bindCore({} as never, { getSignal: () => undefined } as never);
 runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => { approvals++; return choices[0]; } }, "tui");
 await runner.emit({ type: "session_start" } as never);
 agent.state.tools = [createBashTool(cwd, { shellPath, exposeSessionEnvironment: false })];
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") spawns++; } });
 hook.enable();
 t.after(() => { hook.disable(); runner.invalidate(); agent.abort(); rmSync(cwd, { recursive: true }); assert.equal(existsSync(cwd), false); });
 return { cwd, counts: () => ({ approvals, spawns }), async call(command: string) {
  const result = await agent.dispatchHostTool({ type: "toolCall", id: "call", name: "bash", arguments: { command } });
  await agent.waitForIdle(); assert.equal(agent.state.pendingToolCalls.size, 0); assert.equal(providers, 0);
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
