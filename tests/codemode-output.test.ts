import assert from "node:assert/strict";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import test from "node:test";
import { capCodemodeOutput, boundCodemodeResult } from "../packages/coding-agent/src/core/codemode-result.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { BoundedJson } from "../packages/codemode/src/bounded-json.ts";
import { schemaToType } from "../packages/codemode/src/declarations.ts";
import { CodemodeStore } from "../packages/coding-agent/src/core/codemode-store.ts";

function removeOwned(path: string) {
  assert.equal(readFileSync(path + ".sp-owned", "utf8"), "super-pi-output-spill-v2\n");
  unlinkSync(path); unlinkSync(path + ".sp-owned");
}

test("Codemode token cap preserves a bounded preview and recoverable Unicode without rerunning tools", async () => {
  const text = "中文🙂".repeat(10000);
  const result = await capCodemodeOutput([{ type: "text", text }], 256);
  const notice = result.at(-1)!;
  assert.equal(notice.type, "text");
  if (notice.type !== "text") assert.fail();
  const path = /with read: (.+)\. Do not/.exec(notice.text)?.[1]; assert.ok(path);
  try {
    assert.ok(estimateToolOutputTokens(result).estimatedTokens <= 256);
    assert.equal(readFileSync(path, "utf8"), text + "\n");
    assert.doesNotMatch(JSON.stringify(result), /�/);
    assert.match(notice.text, /Do not repeat completed side effects/);
  } finally { removeOwned(path); }
});

test("Codemode 10 MiB single-line result reports recovery cap honestly", async () => {
  const result = await boundCodemodeResult({ role: "toolResult", toolCallId: "large", toolName: "fixture", timestamp: 0, isError: false,
    content: [{ type: "text", text: "x".repeat(10 * 1024 * 1024) }] }, new BoundedJson());
  const path = result.details.codemodeOutput.path;
  try {
    assert.equal(result.details.codemodeOutput.capped, true);
    assert.ok(statSync(path).size <= 5 * 1024 * 1024);
    assert.ok(JSON.stringify(result.content).length < 34 * 1024);
    assert.match(JSON.stringify(result.content), /later data was not saved/);
    assert.match(readFileSync(path, "utf8").slice(-100), /later output was not persisted/);
  } finally { removeOwned(path); }
});

test("small native results retain content identity for host read receipts and normalize optional metadata", async () => {
  const input = { role: "toolResult" as const, toolCallId: "read", toolName: "read", timestamp: 0, isError: false,
    content: [{ type: "text" as const, text: "source" }], details: { optional: undefined, count: 1 } };
  const result = await boundCodemodeResult(input, new BoundedJson());
  assert.equal(result.content, input.content);
  assert.deepEqual(result.details, { count: 1 });
});

test("schema declarations and restored state reject oversized, recursive and deep data before expansion", () => {
  const cyclic: any = { type: "object", properties: {} }; cyclic.properties.self = cyclic;
  assert.equal(schemaToType(cyclic), "unknown");
  assert.equal(schemaToType({ const: "x".repeat(10 * 1024 * 1024) }), "unknown");
  let deep: any = { type: "string" };
  for (let i = 0; i < 100; i++) deep = { type: "array", items: deep };
  assert.equal(schemaToType(deep), "unknown");
  const store = new CodemodeStore();
  assert.throws(() => store.restore({ a: "x".repeat(10 * 1024 * 1024) }), /limit/);
  assert.equal(Object.keys(store.snapshot).length, 0);
});
