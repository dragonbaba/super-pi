import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appendCheckpointTurn, assertCheckpointJson, decodeCheckpoint, encodeCheckpoint, type TaskCheckpoint } from "../packages/extensions/subagent/checkpoints.ts";
import { SubagentTasks } from "../packages/extensions/subagent/tasks.ts";
import { taskHistoryPath } from "../packages/extensions/task-history.ts";

const assistant: any = { role: "assistant", api: "test", provider: "test", model: "test", timestamp: 1, stopReason: "toolUse", content: [
	{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "file" }, backendSecret: "not-context" }], backendAuth: "not-context" };
const result = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file content" }], timestamp: 2, isError: false };
function checkpoint(): TaskCheckpoint { return { version: 1, id: "id", agent: "scout", cwd: "/fixture", device: "1", inode: "2", turns: 0, updatedAt: 1, pending: false, messages: [{ role: "user", content: "inspect", timestamp: 0 }] }; }
test("only completed, paired context is retained; hidden reasoning, credentials and backend extras are projected out", () => {
	const c = checkpoint(); appendCheckpointTurn(c, assistant, [result]);
	const encoded = encodeCheckpoint(c); const decoded = decodeCheckpoint(encoded, "id", "scout", "/fixture");
	assert.equal(decoded.turns, 1); assert.equal(decoded.messages.length, 3);
	assert.doesNotMatch(encoded, /private reasoning|backendSecret|backendAuth|not-context/);
	assert.throws(() => decodeCheckpoint(encoded, "another", "scout", "/fixture"), /identity/);
	c.messages.pop(); assert.throws(() => decodeCheckpoint(encodeCheckpoint(c), "id", "scout", "/fixture"), /unfinished tool/);
});
test("context bounds are checked before serialization and unsupported data is not silently truncated", () => {
	for (const value of [[], {}, { empty: [], text: '😀\n"\\\uD800', flag: false }, [1, null, true, []]]) {
		const bytes = Buffer.byteLength(JSON.stringify(value));
		assert.doesNotThrow(() => assertCheckpointJson(value, bytes));
		assert.throws(() => assertCheckpointJson(value, bytes - 1), /exceeds/);
	}
	assert.throws(() => assertCheckpointJson({ text: "😀".repeat(300000) }), /exceeds/);
	let deep: any = {}; for (let i = 0; i < 40; i++) deep = { deep }; assert.throws(() => assertCheckpointJson(deep), /depth/);
	const c = checkpoint(); c.messages = new Array(128).fill(c.messages[0]);
	assert.throws(() => appendCheckpointTurn(c, assistant, [result]), /128 messages/);
	assert.throws(() => appendCheckpointTurn(checkpoint(), { ...assistant, content: [{ type: "image", data: "x" }] }, []), /unsupported content/);
});
test("checkpoint migrates v1 storage, survives interrupted recovery, and leaves original identity terminal", t => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sp-checkpoint-")));
	const session = { file: join(cwd, "session.jsonl"), id: "checkpoint", cwd };
	const owners: SubagentTasks[] = [];
	t.after(() => { for (const owner of owners) owner.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	const tasks = new SubagentTasks(2); owners.push(tasks); tasks.configureHistory(session, "subagent");
	const record = tasks.create("scout", cwd); tasks.dispose();
	const path = taskHistoryPath(session.file, "subagent"), db = new DatabaseSync(path);
	try { db.exec("ALTER TABLE tasks DROP COLUMN checkpoint; PRAGMA user_version=1;"); } finally { db.close(); }
	const current = new SubagentTasks(2); owners.push(current); current.configureHistory(session, "subagent");
	assert.equal(current.get(record.id).state, "interrupted");
	const fresh = current.create("scout", cwd); current.start(fresh);
	const identity = statSync(cwd, { bigint: true });
	const c = { ...checkpoint(), id: fresh.id, cwd, device: String(identity.dev), inode: String(identity.ino) };
	appendCheckpointTurn(c, assistant, [result]); current.saveCheckpoint(c);
	c.pending = true; current.saveCheckpoint(c); current.dispose();
	const restored = new SubagentTasks(2); owners.push(restored); restored.configureHistory(session, "subagent");
	assert.equal(restored.get(fresh.id).state, "interrupted"); assert.equal(restored.get(fresh.id).checkpointAvailable, true);
	assert.deepEqual(restored.readCheckpoint(fresh.id), decodeCheckpoint(encodeCheckpoint(c), fresh.id, "scout", cwd));
	const next = restored.create("scout", cwd); assert.notEqual(next.id, fresh.id);
	const oversized = { ...c, id: next.id, messages: new Array(129).fill(c.messages[0]) };
	assert.throws(() => restored.saveCheckpoint(oversized), /128 messages/); assert.equal(restored.historyError, undefined);
	restored.finish(next, "done", false);
	const last = restored.create("scout", cwd); restored.finish(last, "done", false);
	assert.throws(() => restored.readCheckpoint(fresh.id), /expired/);
});
