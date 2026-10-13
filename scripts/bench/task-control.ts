import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { SubagentControl, encodeControl } from "../../packages/extensions/subagent/control.ts";
import { SubagentTasks } from "../../packages/extensions/subagent/tasks.ts";
import type { TaskCheckpoint } from "../../packages/extensions/subagent/checkpoints.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sp-control-bench-")));
const refs: WeakRef<object>[] = [];
const results: unknown[] = [];
const message = { role: "assistant", api: "test", provider: "test", model: "fixture", timestamp: 0, stopReason: "stop", content: [{ type: "text", text: "evidence ".repeat(128) }] };
class FixtureChannel extends EventEmitter {
	replies = 0;
	bytes = 0;
	send(message: string, callback: (error: Error | null) => void): void { this.replies++; this.bytes += Buffer.byteLength(message); callback(null); }
}
async function profile(mode: "ordinary" | "complete" | "abort" | "invalid" | "handoff" | "overflow" | "guidance-complete" | "guidance-abort" | "guidance-invalid" | "guidance-handoff") {
	const guidance = mode.startsWith("guidance-"), scenario = guidance ? mode.slice(9) : mode;
	const inspector = new Session(); inspector.connect(); globalThis.gc!();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	let starts = 0, replies = 0, checkpoints = 0, failures = 0, handoffs = 0, ipcReplyBytes = 0, accepted = 0, sent = 0, saved = 0;
	const tasks = new SubagentTasks(8); tasks.configureHistory({ file: join(root, `${mode}.jsonl`), id: mode, cwd: root }, "subagent");
	refs.push(new WeakRef(tasks));
	const identity = statSync(root, { bigint: true });
	for (let i = 0; i < 8; i++) {
		const task = tasks.create("scout", root); tasks.start(task);
		const cp: TaskCheckpoint = { version: 1, id: task.id, agent: "scout", cwd: root, device: String(identity.dev), inode: String(identity.ino), turns: 0, updatedAt: 1, pending: false, messages: [{ role: "user", content: "inspect", timestamp: 0 }] };
		if (scenario === "handoff") cp.messages = new Array(95).fill(cp.messages[0]);
		const prompt: any = { role: "user", content: "continue after inspecting current state", timestamp: 1 };
		const channel = new FixtureChannel(), control = new SubagentControl(tasks, mode === "ordinary" ? undefined : cp, undefined, false, mode === "ordinary" ? undefined : prompt);
		refs.push(new WeakRef(task), new WeakRef(task.controller!), new WeakRef(cp), new WeakRef(cp.messages), new WeakRef(control), new WeakRef(channel), new WeakRef(prompt));
		control.attach(channel as any, () => { failures++; });
		let id = 0;
		channel.emit("message", encodeControl({ id: ++id, kind: "ready" }));
		if (guidance) { control.queueGuidance("g".repeat(4096)); refs.push(new WeakRef((control as any).queuedGuidance)); }
		const turns = scenario === "handoff" || scenario === "overflow" ? 2 : 3;
		for (let turn = 0; mode !== "ordinary" && turn < turns; turn++) {
			channel.emit("message", encodeControl({ id: ++id, kind: "begin" }));
			if (scenario === "abort" && (!guidance || turn === 1)) break;
			const response = scenario === "invalid" ? { ...message, content: [{ type: "image" }] }
				: scenario === "overflow" && turn === 0 ? { ...message, content: [{ type: "text", text: "€".repeat(400000) }] } : message;
			channel.emit("message", encodeControl({ id: ++id, kind: "turn", completed: true, message: response, results: [] }));
			if (scenario === "invalid") break;
		}
		if (scenario !== "abort") control.finish();
		control.dispose(); tasks.finish(task, mode, mode !== "complete");
		assert.equal(channel.listenerCount("message"), 0);
		for (const key of ["proc", "fail", "tasks", "checkpoint", "seed", "pendingPrompt", "queuedGuidance"]) assert.equal((control as any)[key], undefined);
		assert.equal((control as any).pendingGuidance, false);
		starts += control.counters.starts; replies += control.counters.replies; checkpoints += control.counters.checkpointWrites;
		handoffs += control.counters.handoffs;
		ipcReplyBytes += channel.bytes; accepted += control.counters.guidanceAccepted; sent += control.counters.guidanceSent; saved += control.counters.guidanceSaved;
	}
	const history = (tasks as any).history;
	refs.push(new WeakRef(history), new WeakRef(history.db));
	tasks.dispose(); assert.equal(history.counters.openHandles, 0); assert.equal(tasks.size + tasks.waiterCount, 0);
	assert.equal(starts, scenario === "ordinary" ? 0 : scenario === "complete" ? 24 : scenario === "handoff" || scenario === "overflow" || mode === "guidance-abort" ? 16 : 8);
	assert.equal(checkpoints, scenario === "ordinary" ? 0 : scenario === "complete" ? 56 : scenario === "handoff" ? 40 : mode === "guidance-abort" ? 32 : 16);
	assert.equal(replies, scenario === "ordinary" ? 8 : scenario === "complete" ? 56 : scenario === "handoff" || scenario === "overflow" ? 40 : mode === "guidance-abort" ? 32 : 16);
	assert.equal(failures, scenario === "invalid" || mode === "guidance-handoff" ? 8 : 0);
	assert.equal(handoffs, scenario === "handoff" || scenario === "overflow" ? 8 : 0);
	assert.equal(accepted, guidance ? 8 : 0); assert.equal(sent, mode === "guidance-complete" || mode === "guidance-abort" ? 8 : 0); assert.equal(saved, mode === "guidance-complete" ? 8 : 0);
	const sampled = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	let bytes = 0;
	const sites = new Map<string, number>();
	function walk(node: any): void {
		bytes += node.selfSize;
		if (node.selfSize) { const site = node.callFrame.functionName || "(anonymous)"; sites.set(site, (sites.get(site) ?? 0) + node.selfSize); }
		for (const child of node.children) walk(child);
	}
	walk(sampled.profile.head);
	return { mode, tasks: 8, starts, replies, checkpointWrites: checkpoints, failures, handoffs, ipcReplyBytes, guidance: { accepted, sent, saved }, sampledBytes: bytes, leadingSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 5), retainedHandles: history.counters.openHandles };
}
try {
	for (const mode of ["ordinary", "complete", "abort", "invalid", "handoff", "overflow", "guidance-complete", "guidance-abort", "guidance-invalid", "guidance-handoff"] as const) results.push(await profile(mode));
	for (let i = 0; i < 8; i++) { await tick(); globalThis.gc!(); }
	let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
	assert.equal(retained, 0, "control, checkpoint, channel and database owners must be collectible");
	console.log(JSON.stringify({ node: process.version, platform: process.platform, results, references: { total: refs.length, retained } }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
