import { Session } from "node:inspector/promises";
import { cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { BashRenderClock, createBashRenderFixture } from "../../tests/helpers/bash-render-fixture.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

const updates = readIntegerOption("--updates", 1000);
const warmup = readIntegerOption("--warmup", 100);
const runs = readIntegerOption("--runs", 1);
const rootIndex = process.argv.indexOf("--source-root");
const sourceRoot = rootIndex < 0 ? process.cwd() : resolve(process.argv[rootIndex + 1]!);
const sourceUrl = pathToFileURL(sourceRoot + "/").href;
const { ToolExecutionComponent } = await import(sourceUrl + "packages/coding-agent/src/modes/interactive/components/tool-execution.ts");
const { initTheme } = await import(sourceUrl + "packages/coding-agent/src/modes/interactive/theme/theme.ts");
const { RELEASE_COMPONENT_RENDER_CACHE: release } = await import(sourceUrl + "packages/tui/dist/index.js");
const implementation = { ToolExecutionComponent, initTheme, release };
if (process.argv.includes("--lifecycle")) {
	assert.equal(typeof globalThis.gc, "function", "lifecycle measurement needs --expose-gc");
	function cycle() {
		const clock = new BashRenderClock();
		try {
			const fixture = createBashRenderFixture(clock, false, false, implementation);
			fixture.run(100, true);
			const weak = new WeakRef(fixture.component);
			assert.ok(Object.values(fixture.dispose()).every(value => value === 0));
			assert.equal(clock.pending, 0);
			return weak;
		} finally { clock.dispose(); }
	}
	async function collect() {
		for (let i = 0; i < 3; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
	}
	for (let i = 0; i < 5; i++) cycle();
	await collect();
	const before = process.memoryUsage().heapUsed;
	const owners = [];
	for (let i = 0; i < 20; i++) owners.push(cycle());
	await collect();
	const after = process.memoryUsage().heapUsed;
	const liveOwners = owners.filter(owner => owner.deref() !== undefined).length;
	assert.equal(liveOwners, 0);
	console.log(JSON.stringify({ sourceCommit: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		measurement: "no sampler; 5 warmup lifecycles, 20 measured lifecycles x 100 changing updates", beforeHeapBytes: before,
		afterHeapBytes: after, retainedHeapDeltaBytes: after - before, liveOwners, releasedLifecycles: owners.length }));
} else {
const results = [];
for (let run = 0; run < runs; run++) {
for (const scenario of ["quiet", "collapsed", "changing", "expanded"] as const) {
	const clock = new BashRenderClock();
	try {
		const fixture = createBashRenderFixture(clock, scenario === "expanded", scenario === "quiet", implementation);
		fixture.run(warmup, scenario === "changing");
		for (const key of Object.keys(fixture.bashMetrics) as Array<keyof typeof fixture.bashMetrics>) fixture.bashMetrics[key] = 0;
		globalThis.gc?.();
		const beforeHeap = process.memoryUsage().heapUsed;
		// Latency and sampling are separate passes over the same production path.
		const counters = fixture.run(updates, scenario === "changing");
		const productionCounters = typeof fixture.raw.resultRendererComponent.setAllocationMetrics === "function" ? { ...fixture.bashMetrics } : undefined;
		const inspector = new Session();
		inspector.connect();
		await inspector.post("HeapProfiler.enable");
		await inspector.post("HeapProfiler.startSampling", { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		fixture.run(updates, scenario === "changing");
		const { profile } = await inspector.post("HeapProfiler.stopSampling");
		await inspector.post("HeapProfiler.disable");
		inspector.disconnect();
		const stack = [profile.head];
		let sampledBytes = 0;
		const sites = new Map<string, number>();
		while (stack.length) {
			const node = stack.pop()!;
			sampledBytes += node.selfSize;
			const frame = node.callFrame;
			const key = `${frame.functionName}:${frame.url}:${frame.lineNumber + 1}`;
			if (node.selfSize) sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
			if (node.children) stack.push(...node.children);
		}
		const released = fixture.dispose();
		globalThis.gc?.();
		results.push({ run, scenario, counters, productionCounters, sampledBytesPerUpdate: sampledBytes / updates,
			topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 8), released,
			pendingTimers: clock.pending, controlledGcHeapDeltaWithHarnessBytes: process.memoryUsage().heapUsed - beforeHeap });
	} finally { clock.dispose(); }
}
}
console.log(JSON.stringify({ harnessCommit: currentCommit(), sourceCommit: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
	viewport: [120, 40], terminal: "renderer fixture; no physical terminal", updates, warmup, samplingInterval: 8192, results }, null, 2));
}
