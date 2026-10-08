import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, linkSync, renameSync, realpathSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TaskHistory, taskHistoryPath, TASK_RESULT_CHARS } from "../packages/extensions/task-history.ts";
import { SubagentTasks } from "../packages/extensions/subagent/tasks.ts";
import type { ShellExecutionFacts } from "../packages/coding-agent/src/core/tools/shell-execution.ts";

function fixture(t: test.TestContext) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sp-task-history-")));
	const session = { file: join(cwd, "session.jsonl"), id: "fixture-session", cwd };
	const owners: SubagentTasks[] = [];
	t.after(() => { for (const owner of owners) owner.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	function open(kind: "shell" | "subagent" = "subagent", capacity = 8) {
		const tasks = new SubagentTasks(capacity); owners.push(tasks); tasks.configureHistory(session, kind); return tasks;
	}
	return { cwd, session, open, path: taskHistoryPath(session.file, "subagent") };
}
function mutate(file: string, sql: string): void {
	const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); }
}

test("empty and memory-only sessions allocate no history files", t => {
	const h = fixture(t), tasks = h.open();
	assert.deepEqual(readdirSync(h.cwd), []); tasks.dispose();
	const memory = new SubagentTasks(2);
	memory.configureHistory({ ...h.session, file: undefined }, "shell");
	const task = memory.create("bash"); memory.start(task); memory.finish(task, "ok", false);
	assert.match(memory.historyStatus, /memory only/); memory.dispose();
	assert.deepEqual(readdirSync(h.cwd), []);
});

test("normal restart restores bounded text, shell facts and IDs without controllers or authority", async t => {
	const h = fixture(t), tasks = h.open("shell");
	const task = tasks.create("bash", h.cwd, "branch-a");
	tasks.start(task);
	const facts: ShellExecutionFacts = { version: 1, producer: "local-shell", started: true, executionStatus: "exited", sideEffects: "unknown",
		retryGuidance: "inspect_before_retry", cwd: h.cwd, exitCode: 2, signal: null, termination: "exit", output: { complete: true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" } };
	tasks.finish(task, "failed check", true, facts); tasks.dispose();
	const restored = h.open("shell"), record = restored.get(task.id);
	assert.equal(record.state, "failed"); assert.equal(record.recovered, true);
	assert.equal(record.result, "failed check"); assert.equal(record.cwd, h.cwd); assert.equal(record.branchId, "branch-a");
	assert.deepEqual(record.shellExecution, facts); assert.equal(record.controller, undefined);
	assert.equal(await restored.wait(record.id, 60_000), record); assert.equal(restored.waiterCount, 0);
	assert.equal(restored.cancel(record.id).state, "failed");
	assert.throws(() => restored.start(record), /cannot restart/);
	assert.equal(restored.create("bash").recovered, undefined);
});

test("a real exited writer recovers queued/running observations as interrupted and preserves known results", async t => {
	const h = fixture(t);
	const ids = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("fixtures/task-history-crash.mjs", import.meta.url)), h.session.file], { encoding: "utf8" }));
	const tasks = h.open(); assert.equal(tasks.historyError, undefined);
	for (const state of ["completed", "failed", "cancelled"]) {
		assert.equal(tasks.get(ids[state]).state, state); assert.equal(tasks.get(ids[state]).result, `terminal ${state}`);
	}
	for (const state of ["running", "queued"]) {
		const task = tasks.get(ids[state]); assert.equal(task.state, "interrupted"); assert.equal(task.controller, undefined);
		assert.match(task.result!, /side effects are unknown.*nothing was replayed/); assert.equal(task.shellExecution, undefined);
		await tasks.wait(task.id, 60_000); assert.equal(tasks.waiterCount, 0);
	}
	assert.equal(tasks.size, 5);
	tasks.dispose(); const again = h.open(); assert.equal(again.get(ids.running).state, "interrupted");
	assert.deepEqual(readdirSync(h.cwd), ["session.jsonl.tasks-subagent-v1.sqlite"], "only bounded metadata is persisted");
});

test("a concurrent runtime is denied without changing the first writer or its terminal result", t => {
	const h = fixture(t), first = h.open(), task = first.create("scout");
	first.start(task);
	const second = h.open(); assert.match(second.historyError!, /live or uninspectable runtime/);
	assert.throws(() => second.create("scout"), /New work is blocked/);
	assert.throws(() => second.get(task.id), /live or uninspectable runtime/, "missing saved IDs must report the storage failure rather than expiry");
	first.finish(task, "still owned", false); first.dispose(); second.dispose();
	const third = h.open(); assert.equal(third.get(task.id).result, "still owned");
});

test("owner identity mismatch, foreign host and corrupt version fail closed", t => {
	const h = fixture(t), first = h.open(); first.finish(first.create("scout"), "ok", false); first.dispose();
	const foreign = new TaskHistory({ ...h.session, id: "another-session" }, "subagent", 8);
	assert.throws(() => foreign.load(), /different session/); foreign.close();
	mutate(h.path, "UPDATE owner SET token='old',pid=1,host='unrelated-host'");
	const host = h.open(); assert.match(host.historyError!, /cannot be reconciled/); host.dispose();
	mutate(h.path, "PRAGMA user_version=999"); const version = h.open(); assert.match(version.historyError!, /version: 999/);
});

