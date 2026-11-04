import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, Model } from "../../packages/ai/src/types.ts";

const phase = process.argv[2] ?? "counts";
assert.ok(["counts", "profile", "lifecycle"].includes(phase));
const turns = 1024, width = 8192;
const transformUrl = new URL("../../packages/ai/src/api/transform-messages.ts", import.meta.url);
const capabilityUrl = new URL("../../packages/ai/src/model-capabilities.ts", import.meta.url);
const hashes = [transformUrl, capabilityUrl].map(url => ({ path: fileURLToPath(url),
  sha256: createHash("sha256").update(readFileSync(url)).digest("hex") }));
const counters = { transformCalls: 0, capabilityCalls: 0, messageVisits: 0, blockVisits: 0,
  secondMessageVisits: 0, secondBlockVisits: 0, projectedMessageVisits: 0, projectedBlockVisits: 0,
  objects: 0, arrays: 0, maps: 0, sets: 0, closures: 0, thinkingTrimCalls: 0 };

// Instrument only the selected source functions, only in the count run. The
// profile/lifecycle runs import the untouched production modules normally.
if (phase === "counts") {
  const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");
  Object.assign(globalThis, { __thinkingHistoryCounters: counters });
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== transformUrl.href && url !== capabilityUrl.href) return loaded;
    const source = String(loaded.source);
    const file = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
    const edits: Array<{ at: number; text: string }> = [];
    const selected = new Set(url === transformUrl.href
      ? ["transformMessages", "transformMessage", "transformContentBlock", "insertSyntheticToolResults", "replaceImagesWithPlaceholder"]
      : ["contextForModelCapabilities", "plainToolHistoryText"]);
    function increment(name: keyof typeof counters): string { return `globalThis.__thinkingHistoryCounters.${name}++;`; }
    function wrap(node: import("typescript").Node, name: keyof typeof counters): void {
      edits.push({ at: node.getStart(file), text: `(${increment(name).slice(0, -1)},` }, { at: node.end, text: ")" });
    }
    function loop(body: import("typescript").Statement, name: keyof typeof counters): void {
      if (ts.isBlock(body)) edits.push({ at: body.getStart(file) + 1, text: increment(name) });
      else edits.push({ at: body.getStart(file), text: "{" + increment(name) }, { at: body.end, text: "}" });
    }
    function visit(node: import("typescript").Node, owner: string): void {
      if (ts.isFunctionDeclaration(node)) {
        owner = node.name?.text ?? "";
        const name = owner === "transformMessages" ? "transformCalls" : owner === "transformContentBlock" ? "blockVisits"
          : owner === "contextForModelCapabilities" ? "capabilityCalls" : undefined;
        if (name && node.body) edits.push({ at: node.body.getStart(file) + 1, text: increment(name) });
      }
      if (selected.has(owner)) {
        if (ts.isObjectLiteralExpression(node)) wrap(node, "objects");
        else if (ts.isArrayLiteralExpression(node)) wrap(node, "arrays");
        else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) wrap(node, "closures");
        else if (ts.isNewExpression(node) && node.expression.getText(file) === "Map") wrap(node, "maps");
        else if (ts.isNewExpression(node) && node.expression.getText(file) === "Set") wrap(node, "sets");
        else if (ts.isCallExpression(node) && node.getText(file) === "block.thinking.trim()") wrap(node, "thinkingTrimCalls");
        if (ts.isForOfStatement(node)) {
          if (owner === "transformMessages" && node.expression.getText(file) === "messages") loop(node.statement, "messageVisits");
          else if (owner === "transformMessages" && node.expression.getText(file) === "assistantMsg.content") loop(node.statement, "secondBlockVisits");
          else if (owner === "contextForModelCapabilities") loop(node.statement,
            node.expression.getText(file) === "context.messages" ? "projectedMessageVisits" : "projectedBlockVisits");
        } else if (ts.isForStatement(node) && owner === "transformMessages") loop(node.statement, "secondMessageVisits");
      }
      ts.forEachChild(node, child => visit(child, owner));
    }
    visit(file, "");
    let instrumented = source;
    edits.sort((a, b) => b.at - a.at);
    for (const edit of edits) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
    return { ...loaded, source: instrumented };
  } });
}

