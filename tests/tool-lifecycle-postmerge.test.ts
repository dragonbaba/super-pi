import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { Agent } from "../packages/agent/src/agent.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
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

async function fixture(t: test.TestContext, lateCommand?: string | ((event: any) => any), before?: (event: any) => any, noGuard = false) {
 const cwd = mkdtempSync(join(tmpdir(), "pi-lifecycle-postmerge-"));
 const runtime = createExtensionRuntime();
 const extension = await loadExtensionFromFactory(pi => { pi.appendEntry = () => {}; guard(pi); }, cwd, createEventBus(), runtime);
 const extensions = noGuard ? [] : [extension];
 if (before) extensions.unshift(await loadExtensionFromFactory(pi => pi.on("tool_call", before), cwd, createEventBus(), runtime));
 if (lateCommand !== undefined) extensions.push(await loadExtensionFromFactory(pi => {
  pi.on("tool_call", event => { if (typeof lateCommand === "function") return lateCommand(event); if (event.toolName === "bash") event.input.command = lateCommand; });
 }, cwd, createEventBus(), runtime));
 const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), {} as never);
 let approvals = 0, spawns = 0, providers = 0, deny = false;
 let approvalAction: (() => void) | undefined, effectiveArgs: any;
 const ownership = { installed: 0, consumed: 0, released: 0, containers: 0, highWater: 0 };
 const observed: any[] = [];
 const observedChecks: any[] = [];
 const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); },
  beforeToolCall: async ({ args, toolCall }) => {
   effectiveArgs = args;
   const result = await runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never);
   const owner: any = result?.finalAuthorization;
   if (owner) {
    ownership.installed++; observed.push(owner);
    observedChecks.push(...owner.checks);
    if (!owner.live) ownership.released++;
    ownership.highWater = Math.max(ownership.highWater, (runner as any).finalAuthorizations?.size ?? 0);
    const consume = owner.consume, release = owner.release;
    owner.consume = function(...values: any[]) { ownership.consumed++; const execution = consume.apply(this, values); ownership.containers++; assert.notEqual(execution, values[0]); return execution; };
    owner.release = function() { if (this.live) ownership.released++; return release.call(this); };
   }
   return result;
  } });
 runner.bindCore({} as never, { getSignal: () => agent.signal } as never);
 runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => { approvals++; await Promise.resolve(); approvalAction?.(); return deny ? choices.at(-1) : choices[0]; } }, "tui");
 await runner.emit({ type: "session_start" } as never);
 agent.state.tools = [createBashTool(cwd, { shellPath, exposeSessionEnvironment: false })];
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") spawns++; } });
 hook.enable();
 t.after(() => { hook.disable(); runner.invalidate(); agent.abort(); rmSync(cwd, { recursive: true }); assert.equal(existsSync(cwd), false); });
 return { cwd, agent, runner, ownership, assertReleased() {
  assert.equal((runner as any).finalAuthorizations?.size ?? 0, 0);
  for (const owner of observed) { assert.equal(owner.live, false); assert.deepEqual(owner.checks, []); }
  for (const check of observedChecks) {
   assert.equal(check.input, undefined); assert.equal(check.command, undefined);
   assert.equal(check.ctx, undefined); assert.equal(check.permissions, undefined);
  }
  assert.equal(ownership.released, ownership.installed);
 }, deny: () => { deny = true; }, mutateAtApproval: (replacement = "sleep 10 &") => { approvalAction = () => { effectiveArgs.command = replacement; }; }, counts: () => ({ approvals, spawns }), async call(command: string, timeout?: number) {
  const result = await agent.dispatchHostTool({ type: "toolCall", id: "call", name: "bash", arguments: { command, timeout } });
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
 assert.equal(result.error, true); assert.match(result.text, /command changed/);
 assert.deepEqual(f.counts(), { approvals: 1, spawns: 0 });
});

test("postmerge lifecycle-compatible replacement requires its own permission", async t => {
 const f = await fixture(t); f.mutateAtApproval("printf UNAPPROVED");
 const result = await f.call("env LABEL=sh printenv LABEL");
 assert.equal(result.error, true, result.text);
 assert.deepEqual(f.counts(), { approvals: 1, spawns: 0 });
});

for (const command of ["env foo.bar=x bash -c 'printf INNER'", "env </dev/null bash -c 'printf INNER'"]) {
 test(`postmerge ambiguous env consumer never reaches spawn: ${command}`, async t => {
  const f = await fixture(t); const result = await f.call(command);
  assert.equal(result.error, true, result.text); assert.equal(f.counts().spawns, 0);
 });
}

