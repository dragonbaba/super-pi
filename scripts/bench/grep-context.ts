import assert from "node:assert/strict";
import cp, { type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { createOwnedTaskFixture } from "../../tests/helpers/owned-task-fixture.ts";

const phase = process.argv[2] ?? "counts", rows = Number(process.argv[3] ?? 4096);
const contextLines = Number(process.argv[4] ?? 1);
assert.ok(["counts", "profile", "lifecycle"].includes(phase)); assert.ok(Number.isSafeInteger(rows) && rows > 0);
assert.ok(Number.isSafeInteger(contextLines) && contextLines > 0);
assert.equal(tmpdir(), process.env.TMP); assert.equal(process.env.TMP, process.env.TEMP); assert.equal(process.env.TMP, process.env.TMPDIR);
const owned = createOwnedTaskFixture("h08-grep-bench-");
const data = join(owned.root, "data"), file = join(data, "sample.txt"), manifest = join(owned.root, "children.json");
mkdirSync(data); const fd = openSync(file, "w");
const filler = "f".repeat(127) + "\n";
for (let index = 0; index < rows; index++) writeSync(fd, filler);
writeSync(fd, "before\nHIT marker\nafter\n"); closeSync(fd);
process.env.PATH = dirname(rgPath) + delimiter + (process.env.PATH ?? "");
process.env.SP_CODING_AGENT_DIR = owned.root; process.env.SP_OFFLINE = "1"; process.env.RIPGREP_CONFIG_PATH = "";
const sourceUrl = new URL("../../packages/coding-agent/src/core/tools/grep.ts", import.meta.url);
const baselinePath = process.env.GREP_BASELINE_PATH;
const source = readFileSync(baselinePath ?? sourceUrl, "utf8");
const counters = { reads: 0, readBytes: 0, wholeFileSplits: 0, splitLines: 0, jsonRecords: 0, jsonCharacters: 0, retainedRows: 0, retainedBytes: 0 };
const refs: WeakRef<object>[] = [], children: ReturnType<typeof cp.spawn>[] = [], signals: AbortSignal[] = [];
let peakHeap = 0, mode = "success";
let faultQueued = false, faultsAfterMatch = 0;
const processes: Array<{ pid: number | undefined; start: string; code: number | null }> = [];
function observeHeap(): void { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }
function track<T extends object>(value: T): T { refs.push(new WeakRef(value)); return value; }
function afterMatch(): void {
  if (faultQueued || (mode !== "abort" && mode !== "partial-error")) return;
  faultQueued = true; faultsAfterMatch++;
  queueMicrotask(() => {
    if (mode === "abort") controller!.abort();
    else children[children.length - 1]!.emit("error", new Error("fixture transport failure"));
  });
}
Object.assign(globalThis, { __grepCounts: counters, __grepTrack: track, __grepAfterMatch: afterMatch });
if (phase !== "profile" || baselinePath) registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context); if (url !== sourceUrl.href) return loaded;
  if (phase === "profile") return { ...loaded, source };
  let text = source;
  text = text.replace("const fileCache = new Map<string, string[]>();", "const fileCache = globalThis.__grepTrack(new Map<string, string[]>());");
  text = text.replace("fileCache.set(filePath, lines);", "globalThis.__grepTrack(lines); globalThis.__grepCounts.wholeFileSplits++; globalThis.__grepCounts.splitLines += lines.length; fileCache.set(filePath, lines);");
  text = text.replace("event = JSON.parse(line);", "globalThis.__grepCounts.jsonRecords++; globalThis.__grepCounts.jsonCharacters += line.length; event = JSON.parse(line);" + (phase === "lifecycle" ? "if (event.type === 'match') globalThis.__grepAfterMatch();" : ""));
  text = text.replace("new GrepContextBuffer()", "globalThis.__grepTrack(new GrepContextBuffer())");
  text = text.replace("this.bytes += bytes;", "this.bytes += bytes; globalThis.__grepCounts.retainedRows = Math.max(globalThis.__grepCounts.retainedRows, this.text.length); globalThis.__grepCounts.retainedBytes = Math.max(globalThis.__grepCounts.retainedBytes, this.bytes);");
  return { ...loaded, source: text };
} });
const originalSpawn = cp.spawn, originalSync = cp.spawnSync, originalRead = fs.readFile;
let controller: AbortController | undefined;
cp.spawnSync = ((command: string, args: string[], options: SpawnSyncOptions) => {
  const start = new Date().toISOString(), result = originalSync(command, args, options);
  processes.push({ pid: result.pid, start, code: result.status }); return result;
}) as typeof cp.spawnSync;
cp.spawn = ((command: string, args: string[], options: SpawnOptions) => {
  const start = new Date().toISOString(), child = originalSpawn(command, args, options);
  const record = { pid: child.pid, start, code: null as number | null }; processes.push(record);
  child.once("close", code => { record.code = code; });
  child.stdout?.on("data", observeHeap);
  if (phase === "lifecycle") children.push(child);
  return child;
}) as typeof cp.spawn;
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  const value = await originalRead(...args);
  if (String(args[0]) === file) {
    if (phase === "counts") { counters.reads++; counters.readBytes += Buffer.byteLength(value); }
    observeHeap();
  }
  return value;
}) as typeof fs.readFile;
syncBuiltinESMExports();
const { createGrepTool } = await import("../../packages/coding-agent/src/core/tools/grep.ts");
const tool = createGrepTool(owned.root);
async function run(): Promise<void> {
  faultQueued = false;
  controller = new AbortController(); if (phase === "lifecycle") signals.push(controller.signal);
  const operation = tool.execute("bench", { pattern: mode === "error" ? "[" : "HIT", path: data, context: contextLines }, controller.signal);
  if (mode === "success") {
    const result = await operation;
    assert.equal(result.content[0]?.type, "text");
    if (contextLines === 1) assert.ok(result.content[0]?.type === "text" && result.content[0].text.includes("HIT marker"));
  } else {
    await assert.rejects(operation, mode === "error" ? /regex parse error/ : mode === "partial-error" ? /fixture transport failure/ : /Operation aborted/);
    const lastChild = children[children.length - 1];
    if (lastChild && !lastChild.stdout?.destroyed) await new Promise<void>(resolve => lastChild.once("close", () => resolve()));
  }
  observeHeap(); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
}
try {
  console.log(JSON.stringify({ phase, node: process.version, rows, contextLines, fileBytes: rows * 128 + 24,
    sourceHash: createHash("sha256").update(source).digest("hex"), benchmarkHash: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex") }));
  if (phase === "counts") { await run(); console.log(JSON.stringify(counters)); }
  else if (phase === "profile") {
    assert.ok(global.gc); for (let index = 0; index < 2; index++) await run();
    global.gc(); const baselineHeap = process.memoryUsage().heapUsed; peakHeap = baselineHeap;
    const session = new Session(); session.connect();
    await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let index = 0; index < 6; index++) await run();
    const { profile } = await session.post("HeapProfiler.stopSampling"); session.disconnect();
    let bytes = 0; const top: Array<{ bytes: number; fn: string; url: string; line: number }> = [];
    function collect(node: typeof profile.head): void {
      bytes += node.selfSize; if (node.selfSize) top.push({ bytes: node.selfSize, fn: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber });
      for (const child of node.children) collect(child);
    }
    collect(profile.head); top.sort((a, b) => b.bytes - a.bytes);
    console.log(JSON.stringify({ iterations: 6, sampledBytesPerSearch: bytes / 6, observedPeakHeap: peakHeap, observedPeakIncrease: peakHeap - baselineHeap, top: top.slice(0, 7) }));
  } else {
    assert.ok(global.gc); for (const outcome of ["success", "error", "abort", "partial-error"]) { mode = outcome; await run(); }
    for (let index = 0; index < 8; index++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
    const retained = refs.filter(ref => ref.deref() !== undefined).length;
    assert.equal(faultsAfterMatch, 2);
    console.log(JSON.stringify({ weakRefs: refs.length, retained, faultsAfterMatch, childrenAlive: children.length, signalsAlive: signals.length,
      childPipesDestroyed: children.every(child => child.stdout?.destroyed && child.stderr?.destroyed), listeners: signals.map(signal => getEventListeners(signal, "abort").length) }));
    if (source.includes("GrepContextBuffer")) assert.equal(retained, 0);
  }
} finally {
  writeFileSync(manifest, JSON.stringify({ root: owned.root, resources: [data, file, manifest], processes }));
  owned.cleanup();
}
