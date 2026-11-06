import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import type { ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";

const owned = createOwnedTaskFixture("permission-turn-pause-"), oldTemps = [process.env.TMP, process.env.TEMP, process.env.TMPDIR];
process.env.TMP = owned.root; process.env.TEMP = owned.root; process.env.TMPDIR = owned.root;
assert.equal(await fs.realpath(tmpdir()), await fs.realpath(owned.root));
test.after(() => {
  for (const [index, key] of ["TMP", "TEMP", "TMPDIR"].entries()) {
    if (oldTemps[index] === undefined) delete process.env[key]; else process.env[key] = oldTemps[index];
  }
  owned.cleanup();
});

async function fixture(t: test.TestContext, customTools: ToolDefinition[] = []) {
  const root = await fs.realpath(await fs.mkdtemp(join(owned.root, "case-")));
  const cwd = join(root, "project space"), agentDir = join(root, "agent"), outside = join(root, "existing.txt");
  await fs.mkdir(cwd); await fs.mkdir(agentDir); await fs.writeFile(outside, "unchanged");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, executionPermissions: { rules: [{ tool: "*", decision: "allow" }] } });
  settings.setPermissionModeForSession("host-write");
  const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: settings,
    sessionManager: manager, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), customTools });
  const runtime = resources.getExtensions().runtime, boundary = runtime.executionBoundary;
  const notices: string[] = [], events: any[] = []; let dialogs = 0, requests = 0, sequence = 0;
  await session.bindExtensions({ mode: "tui", uiContext: {
    notify: (message: string) => { notices.push(message); },
    select: async (_title: string, choices: string[]) => { dialogs++; return choices[0]; },
  } as any });
  session.subscribe(event => { events.push(event); });
  t.after(async () => {
    session.agent.abort(); await session.agent.waitForIdle();
    session.dispose(); await boundary.dispose();
    await runtime.nativeTasks?.dispose(); await runtime.nativeFiles?.dispose(); await disposeNativeFileWorker();
  });
  function response(calls: { name: string; arguments: object }[]) {
    let issued = false;
    session.agent.streamFunction = () => {
      requests++;
      const content = issued || calls.length === 0 ? [{ type: "text", text: "done" }] : calls.map(call => ({ ...call, type: "toolCall", id: `pause-${++sequence}` }));
      const stopReason = issued || calls.length === 0 ? "stop" : "toolUse"; issued = true;
      const message: any = { role: "assistant", api: "openai-responses", provider: "fixture", model: ALPHA_MODEL.id,
        content, stopReason, timestamp: sequence, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: stopReason, message }); return stream;
    };
  }
  return { cwd, outside, session, runtime, boundary, notices, events, response,
    get requests() { return requests; }, get dialogs() { return dialogs; },
    async run(code: string) { response([{ name: "codemode", arguments: { code } }]); await session.prompt("execute owned fixture"); },
    results() { return session.agent.state.messages.filter(message => message.role === "toolResult"); },
  };
}

test("D5 preserves completed CodeMode receipts, stops the parent turn and only fresh user input resumes", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const batch = { operations: [{ operation: "write", path: "batch-local.txt", mode: "create", content: "must not run" },
    { operation: "write", path: f.outside, mode: "overwrite", content: "must not run" }] };
  await f.run('await tools.write({path:"before.txt",content:"completed"});' +
    `await tools.file_batch(${JSON.stringify(batch)}, {allowFailure:true});` +
    'await tools.write({path:"after.txt",content:"must not run"})');
  assert.equal(await fs.readFile(join(f.cwd, "before.txt"), "utf8"), "completed");
  for (const path of ["batch-local.txt", "after.txt"]) await assert.rejects(fs.stat(join(f.cwd, path)), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.outside, "utf8"), "unchanged"); assert.equal(f.requests, 1);
  assert.equal(f.boundary.requiresUserInput, true); assert.equal(f.events.filter(event => event.type === "agent_end").at(-1)?.requiresUserInput, true);
  const result = JSON.stringify(f.results());
  assert.match(result, /EXTERNAL_FILE_WRITE_BLOCKED/); assert.match(result, /before.txt/);
  assert.match(f.notices.join("\n"), /整轮任务已暂停/); assert.equal(f.dialogs, 0);
  for (const options of [{ queueOnly: true }, { deferredInput: true }, { source: "extension" as const }])
    await assert.rejects(f.session.prompt("old queued work", options), /REQUIRES_USER_INPUT/);
  await f.session.sendCustomMessage({ customType: "background-report", content: "completed receipt", display: true }, { triggerTurn: true });
  await delay(0); assert.equal(f.requests, 1); assert.equal(f.boundary.requiresUserInput, true);
  f.response([]); await f.session.prompt("new user instruction: continue");
  assert.equal(f.requests, 2); assert.equal(f.boundary.requiresUserInput, false);
  assert.equal(f.boundary.preparationCount, 0); assert.equal(f.boundary.hasDeadline, false);
});

