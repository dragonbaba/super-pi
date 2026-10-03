import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
const root = mkdtempSync(join(tmpdir(), "sp-codemode-session-bench-"));
writeFileSync(join(root, "read.txt"), "evidence\n".repeat(200));
const model: any = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const refs: WeakRef<object>[] = [], startupMs: number[] = [], firstMs: number[] = [], warmMs: number[] = [];
let workersStarted = 0, workersStopped = 0, childCalls = 0, progress = 0, ledgerPending = 0;
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
let loader: DefaultResourceLoader | undefined = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true,
  noSkills: true, noPromptTemplates: true, noThemes: true });
await loader.reload();
async function cycle() {
  const start = performance.now();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root),
    tools: ["read"], model, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
      getModel: () => undefined, getAuth: async () => undefined } as never });
  startupMs.push(performance.now() - start);
  const owner = (session as any)._codemode;
  assert.equal(owner.sandbox, undefined, "default startup creates no sandbox/Worker");
  const initialDescriptors = owner.descriptors;
  owner.setTools(owner.tools);
  assert.equal(owner.descriptors, initialDescriptors, "unchanged catalog reuses descriptor identity");
  let request = 0;
  session.agent.streamFunction = () => {
    const code = request++ === 0 ? 'for(let i=0;i<10;i++) await tools.read({path:"read.txt"}); await show((await tools.read({path:"read.txt"})).ref);store("n",1)' : undefined;
    const result: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: request,
      content: code ? [{ type: "toolCall", id: `script-${request}`, name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }], stopReason: code ? "toolUse" : "stop" };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: result.stopReason, message: result }); return stream;
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_end" && event.parentToolCallId) childCalls++;
    if (event.type === "tool_execution_update" && event.parentToolCallId) progress++;
  });
  try {
    let begin = performance.now(); await session.prompt("Read bounded fixture"); firstMs.push(performance.now() - begin);
    request = 0; begin = performance.now(); await session.prompt("Read again"); warmMs.push(performance.now() - begin);
    for (const result of session.messages) if (result.role === "toolResult") assert.equal(result.isError, false);
    assert.equal(owner.current, undefined); assert.equal(owner.pendingStore, undefined);
    ledgerPending += (session as any)._evidenceCompletedReads?.size ?? 0;
    assert.equal(session.agent.state.pendingToolCalls.size, 0);
    const sandbox = owner.sandbox;
    await owner.close();
    const stats = sandbox.stats; assert.equal(stats.activeExecutions, 0);
    workersStarted += stats.workersStarted; workersStopped += stats.workersStopped;
    assert.equal(owner.displayedReads.size, 0); assert.equal(owner.visibleReads.length, 0);
    assert.equal(owner.descriptors.length, 0); assert.equal(Object.keys(owner.store.snapshot).length, 0);
    refs.push(new WeakRef(session), new WeakRef(session.agent), new WeakRef(owner), new WeakRef(sandbox), new WeakRef(initialDescriptors));
  } finally { unsubscribe(); session.dispose(); }
}
function compare(a: number, b: number) { return a - b; }
const profiler = new Session(); profiler.connect();
try {
  await cycle(); startupMs.length = 0; firstMs.length = 0; warmMs.length = 0;
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < 10; i++) await cycle();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let bytes = 0; const stack = [profile.head], sites: { name: string; bytes: number }[] = [];
  while (stack.length) { const node = stack.pop()!; bytes += node.selfSize; if (node.selfSize) sites.push({ name: node.callFrame.functionName || node.callFrame.url, bytes: node.selfSize }); for (const child of node.children) stack.push(child); }
  // The shared fixture loader owns the last bound extension runtime. Release
  // that fixture root before testing collection of its last session as well.
  loader = undefined;
  for (let i = 0; i < 8; i++) { await nextTask(); gc(); }
  let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
  assert.equal(retained, 0); assert.equal(ledgerPending, 0); assert.equal(childCalls, 242); assert.equal(workersStarted, 22); assert.equal(workersStopped, 22);
  startupMs.sort(compare); firstMs.sort(compare); warmMs.sort(compare); sites.sort((a, b) => b.bytes - a.bytes);
  process.stdout.write(JSON.stringify({ benchmark: "codemode-session", node: process.version, platform: process.platform, sampledCycles: 10, excludedWarmupCycles: 1,
    startupMedianMs: startupMs[5], startupP95Ms: startupMs[9], firstBatchMedianMs: firstMs[5], firstBatchP95Ms: firstMs[9], warmBatchMedianMs: warmMs[5], warmBatchP95Ms: warmMs[9],
    childCalls, progress, workersStarted, workersStopped, trackedReferences: refs.length, retainedAfterGc: retained, pendingEvidenceAfterTurn: ledgerPending,
    sampledHostBytes: bytes, leadingSites: sites.slice(0, 5), coverage: "real SDK, built-in reads, AgentSession policy/hooks/results/store, Worker, projection and disposal; offline provider; excludes UI, worker heap and disk sessions" }) + "\n");
} finally { profiler.disconnect(); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
