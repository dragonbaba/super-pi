import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentMessage } from "../packages/agent/src/types.ts";
import type { AssistantMessage, ToolResultMessage } from "../packages/ai/src/types.ts";
import { condenseFailedCodemodeAttempts } from "../packages/coding-agent/src/core/compaction/failed-attempts.ts";
import { normalizeUnconsumedCompaction } from "../packages/coding-agent/src/core/compaction/normalize-checkpoint.ts";
import { SessionManager, buildSessionContext } from "../packages/coding-agent/src/core/session-manager.ts";
import { getUsageCostBreakdown } from "../packages/coding-agent/src/core/usage-totals.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { epochAssistant } from "./helpers/compaction-epoch-fixture.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

function pair(): [AssistantMessage, ToolResultMessage] {
	const call = epochAssistant(512307, 1);
	call.content = [{ type: "toolCall", id: "failed-script", name: "codemode", arguments: { code: "x".repeat(191310) } }]; call.stopReason = "toolUse";
	return [call, { role: "toolResult", toolCallId: "failed-script", toolName: "codemode", content: [{ type: "text", text: "Script failed; write completed once, then read failed. Do not replay the write." }],
		isError: true, timestamp: 2, details: { codemode: { scriptOk: false, calls: [{ toolName: "write", isError: false, ref: "effect-one" }, { toolName: "read", isError: true }] } } }];
}

test("completed failed oversized source folds at compaction without losing outcomes or changing raw records", () => {
	const messages = pair(), original = JSON.stringify(messages), reduced = condenseFailedCodemodeAttempts(messages, 20000);
	assert.equal(reduced.length, 1); assert.equal(reduced[0].role, "custom");
	assert.match(JSON.stringify(convertToLlm(reduced)), /write completed once/);
	assert.doesNotMatch(JSON.stringify(reduced), /x{1000}/);
	assert.equal((reduced[0] as any).details.outcome, (messages[1] as any).details);
	assert.equal(JSON.stringify(messages), original);
	assert.equal(condenseFailedCodemodeAttempts(reduced, 20000), reduced);
	assert.equal(condenseFailedCodemodeAttempts(messages, 0).length, 1, "zero retention still removes completed failed source at the boundary");
});

test("pending, successful, mismatched and mixed tool batches keep their complete source and pairing", () => {
	for (const mode of ["pending", "success", "mismatch", "mixed", "within-budget"] as const) {
		const messages = pair();
		if (mode === "pending") messages.pop();
		if (mode === "success") (messages[1] as any).isError = false;
		if (mode === "mismatch") (messages[1] as any).toolCallId = "other";
		if (mode === "mixed") (messages[0] as any).content.push({ type: "toolCall", id: "other", name: "ask_user", arguments: {} });
		assert.equal(condenseFailedCodemodeAttempts(messages, mode === "within-budget" ? 100000 : 20000), messages);
	}
});

function checkpoint(cwd?: string) {
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "user", content: "original task", timestamp: 0 });
	const messages = pair(), kept = manager.appendMessage(messages[0]); manager.appendMessage(messages[1]);
	const remoteCompaction = { version: 2, replacementHistory: [{ type: "message", role: "user", content: "original task" }, { type: "compaction", encrypted_content: "opaque-fixture" }] };
	manager.appendCompaction("original summary", kept, 512568, { remoteCompaction, contextAccounting: { schemaVersion: 1, materializedTokensAfter: 70807 }, usageComponents: { remoteCompaction: messages[0].role === "assistant" ? messages[0].usage : undefined } }, true,
		messages[0].role === "assistant" ? messages[0].usage : undefined, messages);
	return manager;
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

test("unconsumed legacy checkpoint gets durable local maintenance with identical native history and billing", () => {
	const manager = checkpoint(), old = manager.getLeafEntry()!, raw = JSON.stringify(old), totals = getUsageCostBreakdown(manager.getEntries());
	const nativeHash = hash((old as any).details.remoteCompaction);
	assert.equal(normalizeUnconsumedCompaction(manager, 20000), true);
	const current = manager.getLeafEntry() as any;
	assert.notEqual(current.id, old.id); assert.equal(current.usage, undefined);
	assert.equal(hash(current.details.remoteCompaction), nativeHash);
	assert.equal(JSON.stringify(old), raw);
	assert.deepEqual(getUsageCostBreakdown(manager.getEntries()), totals);
	assert.ok(current.details.contextAccounting.materializedTokensAfter < 1000);
	assert.equal(normalizeUnconsumedCompaction(manager, 20000), false);
	manager.appendMessage(epochAssistant(1000, Date.now() + 1000));
	const restored = buildSessionContext(JSON.parse(JSON.stringify(manager.getEntries()))).messages;
	assert.doesNotMatch(JSON.stringify(restored), /x{1000}/, "source cannot reappear after the next response/reload");
});

test("consumed checkpoints keep established request history until another compaction boundary", () => {
	const manager = checkpoint(); manager.appendMessage(epochAssistant(1000, Date.now() + 1000));
	const before = JSON.stringify(manager.getEntries());
	assert.equal(normalizeUnconsumedCompaction(manager, 20000), false);
	assert.equal(JSON.stringify(manager.getEntries()), before);
});

test("failed local maintenance leaves the old checkpoint intact", t => {
	const manager = checkpoint(), before = JSON.stringify(manager.getEntries());
	t.mock.method(manager, "appendCompaction", () => { throw new Error("fixture journal write failed"); });
	assert.throws(() => normalizeUnconsumedCompaction(manager, 20000), /journal write failed/);
	assert.equal(JSON.stringify(manager.getEntries()), before);
});

test("SDK restore publishes the durable reduced checkpoint before exposing model history", async t => {
	const resources = createOwnedTaskFixture("compaction-restore-");
	const manager = checkpoint(resources.root), settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 20000 } });
	const loader = new DefaultResourceLoader({ cwd: resources.root, agentDir: resources.root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
	await loader.reload();
	const before = manager.getLeafId();
	const { session } = await createAgentSession({ cwd: resources.root, agentDir: resources.root, sessionManager: manager,
		settingsManager: settings, resourceLoader: loader, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), noTools: "all" });
	t.after(async () => { try { session.dispose(); await session.waitForSessionLeaseRelease(); } finally { resources.cleanup(); } });
	assert.notEqual(manager.getLeafId(), before);
	assert.doesNotMatch(JSON.stringify(session.messages), /x{1000}/);
	assert.match(JSON.stringify(session.messages), /write completed once/);
	const maintenance = manager.getEntries().find(entry => entry.type === "compaction" && (entry.details as any)?.contextMaintenance);
	assert.equal((maintenance as any).details.contextMaintenance.kind, "completed-failed-codemode-source");
});
