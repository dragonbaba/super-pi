import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SubagentControl, encodeControl } from "../packages/extensions/subagent/control.ts";
import { SubagentTasks } from "../packages/extensions/subagent/tasks.ts";
import type { TaskCheckpoint } from "../packages/extensions/subagent/checkpoints.ts";

test("parent corrections keep one bounded slot, persist only completed turns, and release on every exit", t => {
	for (const mode of ["queued", "sent", "incomplete", "invalid", "handoff", "complete", "budget", "ordinary"]) {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sp-guidance-")));
		const tasks = new SubagentTasks(2); tasks.configureHistory({ file: join(cwd, "session.jsonl"), id: mode, cwd }, "subagent");
		const record = tasks.create("scout", cwd); tasks.start(record);
		const identity = statSync(cwd, { bigint: true });
		const message: any = { role: "assistant", api: "test", provider: "test", model: "fixture", stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "done" }] };
		const checkpoint: TaskCheckpoint = { version: 1, id: record.id, agent: "scout", cwd, device: String(identity.dev), inode: String(identity.ino), turns: 0, updatedAt: 1, pending: false,
			messages: [{ role: "user", content: "inspect", timestamp: 0 }] };
		const control = new SubagentControl(tasks, mode === "ordinary" ? undefined : checkpoint);
		let lastReply: any, failure = "", sequence = 0;
		const channel: any = new EventEmitter(); channel.send = (raw: string, callback: (error: null) => void) => { lastReply = JSON.parse(raw); callback(null); };
		control.attach(channel, reason => { failure = reason; });
		t.after(() => { control.dispose(); tasks.dispose(); rmSync(cwd, { recursive: true, force: true }); });
		const send = (kind: string, fields = {}) => channel.emit("message", encodeControl({ id: ++sequence, kind, ...fields }));
		assert.throws(() => control.queueGuidance("early"), /initialized/); send("ready");
		if (mode === "ordinary") { assert.throws(() => control.queueGuidance("ignored"), /checkpoint/); control.dispose(); continue; }
		for (const text of [undefined, " ", "x".repeat(4097)]) assert.throws(() => control.queueGuidance(text as string), /4096/);
		control.queueGuidance("\0".repeat(4096)); assert.throws(() => control.queueGuidance("overwrite"), /already pending/);
		assert.equal(control.counters.guidanceSent, 0);
		if (mode !== "queued") {
			send("begin"); send("turn", mode === "handoff" ? { completed: true, message: { ...message, content: [{ type: "text", text: "x".repeat(800_000) }] }, results: [] } : { completed: true, message, results: [] });
			assert.equal(checkpoint.messages.length, 2, "dispatch must not durably save an unconsumed correction");
			if (mode === "handoff") { assert.equal(lastReply.guidance, undefined); assert.throws(() => control.queueGuidance("more"), /handoff/); }
			else { assert.match(lastReply.guidance, /source=parent; user_input=false/); assert.throws(() => control.queueGuidance("more"), /already pending/); }
		}
		if (["incomplete", "invalid", "complete", "budget"].includes(mode)) {
			send("begin"); send("turn", { completed: mode !== "incomplete", message: mode === "invalid" ? { ...message, content: [{ type: "image" }] } : message, results: [] });
		}
		if (mode === "budget") {
			for (let i = 1; i < 8; i++) {
				control.queueGuidance(`correction ${i}`);
				for (let turn = 0; turn < 2; turn++) { send("begin"); send("turn", { completed: true, message, results: [] }); }
			}
			assert.throws(() => control.queueGuidance("ninth"), /8 corrections/);
		}
		control.finish(); control.dispose(); tasks.finish(record, failure || "done", !!failure);
		const saved = tasks.readCheckpoint(record.id);
		assert.equal(saved.messages.filter(m => m.role === "user" && String(m.content).includes("PARENT TASK GUIDANCE")).length, mode === "budget" ? 8 : mode === "complete" ? 1 : 0);
		assert.equal(saved.pending, mode === "incomplete" || mode === "invalid");
		assert.equal(control.counters.guidanceSaved, mode === "budget" ? 8 : mode === "complete" ? 1 : 0);
		if (mode === "complete" || mode === "budget") assert.equal(failure, ""); else assert.match(failure, /uncompleted parent correction|unsupported content/);
		assert.equal(channel.listenerCount("message"), 0);
		for (const key of ["queuedGuidance", "pendingPrompt", "checkpoint", "proc", "tasks", "fail"]) assert.equal((control as any)[key], undefined);
		assert.throws(() => control.queueGuidance("late"), /initialized/);
	}
});

