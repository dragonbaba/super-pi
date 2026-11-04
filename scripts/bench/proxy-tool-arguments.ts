import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { IncrementalToolArguments } from "../../packages/ai/src/utils/incremental-tool-arguments.ts";
import type { ToolCall } from "../../packages/ai/src/types.ts";

const phase = process.argv[2] ?? "counts", size = Number(process.argv[3] ?? 16384);
assert.ok(["counts", "profile", "lifecycle", "wire"].includes(phase)); assert.ok(Number.isSafeInteger(size) && size > 0);
assert.equal(tmpdir(), process.env.TMP); assert.equal(process.env.TMP, process.env.TEMP); assert.equal(process.env.TMP, process.env.TMPDIR);
const proxyUrl = new URL("../../packages/agent/src/proxy.ts", import.meta.url);
const source = readFileSync(process.env.PROXY_BASELINE_PATH ?? proxyUrl, "utf8");
const structural = { deltaObjects: 0, deltaSpreads: 0 };
Object.assign(globalThis, { __proxyCounters: structural });
if (phase === "counts" || process.env.PROXY_BASELINE_PATH) registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context); if (url !== proxyUrl.href) return loaded;
  if (phase !== "counts") return { ...loaded, source };
  const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");
  const file = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true), edits: Array<{ at: number; text: string }> = [];
  function visit(node: import("typescript").Node, delta: boolean): void {
    if (ts.isCaseClause(node)) delta = node.expression.getText(file) === '"toolcall_delta"';
    if (delta && (ts.isObjectLiteralExpression(node) || ts.isSpreadAssignment(node))) {
      const target = ts.isSpreadAssignment(node) ? node.expression : node;
      edits.push({ at: target.getStart(file), text: `(globalThis.__proxyCounters.${ts.isSpreadAssignment(node) ? "deltaSpreads" : "deltaObjects"}++,` }, { at: target.end, text: ")" });
    }
    ts.forEachChild(node, child => visit(child, delta));
  }
  visit(file, false); edits.sort((a, b) => b.at - a.at); let text = source;
  for (const edit of edits) text = text.slice(0, edit.at) + edit.text + text.slice(edit.at);
  return { ...loaded, source: text };
} });
const { proxyArgumentsFixture, proxyEventsFixture, proxyDone } = await import("../../tests/helpers/proxy-arguments-fixture.ts");
const input = JSON.stringify({ payload: "x".repeat(size) });
const candidate = source.includes("IncrementalToolArguments");
async function nextTurn(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
async function run(fixture: ReturnType<typeof proxyArgumentsFixture>, controller?: AbortController, abort = false) {
  const stream = fixture.start(controller?.signal); let deltas = 0;
  for await (const event of stream) if (event.type === "toolcall_delta") { deltas++; if (abort) controller!.abort(); }
  const result = await stream.result(); await nextTurn();
  return { stream, result, deltas, transport: fixture.stats() };
}
console.log(JSON.stringify({ phase, node: process.version, inputCodeUnits: input.length, chunkCodeUnits: 64,
  sourceHash: createHash("sha256").update(source).digest("hex"), benchmarkHash: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex") }));
if (phase === "counts" || phase === "wire") {
  const fixture = phase === "wire" ? proxyEventsFixture([{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "x".repeat(size) }, proxyDone("stop")], { chunkBytes: 32 }) : proxyArgumentsFixture([input]);
  const parse = JSON.parse, append = IncrementalToolArguments.prototype.append, dispose = IncrementalToolArguments.prototype.dispose;
  const split = String.prototype.split, indexOf = String.prototype.indexOf, decode = TextDecoder.prototype.decode;
  let argumentParses = 0, parsedArgumentCodeUnits = 0, parserPromises = 0, streamPromises = 0, inParser = false, wireSplits = 0, wireSplitCodeUnits = 0, wireScanCodeUnits = 0;
  const parsers: ReturnType<IncrementalToolArguments["diagnostics"]>[] = [], decodeOptions = new Set<object>();
  JSON.parse = function(text, reviver) { if (typeof text === "string" && text.startsWith('{"payload"')) { argumentParses++; parsedArgumentCodeUnits += text.length; } return parse(text, reviver); };
  IncrementalToolArguments.prototype.append = function(fragment) { inParser = true; try { return append.call(this, fragment); } finally { inParser = false; } };
  IncrementalToolArguments.prototype.dispose = function() { dispose.call(this); parsers.push(this.diagnostics()); };
  String.prototype.split = function(separator: string | RegExp, limit?: number) { if (separator === "\n") { wireSplits++; wireSplitCodeUnits += this.length; } return split.call(this, separator, limit); } as typeof split;
  String.prototype.indexOf = function(search, from = 0) { const found = indexOf.call(this, search, from); if (search === "\n") wireScanCodeUnits += (found < 0 ? this.length : found + 1) - from; return found; };
  TextDecoder.prototype.decode = function(bytes, options) { if (options) decodeOptions.add(options); return decode.call(this, bytes, options); };
  const hook = createHook({ init(_id, type) { if (type === "PROMISE") { streamPromises++; if (inParser) parserPromises++; } } }); hook.enable();
  try {
    const result = await run(fixture); assert.equal(result.result.stopReason, phase === "wire" ? "stop" : "toolUse");
    console.log(JSON.stringify({ argumentParses, parsedArgumentCodeUnits, parserPromises, streamPromises, deltas: result.deltas, structural, parsers,
      wireSplits, wireSplitCodeUnits, wireScanCodeUnits, decodeOptionIdentities: decodeOptions.size, transport: result.transport }));
  } finally { hook.disable(); JSON.parse = parse; IncrementalToolArguments.prototype.append = append; IncrementalToolArguments.prototype.dispose = dispose;
    String.prototype.split = split; String.prototype.indexOf = indexOf; TextDecoder.prototype.decode = decode; fixture.release(); }
} else if (phase === "profile") {
  assert.ok(global.gc);
  for (let index = 0; index < 2; index++) { const fixture = proxyArgumentsFixture([input]); try { await run(fixture); } finally { fixture.release(); } }
  const fixtures = Array.from({ length: 6 }, () => proxyArgumentsFixture([input]));
  global.gc(); const initialHeap = process.memoryUsage().heapUsed; let peakHeap = initialHeap;
  const session = new Session(); session.connect();
  await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (const fixture of fixtures) { try { await run(fixture); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); } finally { fixture.release(); } }
  const { profile } = await session.post("HeapProfiler.stopSampling"); session.disconnect();
  let bytes = 0; const top: Array<{ bytes: number; fn: string; url: string; line: number }> = [];
  function collect(node: typeof profile.head): void { bytes += node.selfSize; if (node.selfSize) top.push({ bytes: node.selfSize, fn: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber }); for (const child of node.children) collect(child); }
  collect(profile.head); top.sort((a, b) => b.bytes - a.bytes);
  console.log(JSON.stringify({ iterations: 6, sampledBytesPerStream: bytes / 6, settlementPeakHeapIncrease: peakHeap - initialHeap, top: top.slice(0, 8) }));
} else {
  assert.ok(global.gc);
  const retained: Awaited<ReturnType<typeof run>>[] = [], signals: AbortSignal[] = [], refs: WeakRef<IncrementalToolArguments>[] = [], seen = new WeakSet<IncrementalToolArguments>();
  const released: ReturnType<IncrementalToolArguments["diagnostics"]>[] = [];
  const append = IncrementalToolArguments.prototype.append, dispose = IncrementalToolArguments.prototype.dispose;
  IncrementalToolArguments.prototype.append = function(fragment) { if (!seen.has(this)) { seen.add(this); refs.push(new WeakRef(this)); } return append.call(this, fragment); };
  IncrementalToolArguments.prototype.dispose = function() { dispose.call(this); released.push(this.diagnostics()); };
  try {
    for (const reason of ["normal", "error", "abort"]) {
      const fixture = proxyArgumentsFixture([input], 64, reason === "error" ? 4 : undefined), controller = new AbortController(); signals.push(controller.signal);
      try { const result = await run(fixture, controller, reason === "abort"); assert.equal(result.result.stopReason, reason === "normal" ? "toolUse" : reason === "abort" ? "aborted" : "error"); retained.push(result); }
      finally { fixture.release(); }
    }
  } finally { IncrementalToolArguments.prototype.append = append; IncrementalToolArguments.prototype.dispose = dispose; }
  for (let index = 0; index < 8; index++) { await nextTurn(); global.gc(); }
  const retainedParsers = refs.filter(ref => ref.deref() !== undefined).length;
  const rawInResults = retained.map(row => ((row.result.content[0] as ToolCall & { partialJson?: string }).partialJson ?? "").length);
  console.log(JSON.stringify({ parserRefs: refs.length, retainedParsers, released, rawInResults, streamsAlive: retained.length,
    listeners: signals.map(signal => getEventListeners(signal, "abort").length), transport: retained.map(row => row.transport) }));
  if (candidate) { assert.equal(refs.length, 3); assert.equal(retainedParsers, 0); assert.deepEqual(rawInResults, [0, 0, 0]); }
}
