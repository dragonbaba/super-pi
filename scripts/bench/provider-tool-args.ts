import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { release } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { IncrementalToolArguments } from "../../packages/ai/src/utils/incremental-tool-arguments.ts";
import { anthropicArgumentsFixture } from "../../tests/helpers/anthropic-arguments-fixture.ts";
import { responsesArgumentsFixture } from "../../tests/helpers/responses-arguments-fixture.ts";

const moduleIndex = process.argv.indexOf("--provider-module");
const responses = process.argv.includes("--responses");
const argumentsFixture = responses ? responsesArgumentsFixture : anthropicArgumentsFixture;
const modulePath = resolve(moduleIndex < 0 ? `packages/ai/src/api/${responses ? "openai-codex-responses" : "anthropic-messages"}.ts` : process.argv[moduleIndex + 1]);
const { stream: factory } = await import(pathToFileURL(modulePath).href);
const smoke = process.argv.includes("--smoke"), warmup = 2, timingIterations = 8, profileIterations = 4, samplingInterval = 1024;
type Fixture = ReturnType<typeof argumentsFixture>;
async function gc(): Promise<void> { for (let i = 0; i < 4; i++) { await nextTurn(); globalThis.gc!(); } }
async function run(fixture: Fixture) {
	const stream = fixture.start(factory); for await (const _event of stream) { /* drain real delivery */ }
	const output = await stream.result(); assert.equal(output.stopReason, "toolUse", output.errorMessage); return output;
}

async function count(size: number) {
	const input = JSON.stringify({ payload: "x".repeat(size) }), fixture = argumentsFixture([input], 64);
	const parse = JSON.parse, append = IncrementalToolArguments.prototype.append, dispose = IncrementalToolArguments.prototype.dispose;
	let argumentParseCalls = 0, argumentParseCodeUnits = 0, providerPromises = 0, parserPromises = 0, inParser = false, deltas = 0;
	const parsers: ReturnType<IncrementalToolArguments["diagnostics"]>[] = [];
	const hook = createHook({ init(_id, type) { if (type === "PROMISE") { providerPromises++; if (inParser) parserPromises++; } } });
	JSON.parse = function(text, reviver) {
		if (typeof text === "string" && text.startsWith('{"payload"')) { argumentParseCalls++; argumentParseCodeUnits += text.length; }
		return parse(text, reviver);
	};
	IncrementalToolArguments.prototype.append = function(fragment) {
		inParser = true; try { return append.call(this, fragment); } finally { inParser = false; }
	};
	IncrementalToolArguments.prototype.dispose = function() { dispose.call(this); parsers.push(this.diagnostics()); };
	hook.enable();
	try {
		const stream = fixture.start(factory);
		for await (const event of stream) if (event.type === "toolcall_delta") deltas++;
		const output = await stream.result(); assert.equal(output.stopReason, "toolUse", output.errorMessage);
		assert.equal((output.content[0] as any).arguments.payload.length, size);
	} finally {
		hook.disable(); JSON.parse = parse; IncrementalToolArguments.prototype.append = append; IncrementalToolArguments.prototype.dispose = dispose; fixture.release();
	}
	if (smoke) {
		assert.equal(argumentParseCalls, 1); assert.equal(argumentParseCodeUnits, input.length); assert.equal(parserPromises, 0);
		assert.equal(parsers.length, 1); assert.equal(parsers[0].scannedCodeUnits, input.length); assert.equal(parsers[0].retainedRawCodeUnits, 0);
	}
	return { inputCodeUnits: input.length, inputBytes: Buffer.byteLength(input), deltas, argumentParseCalls, argumentParseCodeUnits,
		providerPromises, providerPromisesPerDelta: providerPromises / deltas, parserPromises, parsers };
}

