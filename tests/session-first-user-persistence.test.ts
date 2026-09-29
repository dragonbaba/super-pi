import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }], api: "openai-responses", provider: "fixture", model: "fixture", usage, stopReason: "stop" as const, timestamp: 2 };

function withDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "session-first-user-"));
	try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const lines = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));

test("setup-only sessions leave no file behind", () => withDir(dir => {
	const manager = SessionManager.create(dir, dir);
	manager.appendModelChange("fixture", "fixture");
	manager.appendThinkingLevelChange("high");
	assert.equal(existsSync(manager.getSessionFile()!), false);
}));

// The prompt must survive a first turn that never completes (crash, kill, provider failure).
test("first user message persists the session before any assistant reply", () => withDir(dir => {
	const manager = SessionManager.create(dir, dir);
	manager.appendModelChange("fixture", "fixture");
	manager.appendMessage(user("first prompt"));
	const file = manager.getSessionFile()!;
	assert.deepEqual(lines(file).map(entry => entry.type), ["session", "model_change", "message"]);
	manager.appendMessage(assistant);
	manager.appendMessage(user("second"));
	assert.deepEqual(lines(file).map(entry => entry.message?.role ?? entry.type), ["session", "model_change", "user", "assistant", "user"]);
	const reopened = SessionManager.open(file, dir);
	assert.deepEqual(reopened.getEntries().map(entry => entry.id), manager.getEntries().map(entry => entry.id));
}));

test("a branch whose path only has a user message is written like a new conversation", () => withDir(dir => {
	const manager = SessionManager.create(dir, dir);
	const firstId = manager.appendMessage(user("branch point"));
	manager.appendMessage(assistant);
	const branchFile = manager.createBranchedSession(firstId)!;
	assert.deepEqual(lines(branchFile).map(entry => entry.message?.role ?? entry.type), ["session", "user"]);
	manager.appendMessage(assistant);
	assert.deepEqual(lines(branchFile).map(entry => entry.message?.role ?? entry.type), ["session", "user", "assistant"]);
}));
