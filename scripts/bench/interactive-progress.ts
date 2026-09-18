import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as turn } from "node:timers/promises";
import { response } from "../../tests/helpers/selected-integration-fixture.ts";
const root = resolve(process.argv[2] ?? ".");
const mode = process.argv[3] ?? "burst";
const sampled = process.argv.includes("--sample");
const { Agent } = await import(pathToFileURL(resolve(root, "packages/agent/src/agent.ts")).href);
const updates = mode === "burst" ? 20000 : 2000;
let drains = 0, delivered = 0, requests = 0, active = 0, high = 0;
const agent = new Agent({ streamFn: (model: any) => response(model, requests++ === 0 ? [{ type: "toolCall", id: "p", name: "progress", arguments: {} }] : []),
	eventInstrumentation: { onToolProgressDrainSettled() { drains++; }, onToolProgressPending(_id: string, pending: number) { active += pending ? 1 : -1; high = Math.max(high, active); } },
	initialState: { tools: [{ name: "progress", label: "Progress", description: "offline", parameters: { type: "object", properties: {} },
		execute: async (_id: string, _args: unknown, _signal: unknown, update: any) => {
			for (let i = 0; i < updates; i++) {
				const value = { content: [{ type: "text", text: String(i) }], details: i };
				if (mode === "awaited") await update.awaited(value);
				else update(value);
				if (mode === "paced") await turn();
			}
			return { content: [], details: "done" };
		} }] },
});
const unsubscribe = agent.subscribe((event: any) => { if (event.type === "tool_execution_update") delivered++; });
const inspector = new Session(); inspector.connect(); global.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
if (sampled) await inspector.post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
const start = performance.now(); await agent.prompt("offline"); const elapsed = performance.now() - start;
let bytes = 0;
if (sampled) {
	const result: any = await inspector.post("HeapProfiler.stopSampling"); const pending = [result.profile.head];
	while (pending.length) { const node = pending.pop(); bytes += node.selfSize; pending.push(...node.children); }
}
inspector.disconnect(); unsubscribe(); await agent.waitForIdle(); await turn(); global.gc?.();
console.log(JSON.stringify({ root, mode, sampled, updates, drains, delivered, requests, high, activeAfter: active,
	pendingToolsAfter: agent.state.pendingToolCalls.size, elapsed, sampledBytesPerUpdate: sampled ? bytes / updates : null, heapAfterGcDelta: process.memoryUsage().heapUsed - heapBefore }));