async function lifecycle(reason: "normal" | "abort" | "error") {
	const fixture = argumentsFixture([JSON.stringify({ payload: "x".repeat(256 * 1024) })], 1024, false, reason === "error" ? 3 : undefined);
	const controller = new AbortController(), append = IncrementalToolArguments.prototype.append, dispose = IncrementalToolArguments.prototype.dispose;
	const seen = new WeakSet<IncrementalToolArguments>(), refs: WeakRef<IncrementalToolArguments>[] = [], released: ReturnType<IncrementalToolArguments["diagnostics"]>[] = [];
	let preview: WeakRef<object> | undefined;
	IncrementalToolArguments.prototype.append = function(fragment) {
		if (!seen.has(this)) { seen.add(this); refs.push(new WeakRef(this)); }
		return append.call(this, fragment);
	};
	IncrementalToolArguments.prototype.dispose = function() { dispose.call(this); released.push(this.diagnostics()); };
	const stream = fixture.start(factory, controller.signal);
	try {
		for await (const event of stream) if (event.type === "toolcall_delta") {
			preview ??= new WeakRef((event.partial.content[event.contentIndex] as any).arguments);
			if (reason === "abort") controller.abort();
		}
	} finally { IncrementalToolArguments.prototype.append = append; IncrementalToolArguments.prototype.dispose = dispose; fixture.release(); }
	const result = await stream.result();
	assert.equal(result.stopReason, reason === "normal" ? "toolUse" : reason === "abort" ? "aborted" : "error");
	await gc();
	const row = { reason, parserCount: refs.length, retainedParsers: refs.reduce((n, ref) => n + Number(ref.deref() !== undefined), 0),
		retainedFirstPreview: Number(preview?.deref() !== undefined), released,
		callerOwnsResult: result === await stream.result() };
	assert.equal(row.retainedParsers, 0);
	if (reason === "normal") assert.equal(row.retainedFirstPreview, 0);
	for (const state of released) { assert.equal(state.retainedRawCodeUnits, 0); assert.equal(state.retainedRoot, false); assert.equal(state.depth, 0); }
	if (smoke) assert.equal(row.parserCount, 1);
	// On abort/error the result intentionally owns the incomplete preview; that graph is not a leak.
	return row;
}

async function measure(kind: string, size: number, chunkCharacters: number) {
	const input = kind === "wide" ? JSON.stringify({ payload: Object.fromEntries(Array.from({ length: size / 32 }, (_, i) => [`key${i}`, i])) })
		: JSON.stringify({ payload: "x".repeat(size) });
	const fixture = argumentsFixture([input], chunkCharacters);
	try {
		for (let i = 0; i < warmup; i++) await run(fixture);
		const samples = [], cpu = process.cpuUsage();
		for (let i = 0; i < timingIterations; i++) { const start = performance.now(); await run(fixture); samples.push(performance.now() - start); }
		const elapsed = process.cpuUsage(cpu); samples.sort((a, b) => a - b); await gc();
		const heapBefore = process.memoryUsage().heapUsed; let peakHeap = heapBefore;
		const inspector = new Session(); inspector.connect(); let profile;
		try {
			await inspector.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
			for (let i = 0; i < profileIterations; i++) { await run(fixture); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }
			profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
		} finally { inspector.disconnect(); }
		await gc(); const heapAfterGC = process.memoryUsage().heapUsed;
		let sampledBytes = 0; const sites: { frame: string; bytes: number }[] = [];
		function visit(node: typeof profile.head): void {
			sampledBytes += node.selfSize;
			if (node.selfSize) sites.push({ frame: `${node.callFrame.functionName}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
			for (const child of node.children ?? []) visit(child);
		}
		visit(profile.head);
		return { kind, inputBytes: Buffer.byteLength(input), inputCodeUnits: input.length, chunkCharacters, sampledBytes,
			sampledBytesPerInputByte: sampledBytes / (profileIterations * Buffer.byteLength(input)), wallP95Milliseconds: samples[7],
			cpuMicrosecondsPerInvocation: (elapsed.user + elapsed.system) / timingIterations, heapBefore, peakHeap, heapAfterGC,
			allocationSites: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 10) };
	} finally { fixture.release(); }
}

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
const counters = [], lifecycleRows = [], measurements = [];
for (const size of [8192, 16384, 32768]) counters.push(await count(size));
for (const reason of ["normal", "abort", "error"] as const) lifecycleRows.push(await lifecycle(reason));
if (!smoke) {
	for (const size of [16384, 32768, 65536]) measurements.push(await measure("string", size, 128));
	measurements.push(await measure("string", 32768, 32)); measurements.push(await measure("wide", 65536, 128));
}
console.log(JSON.stringify({ fixtureVersion: 1, node: process.version, os: `${process.platform} ${release()}`, modulePath,
	sourceHash: createHash("sha256").update(readFileSync(modulePath, "utf8").replaceAll("\r\n", "\n")).digest("hex"),
	warmup, timingIterations, profileIterations, samplingInterval, counters, lifecycle: lifecycleRows, measurements }));
