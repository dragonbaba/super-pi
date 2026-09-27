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
import { syncBuiltinESMExports } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { batchExpandedSummary, displayMetadata, PreviewBudget, verificationSummary, BatchResultText } from "../packages/extensions/mutation-guard-write/change-preview.ts";
import { DISPLAY_METADATA_CONTROL_PATTERN, PREVIEW_CONTROL_PATTERN } from "../packages/extensions/mutation-guard-write/regex.ts";

test("N1 imported diff is passed to the budget without concatenating its full body", t => {
  const large = "x".repeat(8 * 1024 * 1024), take = PreviewBudget.prototype.take; let observed = 0;
  t.mock.method(PreviewBudget.prototype, "take", function(this: PreviewBudget, source: string, ...args: any[]) {
    if (source.length > 65536) { assert.equal(source, large); observed++; }
    return Reflect.apply(take, this, [source, ...args]);
  });
  for (const status of ["preview", "succeeded"]) {
    const text = batchExpandedSummary("bounded", [{ itemId: "x:0", operation: "edit", target: "fixture", status, preview: { kind: "Modified", diff: large }, receipt: { patch: large } }]);
    assert.ok(Buffer.byteLength(text) <= 65536); assert.ok(text.includes("display"));
  }
  assert.equal(observed, 2);
  const array = new Proxy([], { get() { assert.fail("metadata arrays must not be coerced/traversed"); } });
  assert.equal(displayMetadata(array), "[invalid metadata]");
});

test("N1 live batch result bounds narrow wrapping, caches stable renders and releases rows", () => {
  const component = new BatchResultText("", 0, 0);
  component.setBatchText("x".repeat(65536));
  const first = component.render(1), counters = component.getPreviewRenderCounts();
  assert.equal(first.length, 401); assert.equal(stripVTControlCharacters(first.at(-1)!), "…");
  for (let i = 0; i < 20000; i++) assert.equal(component.render(1), first);
  assert.deepEqual(component.getPreviewRenderCounts(), counters);
  for (const width of [2, 80, 1, 120]) assert.ok(component.render(width).length <= 401);
  component[RELEASE_COMPONENT_RENDER_CACHE](); assert.equal(component.getPreviewRenderCounts().cachedRows, 0);
  component.releasePreview(); const released = component.getPreviewRenderCounts();
  assert.equal(released.bodyCodeUnits, 0); assert.equal(released.retainedCharacters, 0); assert.equal(released.cachedRows, 0);
});

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
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
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
  assert.equal(details.expandedSummary.match(/planned parent:/g)?.length, 2);
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
  const control = await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "counter-control/file", content: "control" }] }, "counter-control");
  assert.equal(control.isError, false);
  assert.ok(mutations > 0, "positive control proves filesystem mutation counters reach production bindings");
});

test("N1 review: overwrite growth after metadata capture never causes a full preview read", async t => {
  const f = await fixture(t); const path = join(f.cwd, "growing"); writeFileSync(path, "before");
  await f.call("read", { path }, "read-growing");
  // Jiti imports keep their native bindings. Gate the opened handle's methods,
  // rather than a module-property mock that never reaches production imports.
  const probe = await fs.open(path, "r"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = prototype.stat, originalRead = prototype.read;
  let grown = false, readsAfterGrowth = 0;
  t.mock.method(prototype, "stat", async function(this: any, ...args: any[]) {
    if (!grown) { writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 65)); grown = true; }
    return originalStat.apply(this, args);
  });
  t.mock.method(prototype, "read", function(this: any, ...args: any[]) { if (grown) readsAfterGrowth++; return originalRead.apply(this, args); });
  const result = await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "overwrite", path, content: "after" }] }, "growth-preview");
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /preview working-set limit/);
  assert.equal(grown, true);
  assert.equal(readsAfterGrowth, 0);
  assert.equal(readFileSync(path).length, 2 * 1024 * 1024);
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

