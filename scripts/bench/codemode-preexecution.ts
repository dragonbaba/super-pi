import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { createJiti } from "jiti";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import type { InlineExtension } from "../../packages/coding-agent/src/core/extensions/types.ts";

const gc = globalThis.gc;
assert.ok(gc, "Run with --expose-gc");
const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<{ default: InlineExtension }>("../../packages/extensions/mutation-guard-write/index.ts");
const model: any = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const refs: WeakRef<object>[] = [];
let validated = 0, finalized = 0, executed = 0, progress = 0, ended = 0, workersStarted = 0, workersStopped = 0;
const observeResults: InlineExtension = pi => {
  pi.on("tool_result", event => { if (event.toolName === "edit") finalized++; });
};
async function cycle(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sp-preexecution-bench-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [mutation, observeResults] });
    await loader.reload();
    session = (await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.inMemory(root), model, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
        isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never })).session;
    await session.bindExtensions({});
    const edit = session.agent.state.tools.find(tool => tool.name === "edit")!;
    const validate = edit.validateInput!, execute = edit.execute;
    edit.validateInput = args => { validated++; validate(args); };
    edit.execute = (...args) => { executed++; return execute(...args); };
    let request = 0;
    session.agent.streamFunction = () => {
      const code = request++ === 0 ? 'for(let i=0;i<16;i++){try{await tools.edit({path:"missing.txt",edits:[{kind:"replace",start:"1#1234",newLines:["x"]}]})}catch{}}' : undefined;
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: request,
        content: code ? [{ type: "toolCall", id: "preexec", name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }], stopReason: code ? "toolUse" : "stop" };
      const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
    };
    unsubscribe = session.subscribe(event => {
      if (!((event.type === "tool_execution_end" || event.type === "tool_execution_update") && event.parentToolCallId)) return;
      if (event.type === "tool_execution_update") progress++;
      else { ended++; refs.push(new WeakRef(event.result)); }
    });
    await session.prompt("offline pre-execution benchmark");
    const parent = session.messages.find(message => message.role === "toolResult");
    assert.ok(parent?.role === "toolResult" && parent.isError);
    const calls = (parent.details as any).codemode.calls;
    assert.equal(calls.length, 16);
    for (const call of calls) assert.equal(call.executionStatus, "not_executed");
    const owner = (session as any)._codemode, sandbox = owner.sandbox;
    assert.equal(owner.current, undefined); assert.equal(owner.pendingStore, undefined);
    session.agent.abort(); await session.agent.waitForIdle();
    await owner.close();
    workersStarted += sandbox.stats.workersStarted; workersStopped += sandbox.stats.workersStopped;
    assert.equal(sandbox.stats.activeExecutions, 0);
    assert.equal(session.agent.state.pendingToolCalls.size, 0);
    assert.equal(owner.displayedReads.size, 0); assert.equal(owner.visibleReads.length, 0); assert.equal(owner.descriptors.length, 0);
    refs.push(new WeakRef(session), new WeakRef(owner), new WeakRef(sandbox), new WeakRef(edit));
  } finally {
    unsubscribe?.();
    if (session) { session.agent.abort(); await session.agent.waitForIdle(); session.dispose(); }
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const profiler = new Session(); profiler.connect();
try {
  await cycle();
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < 10; index++) await cycle();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let bytes = 0; const stack = [profile.head];
  while (stack.length) { const node = stack.pop()!; bytes += node.selfSize; for (const child of node.children) stack.push(child); }
  for (let index = 0; index < 8; index++) { await nextTask(); gc(); }
  let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
  assert.equal(validated, 176); assert.equal(finalized, 176); assert.equal(ended, 176); assert.equal(executed, 0); assert.equal(progress, 0);
  assert.equal(workersStarted, 11); assert.equal(workersStopped, 11); assert.equal(retained, 0);
  process.stdout.write(JSON.stringify({ benchmark: "codemode-preexecution", node: process.version, platform: process.platform,
    sampledCycles: 10, excludedWarmupCycles: 1, validated, finalized, ended, executed, progress, workersStarted, workersStopped,
    trackedReferences: refs.length, retainedAfterGc: retained, sampledHostBytes: bytes,
    coverage: "real mutation validation hook and tool_result, Agent/Codemode/Worker results and abort/disposal; offline provider; excludes UI and worker heap" }) + "\n");
} finally { profiler.disconnect(); }
