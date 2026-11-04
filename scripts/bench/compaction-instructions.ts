import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@super-pi/agent-core";
import type { Context } from "../../packages/ai/src/types.ts";
import { schemaModel, schemaResponse } from "../../tests/helpers/anthropic-schema-fixture.ts";

const phase = process.argv[2] ?? "counts";
assert.ok(["counts", "profile", "lifecycle"].includes(phase));
const urls = ["compaction/compaction.ts", "compaction/utils.ts", "messages.ts"].map(path => new URL("../../packages/coding-agent/src/core/" + path, import.meta.url));
const counters = { conversions: 0, serializations: 0, convertVisits: 0, filterVisits: 0, serializedVisits: 0,
  objects: 0, arrays: 0, closures: 0, templates: 0, joins: 0 };
if (phase === "counts") {
  const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");
  Object.assign(globalThis, { __compactionCounters: counters });
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!urls.some(source => source.href === url)) return loaded;
    const source = String(loaded.source), file = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
    const selected = new Set(["compact", "generateSummaryWithUsage", "generateTurnPrefixSummary", "completeSummarization",
      "createSummarizationOptions", "combineUsage", "convertToLlm", "serializeConversation", "computeFileLists", "formatFileOperations"]);
    const edits: Array<{ at: number; text: string }> = [];
    function increment(name: keyof typeof counters) { return `globalThis.__compactionCounters.${name}++`; }
    function wrap(node: import("typescript").Node, name: keyof typeof counters) {
      edits.push({ at: node.getStart(file), text: `(${increment(name)},` }, { at: node.end, text: ")" });
    }
    function visit(node: import("typescript").Node, owner: string): void {
      if (ts.isFunctionDeclaration(node)) {
        owner = node.name?.text ?? "";
        const counter = owner === "convertToLlm" ? "conversions" : owner === "serializeConversation" ? "serializations" : undefined;
        if (counter && node.body) edits.push({ at: node.body.getStart(file) + 1, text: increment(counter) + ";" });
      }
      if (selected.has(owner)) {
        if (ts.isObjectLiteralExpression(node)) wrap(node, "objects");
        else if (ts.isArrayLiteralExpression(node)) wrap(node, "arrays");
        else if (ts.isTemplateExpression(node)) wrap(node, "templates");
        else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          wrap(node, "closures");
          if (owner === "convertToLlm") {
            if (ts.isBlock(node.body)) edits.push({ at: node.body.getStart(file) + 1, text: increment("convertVisits") + ";" });
            else wrap(node.body, "filterVisits");
          }
        } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === "join") wrap(node, "joins");
          else if (["map", "filter"].includes(node.expression.name.text)) wrap(node, "arrays");
        } else if (ts.isForOfStatement(node) && owner === "serializeConversation" && node.expression.getText(file) === "messages") {
          assert.ok(ts.isBlock(node.statement));
          edits.push({ at: node.statement.getStart(file) + 1, text: increment("serializedVisits") + ";" });
        }
      }
      ts.forEachChild(node, child => visit(child, owner));
    }
    visit(file, ""); edits.sort((a, b) => b.at - a.at);
    let instrumented = source;
    for (const edit of edits) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
    return { ...loaded, source: instrumented };
  } });
}
const { compact } = await import("../../packages/coding-agent/src/core/compaction/compaction.ts");
const { compactionPreparation, compactionFocus } = await import("../../tests/helpers/compaction-instructions-fixture.ts");
const { stream } = await import("../../packages/ai/src/api/anthropic-messages.ts");
const preparation = compactionPreparation("both", 512), model = schemaModel();
const streams: Array<ReturnType<typeof stream>> = [], signals: AbortSignal[] = [];
const refs: Array<WeakRef<object>> = [];
let requests = 0, wireCodeUnits = 0, focusedRequests = 0, mode = "success", lifecycle = false;
let controller: AbortController | undefined, notifyReady: (() => void) | undefined;
let rejectFetch: ((reason: unknown) => void) | undefined;
function cancelFetch(): void { const reject = rejectFetch; rejectFetch = undefined; reject?.(new Error("fixture cancelled")); }
async function fetchFixture(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  requests++;
  const body = init!.body as string;
  wireCodeUnits += body.length;
  if (body.includes(compactionFocus)) focusedRequests++;
  if (mode === "failure" && requests === 2) return new Response("fixture rejected", { status: 400 });
  if (mode === "abort" && requests === 2) {
    init!.signal!.addEventListener("abort", cancelFetch, { once: true });
    const pending = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
    const ready = notifyReady; notifyReady = undefined; ready?.();
    try { return await pending; } finally { init!.signal!.removeEventListener("abort", cancelFetch); }
  }
  return new Response(schemaResponse, { headers: { "content-type": "text/event-stream" } });
}
const streamFn: StreamFn = (_model, context: Context, options) => {
  if (lifecycle) refs.push(new WeakRef(context), new WeakRef(context.messages), new WeakRef(context.messages[0]!),
    new WeakRef(context.messages[0]!.content as object));
  const events = stream(model, context, { ...options, maxRetries: 0, fetch: fetchFixture });
  if (lifecycle) streams.push(events);
  return events;
};
async function run(): Promise<void> {
  requests = 0; wireCodeUnits = 0; focusedRequests = 0;
  const ready = mode === "abort" ? new Promise<void>(resolve => { notifyReady = resolve; }) : undefined;
  controller = lifecycle ? new AbortController() : undefined;
  if (controller) signals.push(controller.signal);
  const operation = compact(preparation, model, "offline-fixture", undefined, compactionFocus, controller?.signal,
    undefined, streamFn, undefined, { enabled: false, maxRetries: 0, baseDelayMs: 1 }, undefined, "fixture-session");
  const settled = mode === "failure" ? assert.rejects(operation, /Turn prefix summarization failed/) : operation;
  if (ready) { await ready; controller!.abort(); }
  await settled;
  // AgentSession rejects the canceled result before persistence; the benchmark
  // exercises the request chain and retains the documented input tail separately.
  assert.equal(requests, 2);
}
console.log(JSON.stringify({ phase, node: process.version, messages: 1024, charactersPerMessage: 2048,
  benchmarkHash: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
  hashes: urls.map(url => ({ path: fileURLToPath(url), sha256: createHash("sha256").update(readFileSync(url)).digest("hex") })) }));
