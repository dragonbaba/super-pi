/** On-demand diagnostics only. Production sources, protocol and runtime options are unchanged. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTask } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import workerThreads, { type WorkerOptions } from "node:worker_threads";
import type { CodemodeSandbox } from "../../packages/codemode/src/runtime/host.ts";
import type { loadQuickJSWasm } from "../../packages/codemode/src/wasm.ts";

const now = () => Number(process.hrtime.bigint()) / 1e6;
const moduleUrl = (source: string) => new URL(`data:text/javascript,${encodeURIComponent(source)}`);
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

export async function benchmarkRuntimeStages(Sandbox: typeof CodemodeSandbox, loadWasm: typeof loadQuickJSWasm, moduleImportMs: number): Promise<void> {
	const { references, report } = await measureRuntimeStages(Sandbox, loadWasm, moduleImportMs);
	await releaseEvidence(references, report);
}

async function measureRuntimeStages(Sandbox: typeof CodemodeSandbox, loadWasm: typeof loadQuickJSWasm, moduleImportMs: number) {
	assert.ok(globalThis.gc, "Run with --expose-gc");
	const originalWorker = workerThreads.Worker;
	const workerUrl = new URL("../../packages/codemode/dist/runtime/worker.js", import.meta.url);
	const originalSource = readFileSync(workerUrl, "utf8");
	const require = createRequire(workerUrl);
	let source = originalSource;
	function insert(anchor: string, replacement: string): void {
		assert.equal(source.split(anchor).length, 2, `Stage anchor must occur exactly once: ${anchor}`);
		source = source.replace(anchor, replacement);
	}
	// Rewrite only static import specifiers so this diagnostic copy can run from a data URL.
	source = source.replace(/from "([^"]+)"/g, (_match, specifier: string) =>
		`from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, workerUrl).href
			: specifier.startsWith("node:") ? specifier : pathToFileURL(require.resolve(specifier)).href)}`);
	insert("function discardOutput(memory)", "const __trace = new Float64Array(workerData.__stageBuffer);\nconst __now = () => Number(process.hrtime.bigint()) / 1e6;\n__trace[1] = __now();\nfunction __serialized(value, slot) { const json = JSON.stringify(value); __trace[slot] = json.length; __trace[slot + 3] = Buffer.byteLength(json); return json; }\nfunction discardOutput(memory)");
	insert("const vm = await QuickJS.create({", "__trace[9]++;\n    __trace[2] = __now();\n    const vm = await QuickJS.create({");
	insert("// Called from the prelude with primitives only.", "__trace[3] = __now();\n    // Called from the prelude with primitives only.");
	insert("const api = vm.withScope(", "__trace[4] = __now();\n    const api = vm.withScope(");
	insert('const settle = api.getProp("settle");', '__trace[5] = __now();\n    const settle = api.getProp("settle");');
	insert("let fn;", "__trace[6] = __now();\n    let fn;");
	insert("vm.callFunction(run, api, fn).dispose();", "__trace[7] = __now();\n    vm.callFunction(run, api, fn).dispose();");
	insert("port.postMessage(terminal);", 'if (terminal.type === "done") { __trace[23]++; __trace[8] = __now(); }\n    port.postMessage(terminal);');
	insert("JSON.stringify(data.tools)", "__serialized(data.tools, 24)");
	insert("JSON.stringify(data.globals)", "__serialized(data.globals, 25)");
	insert("JSON.stringify(data.store)", "__serialized(data.store, 26)");
	const diagnosticWorker = moduleUrl(source).href;
	const bootstrap = moduleUrl('import { workerData } from "node:worker_threads";\nnew Float64Array(workerData.__stageBuffer)[0] = Number(process.hrtime.bigint()) / 1e6;\nawait import(workerData.__stageWorker);');
	const references: WeakRef<object>[] = [];
	let currentTrace: Float64Array | undefined;
	let calls = 0;
	class MeasuredWorker extends originalWorker {
		private readonly trace: Float64Array;
		constructor(url: string | URL, options: WorkerOptions = {}) {
			assert.equal(String(url), workerUrl.href);
			const trace = new Float64Array(new SharedArrayBuffer(30 * 8));
			currentTrace = trace;
			trace[10] = now();
			super(bootstrap, { ...options, workerData: { ...options.workerData, __stageBuffer: trace.buffer, __stageWorker: diagnosticWorker } });
			trace[11] = now();
			this.trace = trace;
			references.push(new WeakRef(this), new WeakRef(trace.buffer));
			this.on("message", message => {
				if (message.type === "done") trace[12] = now();
				if (message.type === "call") {
					trace[15]++; trace[16] += message.args?.length ?? 0;
					trace[21] += message.args === undefined ? 0 : Buffer.byteLength(message.args);
					trace[19]++; trace[20] = Math.max(trace[20], trace[19]);
				}
			});
		}
		override postMessage(...args: Parameters<InstanceType<typeof originalWorker>["postMessage"]>): void {
			const message = args[0];
			if (message.type === "result") {
				this.trace[17]++; this.trace[18] += message.payload?.length ?? 0;
				this.trace[22] += message.payload === undefined ? 0 : Buffer.byteLength(message.payload);
				this.trace[19]--;
			}
			super.postMessage(...args);
		}
		override async terminate(): Promise<number> {
			this.trace[13] = now();
			try { return await super.terminate(); }
			finally { this.trace[14] = now(); }
		}
	}
	const wasmStart = now();
	assert.equal(loadWasm(), loadWasm());
	await loadWasm();
	const wasmReadAndCompileMs = now() - wasmStart;
	const payload = "x".repeat(4096);
	const tools = [{ name: "read", execute: () => { calls++; return payload; } }];
	const sandbox = new Sandbox({ tools });
	references.push(new WeakRef(sandbox), new WeakRef(tools), new WeakRef(tools[0]!));
	const fixtures = [
		{ name: "noop", code: "return 1", value: 1, calls: 0 },
		{ name: "read-4k", code: "return (await tools.read({})).length", value: 4096, calls: 1 },
		{ name: "batch-100x4k", code: "let n=0; for(let i=0;i<100;i++) n+=(await tools.read({})).length; return n", value: 409600, calls: 100 },
		{ name: "cpu-100k", code: "let n=0; for(let i=0;i<100000;i++) n+=i; return n", value: 4999950000, calls: 0 },
	];
	const stageNames = ["threadBootstrap", "workerModuleLoad", "workerSetup", "vmCreate", "bridgeSetup", "prelude", "listenerSetup", "scriptCompile", "executionAndBridge", "doneDelivery", "hostSettlement", "termination"];
	const results: { name: string; code: string; controlMs: number[]; diagnosticMs: number[]; stages: Record<string, number>[]; counters: Record<string, number>[] }[] = [];
	async function run(fixture: typeof fixtures[number], instrumented: boolean) {
		workerThreads.Worker = instrumented ? MeasuredWorker : originalWorker;
		syncBuiltinESMExports();
		const before = calls;
		const start = now();
		const result = await sandbox.execute(fixture.code);
		const elapsed = now() - start;
		assert.ok(result.ok, JSON.stringify(result));
		assert.equal(result.value, fixture.value);
		assert.equal(calls - before, fixture.calls);
		assert.equal(result.calls.length, fixture.calls);
		references.push(new WeakRef(result));
		return elapsed;
	}
	try {
		for (const fixture of fixtures) {
			for (let index = 0; index < 2; index++) await run(fixture, false);
			const row: typeof results[number] = { name: fixture.name, code: fixture.code, controlMs: [], diagnosticMs: [], stages: [], counters: [] };
			for (let index = 0; index < 5; index++) {
				// Alternate the measurement order; these are small diagnostic samples, not a production SLA.
				for (const instrumented of index % 2 ? [false, true] : [true, false]) {
					const elapsed = await run(fixture, instrumented);
					if (!instrumented) { row.controlMs.push(elapsed); continue; }
					row.diagnosticMs.push(elapsed);
					const trace = currentTrace!;
					const boundaries = [trace[10]!, ...trace.slice(0, 9), trace[12]!, trace[13]!, trace[14]!];
					const stages: Record<string, number> = {};
					for (let stage = 0; stage < stageNames.length; stage++) {
						const duration = boundaries[stage + 1]! - boundaries[stage]!;
						assert.ok(duration >= 0 && boundaries[stage]! > 0, `Invalid stage ${stageNames[stage]}`);
						stages[stageNames[stage]!] = duration;
					}
					stages.workerConstructor = trace[11]! - trace[10]!; // Overlaps threadBootstrap; do not add twice.
					stages.hostFraming = elapsed - (trace[14]! - trace[10]!);
					assert.ok(stages.hostFraming >= 0);
					row.stages.push(stages);
					assert.equal(trace[9], 1); assert.equal(trace[23], 1);
					assert.equal(trace[15], fixture.calls); assert.equal(trace[17], fixture.calls);
					assert.equal(trace[19], 0); assert.equal(trace[20], fixture.calls ? 1 : 0);
					assert.equal(trace[16], fixture.calls * 2); assert.equal(trace[18], fixture.calls * 4098);
					assert.equal(trace[21], trace[16]); assert.equal(trace[22], trace[18]); // ASCII fixture only.
					assert.ok(trace[24]! > 0); assert.equal(trace[25], 2); assert.equal(trace[26], 2);
					row.counters.push({ vmCreates: trace[9]!, completions: trace[23]!, calls: trace[15]!, results: trace[17]!, argumentChars: trace[16]!, argumentUtf8Bytes: trace[21]!, resultChars: trace[18]!, resultUtf8Bytes: trace[22]!, pendingAfter: trace[19]!, pendingPeak: trace[20]!, codeChars: fixture.code.length, codeUtf8Bytes: Buffer.byteLength(fixture.code), toolsJsonChars: trace[24]!, globalsJsonChars: trace[25]!, storeJsonChars: trace[26]!, toolsJsonUtf8Bytes: trace[27]!, globalsJsonUtf8Bytes: trace[28]!, storeJsonUtf8Bytes: trace[29]! });
					currentTrace = undefined;
				}
			}
			results.push(row);
		}
	} finally {
		try { await sandbox.close(); }
		finally {
			workerThreads.Worker = originalWorker;
			syncBuiltinESMExports();
			currentTrace = undefined;
		}
	}
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 48, workersStopped: 48 });
	assert.equal(calls, 1212);
	// Return only primitives/arrays of primitives before GC, releasing all measured owners.
	const report = { benchmark: "codemode-runtime-stages", mode: "compiled", node: process.version, platform: process.platform,
		moduleImportMs, wasmReadAndCompileMs, originalWorkerSha256: sha256(originalSource), instrumentedWorkerSha256: sha256(source),
		workersStarted: 48, workersStopped: 48, calls, results,
		summary: results.map(row => ({ name: row.name, controlMedianMs: median(row.controlMs), diagnosticMedianMs: median(row.diagnosticMs),
			stageMediansMs: Object.fromEntries(Object.keys(row.stages[0]!).map(key => [key, median(row.stages.map(stage => stage[key]!))])) })),
		coverage: "Local tsc output, real host/QuickJS and fresh Worker/VM per script; not an installed executable. Controls use the untouched compiled worker. Diagnostics run a guarded timestamp/counter copy via data-URL bootstrap and a benchmark-only Worker subclass. No production instrumentation or protocol/API change. Worker constructor overlaps threadBootstrap; other intervals partition construction through termination. Host framing is execute preflight/return overhead. Execution/bridge includes VM JSON, message transport, host dispatch and fixture tool work, not separately profiled. Five samples per fixture/variant after two control warmups; no inspector; timings are diagnostic, not statistical improvements. Counters count startup JSON once at existing serialization sites, and observed argument/result JSON at the thread boundary, not total copies or memory. No AgentSession, permissions, real I/O, UI, Worker allocation or QuickJS heap profile." };
	return { references, report };
}

// Collect after measured owners leave their async function, not while a live stack owns them.
async function releaseEvidence(references: WeakRef<object>[], report: object): Promise<void> {
	assert.equal(references.length, 91);
	for (let index = 0; index < 5; index++) { await nextTask(); globalThis.gc!(); }
	const retained = references.filter(ref => ref.deref() !== undefined).length;
	assert.equal(retained, 0);
	process.stdout.write(JSON.stringify({ ...report, trackedReferences: references.length, retainedAfterGc: retained }) + "\n");
}