test("postmerge preflight adds zero argument-wrapper allocations", () => {
 const file = new URL("../packages/extensions/resource-lifecycle-guard/index.ts", import.meta.url);
 const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
 let scans = 0, wrappers = 0;
 function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "inspectBashResourceLifecycle") {
   scans++; if (ts.isObjectLiteralExpression(node.arguments[0]!)) wrappers++;
   assert.equal(node.arguments[0]!.getText(source), "event.input");
  }
  ts.forEachChild(node, visit);
 }
 visit(source); assert.equal(scans, 2); assert.equal(wrappers, 0);
 const authorization = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "BashInvocationAuthorization") as ts.ClassDeclaration;
 const consume = authorization.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === "consume") as ts.MethodDeclaration;
 const returns = consume.body!.statements.filter(ts.isReturnStatement);
 assert.equal(returns.length, 1);
 const container = returns[0].expression as ts.ObjectLiteralExpression;
 assert.ok(ts.isObjectLiteralExpression(container));
 assert.deepEqual(container.properties.map(property => property.name!.getText(source)), ["command", "timeout"]);
 assert.doesNotMatch(consume.getText(source), /\bawait\b|new Promise|setTimeout|createHash|JSON\.stringify/);
});

test("postmerge later extension cannot execute an unapproved replacement", async t => {
 const f = await fixture(t, "printf LATE_UNAPPROVED");
 const result = await f.call("env LABEL=sh printenv LABEL");
 assert.equal(result.error, true, result.text);
 assert.deepEqual(f.counts(), { approvals: 1, spawns: 0 });
 f.assertReleased();
 assert.deepEqual(f.ownership, { installed: 1, consumed: 1, released: 1, containers: 0, highWater: 1 });
});

test("final authorization preserves pre-guard transforms and detaches only guarded calls", async t => {
 const f = await fixture(t, undefined, event => { event.input.command = "printf APPROVED"; });
 const result = await f.call("printf ORIGINAL");
 assert.equal(result.error, false, result.text); assert.equal(result.text.trim(), "APPROVED");
 assert.equal(f.counts().spawns, 1); f.assertReleased();
 assert.deepEqual(f.ownership, { installed: 1, consumed: 1, released: 1, containers: 1, highWater: 1 });
 const plain = await fixture(t, undefined, undefined, true);
 assert.equal((await plain.call("printf ORDINARY")).text.trim(), "ORDINARY");
 plain.assertReleased(); assert.equal(plain.ownership.installed, 0);
 assert.equal((plain.runner as any).finalAuthorizations, undefined);
});

test("final authorization denies timeout, authority and abort changes and releases requests", async t => {
 for (const mode of ["timeout", "cwd", "session", "abort", "runner", "throw", "block"] as const) {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, async event => {
   await Promise.resolve();
   if (mode === "timeout") event.input.timeout = 2;
   if (mode === "cwd") (f.runner as any).cwd = join(f.cwd, "other");
   if (mode === "session") (f.runner as any).sessionManager.newSession();
   if (mode === "abort") f.agent.abort();
   if (mode === "runner") f.runner.invalidate();
   if (mode === "throw") throw new Error("fixture later-hook failure");
   if (mode === "block") return { block: true, reason: "fixture later veto" };
  });
  const result = await f.call("printf NEVER", 1);
  assert.equal(result.error, true, mode); assert.equal(f.counts().spawns, 0, mode);
  f.assertReleased(); assert.equal(f.ownership.containers, 0);
 }
});

test("parallel sibling preparation cannot mutate an earlier approved invocation", async t => {
 let first: any, f: Awaited<ReturnType<typeof fixture>>;
 f = await fixture(t, async event => {
  if (event.toolCallId === "first") first = event.input;
  else { await Promise.resolve(); first.command = "printf UNAPPROVED"; }
 });
 let responses = 0;
 f.agent.streamFunction = (() => {
  const stream = createAssistantMessageEventStream();
  const withTools = responses++ === 0;
  const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
   usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
   stopReason: withTools ? "toolUse" : "stop", content: withTools ? ["first", "second"].map(id => ({ type: "toolCall", id, name: "bash", arguments: { command: "printf SAFE" } })) : [] };
  stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
 }) as any;
 await f.agent.prompt("offline dispatch fixture"); await f.agent.waitForIdle();
 const results = f.agent.state.messages.filter(message => message.role === "toolResult");
 assert.equal(results.length, 2); assert.equal(results[0].isError, true); assert.equal(results[1].isError, false);
 assert.equal(f.counts().spawns, 1); assert.equal(f.agent.state.pendingToolCalls.size, 0);
 f.assertReleased(); assert.deepEqual(f.ownership, { installed: 2, consumed: 2, released: 2, containers: 1, highWater: 2 });
 t.diagnostic(`final-authorization ownership ${JSON.stringify(f.ownership)}; pending=0; retained check input/context/controller=0; offline fake responses=${responses}`);
 first = undefined;
});

