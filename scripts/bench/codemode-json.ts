import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { BoundedJson } from "../../packages/codemode/src/bounded-json.ts";

// Exact pre-review implementation, retained only as a benchmark control.
class PreviousBoundedJson {
	remaining = 0;
	count = (key: string, value: unknown): unknown => {
		let chars = key.length + 3;
		switch (typeof value) {
			case "string": chars += value.length + 2; break;
			case "number": chars += 24; break;
			case "boolean": chars += 5; break;
			default: chars += 4;
		}
		this.remaining -= chars;
		if (this.remaining < 0) throw new RangeError("limit");
		return value;
	};
	stringify(value: unknown, limit: number): string | undefined {
		this.remaining = limit;
		const json = JSON.stringify(value, this.count);
		if (json !== undefined && json.length > limit) throw new RangeError("limit");
		return json;
	}
}
const ITERATIONS = 1024, WARMUP = 128, LIMIT = 1024 * 1024;
function ascending(a: number, b: number) { return a - b; }
function descending(a: any, b: any) { return b.bytes - a.bytes; }
function collect(node: any, top: any[]): number {
	let bytes = node.selfSize;
	if (bytes) top.push({ bytes, function: node.callFrame.functionName, url: node.callFrame.url });
	for (const child of node.children ?? []) bytes += collect(child, top);
	return bytes;
}
async function sample(previous: boolean) {
	const serializer = previous ? new PreviousBoundedJson() : new BoundedJson();
	const value = { content: [{ type: "text", text: "preview" }], details: { numbers: Array(1024).fill(0), escaped: "\n\\\"日".repeat(1024) } };
	const expected = JSON.stringify(value);
	assert.equal(serializer.stringify(value, LIMIT), expected);
	const count = (serializer as any).count;
	let visits = 0;
	// One probe callback outside sampling; both arms use the same instrumentation.
	(serializer as any).count = function (this: unknown, key: string, item: unknown) { visits++; return count.call(this, key, item); };
	for (let i = 0; i < WARMUP; i++) serializer.stringify(value, LIMIT);
	visits = 0; global.gc!();
	const inspector = new Session(); inspector.connect();
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const times: number[] = [];
	let chars = 0, peakHeap = process.memoryUsage().heapUsed;
	for (let i = 0; i < ITERATIONS; i++) {
		const started = performance.now(); chars += serializer.stringify(value, LIMIT)!.length; times.push(performance.now() - started);
		if (i % 128 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
	const { profile } = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	const top: any[] = [], allocated = collect(profile.head, top); top.sort(descending); times.sort(ascending);
	assert.equal(chars, expected.length * ITERATIONS);
	if (!previous) { assert.equal((serializer as any).remaining, 0); assert.equal((serializer as any).visits, 0); assert.equal((serializer as any).active, false); }
	return { refs: [new WeakRef(serializer), new WeakRef(value)], metrics: { control: previous, iterations: ITERATIONS, charsPerResult: expected.length,
		callbackVisits: visits, callbacksPerOwner: 1, callbacksAllocatedPerValue: 0, medianMs: times[ITERATIONS / 2], p95Ms: times[Math.floor(ITERATIONS * .95)],
		sampledBytesPerResult: allocated / ITERATIONS, peakHeap, top: top.slice(0, 6) } };
}
async function measure(previous: boolean) {
	const sampled = await sample(previous);
	for (let i = 0; i < 5; i++) { await nextTask(); global.gc!(); }
	let retained = 0; for (const ref of sampled.refs) if (ref.deref()) retained++;
	assert.equal(retained, 0);
	return { ...sampled.metrics, retainedWeakRefs: retained, heapAfterGc: process.memoryUsage().heapUsed };
}
assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const before = await measure(true), after = await measure(false);
assert.equal(after.callbackVisits, before.callbackVisits);
const numeric = Array(20000).fill(0);
assert.equal(new BoundedJson().stringify(numeric, 262144)?.length, 40001);
assert.throws(() => new PreviousBoundedJson().stringify(numeric, 262144));
console.log(JSON.stringify({ node: process.version, platform: process.platform, scope: "Same JSON payload and native encoder; exact former counter vs corrected bounded serializer. Both cases fit both limits. Full bridge/SDK allocation is measured separately.", before, after,
	correctness: { numericChars: 40001, cap: 262144, previousAccepted: false, correctedAccepted: true } }, null, 2));
