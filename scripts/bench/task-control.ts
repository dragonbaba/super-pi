import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { TaskBudgetLedger, parseTaskBudgets } from "../../packages/extensions/subagent/budgets.ts";
import { SubagentControl, encodeControl } from "../../packages/extensions/subagent/control.ts";
import { SubagentTasks } from "../../packages/extensions/subagent/tasks.ts";
import type { TaskCheckpoint } from "../../packages/extensions/subagent/checkpoints.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sp-control-bench-")));
const refs: WeakRef<object>[] = [];
const results: unknown[] = [];
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const message = { role: "assistant", api: "test", provider: "test", model: "fixture", timestamp: 0, stopReason: "stop", content: [{ type: "text", text: "evidence ".repeat(128) }] };
class FixtureChannel extends EventEmitter {
	replies = 0;
	send(_message: string, callback: (error: Error | null) => void): void { this.replies++; callback(null); }
}
async function profile(mode: "complete" | "abort" | "rejected") {
	const inspector = new Session(); inspector.connect(); globalThis.gc!();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	let budgetWrites = 0, requests = 0, replies = 0, checkpoints = 0;
	const ledger = new TaskBudgetLedger(parseTaskBudgets('{"childTurns":3}'), { appendEntry() { budgetWrites++; } } as any);
	const tasks = new SubagentTasks(8); tasks.configureHistory({ file: join(root, `${mode}.jsonl`), id: mode, cwd: root }, "subagent");
	refs.push(new WeakRef(tasks), new WeakRef(ledger));
	const identity = statSync(root, { bigint: true });
	for (let i = 0; i < 8; i++) {
		const task = tasks.create("scout", root); tasks.start(task);
		const cp: TaskCheckpoint = { version: 1, id: task.id, agent: "scout", cwd: root, device: String(identity.dev), inode: String(identity.ino), turns: 0, updatedAt: 1, pending: false, messages: [{ role: "user", content: "inspect", timestamp: 0 }] };
		const channel = new FixtureChannel(), control = new SubagentControl(ledger, tasks, cp);
		refs.push(new WeakRef(task), new WeakRef(task.controller!), new WeakRef(cp), new WeakRef(cp.messages), new WeakRef(control), new WeakRef(channel));
		control.attach(channel as any, reason => { throw new Error(reason); });
		let id = 0;
		channel.emit("message", encodeControl({ id: ++id, kind: "ready" }));
		for (let turn = 0; turn < 3; turn++) {
			channel.emit("message", encodeControl({ id: ++id, kind: "request" }));
			if (mode === "abort") break;
			channel.emit("message", encodeControl({ id: ++id, kind: "usage", usage }));
			channel.emit("message", encodeControl({ id: ++id, kind: "turn", completed: true, message, results: [] }));
		}
		if (mode === "rejected") channel.emit("message", encodeControl({ id: ++id, kind: "request" }));
		if (mode !== "abort") control.finish();
		control.dispose(); tasks.finish(task, mode, mode !== "complete");
		assert.equal(channel.listenerCount("message"), 0);
		for (const key of ["proc", "fail", "ledger", "tasks", "checkpoint", "seed"]) assert.equal((control as any)[key], undefined);
		requests += control.counters.requests; replies += control.counters.replies; checkpoints += control.counters.checkpointWrites;
	}
	const history = (tasks as any).history;
	refs.push(new WeakRef(history), new WeakRef(history.db));
	tasks.dispose(); assert.equal(history.counters.openHandles, 0); assert.equal(tasks.size + tasks.waiterCount, 0); assert.equal(ledger.usage.pending, 0);
	assert.equal(requests, mode === "abort" ? 8 : 24); assert.equal(budgetWrites, requests * 2);
	assert.equal(checkpoints, mode === "abort" ? 16 : 56);
	const sampled = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	let bytes = 0;
	function walk(node: any): void { bytes += node.selfSize; for (const child of node.children) walk(child); }
	walk(sampled.profile.head);
	return { mode, tasks: 8, requests, replies, budgetWrites, checkpointWrites: checkpoints, sampledBytes: bytes, retainedHandles: history.counters.openHandles, pendingRequests: ledger.usage.pending };
}
try {
	for (const mode of ["complete", "abort", "rejected"] as const) results.push(await profile(mode));
	for (let i = 0; i < 8; i++) { await tick(); globalThis.gc!(); }
	let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
	assert.equal(retained, 0, "control, checkpoint, channel, database and ledger owners must be collectible");
	console.log(JSON.stringify({ node: process.version, platform: process.platform, results, references: { total: refs.length, retained } }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
