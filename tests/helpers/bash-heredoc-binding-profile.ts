import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { Agent } from "../../packages/agent/src/agent.ts";
import { createBashTool } from "../../packages/coding-agent/src/core/tools/bash.ts";
import { getShellConfig } from "../../packages/coding-agent/src/utils/shell.ts";
import { inspectBashResourceLifecycle } from "../../packages/extensions/resource-lifecycle-guard/core.ts";

const warmup = 3, samples = 12;
const refs: WeakRef<object>[] = [];
let processes = 0, providers = 0, permissions = 0;
const activity = createHook({ init(_id, type) { if (type === "PROCESSWRAP") processes++; } });
const profiler = new Session(); profiler.connect();
const stats: Array<{ route: string; calls: number; spawns: number; ms: number }> = [];
async function run(route: string, count: number, retain: boolean) {
 const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); }, beforeToolCall: async ({ args }) => {
  permissions++; const reason = inspectBashResourceLifecycle(args); return reason ? { block: true, reason } : undefined;
 } });
 agent.state.tools = [createBashTool(process.cwd(), { shellPath: getShellConfig().shell, exposeSessionEnvironment: false,
  spawnHook(context) {
   const env = { ...context.env, PATH: "/usr/bin:/bin", BASH_ENV: route === "rejected" ? "/never-open-startup" : "", ENV: "" };
   const result = { ...context, env }; refs.push(new WeakRef(result), new WeakRef(env)); return result;
  }
 })];
 const start = performance.now(), before = processes;
 try {
  for (let i = 0; i < count; i++) {
   const result = await agent.dispatchHostTool({ type: "toolCall", id: `${route}-${i}`, name: "bash", arguments: { command: route === "ordinary" ? "printf ORDINARY" : "cat <<'EOF'\nprintf BODY_EXECUTED\nEOF" } });
   assert.equal(result.isError, route === "rejected" || (route === "bound" && process.platform !== "linux"));
   await agent.waitForIdle(); assert.equal(agent.state.pendingToolCalls.size, 0);
   agent.state.messages.length = 0; // fixture-owned canonical history, after completed delivery
  }
  const expected = route === "ordinary" || (route === "bound" && process.platform === "linux") ? count : 0;
  assert.equal(processes - before, expected);
  if (retain) stats.push({ route, calls: count, spawns: processes - before, ms: performance.now() - start });
 } finally { agent.abort(); agent.state.tools = []; agent.state.messages.length = 0; }
}
activity.enable();
for (const route of ["ordinary", "bound", "rejected"]) await run(route, warmup, false);
await profiler.post("HeapProfiler.startSampling", { samplingInterval: 16384 });
for (const route of ["ordinary", "bound", "rejected"]) await run(route, samples, true);
const allocation = await profiler.post("HeapProfiler.stopSampling"); profiler.disconnect(); activity.disable();
function sampled(node: any): number { return node.selfSize + node.children.reduce((sum: number, child: any) => sum + sampled(child), 0); }
const sampledBytes = sampled(allocation.profile.head);
for (let i = 0; i < 3; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc!(); }
const retainedAliases = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
assert.equal(retainedAliases, 0); assert.equal(providers, 0); assert.equal(permissions, 3 * (warmup + samples));
console.log(JSON.stringify({ fixture: "bash-heredoc-binding-v1", sha: process.env.GITHUB_SHA ?? "local", node: process.version, platform: process.platform,
 warmup, samples, stats, processes, permissions, providers, sampledBytes, observedAliases: refs.length, retainedAliases,
 successfulBindingApiCalls: { realpath: 2, stat: 5, environmentSnapshots: 1, configObjects: 1, argumentArrays: 1, probeProcesses: 0, contentHashes: 0 },
 scope: "sampled allocation is not total allocation or retained heap; API counts are source-derived, not syscall counts" }));
