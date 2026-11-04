import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Type } from "typebox";
import { AssistantMessageEventStream, EventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { IncrementalToolArguments } from "../../packages/ai/src/utils/incremental-tool-arguments.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../../packages/ai/src/types.ts";
import { proxyArgumentsFixture, proxyEventsFixture, proxyStart, proxyDelta, proxyEnd, proxyDone, proxyModel, proxyUsage } from "../helpers/proxy-arguments-fixture.ts";
import type { ProxyAssistantMessageEvent } from "../../packages/agent/src/proxy.ts";
const { Agent } = await import("../../packages/agent/src/agent.ts");

async function finish(fixture: ReturnType<typeof proxyEventsFixture>, signal?: AbortSignal) {
  const stream = fixture.start(signal);
  for await (const _event of stream) { /* actual SDK delivery */ }
  let result: AssistantMessage | undefined;
  void stream.result().then(value => { result = value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(result, "proxy terminal/EOF must settle result()");
  return result;
}

test("proxy interleaved Unicode/escape deltas use private parsers and numeric generations", async () => {
  const inputs = ['{"path":"中😀\\n\\u0041","nested":[1,{"x":true}]}', '{"path":"beta","nested":{"value":null}}'];
  const fixture = proxyArgumentsFixture(inputs, 1), generations = [0, 0], roots: object[] = [];
  const push = EventStream.prototype.push;
  EventStream.prototype.push = function(event: AssistantMessageEvent) {
    if (event.type === "toolcall_delta") {
      const block = event.partial.content[event.contentIndex] as ToolCall & { partialJson?: string; parser?: unknown; toolArgsGeneration?: number };
      assert.equal(block.partialJson, undefined); assert.equal(block.parser, undefined);
      assert.equal(event.toolArgsGeneration, ++generations[event.contentIndex]!); assert.equal(block.toolArgsGeneration, event.toolArgsGeneration);
      if (!roots[event.contentIndex]) roots[event.contentIndex] = block.arguments;
      else assert.equal(block.arguments, roots[event.contentIndex]);
    }
    push.call(this, event);
  };
  try {
    const result = await finish(fixture); assert.equal(result.stopReason, "toolUse", result.errorMessage);
    for (let index = 0; index < inputs.length; index++) {
      const block = result.content[index] as ToolCall & { toolArgsGeneration?: number };
      assert.deepEqual(block.arguments, JSON.parse(inputs[index]!)); assert.equal(block.toolArgsGeneration, undefined);
      assert.equal(block.id, "final-" + index); assert.equal(block.namespace, "fixture-ns"); assert.equal(block.thoughtSignature, "fixture-signature");
    }
  } finally { EventStream.prototype.push = push; fixture.release(); }
});

test("proxy authoritative end replaces malformed preview and preserves empty delta delivery", async () => {
  const fixture = proxyEventsFixture([proxyStart(), proxyDelta(""), proxyDelta('{"path":"unfinished'), proxyEnd({ corrected: true }), proxyDone()]);
  let deltas = 0;
  try {
    const stream = fixture.start(); for await (const event of stream) if (event.type === "toolcall_delta") deltas++;
    const result = await stream.result(); assert.equal(deltas, 2); assert.deepEqual((result.content[0] as ToolCall).arguments, { corrected: true });
    assert.equal(hasIncompleteToolArguments((result.content[0] as ToolCall).arguments), false);
  } finally { fixture.release(); }
});

for (const raw of ["", '{"path":"open', '{"nested":[1,2]}', '{"bad":???']) test(`proxy missing tool end finalizes at done: ${raw}`, async () => {
  const fixture = proxyEventsFixture([proxyStart(), proxyDelta(raw), proxyDone("length")]);
  const finalize = IncrementalToolArguments.prototype.finalize; let calls = 0;
  IncrementalToolArguments.prototype.finalize = function(text) { calls++; return finalize.call(this, text); };
  try {
    const result = await finish(fixture); assert.equal(result.stopReason, "length"); assert.equal(calls, 1);
    assert.equal(hasIncompleteToolArguments((result.content[0] as ToolCall).arguments), raw !== '{"nested":[1,2]}');
  } finally { IncrementalToolArguments.prototype.finalize = finalize; fixture.release(); }
});

test("proxy repeated starts release old owners and terminal frames stop further mutation", async () => {
  const fixture = proxyEventsFixture([proxyStart(), proxyDelta('{"discard":'), proxyStart(), proxyDelta('{"also":'),
    { type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "ok" },
    proxyDone("stop"), { type: "text_delta", contentIndex: 0, delta: "wrong" }], { keepOpen: true });
  const dispose = IncrementalToolArguments.prototype.dispose; let calls = 0;
  IncrementalToolArguments.prototype.dispose = function() { calls++; return dispose.call(this); };
  try {
    const result = await finish(fixture); assert.equal(calls, 2); assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
    assert.equal(fixture.stats().locked, false); assert.equal(fixture.stats().cancellations, 1);
  } finally { IncrementalToolArguments.prototype.dispose = dispose; fixture.release(); }
});

for (const outcome of ["server-error", "transport-error", "abort", "eof"] as const) test(`proxy ${outcome} releases raw state and settles`, async () => {
  const events = [proxyStart(), proxyDelta('{"path":"partial')];
  if (outcome === "server-error") events.push({ type: "error", reason: "error", errorMessage: "server failed", usage: proxyUsage });
  const fixture = proxyEventsFixture(events, { failAfter: outcome === "transport-error" ? 2 : undefined, keepOpen: outcome === "abort" });
  const controller = new AbortController();
  const stream = fixture.start(controller.signal);
  try {
    for await (const event of stream) if (event.type === "toolcall_delta" && outcome === "abort") controller.abort();
    let result: AssistantMessage | undefined; void stream.result().then(value => { result = value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(result, "missing terminal must become a protocol error"); assert.equal(result.stopReason, outcome === "abort" ? "aborted" : "error");
    if (outcome === "eof") assert.match(result.errorMessage!, /without a terminal event/);
    const block = result.content[0] as ToolCall & { partialJson?: string; toolArgsGeneration?: number };
    assert.equal(block.partialJson, undefined); assert.equal(block.toolArgsGeneration, undefined);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.equal(fixture.stats().locked, false);
  } finally { fixture.release(); }
});

for (const separator of ["\n", "\r\n"]) test(`proxy UTF-8 wire split at every byte: ${JSON.stringify(separator)}`, async () => {
  const fixture = proxyEventsFixture([{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "中😀" }, proxyDone("stop")], { chunkBytes: 1, separator });
  try { const result = await finish(fixture); assert.deepEqual(result.content, [{ type: "text", text: "中😀" }]); assert.equal(fixture.stats().locked, false); }
  finally { fixture.release(); }
});

test("proxy pre-aborted request settles before creating a parser", async () => {
  const fixture = proxyEventsFixture([proxyStart(), proxyDelta("{}"), proxyDone()]);
  const controller = new AbortController(); controller.abort();
  try {
    const stream = fixture.start(controller.signal);
    for await (const _event of stream) { /* consume the abort terminal */ }
    const result = await stream.result();
    assert.equal(result.stopReason, "aborted"); assert.deepEqual(result.content, []);
    assert.equal(fixture.stats().locked, false); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { fixture.release(); }
});

test("proxy duplicate end is authoritative, but deltas after a closed call fail explicitly", async () => {
  const fixture = proxyEventsFixture([proxyStart(), proxyEnd({ first: true }), proxyEnd({ second: true }), proxyDelta("{}"), proxyDone()]);
  try {
    const result = await finish(fixture); assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /without an active tool call/);
    assert.deepEqual((result.content[0] as ToolCall).arguments, { second: true });
  } finally { fixture.release(); }
});

for (const complete of [false, true]) test(`actual proxy → Agent preserves observer snapshots and recovery, complete=${complete}`, async () => {
  const raw = complete ? '{"path":"fixture"}' : '{"path":"unfinished';
  const events: ProxyAssistantMessageEvent[] = [{ type: "start" }, proxyStart()];
  for (let offset = 0; offset < raw.length; offset += 2) events.push(proxyDelta(raw.slice(offset, offset + 2)));
  if (complete) events.push(proxyEnd({ path: "fixture" }));
  events.push(proxyDone(complete ? "toolUse" : "length"));
  let releaseFirstDelta!: () => void;
  const firstDelivered = new Promise<void>(resolve => { releaseFirstDelta = resolve; });
  const fixture = proxyEventsFixture(events, { afterFrame(index) { if (index === 2) return firstDelivered; } });
  let requests = 0, executions = 0, generations = 0;
  const snapshots: Array<{ args: object; serialized: string }> = [];
  const agent = new Agent({ streamFn: (model, context, options) => {
    if (requests++ === 0) return fixture.start(options?.signal, context);
    const tail = new AssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: "stop", usage: proxyUsage, timestamp: 0 };
    tail.push({ type: "start", partial: message }); tail.push({ type: "done", reason: "stop", message }); return tail;
  } });
  agent.state.model = proxyModel;
  agent.state.tools = [{ name: "fixture", label: "fixture", description: "fixture", parameters: Type.Object({ path: Type.String() }),
    async execute() { executions++; return { content: [{ type: "text", text: "done" }], details: {} }; } }];
  const unsubscribe = agent.subscribeObserver(event => {
    if (event.type !== "message_update" || event.message.role !== "assistant") return;
    const block = event.message.content[0];
    if (block?.type !== "toolCall") return;
    snapshots.push({ args: block.arguments, serialized: JSON.stringify(block.arguments) });
    if (event.assistantMessageEvent.type === "toolcall_delta") {
      if ((event.assistantMessageEvent.toolArgsGeneration ?? 0) > 0) generations++;
      releaseFirstDelta();
    }
  }, { minIntervalMs: 0 });
  try {
    await agent.prompt("synthetic proxy fixture"); await agent.waitForIdle();
    assert.equal(requests, 2); assert.equal(executions, complete ? 1 : 0);
    const toolResult = agent.state.messages.find(message => message.role === "toolResult");
    assert.ok(toolResult?.role === "toolResult"); assert.equal(toolResult.isError, !complete);
    if (!complete) assert.ok(toolResult.content[0]?.type === "text" && toolResult.content[0].text.startsWith("[TOOL_ARGS_INCOMPLETE]"));
    assert.ok(generations > 0); assert.ok(snapshots.length > 0);
    for (const snapshot of snapshots) { assert.equal(Object.isFrozen(snapshot.args), true); assert.equal(JSON.stringify(snapshot.args), snapshot.serialized); }
  } finally { releaseFirstDelta(); unsubscribe(); agent.abort(); fixture.release(); }
});
