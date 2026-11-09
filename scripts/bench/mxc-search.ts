import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import ts from "typescript";

// Exercise the production pure scan, excluding filesystem/process startup costs.
const source = ts.createSourceFile("worker.mjs", readFileSync("packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["grepRows", "appendSearchRow"].includes(node.name?.text ?? ""));
assert.equal(functions.length, 2);
const scan = new Function("SEARCH_ROWS", functions.map(node => node.getText(source)).join("\n") + "\nreturn grepRows;")(200);
assert.ok(global.gc, "Run with --expose-gc");
const inspector = new Session(); inspector.connect();
const references: WeakRef<object>[] = [];
let slices = 0, retainedRows = 0, maxCharacters = 0;
function cycle() {
  const text = "中".repeat(256) + "\n", content = text.repeat(1000), rows: string[] = [];
  const input = { length: content.length,
    indexOf(value: string, start?: number) { return content.indexOf(value, start); },
    slice(start: number, end: number) { slices++; return content.slice(start, end); } };
  const remaining = scan(input, "中", "中文".repeat(105), rows, 32768);
  assert.equal(remaining, -1);
  let characters = 0;
  for (const row of rows) characters += row.length + 1;
  assert.ok(characters <= 32768); maxCharacters = Math.max(maxCharacters, characters);
  retainedRows += rows.length;
  references.push(new WeakRef(rows), new WeakRef(input));
  rows.length = 0; // search() releases its call-owned output array in finally.
}
try {
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
  for (let index = 0; index < 16; index++) cycle();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  for (let index = 0; index < 4; index++) { await tick(); global.gc!(); }
  let retained = 0, sampledBytes = 0;
  for (const reference of references) if (reference.deref()) retained++;
  const pending = [profile.head];
  while (pending.length) { const node = pending.pop()!; sampledBytes += node.selfSize; for (const child of node.children) pending.push(child); }
  assert.equal(retained, 0);
  assert.equal(slices, retainedRows + 16, "one bounded rejected candidate per search");
  console.log(JSON.stringify({ cycles: 16, slices, retainedRows, maxCharacters, sampledBytes,
    perRowArrays: 0, perRowObjects: 0, perRowPromises: 0, jsonMaterializationsDuringScan: 0, retainedAfterFourGC: retained }));
} finally { inspector.disconnect(); }
