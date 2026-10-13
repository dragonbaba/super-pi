import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";

const mode = process.argv.includes("--compiled") ? "compiled" : "source";
const runtimeRoot = mode === "compiled" ? "dist" : "src";
const extension = mode === "compiled" ? "js" : "ts";
const importStart = performance.now();
const { CodemodeSandbox } = await import(new URL(`../../packages/codemode/${runtimeRoot}/runtime/host.${extension}`, import.meta.url).href);
const { loadQuickJSWasm } = await import(new URL(`../../packages/codemode/${runtimeRoot}/wasm.${extension}`, import.meta.url).href);
const moduleImportMs = performance.now() - importStart;

if (process.argv.includes("--pool")) {
	assert.equal(mode, "compiled", "Pool diagnostics require --compiled and a current codemode build");
	const { benchmarkWorkerPool } = await import("./codemode-worker-pool.ts");
	await benchmarkWorkerPool(CodemodeSandbox, loadQuickJSWasm);
} else if (process.argv.includes("--stages")) {
	assert.equal(mode, "compiled", "Stage diagnostics require --compiled and a current codemode build");
	const { benchmarkRuntimeStages } = await import("./codemode-runtime-stages.ts");
	await benchmarkRuntimeStages(CodemodeSandbox, loadQuickJSWasm, moduleImportMs);
} else {
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
const references: WeakRef<object>[] = [];
const latencies: number[] = [];
const rawLatencies: number[] = [];
let catalogConstructionMs = 0, closeMs = 0;
let workersStarted = 0, workersStopped = 0, calls = 0;
const serializerPayload = "x".repeat(4096);
function read() { calls++; return serializerPayload; }
function compare(a: number, b: number) { return a - b; }
async function cycle(code: string): Promise<number> {
	const catalog = [{ name: "read", execute: read }];
	const catalogStart = performance.now();
	const sandbox = new CodemodeSandbox({ tools: catalog });
	catalogConstructionMs += performance.now() - catalogStart;
	const start = performance.now();
	const result = await sandbox.execute(code);
	const duration = performance.now() - start;
	assert.ok(result.ok, JSON.stringify(result));
	const closeStart = performance.now();
	await sandbox.close();
	closeMs += performance.now() - closeStart;
	const stats = sandbox.stats;
	assert.equal(stats.activeExecutions, 0);
	assert.equal(stats.workersStarted, stats.workersStopped);
	workersStarted += stats.workersStarted;
	workersStopped += stats.workersStopped;
	references.push(new WeakRef(sandbox), new WeakRef(catalog), new WeakRef(catalog[0]!), new WeakRef(result));
	return duration;
}
const wasmStart = performance.now();
assert.equal(loadQuickJSWasm(), loadQuickJSWasm());
await loadQuickJSWasm();
const wasmCompileMs = performance.now() - wasmStart;
const firstScriptMs = await cycle("return 1");
const inspector = new Session();
inspector.connect();
try {
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	for (let index = 0; index < 30; index++) latencies.push(await cycle("return 1"));
	const batchMs = await cycle('for(let i=0;i<100;i++) await tools.read({}); return 100');
	const { profile } = await inspector.post("HeapProfiler.stopSampling");
	let sampledBytes = 0;
	const pending = [profile.head];
	while (pending.length) { const entry = pending.pop()!; sampledBytes += entry.selfSize; for (const child of entry.children) pending.push(child); }
	for (let index = 0; index < 5; index++) { await nextTask(); gc(); }
	let retained = 0;
	for (const ref of references) if (ref.deref()) retained++;
	assert.equal(retained, 0);
	assert.equal(calls, 100);
	assert.equal(workersStarted, 32);
	assert.equal(workersStopped, 32);
	rawLatencies.push(...latencies);
	latencies.sort(compare);
	process.stdout.write(JSON.stringify({ benchmark: "codemode-runtime", mode, node: process.version, platform: process.platform,
		moduleImportMs, catalogConstructionMs, closeMs, warmSamplesMs: rawLatencies,
		wasmCompileMs, firstScriptMs, warmMedianMs: latencies[15], warmP95Ms: latencies[28], batchCalls: calls, batchMs,
		workersStarted, workersStopped, trackedReferences: references.length, retainedAfterGc: retained, sampledHostBytes: sampledBytes,
		coverage: "real Worker and QuickJS; execution includes Worker startup, VM/prelude, execution, bridge and termination (not separately timed); warm=compiled WASM reused, fresh Worker/VM per run; sampling enabled for 30 warm no-ops and batch; excludes worker heaps, AgentSession, policy and UI; compiled is local tsc output, not an installed release" }) + "\n");
} finally { inspector.disconnect(); }
}
