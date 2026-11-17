import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { alphaSession } from "./helpers/alpha-session.ts";
import { epochAssistant } from "./helpers/compaction-epoch-fixture.ts";
import { isLocalCompactionMaintenance } from "../packages/coding-agent/src/core/compaction/normalize-checkpoint.ts";

for (const explicitTail of [false, true]) test(`resume restores archived branch and summaries without duplicate tail, explicit=${explicitTail}`, async t => {
	const owned = createOwnedTaskFixture("resume-compacted-history-");
	const manager = SessionManager.create(owned.root, join(owned.root, "sessions"));
	const first = manager.appendMessage({ role: "user", content: "ORIGINAL_USER_VISIBLE", timestamp: 1 });
	const old = epochAssistant(100, 2); old.content = [{ type: "text", text: "ORIGINAL_ASSISTANT_VISIBLE" }]; manager.appendMessage(old);
	const kept = manager.appendMessage({ role: "user", content: "RETAINED_ONCE_VISIBLE", timestamp: 3 });
	manager.appendCompaction("SUMMARY_ONE_VISIBLE", kept, 100, {}, false, undefined,
		explicitTail ? [{ role: "user", content: "RETAINED_ONCE_VISIBLE", timestamp: 3 }] : undefined);
	const current = manager.appendMessage({ role: "user", content: "BETWEEN_CHECKPOINTS_VISIBLE", timestamp: 4 });
	manager.appendCompaction("SUMMARY_TWO_VISIBLE", current, 200, {}, false, undefined,
		explicitTail ? [{ role: "user", content: "BETWEEN_CHECKPOINTS_VISIBLE", timestamp: 4 }] : undefined);
	const selected = manager.getLeafId()!;
	manager.branch(first); manager.appendMessage({ role: "user", content: "OTHER_BRANCH_HIDDEN", timestamp: 5 });
	manager.branch(selected); manager.appendMessage({ role: "user", content: "AFTER_COMPACTION_VISIBLE", timestamp: 6 });
	const restored = SessionManager.open(manager.getSessionFile()!, join(owned.root, "sessions"));
	assert.equal(restored.getSessionId(), manager.getSessionId());
	const f = await alphaSession({ fixtureRoot: owned.root, sessionManager: restored, g2: false,
		settings: { compaction: { enabled: false }, showCacheMissNotices: false } });
	t.after(async () => { try { await f.release(); } finally { owned.cleanup(); } });
	f.internal.toolOutputExpanded = true;
	const modelBefore = JSON.stringify(f.session.messages), journalBefore = JSON.stringify(restored.getEntries());
	assert.doesNotMatch(modelBefore, /ORIGINAL_USER_VISIBLE|ORIGINAL_ASSISTANT_VISIBLE|OTHER_BRANCH_HIDDEN/);
	const wireBefore = JSON.stringify(await f.session.agent.convertToLlm(f.session.messages));
	for (const phase of ["initial", "rebuild"]) {
		if (phase === "initial") f.mode.renderInitialMessages(); else f.internal.rebuildChatFromMessages();
		const text = f.internal.chatContainer.render(100).join("\n");
		for (const marker of ["ORIGINAL_USER_VISIBLE", "ORIGINAL_ASSISTANT_VISIBLE", "RETAINED_ONCE_VISIBLE", "BETWEEN_CHECKPOINTS_VISIBLE", "AFTER_COMPACTION_VISIBLE", "SUMMARY_ONE_VISIBLE", "SUMMARY_TWO_VISIBLE"])
			assert.equal(text.split(marker).length - 1, 1, `${phase}: ${marker} must appear once`);
		assert.doesNotMatch(text, /OTHER_BRANCH_HIDDEN/);
		assert.equal(JSON.stringify(f.session.messages), modelBefore);
		assert.equal(JSON.stringify(restored.getEntries()), journalBefore);
		assert.equal(JSON.stringify(await f.session.agent.convertToLlm(f.session.messages)), wireBefore);
	}
});

