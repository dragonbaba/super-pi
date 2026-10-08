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

for (const mode of ["complete", "bad-checkpoint", "near", "resume-full", "large-turn", "large-tool-result", "checkpoint-overflow", "transport-overflow", "ordinary"]) test(`real child control: ${mode}`, async t => {
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
	proc.stdout!.on("data", data => { output += data; }); proc.stderr!.on("data", data => { errors += data; });
	t.after(() => { control.dispose(); tasks.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	await new Promise<void>((resolve, reject) => { proc.once("close", code => { code === 0 ? resolve() : reject(new Error(errors)); }); proc.once("error", reject); });
	control.finish(); control.dispose();
	assert.equal(proc.listenerCount("message"), 0);
	const summary = JSON.parse(output);
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
