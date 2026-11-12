import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { emitSessionShutdownEvent } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { getToolPath } from "../packages/coding-agent/src/utils/tools-manager.ts";

const owned = createOwnedTaskFixture("subagent-parent-execution-"), agentDir = join(owned.root, "agent");
const keys = ["TMP", "TEMP", "TMPDIR", "SP_CODING_AGENT_DIR", "SP_SOURCE_LAUNCHER", "SP_BUNDLED_AGENTS_DIR", "SP_OFFLINE"];
const old = keys.map(key => process.env[key]);
for (const key of keys.slice(0, 3)) process.env[key] = owned.root;
process.env.SP_CODING_AGENT_DIR = agentDir;
process.env.SP_OFFLINE = "1";
process.env.SP_SOURCE_LAUNCHER = fileURLToPath(new URL("fixtures/subagent-parent-cli.mjs", import.meta.url));
delete process.env.SP_BUNDLED_AGENTS_DIR;
mkdirSync(join(agentDir, "agents"), { recursive: true }); mkdirSync(join(agentDir, "config"));
writeFileSync(join(agentDir, "agents", "reader.md"), "---\nname: reader\ndescription: Owned fixture\n---\nRead the assigned fixture.");
writeFileSync(join(agentDir, "agents", "writer.md"), "---\nname: writer\ndescription: Owned fixture\ntools: read,find,write,edit,delete,move,file_batch,bash,powershell\n---\nExecute the assigned fixture.");
const { default: subagent } = await import("../packages/extensions/subagent/index.ts");
test.after(async () => {
  await disposeNativeFileWorker();
  keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  owned.cleanup();
});

