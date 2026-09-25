import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { alphaSession } from "../../tests/helpers/alpha-session.ts";

const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<any>("../../packages/extensions/mutation-guard-write/index.ts");
const { default: lifecycle } = await jiti.import<any>("../../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: loop } = await jiti.import<any>("../../packages/extensions/tool-loop-guardrails/index.ts");
const reports = [];
for (const mode of ["regular", "fullscreen"] as const) for (let cycle = 0; cycle < 5; cycle++) {
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed; const start = performance.now();
  const f = await alphaSession({ mode, extensions: [mutation, lifecycle, loop], customTools: [{ name: "benchmark_noop", label: "benchmark", description: "offline fixture", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) }] });
  try {
    assert.equal(await f.mode.init(), true);
    const inputReadyMs = performance.now() - start;
    f.input.write("native files benchmark");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.internal.editor.getText(), "native files benchmark");
    f.session.setActiveToolsByName(["write", "file_batch"]);
    const tools = f.session.agent.state.tools.map(tool => tool.name);
    assert.ok(tools.includes("write") && tools.includes("file_batch"), JSON.stringify(tools));
    const toolReadyMs = performance.now() - start;
    const cpu = process.cpuUsage(); const mutationStart = performance.now();
    const result = await f.session.agent.dispatchHostTool({ type: "toolCall", id: "first", name: "file_batch", arguments: {
      operations: [{ operation: "write", mode: "create", path: "new/a.txt", content: "first\n" }, { operation: "write", mode: "create", path: "new/b.txt", content: "second\n" }],
    } });
    const mutationMs = performance.now() - mutationStart; const used = process.cpuUsage(cpu);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(readFileSync(join(f.root, "new/a.txt"), "utf8"), "first\n");
    assert.equal(readFileSync(join(f.root, "new/b.txt"), "utf8"), "second\n");
    const heapPeakObserved = process.memoryUsage().heapUsed;
    await f.release();
    await new Promise<void>(resolve => setImmediate(resolve)); global.gc?.();
    assert.equal(f.session.agent.state.pendingToolCalls.size, 0);
    assert.equal(f.input.listenerCount("data"), 0); assert.equal(f.resizeSource.listenerCount("resize"), 0);
    reports.push({ mode, cycle, inputReadyMs, toolReadyMs, mutationMs, cpuUs: used.user + used.system,
      heapPeakObserved, releasedHeapDelta: process.memoryUsage().heapUsed - heapBefore, pendingTools: 0, inputListeners: 0, resizeListeners: 0 });
  } catch (error) { await f.release(); throw error; }
}
function percentile(values: number[], fraction: number): number { values.sort((a, b) => a - b); return values[Math.ceil(values.length * fraction) - 1]; }
console.log(JSON.stringify({ benchmark: "native-files-interactive-lifecycle", node: process.version, platform: process.platform,
  terminal: "real InteractiveMode/ProcessTerminal with synthetic input/output; no ConPTY, no network/provider", reports,
  inputReadyP50Ms: percentile(reports.map(r => r.inputReadyMs), .5), inputReadyP95Ms: percentile(reports.map(r => r.inputReadyMs), .95),
  mutationP50Ms: percentile(reports.map(r => r.mutationMs), .5), mutationP95Ms: percentile(reports.map(r => r.mutationMs), .95),
  cpuP50Us: percentile(reports.map(r => r.cpuUs), .5), cpuP95Us: percentile(reports.map(r => r.cpuUs), .95) }, null, 2));
