import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ALPHA_MODEL, alphaModelRuntime } from "./next-phase-model.ts";

export const costProject = resolve(process.env.SP_COST_PROJECT_ROOT ?? ".");
export async function costModule(path: string): Promise<any> { return import(pathToFileURL(join(costProject, path)).href); }
const { createAgentSession } = await costModule("packages/coding-agent/src/core/sdk.ts");
const { DefaultResourceLoader } = await costModule("packages/coding-agent/src/core/resource-loader.ts");
const { SettingsManager } = await costModule("packages/coding-agent/src/core/settings-manager.ts");
const { SessionManager } = await costModule("packages/coding-agent/src/core/session-manager.ts");
const { streamSimple } = await costModule("packages/ai/dist/api/openai-completions.js");
const { estimateToolOutputTokens } = await costModule("packages/coding-agent/src/core/tool-output-budget.ts");
function tokens(text: string): number { return estimateToolOutputTokens([{ type: "text", text }]).estimatedTokens; }
export function costCall(id: string, name: string, args: any): any { return { type: "toolCall", id, name, arguments: args }; }
export function costText(result: any): string { return result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n"); }

interface EstimatorMetrics { estimatorCpuUs: number; estimatorElapsedMs: number; estimatorPasses: number }
/** Capture deltas so setup/discovery and earlier requests are not subtracted twice. */
export function startCostMeasurement(metrics: EstimatorMetrics) {
  return { cpu: process.cpuUsage(), start: performance.now(), estimatorCpuUs: metrics.estimatorCpuUs,
    estimatorElapsedMs: metrics.estimatorElapsedMs, estimatorPasses: metrics.estimatorPasses };
}
export function finishCostMeasurement(metrics: EstimatorMetrics, start: ReturnType<typeof startCostMeasurement>) {
  const inclusiveElapsedMs = performance.now() - start.start, used = process.cpuUsage(start.cpu);
  const inclusiveCpuUs = used.user + used.system, estimatorCpuUs = metrics.estimatorCpuUs - start.estimatorCpuUs,
    estimatorElapsedMs = metrics.estimatorElapsedMs - start.estimatorElapsedMs, estimatorPasses = metrics.estimatorPasses - start.estimatorPasses;
  assert.ok(estimatorElapsedMs >= 0 && estimatorElapsedMs <= inclusiveElapsedMs);
  return { elapsedMs: inclusiveElapsedMs - estimatorElapsedMs, cpuUs: inclusiveCpuUs - estimatorCpuUs,
    inclusiveElapsedMs, inclusiveCpuUs, estimatorCpuUs, estimatorElapsedMs, estimatorPasses,
    measurementScope: "elapsedMs/cpuUs subtract only diagnostic estimation and its JSON serialization within this workload; inclusive totals remain. CPU quantization, later GC, estimator heap allocations and fixture/provider scheduling are not isolated." };
}

/** Isolated real default SDK and final serializer; no provider request leaves this process. */
export async function costSession(options: { historyPairs?: number; budget?: number; extensions?: any[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sp-n4-session-")), cwd = join(root, "work"), agentDir = join(root, "agent");
  let session: any;
  try {
  process.stdout.write(`# owned N4 session ${JSON.stringify({ root })}\n`);
  mkdirSync(cwd); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const model = { ...ALPHA_MODEL, api: "openai-completions", compat: { maxTokensField: "max_tokens" } };
  let manager = SessionManager.create(cwd, join(root, "sessions")), queue: any[][] = [], requestError: unknown;
  let finalText = "Fixture results recorded; no unrequested retry.";
  let beforeRecord: ((type: string, data: any) => void) | undefined, onApproval: (() => void) | undefined;
  const metrics = { requests: 0, toolCalls: 0, approvals: 0, inputTokens: 0, schemaTokens: 0, historyTokens: 0, toolTokens: 0, outputTokens: 0,
    wireBytes: 0, discoveryCalls: 0, reads: 0, compactions: 0, sampledPeakHeap: 0, estimatorCpuUs: 0, estimatorElapsedMs: 0, estimatorPasses: 0, lastWire: "" };
  for (let index = 0; index < (options.historyPairs ?? 0); index++) {
    manager.appendMessage({ role: "user", content: `Historical question ${index} ${"中文 context ".repeat(30)}`, timestamp: index * 2 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Historical answer ${index} ${"verified prose ".repeat(30)}` }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: index * 2 + 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const fakeFetch: typeof fetch = async (_url, init) => {
    try {
      assert.equal(typeof init?.body, "string"); const wire = init!.body as string, payload = JSON.parse(wire);
      metrics.requests++; metrics.lastWire = wire; metrics.wireBytes += Buffer.byteLength(wire);
      const cpu = process.cpuUsage(), inputStart = performance.now(); metrics.inputTokens += tokens(wire); metrics.schemaTokens += tokens(JSON.stringify(payload.tools));
      for (const message of payload.messages) {
        if (message.role === "tool") metrics.toolTokens += tokens(JSON.stringify(message)); else metrics.historyTokens += tokens(JSON.stringify(message));
      }
      metrics.estimatorElapsedMs += performance.now() - inputStart;
      const inputUsed = process.cpuUsage(cpu); metrics.estimatorCpuUs += inputUsed.user + inputUsed.system; metrics.estimatorPasses++;
      const calls = queue.shift();
      if (calls) for (const call of calls) assert.ok(payload.tools.some((tool: any) => tool.function.name === call.name), `discovery missing ${call.name}`);
      const delta = calls ? { tool_calls: calls.map((call: any, index: number) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : { content: finalText };
      const outputCpu = process.cpuUsage(), outputStart = performance.now(); metrics.outputTokens += tokens(JSON.stringify(delta));
      metrics.estimatorElapsedMs += performance.now() - outputStart;
      const used = process.cpuUsage(outputCpu); metrics.estimatorCpuUs += used.user + used.system; metrics.estimatorPasses++;
      metrics.sampledPeakHeap = Math.max(metrics.sampledPeakHeap, process.memoryUsage().heapUsed);
      const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: null }] };
      const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    } catch (error) { requestError = error; throw error; }
  };
  const runtime = alphaModelRuntime((m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "offline-fixture", fetch: fakeFetch, maxRetries: 0 }));
  async function open() {
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [join(costProject, "packages/extensions"), join(costProject, "packages/tool-classification/src/index.ts")], extensionFactories: options.extensions });
    await loader.reload();
    const append = manager.appendCustomEntry;
    manager.appendCustomEntry = function measuredRecord(type: string, data: any) { beforeRecord?.(type, data); return append.call(this, type, data); };
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, model, modelRuntime: runtime,
      noTools: "builtin", toolResultPresentation: options.budget === undefined ? undefined : { enabled: true, budgetTokens: options.budget } }));
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), select: async () => { metrics.approvals++; onApproval?.(); return "仅允许本次"; } } });
    session.subscribe((event: any) => {
      if (event.type === "tool_execution_end") { metrics.toolCalls++; if (event.toolName === "tool_search") metrics.discoveryCalls++; if (event.toolName === "read") metrics.reads++; }
      if (event.type === "compaction_start") metrics.compactions++;
    });
  }
  await open();
  return {
    root, cwd, metrics, get session() { return session; }, get manager() { return manager; },
    recordHook(hook?: typeof beforeRecord) { beforeRecord = hook; }, approvalHook(hook?: typeof onApproval) { onApproval = hook; },
    async run(turns: any[][], prompt = "Perform only the specified isolated fixture operations.") {
      assert.equal(queue.length, 0); queue = turns; requestError = undefined; finalText = "Fixture results recorded; no unrequested retry.";
      await session.prompt(prompt); await session.agent.waitForIdle();
      if (requestError) throw requestError;
      assert.equal(session.agent.state.pendingToolCalls.size, 0);
      return session.messages.filter((message: any) => message.role === "toolResult");
    },
    async continue(turns: any[][], text: string) {
      assert.equal(queue.length, 0); queue = turns; finalText = text; requestError = undefined;
      await session.followUp("Continue the same fixture task; inspect the recorded results before claiming completion.");
      await session.agent.continue(); await session.agent.waitForIdle();
      if (requestError) throw requestError;
      assert.equal(queue.length, 0); assert.equal(session.agent.state.pendingToolCalls.size, 0);
      return costText(session.messages.at(-1));
    },
    result(id: string) { const result = session.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === id); assert.ok(result, id); return result; },
    async reopen() { const path = manager.getSessionFile(); assert.ok(path); session.dispose(); manager = SessionManager.open(path); await open(); },
    async switchModel() { await session.setModel({ ...model, id: "n4-switched-fixture", name: "N4 switched fixture", contextWindow: 192000 }); assert.equal(session.model.id, "n4-switched-fixture"); },
    async release() {
      assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal(session.extensionRunner.finalAuthorizations?.size ?? 0, 0);
      session.dispose(); session = undefined; manager = undefined; queue.length = 0; beforeRecord = undefined; onApproval = undefined; metrics.lastWire = "";
      await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
    },
  };
  } catch (error) {
    session?.dispose(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); throw error;
  }
}
