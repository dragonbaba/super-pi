import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_COMPONENT_RENDER_CACHE, type TUI } from "@super-pi/tui";
import type { ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";
import { createWriteToolDefinition } from "../packages/coding-agent/src/core/tools/write.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { renderWriteResult } from "../packages/extensions/mutation-guard-write/write-renderer.ts";
import { costCall, costSession } from "./helpers/next-phase-session.ts";

const { releaseComponentRenderCaches } = await import(pathToFileURL(resolve("packages/tui/dist/tui.js")).href) as typeof import("../packages/tui/src/tui.ts");

initTheme("dark");
const definition = { ...createWriteToolDefinition(process.cwd()), collapseCallOnResult: true, renderResult: renderWriteResult };
function card(args = { path: "fixture.ts", content: "const visibleBody = 1;" }) {
  return new ToolExecutionComponent("write", "write-card", args, {}, definition as ToolDefinition<any, any>, { requestRender() {} } as TUI, process.cwd());
}
function visible(component: ToolExecutionComponent, width = 100) { return stripVTControlCharacters(component.render(width).join("\n")); }
const created = { operation: "write", mutationReceiptVersion: 1, ok: true, category: "success", stateChanged: true, created: true };

test("write completion uses receipts, preserves original objects and expands in the same card", () => {
  const args = { path: "fixture.ts", content: "const visibleBody = 1;" };
  const component = card(args);
  assert.doesNotMatch(visible(component), /Added/);
  component.setArgsComplete();
  const result = { content: [{ type: "text", text: "Added fixture.ts (+1)" }], details: created };
  component.updateResult(result, true, false);
  assert.match(visible(component), /Write running/);
  assert.doesNotMatch(visible(component), /Added/);
  component.updateResult(result, false, false);
  assert.match(visible(component), /Added fixture.ts/);
  assert.equal(visible(component).split("fixture.ts").length - 1, 1);
  assert.doesNotMatch(visible(component), /visibleBody/);
  component.setExpanded(true);
  assert.match(visible(component), /visibleBody/);
  component.setExpanded(false);
  assert.doesNotMatch(visible(component), /visibleBody/);
  assert.strictEqual((component as any).args, args);
  assert.strictEqual((component as any).result, result);
  assert.match(visible(component, 16).replace(/\s/g, ""), /Addedfixture\.ts/);
});

test("write terminal states never infer success from Added text", () => {
  const cases = [
    [created, false, "Added"],
    [{ ...created, created: undefined, previousSha256: "old", commit: { outcome: "committed" } }, false, "Modified"],
    [{ ...created, ok: false, status: "partial", requiresVerification: true }, true, "Partial write"],
    [{ ...created, ok: false, status: "state_unknown" }, true, "Write state unknown"],
    [{ ...created, ok: false, status: "cancelled" }, true, "Write cancelled"],
    [{ ...created, ok: false, status: "failed_no_change", stateChanged: false }, true, "Write failed — no change"],
    [undefined, true, "Write failed — inspect result"],
    [undefined, false, "Write status unverified"],
  ] as const;
  for (const [details, isError, expected] of cases) {
    const component = card({ path: "empty.ts", content: "" });
    component.setArgsComplete();
    component.updateResult({ content: [{ type: "text", text: "Added is only untrusted prose" }], details }, false, isError);
    assert.ok(visible(component).includes(expected), visible(component));
    assert.doesNotMatch(visible(component), /untrusted prose/);
    component.setExpanded(true);
    assert.match(visible(component), /untrusted prose/);
  }
});

test("streamed long content reuses completed highlights across toggles and releases hidden caches", () => {
  const component = card({ path: "long.ts", content: "const first = 1;\n" });
  component.updateArgs({ path: "long.ts", content: "const first = 1;\n" + "// retained fixture line\n".repeat(2000) });
  component.setArgsComplete();
  const call = (component as any).callRendererComponent;
  const highlights = call.cache.highlightedLines;
  component.updateResult({ content: [{ type: "text", text: "Added long.ts" }], details: created }, false, false);
  for (let i = 0; i < 20; i++) {
    component.setExpanded(true); component.render(32); component.setExpanded(false); component.render(32);
    assert.strictEqual(call.cache.highlightedLines, highlights);
  }
  const result = (component as any).resultRendererComponent;
  const summary = result.summary;
  for (let i = 0; i < 100; i++) component.render(32);
  assert.strictEqual(result.summary, summary);
  releaseComponentRenderCaches(component);
  assert.equal(call.cache, undefined);
  assert.equal(result.receipt, undefined);
  assert.equal(result.source, undefined);
  assert.equal(result.summary, "");
  // Idempotent release is required for clear/dispose paths.
  component[RELEASE_COMPONENT_RENDER_CACHE]();
});

test("real guarded create, overwrite and empty receipts render identically after session reopen", async () => {
  const fixture = await costSession();
  try {
    const first = { path: "created.txt", content: "first content" };
    const next = { path: "created.txt", content: "second content" };
    await fixture.run([[costCall("create", "write", first)], [costCall("read", "read", { path: first.path })], [costCall("overwrite", "write", next)], [costCall("empty", "write", { path: "empty.txt", content: "" })]]);
    assert.equal(readFileSync(join(fixture.cwd, first.path), "utf8"), next.content);
    const before = new Map<string, string>();
    for (const [id, args, label] of [["create", first, "Added"], ["overwrite", next, "Modified"], ["empty", { path: "empty.txt", content: "" }, "Added"]] as const) {
      const result = fixture.result(id);
      assert.equal(result.isError, false);
      const component = card(args); component.setArgsComplete(); component.updateResult(result, false, result.isError);
      assert.match(visible(component), new RegExp(label));
      before.set(id, visible(component));
    }
    await fixture.reopen();
    for (const [id, args] of [["create", first], ["overwrite", next], ["empty", { path: "empty.txt", content: "" }]] as const) {
      const result = fixture.result(id), component = card(args);
      component.setArgsComplete(); component.updateResult(result, false, result.isError);
      assert.equal(visible(component), before.get(id));
    }
  } finally { await fixture.release(); }
});
