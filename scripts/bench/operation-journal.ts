/** One bounded E2 set: paired latency, one sampling profile, one controlled-GC release fixture. */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { fixture } from "../../tests/helpers/operation-write-fixture.ts";
import type { OperationJournal } from "../../packages/coding-agent/src/core/operation-journal.ts";

if (process.platform !== "linux") throw new Error("Native Linux measurement required; no platform override");
if (!globalThis.gc) throw new Error("Use --expose-gc");
const enabled = await fixture(true);
const disabled = await fixture(false);
const content = "bounded write payload\n".repeat(200);
const latencies = { disabled: [] as number[], firstWrite: [] as number[], recovery: [] as number[] };
let lastId = "";
async function cycle(measured: boolean): Promise<void> {
	let start = performance.now();
	await disabled.session.agent.dispatchHostTool({ type: "toolCall", id: randomUUID(), name: "write", arguments: { path: "target", content } });
	if (measured) latencies.disabled.push(performance.now() - start);
	start = performance.now();
	const receipt = await enabled.session.newOperation({ intentId: randomUUID(), originBranch: null, path: "target", content });
	lastId = receipt.operationId;
	if (measured) latencies.firstWrite.push(performance.now() - start);
	start = performance.now();
	await enabled.session.resumeOperation(lastId, { originBranch: null, path: "target", content });
	if (measured) latencies.recovery.push(performance.now() - start);
}
for (let i = 0; i < 10; i++) await cycle(false);
for (let i = 0; i < 30; i++) await cycle(true);
const inspector = new Session(); inspector.connect();
await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (let i = 0; i < 5; i++) await cycle(false);
const { profile } = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
const frames: { name: string; url: string; bytes: number }[] = [];
function collect(node: typeof profile.head): void {
	if (node.selfSize) frames.push({ name: node.callFrame.functionName, url: node.callFrame.url, bytes: node.selfSize });
	for (const child of node.children) collect(child);
}
collect(profile.head);
frames.sort((a, b) => b.bytes - a.bytes);
const sampledBytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
const internals = enabled.session as unknown as { _operationJournal?: OperationJournal; _hostOperation?: unknown };
const counters = { ...internals._operationJournal!.counters };
assert.equal(counters.effects, 45); assert.equal(counters.recoveries, 45); assert.equal(counters.active, 0);
assert.equal(internals._hostOperation, undefined);
const weak = new WeakRef(internals._operationJournal!);
enabled.session.dispose(); disabled.session.dispose();
assert.equal(internals._operationJournal, undefined);
await yieldTurn(); globalThis.gc(); await yieldTurn(); globalThis.gc(); await yieldTurn();
assert.equal(weak.deref(), undefined, "disposed session retained its journal");
function summary(values: number[]) {
	values.sort((a, b) => a - b);
	return { samples: values.length, p50Ms: values[Math.floor(values.length * 0.5)], p95Ms: values[Math.floor(values.length * 0.95)] };
}
console.log("OPERATION_JOURNAL_E2 " + JSON.stringify({
	head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), node: process.version, platform: process.platform,
	fixtureSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
	warmup: 10, timing: { disabled: summary(latencies.disabled), firstWrite: summary(latencies.firstWrite), recovery: summary(latencies.recovery) },
	counters, allocation: { samplingInterval: 1024, cycles: 5, sampledBytes, topFrames: frames.slice(0, 15) },
	lifecycle: { journalReleased: true, active: 0, retainedRequest: false }, providers: enabled.providers() + disabled.providers(),
	interpretation: "Operation-level durability costs; no inference of model calls or tokens saved. fsync counter counts file acknowledgments; best-effort directory sync is additional.",
}));