for (const stage of ["ready", "ready-uncertain", "begin", "incomplete", "invalid", "complete"] as const) test(`resumed checkpoint keeps a new prompt out of durable history until completion: ${stage}`, t => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sp-resume-prompt-")));
	const tasks = new SubagentTasks(2); tasks.configureHistory({ file: join(cwd, "session.jsonl"), id: "fixture", cwd }, "subagent");
	const record = tasks.create("scout", cwd); tasks.start(record);
	const identity = statSync(cwd, { bigint: true });
	const message: any = { role: "assistant", api: "test", provider: "test", model: "fixture", stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "completed" }] };
	const checkpoint: TaskCheckpoint = { version: 1, id: record.id, agent: "scout", cwd, device: String(identity.dev), inode: String(identity.ino), turns: 1, updatedAt: 1, pending: stage === "ready-uncertain",
		messages: [{ role: "user", content: "old completed instruction", timestamp: 0 }, message] };
	const prompt: any = { role: "user", content: "new instruction with a side effect", timestamp: 2 };
	const control = new SubagentControl(tasks, checkpoint, checkpoint.messages, checkpoint.pending, prompt);
	const channel: any = new EventEmitter(); channel.send = (_raw: string, callback: (error: null) => void) => callback(null);
	let failure = "", sequence = 0;
	control.attach(channel, reason => { failure = reason; });
	t.after(() => { control.dispose(); tasks.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	const send = (kind: string, fields = {}) => channel.emit("message", encodeControl({ id: ++sequence, kind, ...fields }));
	send("ready");
	if (stage !== "ready" && stage !== "ready-uncertain") send("begin");
	if (stage === "complete" || stage === "incomplete" || stage === "invalid") send("turn", { completed: stage !== "incomplete", message: stage === "invalid" ? { ...message, content: [{ type: "image" }] } : message, results: [] });
	control.dispose(); tasks.finish(record, failure || stage, stage !== "complete");
	const saved = tasks.readCheckpoint(record.id);
	assert.equal(saved.turns, stage === "complete" ? 2 : 1);
	assert.equal(saved.pending, stage !== "ready" && stage !== "complete");
	assert.equal(saved.messages.length, stage === "complete" ? 4 : 2);
	assert.equal(saved.messages.some(m => m.role === "user" && m.content === prompt.content), stage === "complete");
	assert.equal((control as any).pendingPrompt, undefined); assert.equal(channel.listenerCount("message"), 0);
	if (stage === "invalid") assert.match(failure, /unsupported content/);
});

