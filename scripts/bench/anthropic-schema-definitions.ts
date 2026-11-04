import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import type { Tool } from "../../packages/ai/src/types.ts";
import { freezeSchemaInput, schemaContext, schemaModel, schemaResponse } from "../../tests/helpers/anthropic-schema-fixture.ts";

const phase = process.argv[2] ?? "counts";
assert.ok(["counts", "profile", "lifecycle"].includes(phase));
const urls = ["api/anthropic-messages.ts", "api/constrained-sampling.ts", "api/anthropic-inline-tools.ts", "utils/deferred-tools.ts", "utils/estimate.ts"]
  .map(path => new URL("../../packages/ai/src/" + path, import.meta.url));
const counters = { convertCalls: 0, toolVisits: 0, objects: 0, arrays: 0, closures: 0,
  clones: 0, serializations: 0, maps: 0, sets: 0 };
if (phase === "counts") {
  const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");
  Object.assign(globalThis, { __schemaCounters: counters });
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!urls.some(source => source.href === url)) return loaded;
    const source = String(loaded.source), file = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
    const selected = new Set(["buildParams", "convertTools", "makeStrictJsonSchema", "splitDeferredTools",
      "snapshotText", "changeBlocks", "prepareInlineToolHistory", "insertInlineToolUpdates", "inlineDeclarationSignature", "safeJsonStringify"]);
    const edits: Array<{ at: number; text: string }> = [];
    function increment(name: keyof typeof counters) { return `globalThis.__schemaCounters.${name}++`; }
    function wrap(node: import("typescript").Node, name: keyof typeof counters) {
      edits.push({ at: node.getStart(file), text: `(${increment(name)},` }, { at: node.end, text: ")" });
    }
    function visit(node: import("typescript").Node, owner: string): void {
      if (ts.isFunctionDeclaration(node)) {
        owner = node.name?.text ?? "";
        if (owner === "convertTools" && node.body) edits.push({ at: node.body.getStart(file) + 1, text: increment("convertCalls") + ";" });
      }
      if (selected.has(owner)) {
        if (ts.isObjectLiteralExpression(node)) wrap(node, "objects");
        else if (ts.isArrayLiteralExpression(node)) wrap(node, "arrays");
        else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          wrap(node, "closures");
          if (owner === "convertTools" && ts.isBlock(node.body)) edits.push({ at: node.body.getStart(file) + 1, text: increment("toolVisits") + ";" });
        } else if (ts.isNewExpression(node) && node.expression.getText(file) === "Map") wrap(node, "maps");
        else if (ts.isNewExpression(node) && node.expression.getText(file) === "Set") wrap(node, "sets");
        else if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(file);
          if (callee === "structuredClone") wrap(node, "clones");
          else if (callee === "JSON.stringify") wrap(node, "serializations");
          else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") wrap(node, "arrays");
        }
      }
      ts.forEachChild(node, child => visit(child, owner));
    }
    visit(file, "");
    edits.sort((a, b) => b.at - a.at);
    let instrumented = source;
    for (const edit of edits) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
    return { ...loaded, source: instrumented };
  } });
}

