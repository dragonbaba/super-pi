import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Session } from "node:inspector/promises";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen } from "@super-pi/tui";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { FILE_LIMIT, TEXT_LIMIT } from "../../packages/coding-agent/src/core/sandbox/mxc-file-limits.mjs";
import { WorkspaceSandboxTools } from "../../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { ToolExecutionComponent, type ToolExecutionAllocationMetrics } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTuiReference } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { mxcFileFixture } from "../../tests/helpers/mxc-file-fixture.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";

const ITERATIONS = 100;
assert.ok(global.gc, "Run with --expose-gc");
initTheme("dark");

for (const name of ["read", "grep"] as const) test("render MXC " + name + " status through the production tool component", async t => {
  const fixture = mxcFileFixture(t);
  fs.writeFileSync(path.join(fixture.input, "long"), "x".repeat(TEXT_LIMIT + 100));
  fs.writeFileSync(path.join(fixture.input, "large"), "x".repeat(FILE_LIMIT) + "needle");
  const runtime = createExtensionRuntime();
  const owner = new WorkspaceSandboxTools(fixture.input, fixture.root, "read-only", () => runtime);
  fixture.attach(owner, "read-only");
  fixture.cleanupWith(async () => { await owner.close(); await runtime.executionBoundary.dispose(); });
  const definition = owner.definition(name)!;
  const args = name === "read" ? { path: "long", limit: 1 } : { path: "large", pattern: "needle" };
  const signal = runtime.executionBoundary.signal;
  const ctx = { cwd: fixture.input, hasUI: false, signal } as ExtensionContext;
  const terminal = new FakeTerminal(120, 40);
  const renderer = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const reference = createInteractiveTuiReference(() => renderer);
  const inspector = new Session();
  const refs: WeakRef<object>[] = [];
  const metrics: ToolExecutionAllocationMetrics = {
    updateDisplayCalls: 0, callRendererCalls: 0, resultRendererCalls: 0, componentCreations: 0,
    renderContextObjects: 0, internalWrapperObjects: 0, imageScans: 0, argsSerializations: 0,
    toolArgsGenerationUpdates: 0, toolArgsReplacementUpdates: 0, toolArgsSemanticFallbackComparisons: 0,
    toolArgsMissingGenerationUpdates: 0, toolArgsFinalizations: 0,
  };
  async function measure(): Promise<number> {
    const result = await definition.execute("mxc-render", args, signal, undefined, ctx);
    assert.ok(result);
    const component = new ToolExecutionComponent(name, "mxc-render", args, { showImages: false, allocationMetrics: metrics }, definition, reference, fixture.input);
    refs.push(new WeakRef(component), new WeakRef(result));
    renderer.addChild(component);
    try {
      component.setArgsComplete();
      component.setExpanded(true);
      component.updateResult(result);
      const rendered = stripVTControlCharacters(component.render(120).join("\n"));
      assert.match(rendered, name === "read" ? /Read window incomplete/ : /coverageComplete=false/);
      renderer.renderNow();
      terminal.writes.length = 0;
      for (const key of Object.keys(metrics) as Array<keyof ToolExecutionAllocationMetrics>) metrics[key] = 0;
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < ITERATIONS; index++) {
        component.updateResult(result);
        renderer.renderNow();
        terminal.writes.length = 0;
      }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const pending = [profile.head];
      let bytes = 0;
      while (pending.length) {
        const node = pending.pop()!;
        bytes += node.selfSize;
        for (const child of node.children) pending.push(child);
      }
      return bytes;
    } finally { renderer.removeChild(component); }
  }
  inspector.connect();
  let sampledBytes: number;
  try {
    renderer.start();
    sampledBytes = await measure();
  } finally {
    inspector.disconnect();
    await renderer.dispose({ preserveScreen: true });
  }
  for (let round = 0; round < 4; round++) { await tick(); global.gc!(); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  assert.equal(terminal.started, false);
  assert.equal(metrics.resultRendererCalls, ITERATIONS);
  assert.equal(metrics.componentCreations, 0);
  t.diagnostic(JSON.stringify({ name, updates: ITERATIONS, sampledBytesPerUpdate: sampledBytes / ITERATIONS, metrics, retained: 0 }));
});
