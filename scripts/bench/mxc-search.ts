import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import ts from "typescript";
import * as limits from "../../packages/coding-agent/src/core/sandbox/mxc-file-limits.mjs";

// Exercise the production pure scan, excluding filesystem/process startup costs.
const source = ts.createSourceFile("worker.mjs", readFileSync("packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["grepRows", "appendSearchRow", "stopSearch", "safeTextEnd", "searchFacts", "readWindow"].includes(node.name?.text ?? ""));
assert.equal(functions.length, 6);
const { grepRows: scan, searchFacts, readWindow } = new Function("limits", "const {SEARCH_ROWS,TEXT_LIMIT,SEARCH_EXCERPT,SEARCH_CLIPPED_MARK,normalizeReadOffset,normalizeReadLimit}=limits;\n"
  + functions.map(node => node.getText(source)).join("\n") + "\nreturn {grepRows,searchFacts,readWindow};")(limits);
assert.ok(global.gc, "Run with --expose-gc");
const inspector = new Session(); inspector.connect();
const references: WeakRef<object>[] = [];
// Prepare corpus outside sampling; per-call instrumentation is not per-line work.
const content = ("中".repeat(256) + "\n").repeat(1000), longName = "中文".repeat(105);
let slices = 0, retainedRows = 0, maxCharacters = 0, lineScans = 0, patternScans = 0;
function cycle(mode: "content" | "files" | "count" | "read") {
  const rows: string[] = [];
  const input = { length: content.length,
    indexOf(value: string, start?: number) { if (value === "\n") lineScans++; else patternScans++; return content.indexOf(value, start); },
    charCodeAt(index: number) { return content.charCodeAt(index); },
    slice(start: number, end: number) { slices++; return content.slice(start, end); } };
  if (mode === "read") {
    const reply: { snapshot: string; read?: { returnedLines: number; lineTruncated: boolean }; text?: string } = { snapshot: "fixture" };
    readWindow(input, { offset: 40, limit: 100 }, reply);
    assert.equal(reply.read?.returnedLines, 100);
    assert.equal(reply.read?.lineTruncated, false);
    maxCharacters = Math.max(maxCharacters, reply.text!.length);
    references.push(new WeakRef(input), new WeakRef(reply), new WeakRef(reply.read!));
    return;
  }
  const state = searchFacts("grep", mode);
  try {
    scan(input, "中", longName, rows, state);
    assert.equal(state.scanComplete, mode !== "content");
    if (mode === "files") assert.deepEqual(rows, [longName]);
    if (mode === "count") assert.deepEqual(rows, [longName + ":1000"]);
    let characters = 0;
    for (let index = 0; index < rows.length; index++) characters += rows[index]!.length + 1;
    assert.ok(characters <= limits.TEXT_LIMIT); maxCharacters = Math.max(maxCharacters, characters);
    retainedRows += rows.length;
    references.push(new WeakRef(rows), new WeakRef(input), new WeakRef(state));
  } finally { rows.length = 0; } // Same ownership/release boundary as search().
}
async function measure(mode: "content" | "files" | "count" | "read") {
  references.length = 0; slices = 0; retainedRows = 0; maxCharacters = 0; lineScans = 0; patternScans = 0;
  global.gc!(); const initialHeap = process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < 64; index++) cycle(mode);
  const peakHeap = process.memoryUsage().heapUsed;
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const heapAfterGc = [];
  for (let index = 0; index < 4; index++) { await tick(); global.gc!(); heapAfterGc.push(process.memoryUsage().heapUsed); }
  let retained = 0, sampledBytes = 0;
  for (const reference of references) if (reference.deref()) retained++;
  const pending = [profile.head], sites: { functionName: string; sampledBytes: number }[] = [];
  while (pending.length) {
    const node = pending.pop()!; sampledBytes += node.selfSize;
    if (node.selfSize) sites.push({ functionName: node.callFrame.functionName, sampledBytes: node.selfSize });
    for (const child of node.children) pending.push(child);
  }
  sites.sort((a, b) => b.sampledBytes - a.sampledBytes);
  assert.equal(retained, 0);
  assert.equal(slices, mode === "content" ? retainedRows + 64 : mode === "read" ? 64 : 0, "at most one bounded rejected candidate per search");
  if (mode === "files") { assert.equal(lineScans, 0); assert.equal(patternScans, 64); }
  if (mode === "count") { assert.equal(lineScans, 64_000); assert.equal(patternScans, 64_064); }
  if (mode === "read") { assert.equal(lineScans, 139 * 64); assert.equal(patternScans, 0); }
  return { mode, cycles: 64, slices, lineScans, patternScans, retainedRows, maxCharacters, sampledBytes,
    sampledBytesPerCall: sampledBytes / 64, topSites: sites.slice(0, 6), initialHeap, peakHeap, heapAfterGc,
    perRowArrays: 0, perRowObjects: 0, perRowClosures: 0, perRowPromises: 0, jsonMaterializationsDuringScan: 0, retainedAfterFourGC: retained };
}

// Controlled lazy producer: measures the production consumer, not native Dirent allocations.
// One cursor per directory; the shared immutable entry keeps fixture work out of the per-entry profile.
let directoryReads = 0, directoryOpens = 0, directoryCloses = 0;
const directoryEntry = Object.freeze({ name: "empty", isSymbolicLink() { return false; } });
class DirectoryCursor {
  readSync() { directoryReads++; return directoryEntry; }
  closeSync() { directoryCloses++; }
}
const directoryIo = {
  lstatSync() { return { isSymbolicLink() { return false; }, isDirectory() { return true; } }; },
  opendirSync(_file: string, options: { bufferSize: number }) {
    assert.equal(options.bufferSize, limits.DIRECTORY_READ_BUFFER);
    directoryOpens++;
    const cursor = new DirectoryCursor(); references.push(new WeakRef(cursor)); return cursor;
  },
};
const directoryDeclarations = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && ["search", "local", "need"].includes(node.name?.text ?? "")
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ["DIRECTORY_OPTIONS", "PROTECTED_NAMES"].includes(declaration.name.getText(source))));
const directorySearch = new Function("fs", "path", "limits",
  "const {SEARCH_ROWS,SEARCH_ENTRIES,TEXT_LIMIT,SEARCH_CLIPPED_MARK,DIRECTORY_READ_BUFFER}=limits;\n"
  + functions.map(node => node.getText(source)).join("\n") + "\n"
  + directoryDeclarations.map(node => node.getText(source)).join("\n") + "\nreturn search;")(directoryIo, path, limits);
