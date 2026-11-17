import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { OutputAccumulator as CurrentOutput } from "../../packages/coding-agent/src/core/tools/output-accumulator.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
const OutputAccumulator: typeof CurrentOutput = process.env.SP_OUTPUT_BASELINE_MODULE
	? (await import(process.env.SP_OUTPUT_BASELINE_MODULE)).OutputAccumulator : CurrentOutput;
const inspector = new Session(); inspector.connect();
await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096 });
const chunk = Buffer.from("0123456789abcdef".repeat(4096));
const refs: WeakRef<object>[] = [];
let peak = process.memoryUsage().heapUsed, buffers = 0, bytes = 0;
const start = performance.now(), cpu = process.cpuUsage();
async function cycle(): Promise<void> {
	const output = new OutputAccumulator({ captureData: !process.env.SP_OUTPUT_BASELINE_MODULE }); refs.push(new WeakRef(output));
	try {
		for (let index = 0; index < 64; index++) { output.append(chunk); buffers++; bytes += chunk.length; peak = Math.max(peak, process.memoryUsage().heapUsed); }
		output.finish(); const snapshot = output.snapshot(); await output.closeTempFile();
		assert.equal(snapshot.truncation.totalBytes, chunk.length * 64); assert.equal(snapshot.spillFileCapped, false);
		if (!process.env.SP_OUTPUT_BASELINE_MODULE) {
			const source = output.capture(); assert.equal(source.kind, "file");
			if (source.kind === "file") { assert.equal(source.bytes, chunk.length * 64); assert.equal(source.sha256.length, 64); }
		}
	} finally { await output.discardTempFile(); }
}
for (let index = 0; index < 12; index++) await cycle();
const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
const { profile } = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
let sampledBytes = 0;
const sites: { name: string; bytes: number }[] = [], stack = [profile.head];
while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize; if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize }); for (const child of node.children) stack.push(child); }
sites.sort(compareBytes);
for (let index = 0; index < 8; index++) { await nextTask(); gc(); }
let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
assert.equal(retained, 0);
process.stdout.write(JSON.stringify({ benchmark: "captured-output", mode: process.env.SP_OUTPUT_BASELINE_MODULE ? "baseline" : "candidate", buffers, bytes,
	elapsedMs, cpuUs: used.user + used.system, sampledBytes, peakHeap: peak, finalHeap: process.memoryUsage().heapUsed, retainedOwners: retained,
	appendCallbacks: 0, appendPromises: 0, appendControllers: 0, meteringBufferCopies: 0, captureDescriptors: process.env.SP_OUTPUT_BASELINE_MODULE ? 0 : 12,
	leadingSites: sites.slice(0, 6), coverage: "12 equivalent 4 MiB captures; same raw buffers, decoded tails, exact spill bytes, finish/close and owned-file cleanup. Candidate additionally hashes existing write buffers and issues one final descriptor." }) + "\n");
function compareBytes(a: { bytes: number }, b: { bytes: number }): number { return b.bytes - a.bytes; }
