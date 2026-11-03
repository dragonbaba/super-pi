import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { removeOwnedFixture } from "../../tests/helpers/owned-fixture-cleanup.ts";

// Fixture v1: the same driver imports either the baseline or candidate owner.
const moduleIndex = process.argv.indexOf("--session-module");
const modulePath = resolve(moduleIndex < 0 ? "packages/coding-agent/src/core/session-manager.ts" : process.argv[moduleIndex + 1]);
const { SessionManager } = await import(pathToFileURL(modulePath).href);
const smoke = process.argv.includes("--smoke");
const iterations = smoke ? 16 : 4096, warmup = smoke ? 4 : 64, samplingInterval = 1024;
const root = fs.mkdtempSync(join(tmpdir(), "pi-session-append-bench-"));
const user = { role: "user", content: "append allocation fixture ".repeat(16), timestamp: 1 };
let fixtureId = 0;

function managerFor(history: number) {
	const file = join(root, `${fixtureId++}.jsonl`);
	const header = { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-11-04T00:00:00.000Z", cwd: root };
	const lines = [JSON.stringify(header)];
	for (let i = 0; i < history; i++) lines.push(JSON.stringify({ type: "message", id: `seed${i}`, parentId: i ? `seed${i - 1}` : null, timestamp: header.timestamp, message: user }));
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return SessionManager.open(file, root);
}

function appendBatch(manager: InstanceType<typeof SessionManager>, count: number) {
	for (let i = 0; i < count; i++) manager.appendMessage(user);
}

function counters(history: number) {
	const manager = managerFor(history);
	const entries = manager.fileEntries;
	let historyReads = 0, stringifies = 0, writes = 0, explicitOpens = 0, explicitCloses = 0;
	const activeFds = new Set<number>();
	manager.fileEntries = new Proxy(entries, { get(target, key, receiver) {
		if (typeof key === "string" && /^\d+$/.test(key)) historyReads++;
		return Reflect.get(target, key, receiver);
	} });
	const stringify = JSON.stringify, write = fs.writeFileSync, open = fs.openSync, close = fs.closeSync;
	JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { stringifies++; return stringify(...args); }) as typeof JSON.stringify;
	fs.writeFileSync = (...args) => { writes++; return write(...args); };
	fs.openSync = (...args) => { const fd = open(...args); explicitOpens++; activeFds.add(fd); return fd; };
	fs.closeSync = fd => { close(fd); explicitCloses++; activeFds.delete(fd); };
	syncBuiltinESMExports();
	try { appendBatch(manager, iterations); }
	finally {
		JSON.stringify = stringify; fs.writeFileSync = write; fs.openSync = open; fs.closeSync = close;
		syncBuiltinESMExports(); manager.fileEntries = entries;
	}
	assert.deepEqual({ historyReads, stringifies, writes }, { historyReads: 0, stringifies: iterations, writes: iterations });
	assert.equal(manager.getEntryCount(), history + iterations);
	assert.equal(activeFds.size, 0);
	if (smoke) { assert.equal(explicitOpens, iterations); assert.equal(explicitCloses, iterations); }
	manager.newSession();
	return { history, appends: iterations, historyReads, stringifies, writes, explicitOpens, explicitCloses, activeFds: activeFds.size };
}

async function collect() {
	for (let i = 0; i < 4; i++) { await nextTurn(); globalThis.gc!(); }
}

async function lifecycle() {
	const manager = managerFor(0);
	let failedEntry: WeakRef<object> | undefined, failedPayload: WeakRef<object> | undefined;
	const persist = manager._persist;
	const fault = new Error("lifecycle fixture");
	manager._persist = (entry: object & { message: object }) => {
		failedEntry = new WeakRef(entry); failedPayload = new WeakRef(entry.message); throw fault;
	};
	try { manager.appendMessage({ role: "user", content: "x".repeat(1024 * 1024), timestamp: 1 }); }
	catch (error) { assert.equal(error, fault); }
	finally { manager._persist = persist; }
	await collect();
	const failedWhileOwnerAlive = Number(failedEntry!.deref() !== undefined) + Number(failedPayload!.deref() !== undefined);
	manager.newSession();
	await collect();
	const failedAfterClear = Number(failedEntry!.deref() !== undefined) + Number(failedPayload!.deref() !== undefined);
	const id = manager.appendMessage({ role: "user", content: "y".repeat(1024 * 1024), timestamp: 1 });
	const successful = new WeakRef(manager.getEntry(id));
	await collect();
	const successWhileOwnerAlive = Number(successful.deref() !== undefined);
	manager.newSession();
	await collect();
	const successAfterClear = Number(successful.deref() !== undefined);
	assert.equal(failedAfterClear, 0); assert.equal(successWhileOwnerAlive, 1); assert.equal(successAfterClear, 0);
	if (smoke) assert.equal(failedWhileOwnerAlive, 0);
	return { failedWhileOwnerAlive, failedAfterClear, successWhileOwnerAlive, successAfterClear, finalEntryCount: manager.getEntryCount() };
}

async function measure(history: number) {
	const manager = managerFor(history);
	appendBatch(manager, warmup);
	const durations = new Float64Array(iterations);
	const cpu = process.cpuUsage();
	for (let i = 0; i < iterations; i++) {
		const start = performance.now(); manager.appendMessage(user); durations[i] = performance.now() - start;
	}
	const elapsedCpu = process.cpuUsage(cpu);
	durations.sort();
	manager.newSession();
	const profiled = managerFor(history);
	appendBatch(profiled, warmup);
	await collect();
	const inspector = new Session(); inspector.connect();
	let profile;
	try {
		await inspector.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		appendBatch(profiled, iterations);
		profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
	} finally { inspector.disconnect(); }
	let sampledBytes = 0;
	const stacks: { frame: string; bytes: number }[] = [];
	function visit(node: typeof profile.head) {
		sampledBytes += node.selfSize;
		if (node.selfSize) stacks.push({ frame: `${node.callFrame.functionName}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
		for (const child of node.children ?? []) visit(child);
	}
	visit(profile.head);
	profiled.newSession();
	return { history, timedStartCount: history + warmup, appends: iterations, cpuMicrosecondsPerAppend: (elapsedCpu.user + elapsedCpu.system) / iterations,
		wallP50Milliseconds: durations[Math.floor(iterations * .5)], wallP95Milliseconds: durations[Math.floor(iterations * .95)],
		sampledBytes, sampledBytesPerAppend: sampledBytes / iterations, allocationStacks: stacks.sort((a, b) => b.bytes - a.bytes).slice(0, 8) };
}

try {
	assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
	const histories = [0, 1000, 10000];
	const deterministic = histories.map(counters);
	const references = await lifecycle();
	const measurements = [];
	if (!smoke) for (const history of histories) measurements.push(await measure(history));
	console.log(JSON.stringify({ fixtureVersion: 1, node: process.version, os: `${platform()} ${release()}`, modulePath,
		sourceHash: createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex"), warmup, iterations, samplingInterval,
		deterministic, references, measurements }));
} finally { removeOwnedFixture(root); }
