/** Compiled runtime comparison and benchmark-only Worker/VM retention probes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTask } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import workerThreads, { type WorkerOptions } from "node:worker_threads";
import type { CodemodeSandbox } from "../../packages/codemode/src/runtime/host.ts";
import type { loadQuickJSWasm } from "../../packages/codemode/src/wasm.ts";

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!;
async function collect() { for (let i = 0; i < 5; i++) { await nextTask(); globalThis.gc!(); } }
function sampledBytes(node: { selfSize: number; children: typeof node[] }): number {
	let total = node.selfSize;
	for (const child of node.children) total += sampledBytes(child);
	return total;
}

export async function benchmarkWorkerPool(Sandbox: typeof CodemodeSandbox, loadWasm: typeof loadQuickJSWasm,
	workerUrl: URL, runtime: { mode: string; entry: string; worker: string; moduleImportMs: number; packageVersion?: string }) {
	assert.ok(globalThis.gc, "Run with --expose-gc");
	await loadWasm();
	const results = [];
	// Both modes get a priming lifecycle; fresh-Worker baseline and reuse share identical scripts.
	for (const reuseWorker of [false, true]) {
		const warmup = new Sandbox({ reuseWorker });
		assert.ok((await warmup.execute("return 1")).ok);
		await warmup.close();
	}
	for (const reuseWorker of [false, true]) {
		await collect();
		const before = process.memoryUsage();
		const { report, refs } = await measure(Sandbox, reuseWorker);
		await collect();
		const after = process.memoryUsage();
		assert.equal(refs.filter(ref => ref.deref()).length, 0);
		results.push({ ...report, before, afterCloseGc: after, trackedReferences: refs.length, retainedAfterGc: 0 });
	}
	const workerLifecycle = await measureWorkerLifecycle(Sandbox, workerUrl);
	const workerCpu = await measureWorkerCpu(Sandbox);
	const fresh = results[0]!, pooled = results[1]!;
	const gates = { sampledHostReduction: 1 - pooled.sampledHostBytes / fresh.sampledHostBytes,
		cpuP95Ratio: workerCpu[1]!.p95Us / workerCpu[0]!.p95Us, finalHostHeapRatio: pooled.afterCloseGc.heapUsed / fresh.afterCloseGc.heapUsed };
	assert.ok(gates.sampledHostReduction >= .2, JSON.stringify(gates));
	assert.ok(gates.cpuP95Ratio <= 1.05, JSON.stringify(gates));
	assert.ok(gates.finalHostHeapRatio <= 1.1, JSON.stringify(gates));
	process.stdout.write(JSON.stringify({ benchmark: "codemode-worker-pool", runtime, node: process.version, platform: process.platform,
		results, workerLifecycle, workerCpu, gates,
		coverage: "Same-process runtime selected by the benchmark entry, one owner/mode, 30 warm no-ops plus 100x4KiB bridge; host sampling excludes Worker heaps. Process CPU readings are coarse diagnostics only; CPU gate uses separate Worker.cpuUsage groups with a keepalive bootstrap in both modes. Separate diagnostic Worker reads the same runtime's exported worker and samples V8 allocation, WASM linear-memory peak and WeakRefs after fresh VMs; RSS is process-wide and noisy. Post-close heap gate is host only; idle Worker cost reported separately. No real model, full CLI release or OS I/O. Package archive/install provenance must be recorded separately." }) + "\n");
}

/** Worker.cpuUsage isolates actual thread CPU; process accounting can be near-zero on Windows. */
export async function measureWorkerCpu(Sandbox: typeof CodemodeSandbox) {
	const originalWorker = workerThreads.Worker;
	const active = new Set<CpuWorker>();
	let measuring = false, totalUs = 0;
	let samplingError: unknown;
	class CpuWorker extends originalWorker {
		private previousUs = 0;
		constructor(url: string | URL, options: WorkerOptions = {}) {
			// Keep one-shot workers alive until their CPU snapshot; both modes use this bootstrap.
			super(new URL(`data:text/javascript,${encodeURIComponent(`setInterval(() => {}, 60000); await import(${JSON.stringify(String(url))});`)}`), options);
			active.add(this);
			this.once("exit", () => active.delete(this));
		}
		async sample() {
			this.ref();
			const usage = await this.cpuUsage();
			this.unref();
			const current = usage.user + usage.system;
			if (measuring) totalUs += current - this.previousUs;
			this.previousUs = current;
		}
		override async terminate(): Promise<number> {
			try { if (measuring) await this.sample(); }
			catch (error) { samplingError = error; }
			return super.terminate();
		}
	}
	workerThreads.Worker = CpuWorker; syncBuiltinESMExports();
	const results = [];
	try {
		for (const reuseWorker of [false, true]) {
			const sandbox = new Sandbox({ reuseWorker });
			const samplesUs: number[] = [];
			try {
				assert.ok((await sandbox.execute("return 1")).ok);
				for (const worker of active) await worker.sample();
				totalUs = 0; measuring = true;
				for (let group = 0; group < 30; group++) {
					const before = totalUs;
					for (let i = 0; i < 10; i++) assert.ok((await sandbox.execute("return 1")).ok);
					for (const worker of active) await worker.sample();
					samplesUs.push((totalUs - before) / 10);
				}
			} finally { measuring = false; await sandbox.close(); }
			assert.equal(active.size, 0);
			assert.equal(samplingError, undefined);
			assert.equal(sandbox.stats.workersStarted, reuseWorker ? 5 : 301);
			assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
			assert.ok(p95(samplesUs) > 0, "CPU resolution must be sufficient for a meaningful p95");
			results.push({ reuseWorker, groupSize: 10, samplesUs, p95Us: p95(samplesUs), stats: sandbox.stats });
		}
		assert.ok(results[1]!.p95Us <= results[0]!.p95Us * 1.05);
		return results;
	} finally { workerThreads.Worker = originalWorker; syncBuiltinESMExports(); }
}