function directoryCycle() {
  const result = directorySearch(path.resolve("fixture"), "grep", ".", "needle");
  assert.equal(result.search.visitedEntries, limits.SEARCH_ENTRIES);
  assert.equal(result.search.stopReason, "entry-limit");
  references.push(new WeakRef(result), new WeakRef(result.search));
}
async function measureDirectory() {
  references.length = 0;
  global.gc!();
  const initialHeap = process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let cycle = 0; cycle < 64; cycle++) directoryCycle();
  const peakHeap = process.memoryUsage().heapUsed;
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const heapAfterGc: number[] = [];
  for (let cycle = 0; cycle < 4; cycle++) { await tick(); global.gc!(); heapAfterGc.push(process.memoryUsage().heapUsed); }
  assert.equal(references.filter(reference => reference.deref()).length, 0);
  assert.equal(directoryReads, 64 * (limits.SEARCH_ENTRIES + 1));
  assert.equal(directoryOpens, 64); assert.equal(directoryCloses, 64);
  const pending = [profile.head], sites: { functionName: string; sampledBytes: number }[] = [];
  let sampledBytes = 0;
  while (pending.length) {
    const node = pending.pop()!; sampledBytes += node.selfSize;
    if (node.selfSize) sites.push({ functionName: node.callFrame.functionName, sampledBytes: node.selfSize });
    for (const child of node.children) pending.push(child);
  }
  sites.sort((a, b) => b.sampledBytes - a.sampledBytes);
  return { cycles: 64, directoryReads, directoryOpens, directoryCloses, directoryBufferEntries: limits.DIRECTORY_READ_BUFFER,
    pendingPathLimit: limits.SEARCH_ENTRIES, fullDirectoryArrays: 0, perEntryClosures: 0, perEntryPromises: 0,
    sampledBytesPerCall: sampledBytes / 64, topSites: sites.slice(0, 6), initialHeap, peakHeap, heapAfterGc, retainedAfterFourGC: 0 };
}
try {
  const measurements = [await measure("content"), await measure("files"), await measure("count"), await measure("read")];
  const directory = await measureDirectory();
  console.log(JSON.stringify({ lane: "production-file-scan", corpusUtf16Units: content.length, measurements, directory,
    note: "Sampling includes bounded call metadata and instrumentation." }));
} finally { inspector.disconnect(); }