const { transformMessages } = await import(transformUrl.href) as typeof import("../../packages/ai/src/api/transform-messages.ts");
const { conservativeModelCapabilities } = await import(capabilityUrl.href) as typeof import("../../packages/ai/src/model-capabilities.ts");
const { stream: streamAnthropic } = await import("../../packages/ai/src/api/anthropic-messages.ts");
const target: Model<"anthropic-messages"> = { id: "target", name: "Target", provider: "fixture", api: "anthropic-messages",
  baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 8_000_000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  capabilities: { ...conservativeModelCapabilities(8_000_000, 1024), toolCalling: true, thoughtSignatureRoundTrip: true } };
const noTools: Model<"anthropic-messages"> = { ...target, capabilities: { ...target.capabilities!, toolCalling: false } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const input: Message[] = [];
let thinkingCodeUnits = 0;
for (let i = 0; i < turns; i++) {
  const thinking = `PRIVATE_REASONING_${i}:` + Buffer.alloc(width, 65 + i % 26).toString();
  thinkingCodeUnits += thinking.length;
  input.push({ role: "user", content: "request " + i, timestamp: i * 2 },
    { role: "assistant", api: target.api, provider: target.provider, model: "source",
      content: [{ type: "thinking", thinking }, { type: "text", text: "visible answer " + i }], usage, stopReason: "stop", timestamp: i * 2 + 1 });
}
const context = { messages: input };
const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
let requests = 0, wireCodeUnits = 0, leakedRequests = 0;
let outcome: "success" | "failure" | "cancel" = "success";
let activeAbort: AbortController | undefined;
let currentScene = "transform";
const references: Array<{ kind: string; ref: WeakRef<object> }> = [];
const retainedStreams: object[] = [], retainedSignals: AbortSignal[] = [];
let rejectCancelledFetch: ((error: Error) => void) | undefined;
function cancelFetch(): void {
  activeAbort!.abort();
  const reject = rejectCancelledFetch;
  rejectCancelledFetch = undefined;
  reject?.(new Error("fixture cancellation"));
}
function waitForCancellation(_resolve: (response: Response | PromiseLike<Response>) => void, reject: (error: Error) => void): void {
  rejectCancelledFetch = reject;
  // Model an external cancellation after the SDK has yielded. A default abort
  // reason created inside fetch's SDK stack can itself retain those call frames.
  queueMicrotask(cancelFetch);
}
function capturePayload(payload: unknown): void {
  if (phase !== "lifecycle" || !payload || typeof payload !== "object") return;
  references.push({ kind: currentScene + ":payload", ref: new WeakRef(payload) });
  const messages = (payload as { messages: object }).messages;
  references.push({ kind: currentScene + ":payload messages", ref: new WeakRef(messages) });
}
const fetchFixture: typeof fetch = async (_url, init) => {
  assert.equal(typeof init?.body, "string");
  requests++; wireCodeUnits += (init!.body as string).length;
  if (phase === "counts" && (init!.body as string).includes("PRIVATE_REASONING_")) leakedRequests++;
  if (phase === "lifecycle") references.push({ kind: currentScene + ":fetch init/body", ref: new WeakRef(init!) });
  if (outcome === "cancel") return new Promise<Response>(waitForCancellation);
  if (outcome !== "success") throw new Error("fixture " + outcome);
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
};

async function request(model: Model<"anthropic-messages">): Promise<void> {
  const stream = streamAnthropic(model, context, { apiKey: "offline-fixture", fetch: fetchFixture,
    maxRetries: 0, cacheRetention: "none", signal: activeAbort?.signal, onPayload: capturePayload });
  for await (const _event of stream) { /* Keep the returned owner drained. */ }
  const result = await stream.result();
  assert.equal(result.stopReason, outcome === "success" ? "stop" : outcome === "cancel" ? "aborted" : "error");
  if (phase === "lifecycle") retainedStreams.push(stream);
}
function reset(): void {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
  requests = 0; wireCodeUnits = 0; leakedRequests = 0;
}
function pure(): void {
  const result = transformMessages(input, target);
  assert.equal(result.length, input.length);
  if (phase === "lifecycle") {
    references.push({ kind: "transform result", ref: new WeakRef(result) },
      { kind: "transformed assistant", ref: new WeakRef(result[1]!) },
      { kind: "transformed content", ref: new WeakRef((result[1] as AssistantMessage).content) });
  }
}
interface SamplingNode { selfSize: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: SamplingNode[] }
function samples(root: SamplingNode) {
  const sites: Array<{ bytes: number; function: string; url: string; line: number }> = [];
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    bytes += node.selfSize;
    if (node.selfSize) sites.push({ bytes: node.selfSize, function: node.callFrame.functionName,
      url: node.callFrame.url, line: node.callFrame.lineNumber + 1 });
    if (node.children) pending.push(...node.children);
  }
  return { bytes, top: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 12) };
}
function tick(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

console.log(JSON.stringify({ phase, node: process.version, hashes, benchmarkHash: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  turns, messages: input.length, thinkingCodeUnits,
  coverage: "Production transform and Anthropic SDK/fetch; counts instrument transform/capability projection only. Other provider configurations are source-audited and tested separately." }));
if (phase === "counts") {
  reset(); pure(); console.log(JSON.stringify({ scene: "transform", counters: { ...counters } }));
  for (const model of [target, noTools]) {
    reset(); await request(model);
    console.log(JSON.stringify({ scene: model === target ? "anthropic-tools" : "anthropic-no-tools", counters: { ...counters }, requests, wireCodeUnits, leakedRequests }));
  }
} else if (phase === "profile") {
  assert.ok(globalThis.gc, "run with --expose-gc");
  const inspector = new Session(); inspector.connect();
  try {
    for (const scene of ["transform", "anthropic-tools", "anthropic-no-tools"]) {
      const iterations = scene === "transform" ? 64 : 8;
      for (let i = 0; i < 3; i++) { if (scene === "transform") pure(); else await request(scene === "anthropic-tools" ? target : noTools); }
      await tick(); globalThis.gc(); reset();
      await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (let i = 0; i < iterations; i++) { if (scene === "transform") pure(); else await request(scene === "anthropic-tools" ? target : noTools); }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const allocation = samples(profile.head);
      console.log(JSON.stringify({ scene, iterations, sampledBytesPerRequest: allocation.bytes / iterations, requests, wireCodeUnits, allocation }));
    }
  } finally { inspector.disconnect(); }
} else {
  assert.ok(globalThis.gc, "run with --expose-gc");
  pure();
  for (const mode of ["success", "failure", "cancel"] as const) for (const model of [target, noTools]) {
    outcome = mode; currentScene = mode + (model === target ? ":tools" : ":no-tools");
    activeAbort = new AbortController(); retainedSignals.push(activeAbort.signal);
    await request(model); activeAbort = undefined;
  }
  for (let i = 0; i < 8; i++) { await tick(); globalThis.gc(); }
  const retained = references.filter(entry => entry.ref.deref() !== undefined).map(entry => entry.kind);
  const listeners = retainedSignals.reduce((sum, signal) => sum + getEventListeners(signal, "abort").length, 0);
  console.log(JSON.stringify({ weakReferences: references.length, retained, abortListeners: listeners,
    retainedStreams: retainedStreams.length, retainedInputMessages: input.length, heapAfterGc: process.memoryUsage().heapUsed }));
  assert.deepEqual(retained, []);
  assert.equal(listeners, 0);
  assert.equal(rejectCancelledFetch, undefined);
  assert.equal(retainedStreams.length, 6);
}