test("bounded completion order, reduced configuration and Unicode truncation survive restart", t => {
	const h = fixture(t), tasks = h.open("subagent", 2);
	const oldest = tasks.create("scout"), first = tasks.create("scout");
	tasks.finish(first, "first", false);
	const second = tasks.create("scout"); tasks.finish(second, "second", false);
	tasks.finish(oldest, "😀".repeat(8000), false);
	assert.equal(tasks.find(first.id), undefined); assert.ok(oldest.result!.length <= TASK_RESULT_CHARS);
	assert.equal(oldest.result!.includes("\uFFFD"), false); tasks.dispose();
	const restored = h.open("subagent", 1);
	assert.equal(restored.size, 1); assert.match(restored.get(oldest.id).result!, /truncated/);
	assert.equal(restored.find(second.id), undefined);
	const db = new DatabaseSync(h.path, { readOnly: true });
	try { assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 1); } finally { db.close(); }
});

test("terminal save failure retains the live outcome, blocks admission and recovers uncertainty", t => {
	const h = fixture(t), tasks = h.open(), task = tasks.create("scout"); tasks.start(task);
	mutate(h.path, "CREATE TRIGGER fail_save BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;");
	tasks.finish(task, "actual completed result", false);
	assert.equal(task.state, "completed"); assert.equal(task.result, "actual completed result");
	assert.match(tasks.historyStatus, /fixture disk failure.*New work is blocked/);
	assert.throws(() => tasks.create("scout"), /fixture disk failure/); tasks.dispose();
	mutate(h.path, "DROP TRIGGER fail_save");
	const resumed = h.open(); assert.equal(resumed.get(task.id).state, "interrupted", "unacknowledged completion must not become success");
});

test("admission/start failures occur before execution and release the runtime handle", t => {
	const h = fixture(t), tasks = h.open(), task = tasks.create("scout");
	mutate(h.path, "CREATE TRIGGER fail_start BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'fixture start failure'); END;");
	assert.throws(() => tasks.start(task), /fixture start failure/);
	tasks.finish(task, "did not execute", true); tasks.dispose();
	mutate(h.path, "DROP TRIGGER fail_start"); const restored = h.open(); assert.equal(restored.get(task.id).state, "interrupted");
	const other = new SubagentTasks(2); other.configureHistory({ ...h.session, file: join(h.cwd, "missing", "session.jsonl") }, "shell");
	assert.throws(() => other.create("bash"), /ENOENT/); assert.equal(other.size, 0); other.dispose();
});

test("damaged records and oversized text never become successful historical evidence", t => {
	const h = fixture(t), tasks = h.open(), task = tasks.create("scout"); tasks.finish(task, "ok", false); tasks.dispose();
	mutate(h.path, "UPDATE tasks SET result=char(0)||printf('%49000s','x')");
	const tooLarge = h.open(); assert.match(tooLarge.historyError!, /bounded schema/); assert.equal(tooLarge.size, 0); tooLarge.dispose();
	mutate(h.path, "UPDATE tasks SET result='ok',state='impossible'");
	const corrupt = h.open(); assert.match(corrupt.historyError!, /Invalid task history/); assert.equal(corrupt.size, 0);
	corrupt.dispose(); mutate(h.path, "UPDATE tasks SET completed=NULL");
	const badActive = h.open(); assert.match(badActive.historyError!, /Invalid task history/); badActive.dispose();
	const inspection = new DatabaseSync(h.path, { readOnly: true });
	try { assert.equal(inspection.prepare("SELECT state FROM tasks").get()!.state, "impossible", "recovery must not rewrite malformed state"); } finally { inspection.close(); }
	mutate(h.path, "UPDATE owner SET host=char(0)||printf('%2000s','x')");
	const badOwner = h.open(); assert.match(badOwner.historyError!, /owner exceeds its bounded schema/);
});

test("storage replacement and hard links are rejected without writing the replacement", t => {
	const h = fixture(t), tasks = h.open(), task = tasks.create("scout");
	if (process.platform === "win32") {
		assert.throws(() => renameSync(h.path, `${h.path}.original`), /EBUSY|EPERM|EACCES/, "Windows holds an exclusive file identity while SQLite is open");
		tasks.dispose(); renameSync(h.path, `${h.path}.original`);
	} else {
		renameSync(h.path, `${h.path}.original`); writeFileSync(h.path, "replacement");
		assert.throws(() => tasks.start(task), /identity changed/); tasks.dispose();
		assert.equal(readFileSync(h.path, "utf8"), "replacement");
	}
	const otherSession = { ...h.session, file: join(h.cwd, "linked.jsonl") };
	linkSync(`${h.path}.original`, taskHistoryPath(otherSession.file, "shell"));
	const linked = new TaskHistory(otherSession, "shell", 8); assert.throws(() => linked.load(), /without links/); linked.close();
});

test("separate session and provider histories do not leak across forks", t => {
	const h = fixture(t), shell = h.open("shell"), children = h.open("subagent");
	shell.finish(shell.create("bash"), "shell", false); children.finish(children.create("scout"), "child", false);
	const fork = new SubagentTasks(8); fork.configureHistory({ ...h.session, file: join(h.cwd, "fork.jsonl"), id: "fork" }, "shell");
	assert.equal(fork.size, 0); assert.equal(existsSync(taskHistoryPath(join(h.cwd, "fork.jsonl"), "shell")), false);
	fork.dispose(); shell.dispose(); children.dispose();
	assert.equal(h.open("shell").size, 1); assert.equal(h.open("subagent").size, 1);
	if (process.platform !== "win32") assert.equal(statSync(h.path).mode & 0o077, 0);
});
