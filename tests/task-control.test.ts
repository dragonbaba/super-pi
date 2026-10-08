import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TaskBudgetLedger, parseTaskBudgets } from "../packages/extensions/subagent/budgets.ts";
import { SubagentControl } from "../packages/extensions/subagent/control.ts";
import { SubagentTasks } from "../packages/extensions/subagent/tasks.ts";
import type { TaskCheckpoint } from "../packages/extensions/subagent/checkpoints.ts";

for (const bad of [false, true]) test(`real child control ${bad ? "reports unsupported checkpoint failure" : "gates requests and prepends historical context without replay"}`, async t => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sp-control-")));
	const tasks = new SubagentTasks(2); tasks.configureHistory({ file: join(cwd, "session.jsonl"), id: "fixture", cwd }, "subagent");
	const record = tasks.create("scout", cwd); tasks.start(record);
	const identity = statSync(cwd, { bigint: true });
	const checkpoint: TaskCheckpoint = { version: 1, id: record.id, agent: "scout", cwd, device: String(identity.dev), inode: String(identity.ino), turns: 1, updatedAt: 1, pending: false,
		messages: [{ role: "user", content: "historical instruction", timestamp: 0 }] };
	const ledger = new TaskBudgetLedger(parseTaskBudgets('{"childTurns":1}'), { appendEntry() {} } as any);
	const control = new SubagentControl(ledger, tasks, checkpoint, checkpoint.messages);
	const proc = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("fixtures/subagent-control.mjs", import.meta.url)), bad ? "bad-checkpoint" : "complete"], {
		cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, SP_SUBAGENT_CONTROL: "1" },
	});
	let failure = "", output = "", errors = "";
	control.attach(proc, reason => { failure = reason; });
	proc.stdout!.on("data", data => { output += data; }); proc.stderr!.on("data", data => { errors += data; });
	t.after(() => { control.dispose(); tasks.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	await new Promise<void>((resolve, reject) => { proc.once("close", code => { code === 0 ? resolve() : reject(new Error(errors)); }); proc.once("error", reject); });
	control.finish(); control.dispose();
	assert.equal(proc.listenerCount("message"), 0); assert.equal(ledger.usage.pending, 0);
	assert.equal(ledger.usage.turns, 1); assert.equal(ledger.usage.tokens, 5);
	const summary = JSON.parse(output);
	assert.deepEqual(summary.seedRoles, ["user", "user"]); assert.equal(summary.initialCount, 1);
	assert.match(summary.prompt, /per-child turns 1/);
	tasks.finish(record, failure || "done", !!failure);
	const saved = tasks.readCheckpoint(record.id);
	if (bad) { assert.match(failure, /unsupported content/); assert.equal(saved.pending, true); assert.equal(saved.messages.length, 1); }
	else { assert.equal(failure, ""); assert.match(summary.denied, /Child turn budget reached: 1\/1/); assert.equal(saved.pending, false); assert.equal(saved.messages.length, 2); }
});
