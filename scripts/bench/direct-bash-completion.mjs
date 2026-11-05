import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { BashExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "@super-pi/tui";

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
initTheme("dark");
const ui = { requestRender() {} }, weak = [];
const counts = { completions: 0, renderedFailures: 0, released: 0 };
function complete() {
  const component = new BashExecutionComponent("fixture", ui);
  component.appendOutput("[SANDBOX_PUBLICATION] shell exit=0; publication failed\n");
  component.setComplete(undefined, false, undefined, undefined, true); counts.completions++;
  assert.match(component.render(80).join("\n"), /\(failed\)/); counts.renderedFailures++;
  weak.push(new WeakRef(component)); component[RELEASE_COMPONENT_RENDER_CACHE](); counts.released++;
}
const inspector = new Session(); inspector.connect();
try {
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < 100; i++) complete();
  const profile = (await inspector.post("HeapProfiler.stopSampling")).profile, allocations = [];
  function inspect(node) {
    if (node.selfSize && node.callFrame.url.includes("bash-execution")) allocations.push({ function: node.callFrame.functionName, bytes: node.selfSize });
    for (const child of node.children ?? []) inspect(child);
  }
  inspect(profile.head);
  for (let i = 0; i < 4; i++) { await tick(); globalThis.gc(); }
  let live = 0; for (const target of weak) if (target.deref()) live++;
  assert.equal(live, 0);
  console.log(JSON.stringify({ contract: "direct-bash-failure-completion-v1", counts, allocations, gcRounds: 4, live,
    scope: "Actual direct Bash component completion/render/release; cold completion allocations, not a steady-state speedup claim." }));
} finally { inspector.disconnect(); }