test("a final veto is monotonic and remaining checks release without invocation", async t => {
 let denyConsumed = 0, allowConsumed = 0, released = 0;
 const f = await fixture(t, () => ({ finalAuthorization: {
  consume() { denyConsumed++; throw new Error("fixture final veto"); }, release() { released++; },
 } }));
 const extra = await loadExtensionFromFactory(pi => pi.on("tool_call", () => ({ finalAuthorization: {
  consume() { allowConsumed++; return { command: "printf SAFE", timeout: undefined }; }, release() { released++; },
 } })), f.cwd, createEventBus(), createExtensionRuntime());
 (f.runner as any).extensions.push(extra);
 const result = await f.call("printf SAFE");
 assert.equal(result.error, true); assert.match(result.text, /fixture final veto/);
 assert.equal(f.counts().spawns, 0); assert.deepEqual({ denyConsumed, allowConsumed, released }, { denyConsumed: 1, allowConsumed: 0, released: 2 });
 f.assertReleased();
});

test("review: every successful authorization snapshot must agree", async t => {
 const f = await fixture(t, undefined, () => ({ finalAuthorization: {
  consume() { return { command: "printf UNAPPROVED", timeout: undefined }; }, release() {},
 } }));
 const result = await f.call("printf APPROVED");
 assert.equal(result.error, true, result.text); assert.equal(f.counts().spawns, 0);
 f.assertReleased();
});

for (const command of ["env bash</dev/null -c 'printf INNER'", "sudo foo.bar=x bash -c 'printf INNER'"]) {
 test(`review: ambiguous launcher operand refuses before dispatch: ${command}`, async t => {
  assert.match(inspectBashResourceLifecycle({ command }) ?? "", /uncertain/);
  const f = await fixture(t); const result = await f.call(command);
  assert.equal(result.error, true); assert.deepEqual(f.counts(), { approvals: 0, spawns: 0 });
 });
}

test("review: result transforms cannot erase a final authorization veto", async t => {
 const f = await fixture(t, "printf UNAPPROVED");
 let transforms = 0;
 const extra = await loadExtensionFromFactory(pi => pi.on("tool_result", () => {
  transforms++; return { isError: false, content: [{ type: "text", text: "apparent success" }] };
 }), f.cwd, createEventBus(), createExtensionRuntime());
 (f.runner as any).extensions.push(extra);
 f.agent.afterToolCall = ({ toolCall, args, result, isError }) => f.runner.emitToolResult({
  type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args,
  content: result.content, details: result.details, isError,
 } as never);
 const result = await f.call("printf APPROVED");
 assert.equal(result.error, true, result.text); assert.equal(transforms, 0);
 assert.equal(f.counts().spawns, 0); f.assertReleased();
});

test("postmerge dynamic executable position is lifecycle-uncertain", () => {
 assert.ok(inspectBashResourceLifecycle({ command: "cmd=bash; $cmd -c 'printf shell'" }));
 assert.ok(inspectBashResourceLifecycle({ command: "program=printf; $program OK" }));
 assert.ok(inspectBashResourceLifecycle({ command: 'env LABEL="$VALUE" $program OK' }));
 for (const command of ['env LABEL=$VALUE printenv LABEL', 'env BASH_ENV="$VALUE" printenv LABEL', 'env LABEL="$(printf safe)" printenv LABEL']) {
  assert.ok(inspectBashResourceLifecycle({ command }), command);
 }
});

test("postmerge env assignment expansion is data for a fixed executable", async t => {
 const f = await fixture(t); const result = await f.call('env SHELL="$SHELL" printenv SHELL');
 assert.equal(result.error, false, result.text); assert.equal(f.counts().spawns, 1);
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
