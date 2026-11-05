import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { SubagentStream } from "../../packages/coding-agent/src/modes/subagent-stream.ts";
import { SubagentProcessRun } from "../../packages/extensions/subagent/index.ts";
import { StderrTail } from "../../packages/extensions/subagent/stderr-tail.ts";

const ITERATIONS = 1000;
const refs = [], retainedOwners = [];
class Receiver extends Writable {
    constructor(run) { super(); this.run = run; this.lines = 0; }
    _write(chunk, _encoding, callback) { this.run.onStdoutData(chunk); this.lines++; callback(); }
}
function forbidKill() { throw new Error("Unexpected transport limit"); }
function measure(node, totals, sites) {
    totals.total += node.selfSize;
    if (node.selfSize) sites.push({ function: node.callFrame.functionName, bytes: node.selfSize });
    if (node.callFrame.url.endsWith("/subagent-stream.ts")) totals.sender += node.selfSize;
    if (node.callFrame.url.endsWith("/subagent/index.ts")) totals.receiver += node.selfSize;
    if (node.callFrame.url.endsWith("/stderr-tail.ts")) totals.stderr += node.selfSize;
    for (const child of node.children) measure(child, totals, sites);
}
function largestFirst(left, right) { return right.bytes - left.bytes; }
async function profile() {
    const result = { messages: [], stderr: "", usage: { turns: 0 } };
    const run = Object.create(SubagentProcessRun.prototype);
    Object.assign(run, { result, buffer: "", stdoutDecoder: new StringDecoder("utf8"), stderrTail: new StderrTail(32768),
        jsonTransportBytes: 0, jsonTransportEventCount: 0, retainedJsonEventCount: 0, settled: false, requestProcessTreeKill: forbidKill });
    const sink = new Receiver(run), sender = new SubagentStream(sink, sink.write.bind(sink));
    refs.push(new WeakRef(result), new WeakRef(run), new WeakRef(sink), new WeakRef(run.stderrTail.buffer));
    const message = { role: "toolResult", content: [{ type: "text", text: "x".repeat(4096) }] };
    const events = [
        { type: "tool_execution_end", toolCallId: "fixture", toolName: "read", result: { content: message.content }, isError: false },
        { type: "message_start", message }, { type: "message_end", message },
        { type: "turn_end", message, toolResults: [message] }, { type: "agent_end", messages: [message], willRetry: false },
        { type: "message_update", message, assistantMessageEvent: { partial: message } },
    ];
    const stderr = Buffer.from("日志🙂".repeat(400));
    let waits = 0, serializations = 0, payloads = 0;
    const initialize = sender.initializeWait;
    sender.initializeWait = function countWait(resolve, reject) { waits++; initialize(resolve, reject); };
    const stringify = JSON.stringify;
    JSON.stringify = function countSerialize(value, replacer, space) {
        serializations++; if (value.message === message) payloads++;
        return stringify(value, replacer, space);
    };
    const inspector = new Session(); inspector.connect();
    let sampled, loopWaits;
    try {
        globalThis.gc();
        await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
            for (const event of events) sender.onEvent(event);
            run.onStderrData(stderr);
            const blocked = sender.waitForBackpressure(); if (blocked) await blocked;
            if (iteration % 128 === 127) await tick();
        }
        loopWaits = waits;
        await sender.flush();
        sampled = (await inspector.post("HeapProfiler.stopSampling")).profile;
    } finally { JSON.stringify = stringify; inspector.disconnect(); sender.dispose(); }
    const totals = { total: 0, sender: 0, receiver: 0, stderr: 0 }, sites = []; measure(sampled.head, totals, sites); sites.sort(largestFirst);
    assert.equal(payloads, ITERATIONS); assert.equal(run.retainedJsonEventCount, ITERATIONS);
    assert.equal(loopWaits, 0); assert.equal(result.messages.length, 3);
    assert.equal(sender.messageFrame.message, undefined); assert.equal(sender.output, undefined); assert.equal(sender.write, undefined);
    assert.equal(run.stderrTail.buffer.length, 32768);
    const tail = run.stderrTail.take(); assert.ok(Buffer.byteLength(tail) <= 32768);
    retainedOwners.push(sender); // A disposed owner must not retain its output or result graph.
    return { iterations: ITERATIONS, sourceEvents: ITERATIONS * events.length, lines: sink.lines,
        payloadSerializations: payloads, serializations, perUpdateDeferreds: loopWaits / ITERATIONS,
        finalFlushDeferreds: waits - loopWaits, retainedMessages: result.messages.length, stderrBytes: Buffer.byteLength(tail),
        sampledBytes: totals, sampledBytesPerMessage: totals.total / ITERATIONS, leadingSites: sites.slice(0, 5) };
}
async function lifecycle(outcome) {
    let callback;
    const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { callback = done; } });
    const sender = new SubagentStream(sink, sink.write.bind(sink));
    refs.push(new WeakRef(sink)); retainedOwners.push(sender);
    sender.start(); const waiting = sender.flush();
    if (outcome === "failure") {
        const rejected = assert.rejects(waiting, /fixture/); callback(new Error("fixture")); await rejected;
    } else if (outcome === "abort") {
        const rejected = assert.rejects(waiting, /disposed/); sender.dispose(); callback(); await rejected;
    } else { callback(); await waiting; }
    await tick(); sender.dispose();
    assert.equal(sender.output, undefined); assert.equal(sender.waiting, undefined); assert.equal(sender.pendingWrites, 0);
    for (const event of ["error", "drain", "close"]) assert.equal(sink.listenerCount(event), 0);
}
assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const measured = await profile();
for (const outcome of ["complete", "failure", "abort"]) await lifecycle(outcome);
for (let cycle = 0; cycle < 8; cycle++) { await tick(); globalThis.gc(); }
let live = 0; for (const ref of refs) if (ref.deref()) live++;
assert.equal(live, 0);
console.log(JSON.stringify({ schemaVersion: 1, benchmark: "subagent-stream", node: process.version, platform: process.platform, ...measured,
    retainedDisposedOwners: retainedOwners.length, weakReferences: refs.length, liveReferences: live,
    coverage: "production sender -> Writable -> stdout decoder -> JSON parse/retention; stderr byte collection; completion/failure/abort release" }));