async function measure(Sandbox: typeof CodemodeSandbox, reuseWorker: boolean) {
	let calls = 0;
	const payload = "x".repeat(4096);
	const tools = [{ name: "read", execute: () => { calls++; return payload; } }];
	const sandbox = new Sandbox({ reuseWorker, tools });
	const refs: WeakRef<object>[] = [new WeakRef(sandbox), new WeakRef(tools), new WeakRef(tools[0]!)];
	const latency: number[] = [], cpu: number[] = [];
	const session = new Session();
	session.connect();
	try {
		let begin = performance.now();
		assert.ok((await sandbox.execute("return 1")).ok);
		const firstMs = performance.now() - begin;
		await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < 30; i++) {
			begin = performance.now();
			const result = await sandbox.execute("return 1");
			latency.push(performance.now() - begin);
			assert.ok(result.ok); refs.push(new WeakRef(result));
		}
		begin = performance.now();
		assert.ok((await sandbox.execute('for(let i=0;i<100;i++) await tools.read({}); return 100')).ok);
		const batchMs = performance.now() - begin;
		const { profile } = await session.post("HeapProfiler.stopSampling");
		const sites: { name: string; bytes: number }[] = [];
		const nodes = [profile.head];
		while (nodes.length) {
			const node = nodes.pop()!;
			if (node.selfSize) sites.push({ name: `${node.callFrame.functionName} ${node.callFrame.url}`, bytes: node.selfSize });
			for (const child of node.children) nodes.push(child);
		}
		// Windows CPU accounting is quantized; measure 10-script groups rather than near-zero single runs.
		for (let group = 0; group < 30; group++) {
			const cpuStart = process.cpuUsage();
			for (let i = 0; i < 10; i++) assert.ok((await sandbox.execute("return 1")).ok);
			const used = process.cpuUsage(cpuStart); cpu.push((used.user + used.system) / 10);
		}
		await collect();
		const idle = process.memoryUsage();
		const idleStats = sandbox.stats;
		begin = performance.now(); await sandbox.close(); const closeMs = performance.now() - begin;
		assert.equal(calls, 100);
		assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: reuseWorker ? 6 : 332, workersStopped: reuseWorker ? 6 : 332 });
		return { refs, report: { reuseWorker, firstMs, latency, medianMs: median(latency), p95Ms: p95(latency), cpuUs: cpu,
			cpuP95Us: p95(cpu), cpuGroupSize: 10, cpuGroups: 30, batchMs, closeMs, calls, idle, idleStats, closedStats: sandbox.stats,
			leadingSites: sites.toSorted((a, b) => b.bytes - a.bytes).slice(0, 12), sampledHostBytes: sampledBytes(profile.head) } };
	} finally { session.disconnect(); await sandbox.close(); }
}

