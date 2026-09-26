import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { mutationFixture as fixture } from "./helpers/mutation-fixture.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "@super-pi/tui";
import { Session as InspectorSession } from "node:inspector/promises";

test("N1 preview has real mixed changes and no filesystem mutation", async t => {
  const f = await fixture(t);
  for (const name of ["edit", "snapshot", "delete", "move"]) writeFileSync(join(f.cwd, name), "one\ntwo\nthree\n");
  await f.call("read", { path: "edit" }, "read-exact");
  const read = await f.call("read", { path: "snapshot", offset: 2, limit: 1 }, "read-snapshot");
  const body = read.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  const snapshot = body.slice(body.indexOf("snapshot=") + 9, body.indexOf("snapshot=") + 36);
  const anchor = body.split("\n").find(line => line.startsWith("2#"))!.split("|")[0];
  let mutations = 0;
  for (const method of ["mkdir", "link", "unlink", "rename", "writeFile"] as const) {
    const original: any = fs[method];
    t.mock.method(fs, method, (...args: any[]) => { mutations++; return original(...args); });
  }
  const originalOpen = fs.open;
  t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => { if (args[1] !== "r") mutations++; return originalOpen(...args); });
  const result = await f.call("file_batch", { dryRun: true, operations: [
    { operation: "write", mode: "create", path: "中文/new/empty", content: "" },
    { operation: "write", mode: "create", path: "中文/new/text", content: "新行\n" },
    { operation: "edit", path: "edit", edits: [{ oldText: "two", newText: "TWO" }] },
    { operation: "edit", path: "snapshot", snapshot, edits: [{ kind: "replace", start: anchor, newLines: ["SECOND"] }] },
    { operation: "delete", path: "delete" }, { operation: "move", path: "move", destination: "moved" },
  ] }, "mixed-preview");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(mutations, 0);
  const details = result.details as any;
  assert.equal(details.succeeded, 0);
  assert.equal(details.preview, true);
  assert.deepEqual(details.items.map((item: any) => item.status), Array(6).fill("preview"));
  assert.equal(details.plannedDirectories.length, 2);
  assert.equal(details.items[0].preview.addedLines, 0);
  assert.equal(details.items[1].preview.addedLines, 1);
  assert.match(details.items[2].preview.diff, /-.*two[\s\S]*\+.*TWO/);
  assert.match(details.items[3].preview.diff, /two[\s\S]*SECOND/);
  assert.doesNotMatch(details.items[3].preview.diff, /one|three/);
  assert.match(details.items[4].preview.risk, /irreversible/);
  assert.match(details.items[5].preview.risk, /non-atomic/);
  assert.equal(existsSync(join(f.cwd, "中文")), false);
  assert.equal(readFileSync(join(f.cwd, "edit"), "utf8"), "one\ntwo\nthree\n");
  assert.ok(result.content.every(block => block.type !== "text" || !block.text.includes("SECOND")), "model summary does not repeat patch");
  assert.ok(!f.session.getBranch().some((e: any) => e.customType === "file-mutation-progress-v2" && e.data.toolCallId === "mixed-preview"));
});

test("N1 preview line/UTF-8 budgets, empty/binary content, and new authorization", async t => {
  const f = await fixture(t);
  const operations = Array.from({ length: 16 }, (_, i) => ({ operation: "write", mode: "create", path: `new/f${i}`, content: ("中文".repeat(80) + "\n").repeat(100) }));
  const result = await f.call("file_batch", { dryRun: true, operations }, "bounded-preview");
  assert.equal(result.isError, false, JSON.stringify(result));
  const details = result.details as any;
  let lines = 0, bytes = 0;
  for (const item of details.items) { const diff = item.preview.diff ?? ""; lines += diff ? diff.split("\n").length : 0; bytes += Buffer.byteLength(diff); assert.ok(!diff || diff.split("\n").length <= 80); }
  assert.ok(lines <= 400); assert.ok(bytes <= 65536);
  assert.ok(details.items.some((i: any) => i.preview.omitted));
  const binary = await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "binary", content: "\0" }] }, "binary-preview");
  assert.equal((binary.details as any).items[0].preview.addedLines, undefined);
  assert.equal((binary.details as any).items[0].preview.diff, undefined);
  await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never); f.deny();
  assert.equal((await f.call("file_batch", { operations: [{ ...operations[0], content: "changed" }] }, "apply")).isError, true);
  assert.equal(existsSync(join(f.cwd, "new")), false);
});