test("N1 successful batch expansion uses committed patch and its confirmed provenance", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "committed-diff"), "one\ntwo\nthree\n");
  await f.call("read", { path: "committed-diff", offset: 2, limit: 1 }, "committed-read");
  const result = await f.call("file_batch", { operations: [{ operation: "edit", path: "committed-diff", edits: [{ oldText: "two", newText: "CONFIRMED_PATCH" }] }] }, "committed-batch");
  assert.equal(result.isError, false, JSON.stringify(result));
  const details = result.details as any;
  assert.ok(details.items[0].preview.omitted);
  assert.match(details.expandedSummary, /CONFIRMED_PATCH/);
  assert.doesNotMatch(details.expandedSummary, /Prepared change only|\[omitted\]/);
  assert.ok(details.expandedSummary.includes(details.items[0].receipt.patch));
});

test("N1 successful create and overwrite retain bounded confirmed write differences", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "overwrite"), "before\n");
  await f.call("read", { path: "overwrite" }, "write-preview-read");
  const result = await f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "created", content: "CREATED_VISIBLE\n" },
    { operation: "write", mode: "overwrite", path: "overwrite", content: "OVERWRITE_VISIBLE\n" },
  ] }, "confirmed-write");
  assert.equal(result.isError, false, JSON.stringify(result));
  const expanded = (result.details as any).expandedSummary;
  assert.match(expanded, /CREATED_VISIBLE/); assert.match(expanded, /OVERWRITE_VISIBLE/);
  assert.doesNotMatch(expanded, /Prepared change only/);
});

test("N1 oversized committed patches disclose omission and retain later outcomes", async t => {
  const f = await fixture(t), before = Array.from({ length: 120 }, (_, i) => `old-${i}`).join("\n"), after = before.replaceAll("old-", "new-");
  writeFileSync(join(f.cwd, "large-patch"), before); await f.call("read", { path: "large-patch" }, "large-read");
  const result = await f.call("file_batch", { operations: [{ operation: "edit", path: "large-patch", edits: [{ oldText: before, newText: after }] },
    { operation: "write", mode: "create", path: "following", content: "later-outcome" }] }, "large-committed");
  assert.equal(result.isError, false, JSON.stringify(result));
  const summary = (result.details as any).expandedSummary;
  assert.match(summary, /display limited/); assert.match(summary, /large-committed:1: Added .*following \[succeeded\]/);
  assert.equal(readFileSync(join(f.cwd, "large-patch"), "utf8"), after); assert.equal(readFileSync(join(f.cwd, "following"), "utf8"), "later-outcome");
});

test("N1 actual and imported preview bodies strip every C1 control", async t => {
  const f = await fixture(t), controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(0x80 + index)).join("");
  const content = "before" + controls + "after\n";
  const result = await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "controls", content }] }, "controls");
  assert.equal(result.isError, false); assert.equal(existsSync(join(f.cwd, "controls")), false);
  const actual = (result.details as any).expandedSummary;
  const imported = batchExpandedSummary("imported", [{ itemId: "imported:0", operation: "edit", target: "target", status: "succeeded", receipt: { patch: content } }]);
  for (const text of [actual, imported, new PreviewBudget().take(content).text]) {
    for (const character of text) assert.ok(character.charCodeAt(0) < 0x80 || character.charCodeAt(0) > 0x9f);
    assert.ok(text.includes("before")); assert.ok(text.includes("after"));
  }
});

test("N1 metadata fields cannot introduce new headings or bidi controls into expanded views", () => {
  const unsafe = "path\nfake: succeeded\u202e\u001b[31m";
  const summary = batchExpandedSummary("one result", [{ itemId: unsafe, operation: "move", status: "succeeded", target: unsafe, destination: unsafe,
    receipt: { createdDirectories: [{ path: unsafe, status: unsafe }] } }], [unsafe]);
  assert.doesNotMatch(summary, /\nfake:|\u202e|\u001b/); assert.ok(summary.includes(displayMetadata(unsafe)));
  assert.match(summary, /\\nfake: succeeded\\u202e/);
  const preview = batchExpandedSummary("preview", [{ itemId: "preview", operation: "write", status: "preview", target: "target", preview: { kind: "Added", risk: unsafe, omitted: unsafe } }]);
  assert.doesNotMatch(preview, /\nfake:|\u202e|\u001b/); assert.ok(preview.includes(displayMetadata(unsafe)));
});