if (phase === "counts") {
  await run(); console.log(JSON.stringify({ counters, requests, wireCodeUnits, focusedRequests }));
} else if (phase === "profile") {
  assert.ok(global.gc);
  for (let i = 0; i < 3; i++) await run();
  global.gc(); const session = new Session(); session.connect();
  await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < 16; i++) await run();
  const { profile } = await session.post("HeapProfiler.stopSampling"); session.disconnect();
  let bytes = 0;
  const top: Array<{ bytes: number; function: string; url: string; line: number }> = [];
  function collect(node: typeof profile.head): void {
    bytes += node.selfSize;
    if (node.selfSize) top.push({ bytes: node.selfSize, function: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber });
    for (const child of node.children) collect(child);
  }
  collect(profile.head); top.sort((a, b) => b.bytes - a.bytes);
  console.log(JSON.stringify({ iterations: 16, sampledBytesPerCompaction: bytes / 16, lastRequests: requests, lastWireCodeUnits: wireCodeUnits, focusedRequests, top: top.slice(0, 12) }));
} else {
  assert.ok(global.gc); lifecycle = true;
  for (const nextMode of ["success", "failure", "abort"]) { mode = nextMode; await run(); }
  for (let i = 0; i < 8; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
  const retained = refs.filter(ref => ref.deref()).length;
  const listeners = signals.reduce((sum, signal) => sum + getEventListeners(signal, "abort").length, 0);
  console.log(JSON.stringify({ weakReferences: refs.length, retained, abortListeners: listeners, retainedStreams: streams.length,
    retainedInputMessages: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length, retainedTail: preparation.retainedTail.length, heapAfterGc: process.memoryUsage().heapUsed }));
  assert.equal(retained, 0); assert.equal(listeners, 0); assert.equal(streams.length, 6);
  assert.equal(rejectFetch, undefined); assert.equal(notifyReady, undefined);
}