for (const mode of ["complete", "bad-checkpoint", "near", "resume-full", "large-turn", "large-tool-result", "checkpoint-overflow", "transport-overflow", "ordinary", "steer-real-text", "steer-real-tool"]) test(`real child control: ${mode}`, { timeout: 15_000 }, async t => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sp-control-")));
	const tasks = new SubagentTasks(2); tasks.configureHistory({ file: join(cwd, "session.jsonl"), id: "fixture", cwd }, "subagent");
	const record = tasks.create("scout", cwd); tasks.start(record);
	const identity = statSync(cwd, { bigint: true });
	const checkpoint: TaskCheckpoint = { version: 1, id: record.id, agent: "scout", cwd, device: String(identity.dev), inode: String(identity.ino), turns: 1, updatedAt: 1, pending: false,
		messages: [{ role: "user", content: "historical instruction", timestamp: 0 }] };
	if (mode === "near") checkpoint.messages = new Array(96).fill(checkpoint.messages[0]);
	if (mode === "resume-full") checkpoint.messages = new Array(127).fill(checkpoint.messages[0]);
	const control = new SubagentControl(tasks, mode === "ordinary" ? undefined : checkpoint, mode === "ordinary" ? undefined : checkpoint.messages, false,
		mode === "resume-full" ? { role: "user", content: "new instruction", timestamp: 3 } : undefined);
	const proc = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("fixtures/subagent-control.mjs", import.meta.url)), mode], {
		cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, SP_SUBAGENT_CONTROL: "1" },
	});
	let failure = "", output = "", errors = "";
	control.attach(proc, reason => { failure = reason; });
	const steering = mode.startsWith("steer-real");
	const onBoundary = (raw: unknown) => {
		if (JSON.parse(String(raw)).kind === "begin" && control.counters.starts === 1) control.queueGuidance("report only the verified path");
	};
	if (steering) proc.on("message", onBoundary);
	proc.stdout!.on("data", data => { output += data; }); proc.stderr!.on("data", data => { errors += data; });
	const closed = new Promise<number | null>(resolve => proc.once("close", resolve));
	let spawnError: Error | undefined; proc.once("error", error => { spawnError = error; });
	t.after(async () => {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill();
		await closed; control.dispose(); tasks.dispose(); rmSync(cwd, { recursive: true, force: true });
	});
	assert.equal(await closed, 0, spawnError?.message ?? errors);
	control.finish(); control.dispose();
	if (steering) proc.off("message", onBoundary);
	assert.equal(proc.listenerCount("message"), 0);
	const summary = JSON.parse(output);
	if (steering) {
		assert.equal(failure, ""); assert.equal(summary.requests, 2); assert.deepEqual(summary.errors, []);
		assert.equal(summary.messageListeners + summary.disconnectListeners, 0);
		assert.equal(summary.inspections, mode.endsWith("tool") ? 1 : 0);
		assert.equal(control.counters.guidanceAccepted, 1); assert.equal(control.counters.guidanceSent, 1); assert.equal(control.counters.guidanceSaved, 1);
		tasks.finish(record, "done", false);
		const saved = tasks.readCheckpoint(record.id);
		assert.equal(saved.pending, false); assert.equal(saved.messages.length, mode.endsWith("tool") ? 5 : 4);
		assert.equal(saved.messages.at(-2)?.role, "user"); assert.match(String(saved.messages.at(-2)?.content), /user_input=false.*report only/s);
		return;
	}
	assert.equal(summary.initialCount, 1);
	assert.equal(summary.messageListeners, 0); assert.equal(summary.disconnectListeners, 0);
	if (mode === "ordinary") {
		assert.equal(summary.seedRoles, undefined); assert.equal(summary.toolsDisabled, 0);
		assert.equal(control.counters.received, 1); assert.equal(control.counters.checkpointWrites, 0);
		assert.equal(failure, ""); return;
	}
	assert.deepEqual(summary.seedRoles, new Array(mode === "near" ? 98 : mode === "resume-full" ? 129 : 3).fill("user"));
	assert.match(summary.prompt, /historical context/);
	assert.match(summary.prompt, /1048576.*128 messages/);
	assert.match(summary.prompt, /786432.*96 messages/);
	tasks.finish(record, failure || "done", !!failure);
	const saved = tasks.readCheckpoint(record.id);
	if (mode === "bad-checkpoint") { assert.match(failure, /unsupported content/); assert.equal(saved.pending, true); assert.equal(saved.messages.length, 1); }
	else {
		assert.equal(failure, ""); assert.equal(summary.aborted, 0); assert.equal(control.counters.starts, 2);
		const frozen = mode === "transport-overflow" || mode === "checkpoint-overflow" || mode === "resume-full";
		assert.equal(saved.pending, frozen);
		assert.equal(saved.messages.length, mode === "near" ? 98 : mode === "resume-full" ? 127 : mode === "large-tool-result" ? 4 : frozen ? 1 : 3);
		if (frozen) assert.equal(saved.turns, 1, "failed capacity admission must restore in-memory and durable completed-turn counts");
		assert.equal(summary.toolsDisabled, mode === "complete" ? 0 : 1);
		assert.equal(summary.startupDisabled, mode === "near" || mode === "resume-full" ? 1 : 0);
		assert.equal(summary.followUps, mode === "large-turn" || mode === "checkpoint-overflow" || mode === "transport-overflow" ? 1 : 0, "a final text turn must get exactly one chance to return a concise handoff");
		assert.equal(summary.toolBlocked, mode !== "complete");
		assert.equal(tasks.historyError, undefined);
		if (mode !== "complete") {
			assert.match(summary.capacityNotice, /HANDOFF NOW/); assert.match(control.handoffReason!, /fresh bounded assignment/);
			assert.equal(control.counters.handoffs, 1);
		}
	}
});
