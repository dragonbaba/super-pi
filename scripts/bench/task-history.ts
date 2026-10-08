import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as tick } from "node:timers/promises";
import { SubagentTasks } from "../../packages/extensions/subagent/tasks.ts";
import { taskHistoryPath, type TaskHistory } from "../../packages/extensions/task-history.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sp-history-bench-")));
const weak: WeakRef<object>[] = [];
const results: unknown[] = [];
const text = "evidence ".repeat(1300);

function trackHistory(tasks: SubagentTasks): TaskHistory {
	const history = (tasks as unknown as { history: TaskHistory }).history;
	for (const name of ["db", "ownerStatement", "saveStatement", "pruneStatement"]) {
		const value = (history as unknown as Record<string, object>)[name]; if (value) weak.push(new WeakRef(value));
	}
	weak.push(new WeakRef(history)); return history;
}

async function lifecycle(mode: "complete" | "fail" | "cancel" | "dispose") {
	const tasks = new SubagentTasks(8);
	const session = { file: join(root, `${mode}.jsonl`), id: mode, cwd: root };
	tasks.configureHistory(session, "subagent");
	weak.push(new WeakRef(tasks));
	const inspector = new Session(); inspector.connect(); globalThis.gc!();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const started = performance.now();
	for (let i = 0; i < 8; i++) {
		const task = tasks.create("scout", root, "branch");
		weak.push(new WeakRef(task), new WeakRef(task.controller!));
		tasks.start(task);
		if (mode === "cancel") tasks.cancel(task.id);
		if (mode !== "dispose") tasks.finish(task, text, mode === "fail");
	}
	const history = trackHistory(tasks);
	assert.equal(history.counters.writes, mode === "dispose" ? 16 : 24);
	tasks.dispose(); assert.equal(history.counters.openHandles, 0);
	assert.equal(tasks.size + tasks.waiterCount, 0);
	const restored = new SubagentTasks(8); restored.configureHistory(session, "subagent");
	assert.equal(restored.historyError, undefined); assert.equal(restored.size, 8);
	weak.push(new WeakRef(restored));
	for (const record of restored.values()) {
		weak.push(new WeakRef(record)); assert.equal(record.controller, undefined);
		assert.equal(record.state, mode === "dispose" ? "interrupted" : mode === "cancel" ? "cancelled" : mode === "fail" ? "failed" : "completed");
	}
	const restoredHistory = trackHistory(restored);
	restored.dispose(); assert.equal(restoredHistory.counters.openHandles, 0);
	const elapsedMs = performance.now() - started;
	const sampled = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	let bytes = 0; const sites: { name: string; bytes: number }[] = [];
	function walk(node: any) {
		bytes += node.selfSize; if (node.selfSize) sites.push({ name: `${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
		for (const child of node.children) walk(child);
	}
	walk(sampled.profile.head); sites.sort((a, b) => b.bytes - a.bytes);
	return { mode, tasks: 8, writes: history.counters.writes, recovered: restoredHistory.counters.recovered,
		openHandlesAfterDispose: history.counters.openHandles + restoredHistory.counters.openHandles,
		retainedOwners: tasks.size + tasks.waiterCount + restored.size + restored.waiterCount,
		databaseBytes: statSync(taskHistoryPath(session.file, "subagent")).size, elapsedMs, sampledBytes: bytes, sampledBytesPerTask: bytes / 8, leadingSites: sites.slice(0, 5) };
}

try {
	for (const mode of ["complete", "fail", "cancel", "dispose"] as const) results.push(await lifecycle(mode));
	for (let i = 0; i < 8; i++) { await tick(); globalThis.gc!(); }
	let retained = 0; for (const ref of weak) if (ref.deref()) retained++;
	assert.equal(retained, 0, "databases, prepared statements, records, controllers and owners must be collectible");
	console.log(JSON.stringify({ node: process.version, platform: process.platform, results, references: { total: weak.length, retained } }, null, 2));
} finally {
	assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir())); rmSync(root, { recursive: true, force: true });
}