test("N1 imported counts and oversized directory arrays stay bounded single-line metadata", () => {
  for (const field of ["bytes", "addedLines"]) {
    const summary = batchExpandedSummary("result", [{ itemId: "one", operation: "write", target: "target", status: "succeeded",
      receipt: { creation: { [field]: "1\nfake: succeeded\u202e" } } }]);
    assert.match(summary, /invalid count/); assert.doesNotMatch(summary, /fake|\u202e/);
  }
  let visits = 0;
  const directories = new Array(100000);
  for (let n = 0; n < 33; n++) Object.defineProperty(directories, n, { get() { visits++; assert.ok(n < 32); return { path: "p", status: "created" }; } });
  const summary = batchExpandedSummary("result", [{ itemId: "one", operation: "write", target: "target", status: "partial", receipt: { createdDirectories: directories } }]);
  assert.equal(visits, 32); assert.match(summary, /remaining display omitted/);
  visits = 0;
  const planned = batchExpandedSummary("line\n".repeat(500), [], directories);
  assert.equal(visits, 0); assert.match(planned, /remaining display omitted/); assert.ok(Buffer.byteLength(planned) <= 65536);
  const view = verificationSummary({ parents: Array.from({ length: 32 }, (_, n) => ({ path: `p${n}`, identity: Object.fromEntries(Array.from({ length: 15 }, (_, k) => [`field${k}`, "observed"])) })) });
  assert.match(view, /verification display truncated/); assert.ok(Buffer.byteLength(view) <= 65536); assert.ok(view.split("\n").length <= 400);
});

test("N1 shared display patterns reset across interleaved preview owners", () => {
  for (let n = 0; n < 20; n++) {
    DISPLAY_METADATA_CONTROL_PATTERN.lastIndex = 999;
    PREVIEW_CONTROL_PATTERN.lastIndex = 999;
    assert.equal(displayMetadata("中\u202e\u0080\n文"), "中\\u202e\\u0080\\n文");
    assert.equal(new PreviewBudget().take("A\0B\u007f\nC").text, "AB\nC");
    assert.equal(displayMetadata("plain"), "plain");
    assert.equal(new PreviewBudget().take("D\u0001E").text, "DE");
    assert.equal(DISPLAY_METADATA_CONTROL_PATTERN.lastIndex, 0);
    assert.equal(PREVIEW_CONTROL_PATTERN.lastIndex, 0);
  }
});

test("N1 actual tool component expansion, 20k running updates and ten releases", async t => {
  const f = await fixture(t); initTheme("dark");
  const input = { dryRun: true, operations: [{ operation: "write", mode: "create", path: "中文.txt", content: "actual change\n" }] };
  const result = await f.call("file_batch", input);
  const narrowResult = { ...result, details: { ...result.details as object, expandedSummary: "x".repeat(65536) } };
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
    component.updateResult(narrowResult);
    component.render(3);
    const narrowBefore = textComponent.getPreviewRenderCounts();
    assert.ok(narrowBefore.cachedRows <= 401);
    for (let n = 0; n < 2000; n++) component.render(3);
    assert.deepEqual(textComponent.getPreviewRenderCounts(), narrowBefore);
    component[RELEASE_COMPONENT_RENDER_CACHE]();
    assert.equal(state.batchComponent, undefined);
    assert.equal(textComponent.getPreviewRenderCounts().retainedCharacters, 0);
    assert.equal(textComponent.getPreviewRenderCounts().bodyCodeUnits, 0);
    assert.equal(textComponent.getPreviewRenderCounts().cachedRows, 0);
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
        stableRenderTextChanges: 0, narrowStableRenders: 20000, narrowStableNewRows: 0, maxCachedRows: 401, releasedDerivedCharacters: 0, releasedCachedRows: 0 }));
    } finally { profiler.disconnect(); }
  }
  t.diagnostic("cycles=10; runningUpdates=20000; stableRenderTextChanges=0; releasedDerivedCharacters=0");
});