async function fixture(t: test.TestContext, environment?: "trusted-host" | "sandbox", hasUI = true, shellCommandPrefix?: string, mode: "host-write" | "read-only" | "sandbox-write" = "host-write") {
  const root = await fs.realpath(await fs.mkdtemp(join(owned.root, "case-"))), cwd = join(root, "project 中文 space");
  await fs.mkdir(cwd); await fs.writeFile(join(cwd, "sample.txt"), "marker\n");
  await fs.writeFile(join(agentDir, "config", "settings.json"), JSON.stringify({ executionEnvironment: environment, compaction: { enabled: false },
    powershellStatus: mode === "host-write" ? undefined : { available: false } }));
  const settings = SettingsManager.inMemory({ executionEnvironment: environment, shellCommandPrefix, compaction: { enabled: false }, retry: { enabled: false }, executionPermissions: { rules: [{ tool: "*", decision: "allow" }] } });
  settings.setPermissionModeForSession(mode);
  const additional = join(root, "Assets 中文 ' space");
  if (mode !== "host-write") {
    await fs.mkdir(additional); await fs.writeFile(join(additional, "sample.txt"), "additional marker\n");
    settings.setSessionDirectories([await fs.realpath(additional)]);
  }
  // Prefix compatibility also exercises the same Windows directory with a different spelling.
  const sessionCwd = shellCommandPrefix && process.platform === "win32" ? cwd.toUpperCase() : cwd;
  const resources = new DefaultResourceLoader({ cwd: sessionCwd, agentDir, settingsManager: settings, noExtensions: true,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [subagent] });
  await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: sessionCwd, agentDir, resourceLoader: resources, settingsManager: settings,
    sessionManager: SessionManager.create(sessionCwd, join(root, "sessions")), model: ALPHA_MODEL, modelRuntime: alphaModelRuntime() });
  const runtime = resources.getExtensions().runtime, notices: string[] = []; let dialogs = 0, requests = 0;
  await session.bindExtensions(hasUI ? { mode: "tui", uiContext: { notify: (text: string) => { notices.push(text); },
    select: async (_title: string, choices: string[]) => { dialogs++; return choices[0]; } } as any } : { mode: "print" });
  t.after(async () => {
    session.agent.abort(); await session.agent.waitForIdle();
    await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
    session.dispose(); await runtime.executionBoundary.dispose(); await runtime.nativeFiles?.dispose(); await runtime.nativeTasks?.dispose();
    await session.waitForSessionLeaseRelease();
  });
  async function run(code: string, agent = "reader", childCwd = cwd, extraArguments: Record<string, unknown> = {}) {
    await fs.writeFile(join(childCwd, "child-request.json"), JSON.stringify({ code, temp: owned.root }));
    let first = true;
    session.agent.streamFunction = () => {
      requests++;
      const content = first ? [{ type: "toolCall", id: "parent-delegation", name: "subagent", arguments: { agent, task: "Run the owned fixture", scope: "Owned fixture files", deliverable: "Tool receipts", stopCondition: "Return after the fixture code", cwd: childCwd, timeoutMs: 60000, ...extraArguments } }]
        : [{ type: "text", text: "Parent complete" }];
      const stopReason = first ? "toolUse" : "stop"; first = false;
      const message: any = { role: "assistant", api: "openai-responses", provider: "fixture", model: ALPHA_MODEL.id, content, stopReason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: stopReason, message }); return stream;
    };
    await session.prompt("Run owned subagent");
    const result = session.agent.state.messages.filter(message => message.role === "toolResult").at(-1);
    return result;
  }
  return { root, cwd, additional, session, runtime, notices, run, get requests() { return requests; }, get dialogs() { return dialogs; },
    async observations(path = cwd) { return (await fs.readFile(join(path, "child-observation.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); } };
}

const liveSandbox = process.platform === "win32" && process.env.SUPERPI_MXC_LIVE === "1";
test("PowerShell-only MXC roles keep writer admission and never expose Bash", async () => {
  const { assertSubagentBatchPreflight, effectiveTools } = await import("../packages/extensions/subagent/index.ts");
  const agent: any = { name: "shell", source: "user", tools: ["powershell"] };
  const policy: any = { source: "primary", canonicalCwd: owned.root, allowMutation: true, sharedParentScope: true,
    parentExecution: { profile: { mode: "sandbox-write" } } };
  assertSubagentBatchPreflight([agent], ["shell"], [policy], false);
  assert.equal(policy.allowMutation, true, "PowerShell is a writer capability even without file tools");
  assert.throws(() => assertSubagentBatchPreflight([agent], ["shell", "shell"], [policy, { ...policy }], true), /Parallel mutation/);
  assert.deepEqual(effectiveTools({ ...agent, tools: ["bash", "powershell"] }, true, "sandbox-write"), { tools: ["powershell"], allowBash: false });
  assert.deepEqual(effectiveTools(agent, false, "read-only"), { tools: [], allowBash: false });
});

test("live sandbox parent shares one MXC owner with real read-only children and drains concurrent calls", { skip: !liveSandbox, timeout: 240000 }, async t => {
  const f = await fixture(t, "trusted-host", false, undefined, "read-only");
  assert.ok(f.session.getAllTools().some(tool => tool.name === "subagent"));
  const task = { agent: "reader", task: "Read fixture", scope: "Owned files", deliverable: "Read receipt", stopCondition: "After read", cwd: f.cwd };
  const start = performance.now();
  const result = await f.run('console.log(await tools.read({path:"sample.txt"})); console.log(await tools.ls({}));', "reader", f.cwd,
    { agent: undefined, task: undefined, tasks: [task, task], timeoutMs: 180000 });
  assert.equal((result as any)?.isError, false, JSON.stringify(result));
  const entries = await f.observations(), owner = (f.session as any)._workspaceSandbox;
  assert.equal(entries.filter(entry => entry.event === "start").length, 2);
  assert.ok(entries.filter(entry => entry.event === "profile").every(entry => entry.profile.mode === "read-only" && !entry.profile.writable));
  assert.ok(entries.filter(entry => entry.event === "result").every(entry => !entry.isError), JSON.stringify(entries));
  assert.equal(owner.diagnostics.starts, 1); assert.equal(owner.diagnostics.highWaterMark, 1); assert.ok(owner.diagnostics.queueHighWaterMark >= 1);
  assert.equal(owner.diagnostics.reservations, 0); assert.equal(await fs.readFile(join(f.cwd, "sample.txt"), "utf8"), "marker\n");
  t.diagnostic(JSON.stringify({ mode: "read-only", children: 2, mxcStarts: 1, elapsedMs: performance.now() - start, ...owner.diagnostics }));
});

test("live sandbox-write child uses literal additional cwd and writes directly through its parent MXC owner", { skip: !liveSandbox, timeout: 240000 }, async t => {
  const f = await fixture(t, "trusted-host", false, undefined, "sandbox-write"), owner = (f.session as any)._workspaceSandbox;
  const result = await f.run(`const r=await tools.read({path:"sample.txt"}); console.log(await tools.write({path:"sample.txt",content:"child published",snapshot:r.details.snapshot})); console.log(await tools.powershell({command:"(Get-Location).Path",cwd:${JSON.stringify(f.additional)}})); console.log(await tools.write({path:"target/local.txt",content:"host workspace"})); console.log(await tools.find({path:"target",pattern:"local"}));`, "writer", f.cwd, { timeoutMs: 180000 });
  assert.equal((result as any)?.isError, false, JSON.stringify(result));
  const entries = await f.observations();
  assert.equal(entries.find(entry => entry.event === "profile").profile.mode, "sandbox-write");
  const tools = entries.filter(entry => entry.event === "result" && entry.name !== "codemode");
  assert.ok(tools.every(entry => !entry.isError), JSON.stringify(entries)); assert.equal(tools.length, 5, JSON.stringify(entries));
  assert.match(JSON.stringify(tools.find(entry => entry.name === "powershell").content), /Assets 中文 ' space/);
  assert.equal(await fs.readFile(join(f.cwd, "sample.txt"), "utf8"), "child published");
  assert.equal(await fs.readFile(join(f.cwd, "target", "local.txt"), "utf8"), "host workspace");
  assert.equal(owner.diagnostics.starts, 1); assert.equal(owner.diagnostics.reservations, 0);
  t.diagnostic(JSON.stringify({ mode: "sandbox-write", parentDirectWrite: true, literalAdditionalCwd: true, privateDirectories: false, ...owner.diagnostics }));
});

test("live parent pause cancels a real child command and queued MXC request before a fresh user restart", { skip: !liveSandbox, timeout: 240000 }, async t => {
  const f = await fixture(t, "trusted-host", false, undefined, "sandbox-write"), owner = (f.session as any)._workspaceSandbox;
  const backend = owner.backend, boundary = f.runtime.executionBoundary;
  // A task-owned workspace marker confirms the real command started.
  const command = `[IO.File]::WriteAllText((Join-Path $PWD "command-started.txt"),"started"); Start-Sleep 30`;
  const running = f.run(`await tools.read({path:"sample.txt"}); await tools.powershell({command:${JSON.stringify(command)}}); await tools.write({path:"after-pause.txt",content:"must not run"});`, "writer", f.cwd, { timeoutMs: 180000 });
  const observedRun = Promise.allSettled([running]);
  let started = false;
  for (let i = 0; i < 600; i++) {
    if (backend.root) {
      try { started = await fs.readFile(join(f.cwd, "command-started.txt"), "utf8") === "started"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (started) break; await delay(50);
  }
  assert.equal(started, true, "MXC command must actually start before cancellation");
  const scope = f.session.agent.createDelegatedToolDispatch("parent-queued", boundary.signal, () => {}, [...(f.session as any)._toolRegistry.values()]);
  const queued = Promise.allSettled([scope.callTool("read", { path: "sample.txt" })]);
  for (let i = 0; owner.diagnostics.queued === 0 && i < 100; i++) await delay(10);
  assert.equal(owner.diagnostics.queued, 1);
  const calls = owner.diagnostics.calls;
  await boundary.pauseForUser(); await observedRun; await queued; await scope.close();
  assert.equal(boundary.requiresUserInput, true); assert.equal(owner.diagnostics.calls, calls);
  assert.equal(owner.diagnostics.process.active, false); assert.equal(owner.diagnostics.ownedArtifacts, 0);
  assert.equal(owner.diagnostics.active, 0); assert.equal(owner.diagnostics.queued, 0); assert.equal(owner.diagnostics.reservations, 0);
  await assert.rejects(fs.stat(join(f.cwd, "after-pause.txt")), { code: "ENOENT" });
  const result = await f.run('console.log(await tools.read({path:"sample.txt"}));', "reader", f.cwd, { timeoutMs: 180000 });
  assert.equal((result as any)?.isError, false, JSON.stringify(result)); assert.equal(owner.diagnostics.starts, 1);
  t.diagnostic(JSON.stringify({ mxcCommandStarted: true, pausedProcessReleased: true, queuedBackendCalls: 0, afterPauseWrites: 0, reusedPolicyOwner: true }));
});

test("real CLI children inherit explicit host mode across all global defaults and use parent read tools", { timeout: 90000 }, async t => {
  for (const environment of [undefined, "trusted-host", "sandbox"] as const) {
    await t.test(String(environment), async t => {
      const f = await fixture(t, environment);
      const available = { grep: getToolPath("rg") !== null, find: getToolPath("fd") !== null };
      const result = await f.run('console.log(await tools.read({path:"sample.txt"})); console.log(await callTool("grep",{pattern:"marker",path:"sample.txt"},{allowFailure:true})); console.log(await callTool("find",{pattern:"sample.txt"},{allowFailure:true})); console.log(await tools.ls({}));');
      assert.equal((result as any)?.isError, false, JSON.stringify(result));
      const entries = await f.observations();
      assert.equal(entries.find(entry => entry.event === "profile").profile.mode, "host-write");
      assert.deepEqual(entries.find(entry => entry.event === "runtime"), { event: "runtime", parent: true, files: true, tasks: false, permissions: false });
      const calls = entries.filter(entry => entry.event === "result" && entry.name !== "codemode");
      assert.deepEqual(calls.map(entry => entry.name), ["read", "grep", "find", "ls"]);
      for (const call of calls) {
        const missing = call.name === "grep" && !available.grep ? "ripgrep (rg)" : call.name === "find" && !available.find ? "fd" : undefined;
        assert.equal(call.isError, missing !== undefined, JSON.stringify(call));
        if (missing) assert.ok(JSON.stringify(call.content).includes(missing + " is not available and could not be downloaded"), JSON.stringify(call));
      }
      t.diagnostic(JSON.stringify({ searchDependencies: available, parentToolCalls: calls.length }));
      assert.equal(f.dialogs, 0); assert.equal(f.requests, 2);
    });
  }
});

test("real child external delete asks parent, protected delete refuses, and D6 asks for agent modification", { timeout: 60000 }, async t => {
  const f = await fixture(t), outside = join(f.root, "delete.txt"), config = join(agentDir, "note.txt");
  await fs.writeFile(outside, "delete owned fixture"); await fs.writeFile(config, "old");
  const result = await f.run(`console.log(await tools.delete({path:${JSON.stringify(outside)}})); console.log(await callTool("delete", {path:${JSON.stringify(f.cwd)}}, {allowFailure:true})); console.log(await callTool("file_batch", {operations:[{operation:"write",path:${JSON.stringify(join(agentDir, "config", "auth.json"))},mode:"overwrite",content:"forbidden"}]}, {allowFailure:true})); await tools.read({path:${JSON.stringify(config)}}); console.log(await tools.write({path:${JSON.stringify(config)},content:"changed"})); console.log(await tools.bash({command:"printf 'relay cwd\\n'; pwd"}));`, "writer");
  assert.equal((result as any)?.isError, false, JSON.stringify(result));
  const entries = await f.observations();
  assert.equal(entries.find(entry => entry.event === "result" && entry.name === "write")?.isError, false, JSON.stringify(entries));
  const shell = entries.find(entry => entry.event === "result" && entry.name === "bash");
  assert.equal(shell?.isError, false, JSON.stringify(shell)); assert.match(JSON.stringify(shell.content), /project 中文 space/);
  assert.match(JSON.stringify(entries.find(entry => entry.event === "result" && entry.name === "codemode")?.content), /authentication storage/);
  await assert.rejects(fs.stat(outside), { code: "ENOENT" }); assert.equal(await fs.readFile(config, "utf8"), "changed");
  assert.equal(f.dialogs, 2); assert.match(f.notices.join("\n"), /操作未执行/);
  assert.equal(f.runtime.executionBoundary.requiresUserInput, false);
});

test("parent cwd preserves configured Bash prefixes without bypassing explicit cwd restrictions", { timeout: 60000 }, async t => {
  const f = await fixture(t, undefined, true, "printf 'configured-prefix\\n';");
  await f.run('console.log(await tools.bash({command:"printf \'ordinary-command\\n\'"})); console.log(await callTool("bash",{command:"printf \'must-not-run\\n\'",cwd:"."},{allowFailure:true}));', "writer");
  const entries = await f.observations(), shell = entries.find(entry => entry.event === "result" && entry.name === "bash");
  assert.equal(shell?.isError, false, JSON.stringify(entries));
  assert.match(JSON.stringify(shell.content), /configured-prefix.*ordinary-command/);
  assert.match(JSON.stringify(entries.find(entry => entry.event === "result" && entry.name === "codemode")?.content), /SHELL_CWD_UNSUPPORTED/);
});

test("native delegated writer admission uses parent scope instead of disjoint assigned directories", async t => {
  const f = await fixture(t), first = join(f.root, "first"), second = join(f.root, "second");
  await fs.mkdir(first); await fs.mkdir(second);
  const result = await f.run('await tools.write({path:"must-not-exist.txt",content:"no"});', "writer", first, { background: true });
  assert.match(JSON.stringify(result), /Parent-routed writers.*foreground/);
  await assert.rejects(fs.stat(join(first, "child-observation.jsonl")), { code: "ENOENT" });
  // The production delegation materializes scheduler scope for both native grants.
  const call = { type: "tool_call", toolName: "subagent", toolCallId: "scoped-batch", input: {
    tasks: [{ agent: "writer", task: "one", cwd: first }, { agent: "writer", task: "two", cwd: second }],
  } };
  const { assertBackgroundWorkspace, consumeDelegatedTaskPolicies } = await import("../packages/extensions/subagent/delegation.ts");
  const { assertSubagentBatchPreflight } = await import("../packages/extensions/subagent/index.ts");
  const { SubagentScheduler } = await import("../packages/coding-agent/src/core/tasks/scheduler.ts");
  const ctx = f.session.extensionRunner.createContext();
  const authorization = await f.runtime.nativePermissions!.authorize(call as any, ctx);
  const scheduler = new SubagentScheduler({ maxConcurrent: 2, maxTasks: 4 });
  try {
    const policies = consumeDelegatedTaskPolicies(call.input, [first, second], f.cwd, call.toolCallId);
    assert.equal(policies.every(policy => policy.sharedParentScope), true);
    assert.throws(() => scheduler.reserve(policies), /overlapping/);
    assert.equal(scheduler.reserved, 0);
    assert.throws(() => assertBackgroundWorkspace(policies[0], f.cwd), /foreground/);
    assertSubagentBatchPreflight([{ name: "reader", source: "user" } as any], ["reader", "reader"], policies, true);
    assert.equal(policies.every(policy => !policy.allowMutation), true, "default read-only role tools do not become writer reservations");
    scheduler.reserve(policies).release();
    assertBackgroundWorkspace(policies[0], f.cwd);
  } finally { authorization.release(); scheduler.dispose(); }
});

test("a real child stops before effects when parent approval UI is unavailable", { timeout: 60000 }, async t => {
  const f = await fixture(t, undefined, false), outside = join(f.root, "keep.txt"); await fs.writeFile(outside, "unchanged");
  const result = await f.run(`await tools.delete({path:${JSON.stringify(outside)}}); await tools.write({path:"after.txt",content:"no"});`, "writer");
  assert.match(JSON.stringify(result), /APPROVAL_REQUIRED/);
  assert.equal(await fs.readFile(outside, "utf8"), "unchanged"); await assert.rejects(fs.stat(join(f.cwd, "after.txt")), { code: "ENOENT" });
  assert.equal((await f.observations()).filter(entry => entry.event === "request").length, 1);
});

test("assigned cwd is not a new workspace: real child D5 pauses parent and preserves the initiating reason", { timeout: 60000 }, async t => {
  const f = await fixture(t), childCwd = join(f.root, "assigned outside"); await fs.mkdir(childCwd);
  const existing = join(childCwd, "existing.txt"); await fs.writeFile(existing, "unchanged");
  const result = await f.run('console.log(await tools.write({path:"new.txt",content:"completed"})); await tools.write({path:"existing.txt",content:"forbidden"}); await tools.write({path:"after.txt",content:"no"});', "writer", childCwd);
  assert.equal(await fs.readFile(existing, "utf8"), "unchanged"); assert.equal(await fs.readFile(join(childCwd, "new.txt"), "utf8"), "completed");
  await assert.rejects(fs.stat(join(childCwd, "after.txt")), { code: "ENOENT" });
  assert.equal(f.runtime.executionBoundary.requiresUserInput, true); assert.equal(f.requests, 1);
  assert.match(JSON.stringify(result), /EXTERNAL_FILE_WRITE_BLOCKED/); assert.match(f.notices.join("\n"), /整轮任务已暂停/);
});
