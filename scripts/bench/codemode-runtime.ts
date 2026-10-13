import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { isAbsolute, join, relative } from "node:path";
import { setImmediate as nextTask } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let packageRoot: string | undefined;
const flags = new Set<string>();
for (let i = 0; i < args.length; i++) {
	const flag = args[i]!;
	assert.ok(["--compiled", "--pool", "--stages", "--package-root"].includes(flag) && !flags.has(flag), `Unknown or duplicate option: ${flag}`);
	flags.add(flag);
	if (flag === "--package-root") {
		const value = args[++i];
		assert.ok(value && !value.startsWith("--"), "--package-root requires an installed @super-pi/codemode directory");
		packageRoot = realpathSync(value);
	}
}
assert.ok(!(packageRoot && flags.has("--compiled")), "Choose --package-root or --compiled");
assert.ok(!(flags.has("--pool") && flags.has("--stages")), "Choose --pool or --stages");
assert.ok(!(packageRoot && flags.has("--stages")), "Stage instrumentation currently supports only repository --compiled output");
const mode = packageRoot ? "package" : flags.has("--compiled") ? "compiled" : "source";
const runtimeRoot = mode === "source" ? "src" : "dist";
const extension = mode === "source" ? "ts" : "js";
let entryUrl = new URL(`../../packages/codemode/${runtimeRoot}/runtime/host.${extension}`, import.meta.url);
let wasmUrl = new URL(`../../packages/codemode/${runtimeRoot}/wasm.${extension}`, import.meta.url);
let workerUrl = new URL(`./worker.${extension}`, entryUrl);
let packageVersion: string | undefined;
if (packageRoot) {
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.equal(manifest.name, "@super-pi/codemode");
	assert.equal(typeof manifest.version, "string");
	packageVersion = manifest.version;
	function exportedFile(name: string): URL {
		const target = manifest.exports?.[name]?.import;
		assert.ok(typeof target === "string" && target.startsWith("./"), `Missing import export: ${name}`);
		const path = realpathSync(join(packageRoot!, target));
		const within = relative(packageRoot!, path);
		assert.ok(within && within !== ".." && !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(within), `Export escapes package: ${name}`);
		return pathToFileURL(path);
	}
	entryUrl = exportedFile(".");
	wasmUrl = entryUrl; // Load both public exports from the installed package, including its dependency resolver.
	workerUrl = exportedFile("./worker");
	assert.notEqual(packageRoot, realpathSync(new URL("../../packages/codemode", import.meta.url)), "Use an installed package, not the repository workspace");
}
const importStart = performance.now();
const { CodemodeSandbox } = await import(entryUrl.href);
const { loadQuickJSWasm } = await import(wasmUrl.href);
const moduleImportMs = performance.now() - importStart;
const runtime = { mode, packageVersion, entry: fileURLToPath(entryUrl), worker: fileURLToPath(workerUrl), moduleImportMs };

if (flags.has("--pool")) {
	assert.notEqual(mode, "source", "Pool diagnostics require --compiled or --package-root");
	const { benchmarkWorkerPool } = await import("./codemode-worker-pool.ts");
	await benchmarkWorkerPool(CodemodeSandbox, loadQuickJSWasm, workerUrl, runtime);
} else if (flags.has("--stages")) {
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
	process.stdout.write(JSON.stringify({ benchmark: "codemode-runtime", mode, runtime, node: process.version, platform: process.platform,
		moduleImportMs, catalogConstructionMs, closeMs, warmSamplesMs: rawLatencies,
		wasmCompileMs, firstScriptMs, warmMedianMs: latencies[15], warmP95Ms: latencies[28], batchCalls: calls, batchMs,
		workersStarted, workersStopped, trackedReferences: references.length, retainedAfterGc: retained, sampledHostBytes: sampledBytes,
		coverage: "real Worker and QuickJS; execution includes Worker startup, VM/prelude, execution, bridge and termination (not separately timed); warm=compiled WASM reused, fresh Worker/VM per run; sampling enabled for 30 warm no-ops and batch; excludes worker heaps, AgentSession, policy and UI; runtime identifies repository source/dist or the explicitly selected package; package mode alone does not establish archive provenance or validate a full CLI release" }) + "\n");
} finally { inspector.disconnect(); }
}
