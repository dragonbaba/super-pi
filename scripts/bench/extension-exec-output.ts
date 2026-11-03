import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { platform, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { ExecFixture, installExecFixture } from "../../tests/helpers/extension-exec-fixture.ts";
import { ExtensionExecOwner } from "../../packages/coding-agent/src/core/extension-exec-owner.ts";
import { SessionExecutionBoundary } from "../../packages/coding-agent/src/core/execution-boundary.ts";

const moduleIndex = process.argv.indexOf("--exec-module");
const modulePath = resolve(moduleIndex < 0 ? "packages/coding-agent/src/core/exec.ts" : process.argv[moduleIndex + 1]);
const { execCommand } = await import(pathToFileURL(modulePath).href);
const smoke = process.argv.includes("--smoke"), warmup = smoke ? 1 : 4, iterations = smoke ? 1 : 16;
const samplingInterval = 1024;

async function gc() { for (let i = 0; i < 4; i++) { await nextTurn(); globalThis.gc!(); } }

async function run(bytes: number, chunk: Buffer, cap = bytes) {
	const child = new ExecFixture(), restore = installExecFixture(child);
	try {
		const pending = execCommand("fixture", [], process.cwd(), { maxBuffer: cap });
		await child.ready;
		for (let offset = 0; offset < bytes; offset += chunk.length) {
			if (offset / chunk.length % 2) child.stderr.emit("data", chunk);
			else child.stdout.emit("data", chunk);
		}
		child.finish();
		return await pending;
	} finally { restore(); }
}

async function counters(cap: number) {
	const chunk = Buffer.from("x".repeat(64)), bytes = 4096;
	let inDelivery = false, stopping = false, promises = 0, stopPromises = 0, decodedBytes = 0, decodedChunks = 0, views = 0;
	const hook = createHook({ init(_id, type) { if (inDelivery && type === "PROMISE") { if (stopping) stopPromises++; else promises++; } } });
	const write = StringDecoder.prototype.write, subarray = Buffer.prototype.subarray;
	StringDecoder.prototype.write = function(buffer) { decodedBytes += buffer.length; decodedChunks++; return write.call(this, buffer); };
	Buffer.prototype.subarray = function(start, end) { if (inDelivery) views++; return subarray.call(this, start, end); };
	const child = new ExecFixture(), restore = installExecFixture(child);
	hook.enable();
	try {
		const pending = execCommand("fixture", [], process.cwd(), { maxBuffer: cap });
		await child.ready;
		inDelivery = true;
		for (let offset = 0; offset < bytes; offset += chunk.length) {
			// The first over-cap delivery invokes one stop boundary; it is not normal output work.
			stopping = offset <= cap && offset + chunk.length > cap;
			if (offset / chunk.length % 2) child.stderr.emit("data", chunk);
			else child.stdout.emit("data", chunk);
		}
		inDelivery = false;
		child.finish();
		const result = await pending;
		const listeners = child.stdout.listenerCount("data") + child.stderr.listenerCount("data");
		const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
		assert.equal(promises, 0);
		if (smoke) {
			assert.equal(decodedBytes, Math.min(cap, bytes)); assert.equal(outputBytes, Math.min(cap, bytes));
			assert.equal(listeners, 0); assert.equal(result.truncated, cap < bytes);
			assert.equal(child.signals.length, cap < bytes ? 1 : 0);
			assert.ok(views <= 1); child.assertReleased();
		}
		return { inputBytes: bytes, inputChunks: bytes / chunk.length, cap, decodedBytes, decodedChunks, outputBytes,
			promisesDuringDelivery: promises, promisesDuringStopDelivery: stopPromises, partialBufferViews: views, remainingDataListeners: listeners, stopSignals: child.signals.length };
	} finally {
		hook.disable(); StringDecoder.prototype.write = write; Buffer.prototype.subarray = subarray;
		restore();
	}
}

async function lifecycle(kind: "normal" | "abort" | "cap" | "error") {
	const child = new ExecFixture(), restore = installExecFixture(child), controller = new AbortController();
	const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
	const timers = new Set<NodeJS.Timeout>();
	globalThis.setTimeout = ((...args: Parameters<typeof set>) => { const timer = set(...args); timers.add(timer); return timer; }) as typeof set;
	globalThis.clearTimeout = ((timer: NodeJS.Timeout) => { timers.delete(timer); clear(timer); }) as typeof clear;
	let output: object | undefined, outputRef: WeakRef<object> | undefined;
	let pending: Promise<object> | undefined;
	let payload: Buffer | undefined = Buffer.alloc(1024 * 1024, 120);
	const payloadRef = new WeakRef(payload);
	let listeners: Function[] | undefined;
	let callbackRefs: WeakRef<Function>[] = [];
	try {
		pending = execCommand("fixture", [], process.cwd(), { signal: controller.signal, maxBuffer: kind === "cap" ? 128 : payload.length });
		await child.ready;
		listeners = child.stdout.listeners("data"); callbackRefs = listeners.map(fn => new WeakRef(fn));
		child.stdout.emit("data", payload);
		if (kind === "abort") controller.abort();
		if (kind === "error") child.emit("error", new Error("injected spawn boundary error"));
		else child.finish();
		output = await pending!;
		outputRef = new WeakRef(output);
		if (smoke) child.assertReleased();
		// No producer listener should hold the invocation after completion. Keep child alive.
	} finally { restore(); globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
	const pendingTimers = timers.size;
	for (const timer of timers) clear(timer); // exact fixture-owned timers, including baseline leaks
	timers.clear();
	output = undefined; pending = undefined; payload = undefined; listeners = undefined;
	await gc();
	const refs = { kind, retainedInputBuffers: Number(payloadRef.deref() !== undefined),
		retainedCallbacks: callbackRefs.reduce((count, ref) => count + Number(ref.deref() !== undefined), 0),
		retainedResult: Number(outputRef!.deref() !== undefined), dataListeners: child.stdout.listenerCount("data") + child.stderr.listenerCount("data"),
		pendingTimers, abortListeners: getEventListeners(controller.signal, "abort").length };
	if (smoke) {
		assert.equal(refs.retainedInputBuffers, 0, JSON.stringify(refs)); assert.equal(refs.retainedCallbacks, 0, JSON.stringify(refs));
		assert.equal(refs.retainedResult, 0, JSON.stringify(refs)); assert.equal(pendingTimers, 0); assert.equal(refs.abortListeners, 0);
	}
	child.stdout.removeAllListeners("data"); child.stderr.removeAllListeners("data");
	return refs;
}

async function measure(bytes: number, chunkBytes: number, cap: number) {
	const chunk = Buffer.alloc(chunkBytes, 120);
	for (let i = 0; i < warmup; i++) await run(bytes, chunk, cap);
	await gc();
	const timingIterations = 256 * 1024 * 1024 / bytes;
	const durations = new Float64Array(timingIterations), cpu = process.cpuUsage();
	for (let i = 0; i < timingIterations; i++) {
		const start = performance.now(); await run(bytes, chunk, cap); durations[i] = performance.now() - start;
	}
	const elapsedCpu = process.cpuUsage(cpu); durations.sort();
	await gc();
	const heapBefore = process.memoryUsage().heapUsed;
	let peakHeap = heapBefore;
	const inspector = new Session(); inspector.connect();
	let profile;
	try {
		await inspector.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < iterations; i++) {
			await run(bytes, chunk, cap); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
		}
		profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
	} finally { inspector.disconnect(); }
	await gc();
	const heapAfterGC = process.memoryUsage().heapUsed;
	let sampledBytes = 0;
	const stacks: { frame: string; bytes: number }[] = [];
	function visit(node: typeof profile.head) {
		sampledBytes += node.selfSize;
		if (node.selfSize) stacks.push({ frame: `${node.callFrame.functionName}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
		for (const next of node.children ?? []) visit(next);
	}
	visit(profile.head);
	return { bytes, chunkBytes, cap, iterations, timingIterations, cpuMicrosecondsPerInvocation: (elapsedCpu.user + elapsedCpu.system) / timingIterations,
		wallP95Milliseconds: durations[Math.floor(timingIterations * .95)], sampledBytes,
		sampledBytesPerInputChunk: sampledBytes / (iterations * bytes / chunkBytes), heapBefore, peakHeap, heapAfterGC,
		allocationStacks: stacks.sort((a, b) => b.bytes - a.bytes).slice(0, 8) };
}

async function ownerLifecycle(dispose: boolean) {
	const boundary = new SessionExecutionBoundary();
	let owner: ExtensionExecOwner | undefined = new ExtensionExecOwner(boundary);
	const ownerRef = new WeakRef(owner), signal = boundary.signal;
	const child = new ExecFixture(), restore = installExecFixture(child);
	let pending: Promise<object> | undefined, result: object | undefined, resultRef: WeakRef<object>;
	try {
		pending = owner.exec("fixture", [], process.cwd()); await child.ready;
		child.stdout.emit("data", Buffer.alloc(1024 * 1024, 120));
		if (dispose) await boundary.dispose();
		else { child.finish(); await pending; await boundary.transition(() => {}); }
		result = await pending; resultRef = new WeakRef(result);
		child.assertReleased();
	} finally { restore(); }
	pending = undefined; result = undefined;
	if (dispose) owner = undefined;
	await gc();
	const row = { dispose, retainedResult: Number(resultRef.deref() !== undefined), retainedDisposedOwner: dispose ? Number(ownerRef.deref() !== undefined) : null,
		abortListeners: getEventListeners(signal, "abort").length, participants: boundary.participantCount };
	assert.equal(row.retainedResult, 0); assert.equal(row.abortListeners, 0);
	assert.equal(row.participants, dispose ? 0 : 1);
	if (dispose) assert.equal(row.retainedDisposedOwner, 0);
	await boundary.dispose();
	return row;
}

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
const deterministic = [await counters(4096), await counters(135), await counters(0)];
const references = [];
for (const kind of ["normal", "abort", "cap", "error"] as const) references.push(await lifecycle(kind));
const measurements = [];
const runtimeReferences = [await ownerLifecycle(false), await ownerLifecycle(true)];
if (!smoke) {
	for (const bytes of [256 * 1024, 512 * 1024, 1024 * 1024]) measurements.push(await measure(bytes, 1024, bytes));
	measurements.push(await measure(1024 * 1024, 64, 1024 * 1024));
	measurements.push(await measure(1024 * 1024, 1024, 8192));
}
console.log(JSON.stringify({ fixtureVersion: 2, node: process.version, os: `${platform()} ${release()}`, modulePath,
	sourceHash: createHash("sha256").update(readFileSync(modulePath, "utf8").replaceAll("\r\n", "\n")).digest("hex"),
	warmup, iterations, samplingInterval, deterministic, references, runtimeReferences, measurements }));
