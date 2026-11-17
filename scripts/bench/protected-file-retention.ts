import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { releaseComponentRenderCaches } from "@super-pi/tui";
import { nativeFileSession } from "../../tests/helpers/sandbox-file-session.ts";
import { FileService } from "../../packages/coding-agent/src/core/files/file-service.ts";
import { disposeNativeFileWorker } from "../../packages/coding-agent/src/core/files/native-file-client.ts";
import { CodemodeTreeComponent } from "../../packages/coding-agent/src/modes/interactive/components/codemode-tree.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { codemodeTextDigest } from "../../packages/coding-agent/src/core/codemode-display.ts";

function exerciseErrorTrees(refs: WeakRef<object>[]) {
  let paintedRows = 0, projectionCount = 0;
  for (let index = 0; index < 32; index++) {
    const tree = new CodemodeTreeComponent(), error = "[POLICY_BLOCKED] Source tree contains protected .git/.sp metadata. No item executed.";
    refs.push(new WeakRef(tree));
    const summary = "[CODEMODE_FAILED] Child calls: 2.";
    const final: any = { content: [{ type: "text", text: summary }, { type: "text", text: "[CODEMODE_SCRIPT] [ref:2] " + error + "; successful bash output is truncated. Its content is display text, not a complete document. Inspect the existing Output path when available. Do not repeat completed commands." }],
      details: { codemode: { version: 1, summaryDigest: codemodeTextDigest(summary), calls: [
        { toolCallId: "p:1", toolName: "bash", preview: "tail", outputTruncated: true, isError: false },
        { toolCallId: "p:2", toolName: "file_batch", ref: "ref:2", preview: error, isError: true },
      ] } } };
    refs.push(new WeakRef(final));
    for (const expanded of [false, true]) {
      tree.updateParent("historical script", final, false, true, expanded);
      for (let frame = 0; frame < 20; frame++) {
        const lines = tree.render(100); paintedRows += lines.length;
        assert.equal(stripVTControlCharacters(lines.join("\n")).split("Source tree contains").length - 1, 1);
      }
    }
    projectionCount += tree.getLifecycleCounts().outputProjections;
    releaseComponentRenderCaches(tree);
    const released = tree.getLifecycleCounts();
    assert.equal(released.rows, 0); assert.equal(released.resultReferences, 0); assert.equal(released.textChars, 0); assert.equal(released.timers, 0);
  }
  return { paintedRows, projectionCount };
}

// A correctness/lifecycle probe, not an old/new timing comparison: the former
// implementation refused protected trees and did not complete this workload.
test("protected native plans and legacy CodeMode error projections release their references", async t => {
  const root = await mkdtemp(join(tmpdir(), "protected-retention-bench-"));
  const f = nativeFileSession(root), definitions: any = {}; f.files.install(definitions);
  const inspector = new Session(); inspector.connect(); initTheme("dark");
  const refs: WeakRef<object>[] = [], original = FileService.prototype.prepareV3;
  const probe = t.mock.method(FileService.prototype, "prepareV3", async function(this: FileService, ...args: Parameters<typeof original>) {
    const item = await original.apply(this, args);
    refs.push(new WeakRef(item));
    if (item.tree) { refs.push(new WeakRef(item.tree), new WeakRef(item.tree.tree.protectedEntries!)); }
    return item;
  });
  let peakHeap = 0, peakRss = 0;
  function sampleMemory() { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }
  const timer = setInterval(sampleMemory, 10), started = performance.now(), cpu = process.cpuUsage();
  try {
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let index = 0; index < 8; index++) {
      const source = "source-" + index, copied = "copied-" + index, moved = "moved-" + index;
      await mkdir(join(root, source, ".git"), { recursive: true });
      await writeFile(join(root, source, ".git/config"), "retained"); await writeFile(join(root, source, "file"), "ordinary");
      for (const operation of ["copy", "move", "delete"]) {
        const result = await f.invoke(definitions, operation, { path: source, ...(operation === "delete" ? { recursive: true } : { destination: operation === "copy" ? copied : moved }) });
        assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.skippedProtected, 1);
        assert.equal(result.details.coverageComplete, false);
        assert.equal(await readFile(join(root, source, ".git/config"), "utf8"), "retained");
      }
      assert.equal(await readFile(join(root, copied, "file"), "utf8"), "ordinary");
      assert.equal(await readFile(join(root, moved, "file"), "utf8"), "ordinary");
    }
    const { paintedRows, projectionCount } = exerciseErrorTrees(refs);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let sampledBytes = 0; const stack = [profile.head], sites = [];
    while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize;
      if (node.selfSize) sites.push({ function: node.callFrame.functionName, source: basename(node.callFrame.url), sampledBytes: node.selfSize });
      for (const child of node.children) stack.push(child);
    }
    sites.sort((a, b) => b.sampledBytes - a.sampledBytes);
    await f.close(); await disposeNativeFileWorker(); probe.mock.resetCalls();
    for (let index = 0; index < 4; index++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
    let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
    assert.equal(retained, 0); assert.equal(projectionCount, 32);
    sampleMemory();
    t.diagnostic(JSON.stringify({ operations: 24, retainedMetadata: 8, frames: 1280, paintedRows, projectionCount, references: refs.length, retained,
      sampledBytes, sampledNotTotalAllocations: true, peakHeap, peakRss, retainedHeap: process.memoryUsage().heapUsed,
      milliseconds: performance.now() - started, cpuMicroseconds: process.cpuUsage(cpu), sites: sites.slice(0, 10) }));
  } finally { clearInterval(timer); inspector.disconnect(); await f.close(); await disposeNativeFileWorker(); await rm(root, { recursive: true }); }
});
