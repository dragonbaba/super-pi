import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { Agent } from "../packages/agent/src/agent.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { getShellConfig } from "../packages/coding-agent/src/utils/shell.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { extractCommandSubstitutions } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
const jiti = createJiti(import.meta.url);
const { default: guard } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: loopGuardrails } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
const { failureRecoveryHint, classifyFailureText } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const shellPath = process.platform === "win32" && existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : getShellConfig().shell;

async function fixture(t: test.TestContext, lateCommand?: string | ((event: any) => any), before?: (event: any) => any, noGuard = false, profileBackend?: any) {
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
   if (owner && !profileBackend) {
    ownership.installed++; observed.push(owner);
    observedChecks.push(...owner.checks);
    if (owner.authority) observedChecks.push(owner.authority);
    if (!owner.live) ownership.released++;
    ownership.highWater = Math.max(ownership.highWater, (runner as any).finalAuthorizations?.size ?? 0);
    const consume = owner.consume, release = owner.release;
    owner.consume = function(...values: any[]) { ownership.consumed++; const execution = consume.apply(this, values); ownership.containers++; assert.notEqual(execution, values[0]); return execution; };
    owner.release = function() { if (this.live) ownership.released++; return release.call(this); };
   }
   return result;
  } });
 runner.bindCore({ getThinkingLevel: () => "off" } as never, {
  getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
  getScopedModels: () => [], isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
 } as never);
 runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => { approvals++; await Promise.resolve(); approvalAction?.(); return deny ? choices.at(-1) : choices[0]; } }, "tui");
 await runner.emit({ type: "session_start" } as never);
 agent.state.tools = [createBashTool(cwd, { shellPath, exposeSessionEnvironment: false, operations: profileBackend })];
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") spawns++; } });
 hook.enable();
 t.after(() => { hook.disable(); runner.invalidate(); agent.abort(); rmSync(cwd, { recursive: true }); assert.equal(existsSync(cwd), false); });
 return { cwd, agent, runner, ownership, assertReleased() {
  assert.equal((runner as any).finalAuthorizations?.size ?? 0, 0);
  for (const owner of observed) { assert.equal(owner.live, false); assert.deepEqual(owner.checks, []); assert.equal(owner.authority, undefined); }
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
 const containers: ts.ObjectLiteralExpression[] = [];
 function findContainer(node: ts.Node) {
  if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) containers.push(node.expression);
  ts.forEachChild(node, findContainer);
 }
 findContainer(consume);
 assert.equal(containers.length, 1);
 assert.deepEqual(containers[0].properties.map(property => property.name!.getText(source)), ["command", "timeout", "cwd", "purpose"]);
 assert.doesNotMatch(consume.getText(source), /\bawait\b|new Promise|setTimeout|createHash|JSON\.stringify/);
 const runnerText = readFileSync(new URL("../packages/coding-agent/src/core/extensions/runner.ts", import.meta.url), "utf8");
 assert.equal(runnerText.match(/const approved = authority\.consume/g)?.length, 1);
 assert.ok(runnerText.indexOf("finally { check.release(); }") < runnerText.indexOf("const approved = authority.consume"));
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

test("review: agreeing snapshots cannot be changed by a release callback", async t => {
 const snapshot = { command: "printf APPROVED", timeout: undefined };
 const f = await fixture(t, undefined, () => ({ finalAuthorization: {
  consume() { return snapshot; }, release() { snapshot.command = "printf UNAPPROVED"; },
 } }));
 const result = await f.call("printf APPROVED");
 assert.equal(result.error, false, result.text); assert.equal(result.text.trim(), "APPROVED");
 assert.equal(f.counts().spawns, 1); f.assertReleased();
});

for (const phase of ["consume", "release"]) test(`review: authority is current after every ${phase} callback`, async t => {
 let f: Awaited<ReturnType<typeof fixture>>;
 f = await fixture(t, () => ({ finalAuthorization: {
  consume() { if (phase === "consume") (f.runner as any).cwd = join(f.cwd, "obsolete"); return { command: "printf SAFE", timeout: undefined }; },
  release() { if (phase === "release") (f.runner as any).cwd = join(f.cwd, "obsolete"); },
 } }));
 const result = await f.call("printf SAFE");
 assert.equal(result.error, true, result.text); assert.equal(f.counts().spawns, 0); f.assertReleased();
});

test("review: actual registered scoped Bash retains its requested cwd", async t => {
 const f = await fixture(t);
 const child = join(f.cwd, "selected-child"); mkdirSync(child);
 const registered = await loadExtensionFromFactory(loopGuardrails, f.cwd, createEventBus(), createExtensionRuntime());
 const definition = registered.tools.get("bash")!.definition;
 f.agent.state.tools = [wrapToolDefinition(definition, () => f.runner.createContext())];
 const result = await f.agent.dispatchHostTool({ type: "toolCall", id: "cwd-call", name: "bash",
  arguments: { command: "pwd", cwd: child, purpose: "confirm selected directory" } });
 const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
 assert.equal(result.isError, false, text);
 assert.match(text, /selected-child/); assert.equal(f.counts().spawns, 1); f.assertReleased();
});

test("review: a second terminal authority claim cannot override the real guard", async t => {
 const f = await fixture(t, undefined, () => ({ finalAuthorization: {
  finalAuthority: true as const, consume() { return { command: "printf UNAPPROVED" }; }, release() {},
 } }));
 const result = await f.call("printf SAFE");
 assert.equal(result.error, true); assert.match(result.text, /conflicting final authority/);
 assert.equal(f.counts().spawns, 0); f.assertReleased();
});

test("review: scoped cwd and purpose cannot change after approval", async t => {
 for (const field of ["cwd", "purpose"]) {
  const f = await fixture(t, event => { event.input[field] = "changed"; });
  const result = await f.call("printf SAFE");
  assert.equal(result.error, true); assert.equal(f.counts().spawns, 0); f.assertReleased();
 }
});

test("review: brace-expanded launcher assignments cannot select an uninspected executable", async t => {
 const f = await fixture(t);
 const result = await f.call("env {LABEL=x,bash,-c,'printf INNER'} true");
 assert.equal(result.error, true, result.text); assert.equal(f.counts().spawns, 0);
 for (const command of ["env {LABEL=x,bash,-c,'sleep 10 &'} true", "sudo {LABEL=x,bash,-c,'sleep 10 &'} true"]) {
  assert.match(inspectBashResourceLifecycle({ command }) ?? "", /uncertain/);
 }
 const literal = await f.call("env LABEL='{a,b}' printenv LABEL");
 assert.equal(literal.error, false, literal.text); assert.equal(literal.text.trim(), "{a,b}");
 assert.equal(f.counts().spawns, 1);
});

test("final authorization bounded paired allocation sample", async t => {
 // One fixed workload. Fake backend excludes child startup while retaining the
 // real Agent/runner/guard/Bash invocation and result-delivery chain. No network.
 const warmup = 16, samples = 256, samplingInterval = 1024;
 let effects = 0;
 const backend = { async exec() { effects++; return { exitCode: 0 }; } };
 const guarded = await fixture(t, undefined, undefined, false, backend);
 const ordinary = await fixture(t, undefined, undefined, true, backend);
 for (let i = 0; i < warmup; i++) { await guarded.call("printf SAFE"); await ordinary.call("printf SAFE"); }
 const inspector = new Session(); inspector.connect();
 const guardedMs: number[] = [], ordinaryMs: number[] = [];
 let profile: any;
 try {
  await inspector.post("HeapProfiler.enable");
  await inspector.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < samples; i++) {
   let started = performance.now(); assert.equal((await guarded.call("printf SAFE")).error, false); guardedMs.push(performance.now() - started);
   started = performance.now(); assert.equal((await ordinary.call("printf SAFE")).error, false); ordinaryMs.push(performance.now() - started);
  }
  profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
  await inspector.post("HeapProfiler.disable");
 } finally { inspector.disconnect(); }
 let sampledBytes = 0, authorizationSiteBytes = 0;
 const stack = [profile.head];
 while (stack.length) {
  const node = stack.pop(); sampledBytes += node.selfSize;
  if (["BashInvocationAuthorization", "PendingToolAuthorization", "consume", "emitToolCall"].includes(node.callFrame.functionName)) authorizationSiteBytes += node.selfSize;
  for (const child of node.children) stack.push(child);
 }
 profile = undefined;
 guardedMs.sort((a,b) => a-b); ordinaryMs.sort((a,b) => a-b);
 const p50 = Math.floor(samples * 0.5), p95 = Math.floor(samples * 0.95);
 guarded.assertReleased(); ordinary.assertReleased();
 assert.equal(effects, 2 * (warmup + samples)); assert.ok(sampledBytes > 0);
 assert.equal(guarded.counts().spawns, 0); assert.equal(ordinary.counts().spawns, 0);
 t.diagnostic(`final-authorization allocation ${JSON.stringify({ node: process.version, platform: process.platform,
  warmup, samples, samplingInterval, effects, sampledBytes, authorizationSiteBytes,
  guardedP50Ms: guardedMs[p50], guardedP95Ms: guardedMs[p95], ordinaryP50Ms: ordinaryMs[p50], ordinaryP95Ms: ordinaryMs[p95],
  pending: 0, retainedCheckReferences: 0, providerTraffic: 0 })}; sampled allocations under profiling, not total allocation/retained heap or native process latency`);
 // Gross regression ceilings derived with margin from the first Windows/Linux
 // samples, not a claim that noisy sampled bytes or timings are exact totals.
 assert.ok(authorizationSiteBytes > 0, "authorization allocation sites must be sampled");
 assert.ok(authorizationSiteBytes / samples <= 8192, "authorization sites exceeded 8 KiB sampled bytes per guarded call");
 assert.ok(guardedMs[p50] - ordinaryMs[p50] <= 5, "guarded profiling p50 delta exceeded 5 ms");
 assert.ok(guardedMs[p95] - ordinaryMs[p95] <= 10, "guarded profiling p95 delta exceeded 10 ms");
});

for (const command of ["env bash</dev/null -c 'printf INNER'", "bash</dev/null -c 'printf INNER'", "sudo foo.bar=x bash -c 'printf INNER'"]) {
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
 const ordinary = await f.call("printf UNAPPROVED"); // unchanged for this separate authorized call
 assert.equal(ordinary.error, false); assert.equal(ordinary.text, "apparent success");
 assert.equal(transforms, 1); assert.equal(f.counts().spawns, 1); f.assertReleased();
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
