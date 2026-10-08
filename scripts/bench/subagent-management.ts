import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as tick } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SubagentProcessRun } from "../../packages/extensions/subagent/index.ts";
import { SubagentScheduler } from "../../packages/extensions/subagent/scheduler.ts";
import { SubagentTasks } from "../../packages/extensions/subagent/tasks.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc.");
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex < 0 ? undefined : process.argv[baselineIndex + 1];
const updates = 1000;
let Run = SubagentProcessRun;
let baselinePath: string | undefined;
if (baseline) {
	if (!/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error("Baseline must be an exact Git commit ID.");
	const source = execFileSync("git", ["show", `${baseline}:packages/extensions/subagent/index.ts`], { encoding: "utf8" });
	assert.ok(source.includes("class SubagentProcessRun {"));
	baselinePath = fileURLToPath(new URL(`../../packages/extensions/subagent/.bench-baseline-${process.pid}.ts`, import.meta.url));
	writeFileSync(baselinePath, source.replace("class SubagentProcessRun {", "export class SubagentProcessRun {"), { flag: "wx" });
	Run = (await import(pathToFileURL(baselinePath).href)).SubagentProcessRun;
}

function result() {
	return { agent: "scout", agentSource: "user", task: "fixture", messages: [], stderr: "", exitCode: -1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
}
const text = "evidence ".repeat(450);
const chunk = Buffer.from(JSON.stringify({ type: "message_end", message: {
	role: "assistant", content: [{ type: "text", text }], model: "fixture", stopReason: "stop", timestamp: 0,
	usage: { input: 10, output: 10, totalTokens: 20, cost: { total: 0 } },
} }) + "\n");

async function profile(children: number) {
	const results = Array.from({ length: children }, result);
	let snapshots = 0;
	const runs = results.map((value, index) => {
		const run: any = Object.create(Run.prototype);
		Object.assign(run, { result: value, buffer: "", stdoutDecoder: new StringDecoder("utf8"), jsonTransportBytes: 0, jsonTransportEventCount: 0, retainedJsonEventCount: 0, settled: false,
			makeDetails: (single: any[]) => ({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results: single }),
			onUpdate: (partial: any) => {
				results[index] = partial.details.results[0];
				// Baseline's actual parallel publication followed by observer isolation.
				structuredClone({ content: partial.content, details: { mode: "parallel", results: [...results] } });
				snapshots++;
			},
			requestProcessTreeKill: () => { throw new Error("Unexpected transport limit"); },
		});
		return run;
	});
	for (let i = 0; i < 100; i++) runs[i % children].onStdoutData(chunk);
	snapshots = 0;
	const stringify = JSON.stringify;
	let fullMessageSerializations = 0;
	JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { fullMessageSerializations++; return stringify(...args); }) as typeof JSON.stringify;
	globalThis.gc!();
	const inspector = new Session(); inspector.connect();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const start = performance.now();
	for (let i = 0; i < updates; i++) runs[i % children].onStdoutData(chunk);
	const elapsedMs = performance.now() - start;
	const sampled = await inspector.post("HeapProfiler.stopSampling");
	inspector.disconnect();
	JSON.stringify = stringify;
	const sites: any[] = [];
	let bytes = 0;
	function walk(node: any) {
		bytes += node.selfSize;
		if (node.selfSize) sites.push({ function: node.callFrame.functionName, bytes: node.selfSize });
		for (const child of node.children ?? []) walk(child);
	}
	walk(sampled.profile.head);
	sites.sort((a, b) => b.bytes - a.bytes);
	const weak = runs.map(run => new WeakRef(run.result));
	const retainedMessages = results.reduce((sum, value) => sum + value.messages.length, 0);
	for (const run of runs) { run.buffer = ""; run.result = undefined; run.onUpdate = undefined; run.makeDetails = undefined; }
	runs.length = 0; results.length = 0;
	return { children, updates, elapsedMs, sampledBytes: bytes, sampledBytesPerUpdate: bytes / updates, snapshots, fullMessageSerializations, retainedMessages, topSites: sites.slice(0, 5), weak };
}

async function lifecycle() {
	const weak: WeakRef<object>[] = [];
	const counters: any[] = [];
	for (const mode of ["complete", "failure", "cancel", "dispose"]) {
		const scheduler = new SubagentScheduler({ maxConcurrent: 16, maxTasks: 64 });
		const tasks = new SubagentTasks(64);
		const workspace = { canonicalCwd: process.cwd(), allowMutation: false };
		const reservation = scheduler.reserve(new Array(64).fill(workspace));
		const jobs: Promise<void>[] = [];
		for (let i = 0; i < 64; i++) {
			const task = tasks.create("scout"); weak.push(new WeakRef(task));
			const signal = task.controller!.signal;
			jobs.push(scheduler.run(signal, async () => { tasks.start(task); await tick(); if (mode === "failure") throw new Error("fixture"); }).then(
				() => tasks.finish(task, text, false), () => tasks.finish(task, "ended", true),
			).finally(() => reservation.completed()));
		}
		if (mode === "cancel" || mode === "dispose") tasks.cancelAll();
		if (mode === "dispose") scheduler.dispose();
		await Promise.all(jobs); reservation.release(); jobs.length = 0;
		tasks.dispose(); scheduler.dispose();
		const released = scheduler.active + scheduler.queued + scheduler.outstanding + scheduler.reserved + scheduler.reservationCount + tasks.size + tasks.waiterCount;
		assert.equal(released, 0);
		counters.push({ mode, highWaterMark: scheduler.highWaterMark, queueHighWaterMark: scheduler.queueHighWaterMark, retainedAfterDispose: released });
	}
	return { weak, counters };
}

try {
	const profiles = [];
	for (const count of [8, 16, 64]) profiles.push(await profile(count));
	const cleanup = await lifecycle();
	for (let i = 0; i < 8; i++) { await tick(); globalThis.gc!(); }
	const liveResults = profiles.reduce((sum, profile) => sum + profile.weak.filter(ref => ref.deref()).length, 0);
	const liveTasks = cleanup.weak.filter(ref => ref.deref()).length;
	assert.equal(liveResults + liveTasks, 0, "released owners must be collectible after normal/failure/cancel/dispose");
	for (const p of profiles) {
		if (!baseline) { assert.equal(p.snapshots, 0); assert.equal(p.fullMessageSerializations, 0); }
	}
	console.log(JSON.stringify({ baseline: baseline ?? "working-tree", node: process.version, platform: process.platform,
		coverage: "Production stdout/parse/retention methods; simulated baseline observer snapshot. Downstream TUI is covered separately by tui-tool-leaf-allocations.",
		profiles: profiles.map(({ weak, ...profile }) => profile), cleanup: cleanup.counters,
		weakReferences: { total: cleanup.weak.length + profiles.reduce((sum, p) => sum + p.weak.length, 0), liveResults, liveTasks },
	}, null, 2));
} finally { if (baselinePath) unlinkSync(baselinePath); }