test("SDK maintenance on terminal resume keeps the original transcript visible and source out of model context", async t => {
	const owned = createOwnedTaskFixture("resume-maintained-history-");
	const manager = SessionManager.create(owned.root, join(owned.root, "sessions"));
	manager.appendMessage({ role: "user", content: "BEFORE_MAINTENANCE_VISIBLE", timestamp: 1 });
	const call = epochAssistant(100, 2); call.stopReason = "toolUse";
	call.content = [{ type: "toolCall", id: "historical-failed-script", name: "codemode", arguments: { code: "x".repeat(513) } }];
	const kept = manager.appendMessage(call);
	const outcome = { role: "toolResult" as const, toolCallId: "historical-failed-script", toolName: "codemode", isError: true,
		content: [{ type: "text" as const, text: "ARCHIVED_FAILURE_OUTCOME" }], timestamp: 3 };
	manager.appendMessage(outcome);
	manager.appendCompaction("MAINTAINED_SUMMARY_VISIBLE", kept, 100, {}, true, undefined, [call, outcome]);
	const restored = SessionManager.open(manager.getSessionFile()!, join(owned.root, "sessions"));
	const f = await alphaSession({ fixtureRoot: owned.root, sessionManager: restored, g2: false,
		settings: { compaction: { enabled: false, keepRecentTokens: 128 }, showCacheMissNotices: false } });
	t.after(async () => { try { await f.release(); } finally { owned.cleanup(); } });
	assert.ok(restored.getEntries().some(entry => entry.type === "compaction" && (entry.details as any)?.contextMaintenance));
	const before = JSON.stringify(f.session.messages), journal = JSON.stringify(restored.getEntries());
	assert.doesNotMatch(before, /x{500}|BEFORE_MAINTENANCE_VISIBLE/);
	f.internal.toolOutputExpanded = true;
	f.mode.renderInitialMessages();
	const text = f.internal.chatContainer.render(100).join("\n");
	assert.match(text, /BEFORE_MAINTENANCE_VISIBLE/);
	assert.equal(text.split("MAINTAINED_SUMMARY_VISIBLE").length - 1, 1);
	assert.match(text, /Session compacted 1 time/);
	assert.equal(JSON.stringify(f.session.messages), before);
	assert.equal(JSON.stringify(restored.getEntries()), journal);
});

test("successful length-recovery settlement reuses the visible summary after disk restore", async t => {
	const owned = createOwnedTaskFixture("resume-length-settlement-");
	const manager = SessionManager.create(owned.root, join(owned.root, "sessions"));
	manager.appendMessage({ role: "user", content: "LENGTH_RECOVERY_ORIGINAL_VISIBLE", timestamp: 1 });
	const truncated = epochAssistant(100, 2); truncated.stopReason = "length";
	const abandoned = manager.appendMessage(truncated);
	const checkpointId = manager.appendCompaction("LENGTH_SUMMARY_VISIBLE", abandoned, 100, {}, true, undefined, [truncated]);
	const f = await alphaSession({ fixtureRoot: owned.root, sessionManager: SessionManager.open(manager.getSessionFile()!), g2: false,
		settings: { compaction: { enabled: false }, showCacheMissNotices: false } });
	t.after(async () => { try { await f.release(); } finally { owned.cleanup(); } });
	const summary = f.session.messages[0]; assert.equal(summary.role, "compactionSummary");
	const response = epochAssistant(200, Date.now()); response.content = [{ type: "text", text: "LENGTH_RECOVERY_COMPLETED_VISIBLE" }];
	f.sessionManager.appendMessage(response); f.session.agent.state.messages = [summary, response];
	const internal = f.session as any;
	internal._pendingLengthRecovery = { sessionId: f.session.sessionId, compactionId: checkpointId, abandonedEntryId: abandoned };
	internal._settleLengthRecovery(true);
	const reopened = SessionManager.open(manager.getSessionFile()!);
	assert.equal(reopened.getEntries().filter(isLocalCompactionMaintenance).length, 1);
	f.internal.toolOutputExpanded = true; f.mode.renderInitialMessages();
	const text = f.internal.chatContainer.render(100).join("\n");
	assert.equal(text.split("LENGTH_SUMMARY_VISIBLE").length - 1, 1);
	assert.match(text, /LENGTH_RECOVERY_ORIGINAL_VISIBLE/);
	assert.match(text, /LENGTH_RECOVERY_COMPLETED_VISIBLE/);
	assert.match(text, /Session compacted 1 time/);
});