export async function measureWorkerLifecycle(Sandbox: typeof CodemodeSandbox, workerUrl: URL) {
	const require = createRequire(workerUrl);
	let source = readFileSync(workerUrl, "utf8").replace(/from "([^"]+)"/g, (_match, specifier: string) =>
		`from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, workerUrl).href
			: specifier.startsWith("node:") ? specifier : pathToFileURL(require.resolve(specifier)).href)}`);
	function insert(anchor: string, replacement: string) {
		assert.equal(source.split(anchor).length, 2, anchor);
		source = source.replace(anchor, replacement);
	}
	// Diagnostics run only in this data-URL copy. Production workers expose no GC/inspection RPC.
	source += `
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTask } from "node:timers/promises";
import { Session } from "node:inspector/promises";
setFlagsFromString("--expose-gc");
const forceGC = runInNewContext("gc");
const refs = [];
let created = 0, disposed = 0, cleared = 0, peakWasmBytes = 0, allocation;
async function inspect() {
  for(let i=0;i<5;i++) { await nextTask(); forceGC(); }
  if(created === 31 && allocation === undefined) {
    const { profile } = await sampler.post("HeapProfiler.stopSampling");
    let bytes = 0; const pending = [profile.head], sites = [];
    while(pending.length) { const node = pending.pop(); bytes += node.selfSize;
      if(node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize });
      pending.push(...node.children); }
    allocation = { sampledWorkerBytes: bytes, leadingSites: sites.sort((a,b)=>b.bytes-a.bytes).slice(0,8) };
    sampler.disconnect();
  }
  parentPort.postMessage({ diagnostic: true, created, disposed, cleared, tracked: refs.length,
    retained: refs.filter(ref => ref.deref() !== undefined).length, memory: process.memoryUsage(), peakWasmBytes, allocation });
}
`;
	insert("if (parentPort) {", 'const sampler = new Session(); sampler.connect();\nawait sampler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });\nif (parentPort) {');
	insert('parentPort.on("message", start)', 'parentPort.on("message", message => { if(message.inspect) void inspect(); else start(message); })');
	insert("const budget = new BridgeBudget();", "refs.push(new WeakRef(data), new WeakRef(data.tools), new WeakRef(data.store), new WeakRef(data.interrupt), new WeakRef(port));\n    const budget = new BridgeBudget();");
	insert("let onMessage;", "created++; refs.push(new WeakRef(vm), new WeakRef(vm.instance), new WeakRef(vm.instance.exports.memory));\n    let onMessage;");
	insert("vm.dispose();", "peakWasmBytes = Math.max(peakWasmBytes, vm._getMemory().buffer.byteLength);\n        vm.dispose(); disposed++; if(vm.instance === null && vm.module === null && vm.hostCallbacks.size === 0 && vm._ownedHandles.size === 0) cleared++;");
	const originalWorker = workerThreads.Worker;
	let current: InstanceType<typeof originalWorker> | undefined;
	const workerRefs: WeakRef<object>[] = [];
	class MeasuredWorker extends originalWorker {
		constructor(url: string | URL, options: WorkerOptions = {}) {
			assert.equal(String(url), workerUrl.href);
			super(new URL(`data:text/javascript,${encodeURIComponent(source)}`), options);
			current = this; workerRefs.push(new WeakRef(this));
		}
	}
	workerThreads.Worker = MeasuredWorker; syncBuiltinESMExports();
	const sandbox = new Sandbox({ reuseWorker: true });
	async function inspect() {
		const worker = current!;
		worker.ref();
		const message = new Promise<any>(resolve => worker.once("message", resolve));
		worker.postMessage({ inspect: true });
		const result = await message;
		worker.unref();
		assert.equal(result.diagnostic, true); assert.equal(result.retained, 0);
		assert.equal(result.created, result.disposed); assert.equal(result.created, result.cleared);
		assert.equal(result.tracked, result.created * 8);
		return result;
	}
	try {
		assert.ok((await sandbox.execute("return 1")).ok);
		const idleAfterOne = await inspect();
		for (let i = 0; i < 30; i++) {
			assert.ok((await sandbox.execute('globalThis.large = new Uint8Array(8 * 1024 * 1024); store("x", 1); return large.length')).ok);
			await inspect();
		}
		const idleAfterLargeRuns = await inspect();
		assert.equal(idleAfterLargeRuns.created, 31);
		await sandbox.close(); current = undefined;
		await collect();
		assert.equal(workerRefs.filter(ref => ref.deref()).length, 0);
		return { idleAfterOne, idleAfterLargeRuns, closedStats: sandbox.stats, workersRetainedAfterClose: 0 };
	} finally { await sandbox.close(); workerThreads.Worker = originalWorker; syncBuiltinESMExports(); }
}
