import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { nativeFileSession } from "../../tests/helpers/sandbox-file-session.ts";
import { FileService } from "../../packages/coding-agent/src/core/files/file-service.ts";
import { FileResultReader } from "../../packages/coding-agent/src/core/files/file-result-store.ts";
import { FileChangesV3 } from "../../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { disposeNativeFileWorker } from "../../packages/coding-agent/src/core/files/native-file-client.ts";
import { FILE_RESULT_PAGE_BYTES } from "../../packages/coding-agent/src/core/files/file-operation-limits.mjs";

test("native session v3 covers 2,000 targets for every public operation and releases owned plans", { timeout: 600000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-native-allocation-"))), f = nativeFileSession(root), { files, policy } = f;
  t.after(() => rm(root, { recursive: true, force: true }));
  const definitions: any = {}; files.install(definitions);
  const inspector = new InspectorSession(); inspector.connect();
  const refs: WeakRef<object>[] = [], original = FileService.prototype.prepareV3;
  const preparationProbe = t.mock.method(FileService.prototype, "prepareV3", async function(this: FileService, ...args: Parameters<typeof original>) {
    const item = await original.apply(this, args); refs.push(new WeakRef(item)); if (item.tree) refs.push(new WeakRef(item.tree)); return item;
  });
  let peakHeap = 0, peakRss = 0;
  function sampleMemory() { const memory = process.memoryUsage(); peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss); }
  const timer = setInterval(sampleMemory, 10), samples = [], count = 2000;
  const invoke = async (name: string, input: any) => {
    const id = "native-allocation-" + samples.length, event: any = { type: "tool_call", toolCallId: id, toolName: name, input };
    f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as any);
    let prepared: Awaited<ReturnType<typeof files.prepareInvocation>>;
    try {
      const grant = await policy.authorize(event, f.ctx, definitions[name], false, async () => { prepared = await files.prepareInvocation(event, f.ctx); return prepared?.describePreflight; });
      try { grant.consume(input, id, name); return await definitions[name].execute(id, prepared!.consume(input, id, name), f.ctx.signal); }
      finally { grant.release(); }
    } finally { prepared?.release(); }
  };
  try {
    for (const name of ["source", "copied", "moved", "batch"]) await mkdir(join(root, name));
    const copies = [], moves = [], paths = [], operations = [];
    for (let index = 0; index < count; index++) {
      const source = `source/${index}`, copied = `copied/${index}`, moved = `moved/${index}`;
      await writeFile(join(root, source), "x"); copies.push({ path: source, destination: copied }); moves.push({ path: copied, destination: moved }); paths.push(moved);
      operations.push({ operation: "write", path: `batch/${index}`, mode: "create", content: "one" });
    }
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (const operation of ["copy", "move", "delete", "file_batch"] as const) {
      const started = performance.now(), cpu = process.cpuUsage();
      const result = await invoke(operation, operation === "copy" ? { items: copies } : operation === "move" ? { items: moves } : operation === "delete" ? { paths } : { operations });
      assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.succeeded, count); assert.equal(result.details.itemsOmitted, true);
      const reader = new FileResultReader(f.manager); let cursor: string | undefined, outcomes = 0;
      try { do {
        const page = reader.read(result.details.resultRef, cursor, 128); assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
        for (const row of page.records) if (row.record.phase === "result") outcomes++;
        cursor = page.nextCursor ?? undefined;
      } while (cursor); } finally { reader.dispose(); }
      assert.equal(outcomes, count);
      const changes = new FileChangesV3(f.manager); let visited = 0;
      try { changes.open(result.details.resultRef); let more; do { const page = changes.nextItems(); visited += page.records.length; more = page.hasMore; } while (more); }
      finally { changes.dispose(); }
      assert.equal(visited, count);
      for (let index = 0; index < count; index++) {
        if (operation === "copy") assert.equal(await readFile(join(root, "copied", String(index)), "utf8"), "x");
        else if (operation === "move") { assert.equal(await readFile(join(root, "moved", String(index)), "utf8"), "x"); await assert.rejects(lstat(join(root, "copied", String(index))), { code: "ENOENT" }); }
        else if (operation === "delete") await assert.rejects(lstat(join(root, "moved", String(index))), { code: "ENOENT" });
        else assert.equal(await readFile(join(root, "batch", String(index)), "utf8"), "one");
      }
      const sample = { operation, targets: count, milliseconds: performance.now() - started, cpuMicroseconds: process.cpuUsage(cpu) }; samples.push(sample);
      process.stdout.write(JSON.stringify({ fixture: "native-v3-session", ...sample }) + "\n");
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling"); let sampledBytes = 0; const stack = [profile.head], allocationSites = [];
    while (stack.length) {
      const node = stack.pop()!; sampledBytes += node.selfSize;
      if (node.selfSize) allocationSites.push({ function: node.callFrame.functionName, source: basename(node.callFrame.url), sampledBytes: node.selfSize });
      for (const child of node.children) stack.push(child);
    }
    allocationSites.sort((left, right) => right.sampledBytes - left.sampledBytes);
    await files.dispose(); policy.dispose(); await f.runtime.executionBoundary.dispose(); await disposeNativeFileWorker();
    // node:test keeps every mocked call's returned Promise. Drop that fixture
    // history before measuring production-owner reference release.
    preparationProbe.mock.resetCalls();
    for (let index = 0; index < 4; index++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
    let retainedPlans = 0; for (const ref of refs) if (ref.deref()) retainedPlans++;
    assert.equal(retainedPlans, 0); assert.equal(files.getDiagnostics().pending, 0); assert.equal(files.getDiagnostics().revisions, 0);
    sampleMemory(); t.diagnostic(JSON.stringify({ fixture: "native-v3-session", samples, peakHeap, peakRss, sampledBytes,
      sampledNotTotalAllocations: true, allocationSites: allocationSites.slice(0, 15), planReferences: refs.length, retainedPlans, sessionHistoricalEntries: f.manager.getEntryCount() }));
  } finally {
    clearInterval(timer); inspector.disconnect(); await files.dispose(); policy.dispose(); await f.runtime.executionBoundary.dispose(); await disposeNativeFileWorker(); await rm(root, { recursive: true });
  }
});