test("N1 unread neighbors stay out of exact preview and failed preview identifies its item", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "file"), "PRIVATE_BEFORE\ntwo\nPRIVATE_AFTER\n");
  await f.call("read", { path: "file", offset: 2, limit: 1 });
  const result = await f.call("file_batch", { dryRun: true, operations: [{ operation: "edit", path: "file", edits: [{ oldText: "two", newText: "TWO" }] }] });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const failed = await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "first", content: "x" }, { operation: "delete", path: "missing" }] }, "bad-preview");
  assert.equal(failed.isError, true); assert.match(JSON.stringify(failed), /bad-preview:1/);
  assert.equal(existsSync(join(f.cwd, "first")), false);
});

test("N1 actual tool component expansion, 20k running updates and ten releases", async t => {
  const f = await fixture(t); initTheme("dark");
  const input = { dryRun: true, operations: [{ operation: "write", mode: "create", path: "中文.txt", content: "actual change\n" }] };
  const result = await f.call("file_batch", input);
  const definition = f.runner.getAllRegisteredTools().find(r => r.definition.name === "file_batch")!.definition;
  const partial = { content: [], details: undefined };
  const profiler = process.env.SP_PREVIEW_PROFILE === "1" ? new InspectorSession() : undefined;
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  if (profiler) { profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024 }); }
  for (let cycle = 0; cycle < 10; cycle++) {
    const component = new ToolExecutionComponent("file_batch", `preview-${cycle}`, input, {}, definition, { requestRender() {} } as never, f.cwd);
    for (let n = 0; n < 2000; n++) component.updateResult(partial as never, true);
    assert.ok(component.render(20).join("\n").includes("running"));
    component.updateResult(result);
    component.setExpanded(true);
    assert.match(component.render(80).join("\n"), /actual change/);
    component.setExpanded(false);
    assert.doesNotMatch(component.render(80).join("\n"), /actual change/);
    component.setExpanded(true);
    assert.match(component.render(15).join("\n"), /actual/);
    const state = (component as any).rendererState;
    assert.ok(state.batchComponent);
    const textComponent = state.batchComponent;
    const before = textComponent.getPreviewRenderCounts();
    for (let n = 0; n < 100; n++) component.render(15);
    assert.equal(textComponent.getPreviewRenderCounts().textChanges, before.textChanges);
    component[RELEASE_COMPONENT_RENDER_CACHE]();
    assert.equal(state.batchComponent, undefined);
    assert.equal(textComponent.getPreviewRenderCounts().retainedCharacters, 0);
    assert.deepEqual(textComponent.render(80), []);
  }
  if (profiler) {
    try {
      const { profile } = await profiler.post("HeapProfiler.stopSampling");
      let sampledBytes = 0;
      const stack = [profile.head];
      while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize; for (const child of node.children) stack.push(child); }
      global.gc?.();
      t.diagnostic(JSON.stringify({ benchmark: "file-change-preview", node: process.version, updates: 20000, cycles: 10,
        sampledBytes, sampledBytesPerUpdate: sampledBytes / 20000, heapBefore, heapAfterRelease: process.memoryUsage().heapUsed,
        stableRenderTextChanges: 0, releasedDerivedCharacters: 0 }));
    } finally { profiler.disconnect(); }
  }
  t.diagnostic("cycles=10; runningUpdates=20000; stableRenderTextChanges=0; releasedDerivedCharacters=0");
});
