/** Opt-in Bun/JSC compatibility and bounded latency probe; called by a bundled entrypoint. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { CodemodeSandbox } from "../../packages/codemode/src/runtime/host.ts";
import type { loadQuickJSWasm } from "../../packages/codemode/src/wasm.ts";

interface HeapStats { heapSize: number; heapCapacity: number; extraMemorySize: number; objectCount: number }
interface BunRuntime { gc(full: boolean): number }
const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
// Run GC in a native event callback. Bun 1.4.0 on Windows retained two tool WeakRefs
// when the same five collections ran inside the benchmark's resumed async frames.
function collectTick(resolve: () => void): void { bun!.gc(true); resolve(); }
async function collect(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(collectTick, resolve));
}

export async function benchmarkBunRuntime(Sandbox: typeof CodemodeSandbox, loadWasm: typeof loadQuickJSWasm,
	workerUrl: string, wasmPath: string, entry: string): Promise<void> {
	assert.ok(bun && process.versions.bun, "This probe requires Bun");
	// A runtime import keeps this optional probe typecheckable without adding Bun to production dependencies.
	const jscModule: string = "bun:jsc";
	const { heapStats }: { heapStats(): HeapStats } = await import(jscModule);
	const heap = (): HeapStats => {
		const { heapSize, heapCapacity, extraMemorySize, objectCount } = heapStats();
		return { heapSize, heapCapacity, extraMemorySize, objectCount };
	};
	const wasmStart = performance.now();
	const wasm = await loadWasm(wasmPath);
	const wasmReadCompileMs = performance.now() - wasmStart;
	const options = { wasm, workerUrl, timeoutMs: 2000 };
	const priming = [];
	for (const reuseWorker of [false, true]) {
		const warmup = new Sandbox({ ...options, reuseWorker });
		try { assert.ok((await warmup.execute("return 1")).ok); }
		finally { await warmup.close(); }
		priming.push(warmup.stats);
	}
	const results = [];
	for (const reuseWorker of [false, true]) {
		await collect();
		const before = heap();
		const { report, references } = await measure(Sandbox, options, reuseWorker);
		await collect();
		const retained = references.flatMap((ref, index) => ref.deref() === undefined ? [] : [index]);
		assert.deepEqual(retained, [], "Retained indices: 0 sandbox, 1 catalog, 2/3 tools, 4..33 results, 34 controller, 35 signal");
		results.push({ ...report, before, afterCloseGc: heap(), trackedReferences: references.length, retainedAfterGc: retained.length });
	}
	console.log(JSON.stringify({ benchmark: "codemode-bun", bun: process.versions.bun, platform: process.platform,
		entry, workerUrl, wasmPath, wasmReadCompileMs, priming, results,
		coverage: "Bun/JSC, original runtime and explicit worker/WASM; 30 warm no-ops plus 100x4KiB sequential bridge per mode, followed by failure/timeout/abort/active-close checks. Timing is within one process after priming; heapStats is retained heap, not cumulative allocation. No allocation-sampling or CPU-p95 admission claim, Worker-internal heap/VM WeakRefs, full CLI, policy/UI or real-model measurement." }));
}

async function measure(Sandbox: typeof CodemodeSandbox,
	options: { wasm: object; workerUrl: string; timeoutMs: number }, reuseWorker: boolean) {
	let calls = 0;
	let entered: (() => void) | undefined, release: (() => void) | undefined;
	let hostSignal: AbortSignal | undefined;
	const payload = "x".repeat(4096);
	const tools = [
		{ name: "read", execute: () => { calls++; return payload; } },
		{ name: "block", execute: (_args: unknown, context: { signal: AbortSignal }) => {
			hostSignal = context.signal; entered!();
			return new Promise<void>(resolve => { release = resolve; });
		} },
	];
	const sandbox = new Sandbox({ ...options, reuseWorker, tools });
	const references: WeakRef<object>[] = [new WeakRef(sandbox), new WeakRef(tools), new WeakRef(tools[0]!), new WeakRef(tools[1]!)];
	const latency: number[] = [];
	try {
		let start = performance.now();
		const first = await sandbox.execute('globalThis.previous = 1; store("old", 1); return 42');
		const firstMs = performance.now() - start;
		assert.ok(first.ok); assert.equal(first.value, 42);
		for (let i = 0; i < 30; i++) {
			start = performance.now();
			const result = await sandbox.execute("return 1");
			latency.push(performance.now() - start);
			assert.ok(result.ok); assert.equal(result.value, 1);
			references.push(new WeakRef(result));
		}
		start = performance.now();
		const batch = await sandbox.execute('for(let i=0;i<100;i++) await tools.read({}); return [typeof previous, load("old"), 100]');
		const batchMs = performance.now() - start;
		assert.ok(batch.ok); assert.deepEqual(batch.value, ["undefined", null, 100]); assert.equal(calls, 100);
		const measuredStats = sandbox.stats;
		assert.deepEqual(measuredStats, { activeExecutions: 0, workersStarted: reuseWorker ? 1 : 32, workersStopped: reuseWorker ? 0 : 32 });
		const failed = await sandbox.execute('throw new Error("fixture")');
		assert.ok(!failed.ok && failed.error.kind === "script");
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		assert.ok((await sandbox.execute("return 1")).ok);
		const timed = await sandbox.execute("while(true) {}", { timeoutMs: 200 });
		assert.ok(!timed.ok && timed.error.kind === "timeout");
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		assert.ok((await sandbox.execute("return 1")).ok);
		let started = new Promise<void>(resolve => { entered = resolve; });
		const controller = new AbortController();
		references.push(new WeakRef(controller), new WeakRef(controller.signal));
		const running = sandbox.execute("await tools.block()", { signal: controller.signal });
		await started; controller.abort();
		const aborted = await running;
		assert.ok(!aborted.ok && aborted.error.kind === "aborted"); assert.equal(hostSignal?.aborted, true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		release!(); release = undefined;
		assert.ok((await sandbox.execute("return 1")).ok);
		started = new Promise<void>(resolve => { entered = resolve; });
		const closing = sandbox.execute("await tools.block()");
		await started; await sandbox.close();
		const closed = await closing;
		assert.ok(!closed.ok && closed.error.kind === "aborted"); assert.equal(hostSignal?.aborted, true);
		release!(); release = undefined;
		await assert.rejects(sandbox.execute("return 1"), /closed/);
		assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: reuseWorker ? 4 : 39, workersStopped: reuseWorker ? 4 : 39 });
		const sorted = latency.toSorted((a, b) => a - b);
		return { references, report: { reuseWorker, firstMs, latency, medianMs: sorted[15], p95Ms: sorted[28],
			batchMs, calls, measuredStats, closedStats: sandbox.stats, lifecycle: ["script failure", "timeout", "explicit abort", "active close", "closed rejection"] } };
	} finally {
		release?.(); entered = undefined; release = undefined; hostSignal = undefined;
		await sandbox.close();
	}
}
