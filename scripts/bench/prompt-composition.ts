import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import * as native from "../../packages/coding-agent/src/core/system-prompt.ts";
import { promptFixture } from "../../tests/helpers/prompt-fixture.ts";
import dynamicInstructions from "../../packages/dynamic-instructions/src/index.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";

// Manual, bounded actual builder -> runner -> dynamic projection. No files or CI matrix.
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const compose = (native as any).buildSystemPromptComposition;
const runtime = createExtensionRuntime(), events = createEventBus(), manager = SessionManager.inMemory();
const extension = await loadExtensionFromFactory(dynamicInstructions, process.cwd(), events, runtime);
const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, {} as never);
runner.onError(error => { throw new Error(error.error); });
const optionRefs: WeakRef<object>[] = [], compositionRefs: WeakRef<object>[] = [], segmentRefs: WeakRef<object>[] = [];
const tracked = new Set(["buildSystemPrompt", "buildSystemPromptComposition", "formatSkillsForPrompt", "formatContextFiles", "formatSkills", "buildProjection", "buildNativeProjection", "removeUniqueSection", "compactPiDocs", "sha256", "replacementContent"]);
let options: any, composition: any, prompt = "";
function rebuild(index: number) {
	options = promptFixture();
	options.contextFiles[0].content = "x".repeat(128 * 1024) + index;
	composition = compose?.(options);
	prompt = composition ? composition.text : native.buildSystemPrompt(options);
	optionRefs.push(new WeakRef(options));
	if (composition) {
		compositionRefs.push(new WeakRef(composition));
		segmentRefs.push(new WeakRef(composition.segments), new WeakRef(composition.dynamicSources));
		for (const segment of composition.segments) segmentRefs.push(new WeakRef(segment));
	}
}
async function deliver() {
	const result = await (runner.emitBeforeAgentStart as any)("hello", undefined, prompt, options, composition);
	for (const message of result?.messages ?? []) manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
}
for (const phase of ["first", "change", "warm"]) {
	const iterations = phase === "first" ? 1 : phase === "change" ? 16 : 64;
	const profiler = new Session(); profiler.connect();
	let bytes = 0;
	const sites: { site: string; bytes: number }[] = [], times = new Float64Array(iterations);
	const counters: Record<string, number> = {};
	try {
		gc();
		await profiler.post("Profiler.enable");
		await profiler.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
		await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			if (phase !== "warm") rebuild(phase === "first" ? -1 : i);
			await deliver(); times[i] = performance.now() - start;
		}
		const coverage = await profiler.post("Profiler.takePreciseCoverage");
		for (const script of coverage.result) {
			if (!/system-prompt\.ts|core\/skills\.ts|dynamic-instructions\/src\/index\.ts/u.test(script.url.replaceAll("\\", "/"))) continue;
			for (const fn of script.functions) if (tracked.has(fn.functionName)) counters[fn.functionName] = (counters[fn.functionName] ?? 0) + fn.ranges[0].count;
		}
		const { profile } = await profiler.post("HeapProfiler.stopSampling");
		const pending = [profile.head];
		while (pending.length) {
			const node = pending.pop()!; bytes += node.selfSize;
			if (node.selfSize) sites.push({ site: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
			for (const child of node.children) pending.push(child);
		}
	} finally { profiler.disconnect(); }
	times.sort(); sites.sort((a, b) => b.bytes - a.bytes);
	if (phase === "warm") for (const count of Object.values(counters)) assert.equal(count, 0);
	if (counters.buildNativeProjection) {
		assert.equal(counters.buildNativeProjection, iterations);
		assert.equal(counters.sha256, iterations * 2);
		for (const name of ["formatContextFiles", "formatSkills", "removeUniqueSection", "compactPiDocs"]) assert.equal(counters[name] ?? 0, 0);
	}
	console.log(JSON.stringify({ phase, iterations, structured: Boolean(compose), counters, sampledBytesPerCall: bytes / iterations, p95Ms: times[Math.floor(iterations * .95)], sites: sites.slice(0, 5) }));
}
options = composition = undefined; prompt = "";
await runner.emit({ type: "session_shutdown", reason: "exit" } as never);
events.clear();
await setImmediate();
for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
let retainedOptions = 0, retainedCompositions = 0, retainedSegments = 0;
for (const reference of optionRefs) if (reference.deref()) retainedOptions++;
for (const reference of compositionRefs) if (reference.deref()) retainedCompositions++;
for (const reference of segmentRefs) if (reference.deref()) retainedSegments++;
assert.equal(retainedCompositions, 0);
assert.equal(retainedSegments, 0);
console.log(JSON.stringify({ lifecycle: { trackedOptions: optionRefs.length, trackedCompositions: compositionRefs.length, trackedSegments: segmentRefs.length, retainedOptions, retainedCompositions, retainedSegments }, node: process.version }));
// The runner stays live: released projections must not depend on its collection.
assert.ok(runner);

async function invalidatedWithoutShutdown() {
	const localRuntime = createExtensionRuntime();
	const localExtension = await loadExtensionFromFactory(dynamicInstructions, process.cwd(), createEventBus(), localRuntime);
	const localRunner = new ExtensionRunner([localExtension], localRuntime, process.cwd(), SessionManager.inMemory(), {} as never);
	const localOptions = promptFixture(), localComposition = compose(localOptions);
	await localRunner.emitBeforeAgentStart("sync dispose", undefined, localComposition.text, localOptions, localComposition);
	localRunner.invalidate();
	return { runner: localRunner as ExtensionRunner | undefined, reference: new WeakRef(localComposition) };
}
const invalidated = await invalidatedWithoutShutdown();
await setImmediate();
for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
assert.ok(invalidated.reference.deref(), "without shutdown the current extension cache follows the live runner");
invalidated.runner = undefined;
await setImmediate();
for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
assert.equal(invalidated.reference.deref(), undefined);
console.log(JSON.stringify({ invalidatedWithoutShutdown: { retainedWhileRunnerAlive: 1, retainedAfterRunnerRelease: 0 } }));