const { stream } = await import("../../packages/ai/src/api/anthropic-messages.ts");
const tools: Tool[] = [];
for (let tool = 0; tool < 16; tool++) {
  const definitions: Record<string, unknown> = {}, properties: Record<string, unknown> = {};
  for (let entry = 0; entry < 32; entry++) {
    definitions["Entry" + entry] = { type: "object", properties: { value: { type: "string",
      description: `${tool}:${entry}:` + Buffer.alloc(512, 65 + entry % 26).toString() } }, required: ["value"] };
    properties["entry" + entry] = { type: "array", items: { $ref: "#/$defs/Entry" + entry } };
  }
  tools.push({ name: "fixture" + tool, description: "Fixture schema", parameters: { type: "object", properties, $defs: definitions } });
}
const context = schemaContext(tools), models = [schemaModel(), schemaModel(true)];
freezeSchemaInput(context);
const retainedStreams: Array<ReturnType<typeof stream>> = [], signals: AbortSignal[] = [];
const refs: Array<{ name: string; ref: WeakRef<object> }> = [];
let requests = 0, wireCodeUnits = 0, definitionsRequests = 0, mode = "success";
let retainedCheckpoints = 0;
let releaseFetch: (() => void) | undefined;
let rejectFetch: ((reason: unknown) => void) | undefined;
function cancelFetch(): void {
  const reject = rejectFetch;
  rejectFetch = undefined;
  reject?.(new Error("fixture fetch cancelled"));
}
function pendingFetch(_resolve: (response: Response) => void, reject: (reason: unknown) => void): void {
  rejectFetch = reject;
}
function capturePayload(value: unknown): void {
  const payload = value as { tools: Array<{ input_schema: { $defs?: object } }> };
  refs.push({ name: mode + ":params", ref: new WeakRef(payload) }, { name: mode + ":tools", ref: new WeakRef(payload.tools) },
    { name: mode + ":schema", ref: new WeakRef(payload.tools[0]!.input_schema) });
}
async function fetchFixture(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  requests++;
  assert.equal(typeof init?.body, "string");
  const body = init!.body as string;
  wireCodeUnits += body.length;
  if (body.includes('"$defs":')) definitionsRequests++;
  if (mode === "failure") return new Response("fixture failure", { status: 400 });
  if (mode === "abort") {
    init!.signal!.addEventListener("abort", cancelFetch, { once: true });
    const pending = new Promise<Response>(pendingFetch);
    const ready = releaseFetch; releaseFetch = undefined; ready?.();
    try { return await pending; } finally { init!.signal!.removeEventListener("abort", cancelFetch); }
  }
  return new Response(schemaResponse, { headers: { "content-type": "text/event-stream" } });
}
async function request(inline: number, lifecycle = false): Promise<void> {
  const controller = lifecycle ? new AbortController() : undefined;
  const ready = mode === "abort" ? new Promise<void>(resolve => { releaseFetch = resolve; }) : undefined;
  const events = stream(models[inline]!, context, { apiKey: "offline-fixture", maxRetries: 0, cacheRetention: "none",
    fetch: fetchFixture, signal: controller?.signal, onPayload: lifecycle ? capturePayload : undefined });
  if (ready) { await ready; controller!.abort(); }
  for await (const _event of events) { /* Drain actual parser and event stream. */ }
  const result = await events.result();
  assert.equal(result.stopReason, mode === "success" ? "stop" : mode === "abort" ? "aborted" : "error");
  if (lifecycle) {
    retainedStreams.push(events); signals.push(controller!.signal);
    if (result.anthropicContext) retainedCheckpoints++;
  }
}
function reset(): void {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
  requests = 0; wireCodeUnits = 0; definitionsRequests = 0;
}
console.log(JSON.stringify({ phase, node: process.version, tools: tools.length, definitions: 512,
  schemaCodeUnits: JSON.stringify(tools).length,
  benchmarkHash: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
  hashes: urls.map(url => ({ path: fileURLToPath(url), sha256: createHash("sha256").update(readFileSync(url)).digest("hex") })) }));
for (let inline = 0; inline < 2 && phase !== "lifecycle"; inline++) {
  if (phase === "counts") {
    reset(); await request(inline);
    console.log(JSON.stringify({ scene: inline ? "inline" : "standard", counters, requests, wireCodeUnits, definitionsRequests }));
  } else {
    assert.ok(global.gc);
    for (let i = 0; i < 3; i++) await request(inline);
    reset(); global.gc();
    const session = new Session(); session.connect();
    await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < 16; i++) await request(inline);
    const { profile } = await session.post("HeapProfiler.stopSampling"); session.disconnect();
    const allocations: Array<{ bytes: number; function: string; url: string; line: number }> = [];
    let bytes = 0;
    function collect(node: typeof profile.head): void {
      bytes += node.selfSize;
      if (node.selfSize) allocations.push({ bytes: node.selfSize, function: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber });
      for (const child of node.children) collect(child);
    }
    collect(profile.head); allocations.sort((a, b) => b.bytes - a.bytes);
    console.log(JSON.stringify({ scene: inline ? "inline" : "standard", iterations: 16, sampledBytesPerRequest: bytes / 16,
      requests, wireCodeUnits, definitionsRequests, top: allocations.slice(0, 12) }));
  }
}
if (phase === "lifecycle") {
  assert.ok(global.gc);
  for (const nextMode of ["success", "failure", "abort"]) for (let inline = 0; inline < 2; inline++) {
    mode = nextMode; await request(inline, true);
  }
  for (let i = 0; i < 8; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
  const retained = refs.filter(entry => entry.ref.deref()).map(entry => entry.name);
  const listeners = signals.reduce((sum, signal) => sum + getEventListeners(signal, "abort").length, 0);
  console.log(JSON.stringify({ weakReferences: refs.length, retained, abortListeners: listeners,
    retainedStreams: retainedStreams.length, retainedInputTools: tools.length,
    retainedCheckpoints,
    heapAfterGc: process.memoryUsage().heapUsed }));
  assert.deepEqual(retained, []); assert.equal(listeners, 0);
  assert.equal(releaseFetch, undefined); assert.equal(rejectFetch, undefined);
  assert.equal(retainedStreams.length, 6); assert.equal(context.tools, tools);
  assert.equal(retainedCheckpoints, 1);
}
