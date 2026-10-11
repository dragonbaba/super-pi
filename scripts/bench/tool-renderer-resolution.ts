import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import type { ExtensionAPI, ToolRenderers } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { currentCommit } from "./benchmark.ts";

type Sample = { selfSize: number; children?: Sample[]; callFrame: { functionName: string; url: string } };
function totalBytes(node: Sample): number {
	let bytes = node.selfSize;
	for (const child of node.children ?? []) bytes += totalBytes(child);
	return bytes;
}
function resolverBytes(node: Sample): number {
	let bytes = node.callFrame.url.endsWith("extensions/runner.ts") ? node.selfSize : 0;
	for (const child of node.children ?? []) bytes += resolverBytes(child);
	return bytes;
}
function collectSites(node: Sample, sites: { bytes: number; functionName: string; url: string }[]): void {
	if (node.selfSize) sites.push({ bytes: node.selfSize, functionName: node.callFrame.functionName, url: node.callFrame.url });
	for (const child of node.children ?? []) collectSites(child, sites);
}
const fallback: ToolRenderers = { renderShell: "self" };
let resolverCalls = 0;
function first(name: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
	resolverCalls++;
	if (name === "failure") throw new Error("fixture failure");
	return next();
}
function second(_name: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
	resolverCalls++;
	return next() ?? fallback;
}
function ignoreError(): void {}
function captureBase(runner: ExtensionRunner, name: string): WeakRef<ToolRenderers> {
	const base: ToolRenderers = { renderShell: "default" };
	assert.equal(runner.resolveToolRenderers(name, base), base);
	return new WeakRef(base);
}
async function captureFailedRegistration(): Promise<{ reference: WeakRef<object>; api: ExtensionAPI }> {
	let api!: ExtensionAPI, reference!: WeakRef<object>;
	const runtime = createExtensionRuntime();
	try {
		await assert.rejects(loadExtensionFromFactory(pi => {
			api = pi;
			const resolver = () => undefined;
			reference = new WeakRef(resolver);
			pi.registerToolRenderer(resolver);
			throw new Error("discard registration");
		}, process.cwd(), createEventBus(), runtime), /discard registration/);
	} finally { runtime.invalidate(); }
	return { reference, api };
}

if (!globalThis.gc) throw new Error("tool-renderer-resolution requires --expose-gc");
const runtime = createExtensionRuntime();
const extension = await loadExtensionFromFactory(pi => {
	pi.registerToolRenderer(first); pi.registerToolRenderer(second);
}, process.cwd(), createEventBus(), runtime);
const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as ModelRegistry);
runner.onError(ignoreError);
const inspector = new Session(); inspector.connect();
try {
	for (let index = 0; index < 10_000; index++) runner.resolveToolRenderers("warmup", fallback);
	globalThis.gc();
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096 });
	resolverCalls = 0;
	let matched = 0;
	for (let index = 0; index < 100_000; index++) if (runner.resolveToolRenderers("fixture", fallback) === fallback) matched++;
	const sample = await inspector.post("HeapProfiler.stopSampling");
	const measuredCalls = resolverCalls;
	const sites: { bytes: number; functionName: string; url: string }[] = [];
	collectSites(sample.profile.head as Sample, sites);
	sites.sort((left, right) => right.bytes - left.bytes);
	assert.equal(matched, 100_000); assert.equal(measuredCalls, 200_000);
	const success = captureBase(runner, "success"), failure = captureBase(runner, "failure");
	const discarded = await captureFailedRegistration();
	for (let index = 0; index < 4; index++) { await nextTask(); globalThis.gc(); }
	const retained = Number(success.deref() !== undefined) + Number(failure.deref() !== undefined) + Number(discarded.reference.deref() !== undefined);
	assert.equal(retained, 0);
	assert.throws(() => discarded.api.registerToolRenderer(first), /failed to load/);
	const state = runner as unknown as { rendererBase?: ToolRenderers; rendererToolName?: string; rendererDepth: number };
	assert.equal(state.rendererBase, undefined); assert.equal(state.rendererToolName, undefined); assert.equal(state.rendererDepth, 0);
	process.stdout.write(`${JSON.stringify({ benchmark: "tool-renderer-resolution", commit: currentCommit(), node: process.version,
		lookups: matched, resolverCalls: measuredCalls, sampledBytes: totalBytes(sample.profile.head as Sample), topAllocationSites: sites.slice(0, 8),
		runnerSampledBytes: resolverBytes(sample.profile.head as Sample), retainedAfterFourGcTurns: retained,
		transientBaseReferences: 0, activeResolutionDepth: 0, registrationCallbacks: 2, runnerContinuations: 1 }, null, 2)}\n`);
} finally { inspector.disconnect(); runner.invalidate(); }