test("recognized shell overwrite pauses and drains an already running managed child without losing its receipt", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await fs.copyFile(new URL("fixtures/background-shell-child.mjs", import.meta.url), join(f.cwd, "fixture.mjs"));
  const started = await f.session.agent.dispatchHostTool({ type: "toolCall", id: "background", name: "bash",
    arguments: { command: "node fixture.mjs handoff small", cwd: ".", background: true } });
  assert.equal(started.isError, false, JSON.stringify(started));
  const taskId = (started.details as any).backgroundTask.id;
  let ready = false;
  for (let index = 0; index < 200; index++) {
    try { await fs.stat(join(f.cwd, "handoff.ready.json")); ready = true; break; } catch { await delay(10); }
  }
  assert.equal(ready, true);
  const command = "printf changed > '" + f.outside.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
  await f.run(`await tools.bash(${JSON.stringify({ command, cwd: "." })}, {allowFailure:true});await tools.write({path:"after.txt",content:"no"})`);
  assert.equal(f.requests, 1); assert.equal(await fs.readFile(f.outside, "utf8"), "unchanged");
  assert.match(JSON.stringify(f.results()), /EXTERNAL_FILE_WRITE_BLOCKED/);
  await f.runtime.nativeTasks!.shell.drainExecution();
  const task = f.runtime.nativeTasks!.shell.tasks.get(taskId)!;
  assert.equal(task.state, "cancelled"); assert.equal(f.runtime.nativeTasks!.shell.scheduler.outstanding, 0);
  assert.match(JSON.stringify(task), /before handoff/);
  assert.equal(f.boundary.requiresUserInput, true);
  await assert.rejects(fs.stat(join(f.cwd, "after.txt")), { code: "ENOENT" });
});

test("LSP write denial stops prepared parallel siblings before execution", { timeout: 20000 }, async t => {
  let executions = 0;
  const execute = async () => { executions++; return { content: [{ type: "text" as const, text: "must not run" }], details: {} }; };
  const f = await fixture(t, [
    { name: "marker", label: "marker", description: "owned fixture", parameters: Type.Object({}), modelOnly: true, execute },
    { name: "lsp_fix", label: "fix", description: "owned fixture", parameters: Type.Object({ path: Type.String(), write: Type.Boolean() }), modelOnly: true, execute },
  ]);
  f.session.agent.toolExecution = "parallel";
  f.response([{ name: "marker", arguments: {} }, { name: "lsp_fix", arguments: { path: f.outside, write: true } }, { name: "marker", arguments: {} }]);
  await f.session.prompt("execute parallel owned fixture");
  assert.equal(executions, 0); assert.equal(f.requests, 1); assert.equal(f.boundary.requiresUserInput, true);
  assert.match(JSON.stringify(f.results()), /EXTERNAL_FILE_WRITE_BLOCKED/);
  assert.equal(f.results().length, 3, "every unstarted call receives a terminal result");
  assert.equal(await fs.readFile(f.outside, "utf8"), "unchanged");
});
