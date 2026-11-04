import assert from "node:assert/strict";
import cp, { type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";

const root = process.argv[2]!, scene = process.argv[3]!;
assert.equal(tmpdir(), root); assert.equal(process.env.TMP, root);
assert.equal(process.env.TEMP, root); assert.equal(process.env.TMPDIR, root);
process.env.PATH = dirname(rgPath) + delimiter + (process.env.PATH ?? "");
const data = join(root, "data"); mkdirSync(data);
let content = "before\nHIT one\nshared\nHIT two\nafter\ngap\ngap\nHIT three\nlast";
let context = 1, pattern = "HIT", limit = 100;
if (scene === "crlf") content = "前\r\nHIT 日本😀\r\n後\r\n";
if (scene === "cr") content = "before\rHIT one\rafter\nlast";
if (scene === "utf16") content = "前\nHIT 日本😀\n後";
if (scene === "bytes") content = "before\nHIT binary\nafter";
if (scene === "long") content = "before\nHIT " + "z".repeat(2 * 1024 * 1024) + "\nafter";
if (scene === "large") content = "prefix\n".repeat(100000) + "before\nHIT one\nafter\n" + "tail\n".repeat(100000);
if (scene === "budget") { content = "short\n".repeat(20000) + "HIT one\nafter"; context = 20001; }
if (scene === "budget-exact") {
  const lines: string[] = []; let bytes = 0;
  while (bytes < 51200) {
    const prefix = `sample.txt-${lines.length + 1}- `;
    const length = Math.min(400, 51200 - bytes - prefix.length - (lines.length ? 1 : 0));
    assert.ok(length >= 0); lines.push("x".repeat(length)); bytes += prefix.length + length + (lines.length > 1 ? 1 : 0);
  }
  content = lines.join("\n") + "\nHIT tail\nafter"; context = lines.length;
}
if (scene === "limit") { content = "before\nHIT one\nHIT two\nafter"; limit = 1; context = 2; }
if (scene === "error") pattern = "[";
const file = join(data, "sample.txt");
writeFileSync(file, scene === "utf16" ? Buffer.from("\uFEFF" + content, "utf16le") : scene === "bytes" ? Buffer.concat([Buffer.from(content), Buffer.from([255])]) : content);
if (scene === "multi") writeFileSync(join(data, "second.txt"), "HIT first\nend");
const processes: Array<{ pid: number | undefined; startedAt: string; code: number | null; purpose: string }> = [];
const originalSpawn = cp.spawn, originalSync = cp.spawnSync, originalRead = fs.readFile;
let child: ReturnType<typeof cp.spawn> | undefined, reads = 0, readBytes = 0;
const controller = new AbortController();
cp.spawnSync = ((command: string, args: string[], options: SpawnSyncOptions) => {
  const startedAt = new Date().toISOString(), result = originalSync(command, args, options);
  processes.push({ pid: result.pid, startedAt, code: result.status, purpose: "availability" }); return result;
}) as typeof cp.spawnSync;
cp.spawn = ((command: string, args: string[], options: SpawnOptions) => {
  const startedAt = new Date().toISOString(); child = originalSpawn(command, args, options);
  const record = { pid: child.pid, startedAt, code: null as number | null, purpose: "grep" }; processes.push(record);
  child.once("close", code => { record.code = code; });
  if (scene === "abort") child.once("spawn", () => controller.abort());
  return child;
}) as typeof cp.spawn;
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  const result = await originalRead(...args);
  if (String(args[0]).startsWith(data)) { reads++; readBytes += Buffer.byteLength(result); }
  return result;
}) as typeof fs.readFile;
syncBuiltinESMExports();
const { createGrepTool } = await import("../../packages/coding-agent/src/core/tools/grep.ts");
const tool = createGrepTool(root);
let text = "", details: { matchCount?: number; matchLimitReached?: number; linesTruncated?: boolean; truncation?: { truncated: boolean } } = {};
try {
  if (scene === "error" || scene === "abort") {
    await assert.rejects(tool.execute("context", { pattern, path: data, context }, controller.signal), scene === "error" ? /regex parse error/ : /Operation aborted/);
  } else {
    const result = await tool.execute("context", { pattern, path: data, context, limit }, controller.signal);
    text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    details = result.details as typeof details;
    if (["overlap", "multi", "large"].includes(scene)) {
      const line = scene === "large" ? 100002 : 2;
      assert.ok(text.includes(`sample.txt-${line - 1}- before\nsample.txt:${line}: HIT one\nsample.txt-${line + 1}- ${scene === "large" ? "after" : "shared"}`), text);
      if (scene !== "large") assert.ok(text.includes("sample.txt-3- shared\nsample.txt:4: HIT two\nsample.txt-5- after"), text);
      if (scene !== "large") assert.ok(text.includes("sample.txt-7- gap\nsample.txt:8: HIT three\nsample.txt-9- last"), text);
      if (scene === "multi") assert.ok(text.includes("second.txt:1: HIT first\nsecond.txt-2- end"), text);
    } else if (scene === "crlf" || scene === "utf16") assert.equal(text, "sample.txt-1- 前\nsample.txt:2: HIT 日本😀\nsample.txt-3- 後");
    else if (scene === "cr") assert.equal(text, "sample.txt:1: beforeHIT oneafter\nsample.txt-2- last");
    else if (scene === "bytes") assert.equal(text, "sample.txt-1- before\nsample.txt:2: HIT binary\nsample.txt-3- after�");
    else if (scene === "long") { assert.ok(text.includes("sample.txt-3- after")); assert.equal(details.linesTruncated, true); assert.ok(text.length < 1000); }
    else if (scene === "budget" || scene === "budget-exact") { assert.equal(details.truncation?.truncated, true); assert.ok(Buffer.byteLength(text) < 51500); assert.ok(text.startsWith(scene === "budget" ? "sample.txt-1- short\n" : "sample.txt-1- xxx")); }
    else if (scene === "limit") { assert.equal(details.matchCount, 1); assert.equal(details.matchLimitReached, 1); assert.ok(text.includes("sample.txt-3- HIT two\nsample.txt-4- after"), text); }
    assert.equal(reads, 0, "default context must not read the complete matched file");
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(child); assert.equal(child.stdout?.destroyed, true); assert.equal(child.stderr?.destroyed, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  console.log(JSON.stringify({ scene, reads, readBytes, outputBytes: Buffer.byteLength(text), matches: details.matchCount, listeners: 0, childClosed: true }));
} finally {
  writeFileSync(join(root, "children.json"), JSON.stringify({ root, resources: [data, file, join(root, "children.json")], processes, reads, readBytes }));
}
