import assert from "node:assert/strict";
import { test } from "node:test";
import { autoCompactionSettingKey, getAutoCompactionThreshold } from "../packages/agent/src/compaction-policy.ts";
import { shouldCompact as harnessShouldCompact } from "../packages/agent/src/harness/compaction/compaction.ts";
import { shouldCompact, prepareToolResultPruneCheckpoint } from "../packages/coding-agent/src/core/compaction/compaction.ts";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { parseAutoCompactionPercentage, formatAutoCompactionStatus } from "../packages/coding-agent/src/core/auto-compaction-status.ts";
import { AutoCompactionPercentageSubmenu } from "../packages/coding-agent/src/modes/interactive/components/settings-selector.ts";
import { exceedsAutoCompactionThreshold } from "../packages/statusline/src/context-usage.ts";
import { compactionEpochFixture, epochAssistant, EPOCH_MODEL } from "./helpers/compaction-epoch-fixture.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";

function storage(global: object = {}, project: object = {}): SettingsStorage {
	const contents: Record<SettingsScope, string> = { global: JSON.stringify(global), project: JSON.stringify(project) };
	return { withLock(scope, callback) { const next = callback(contents[scope]); if (next !== undefined) contents[scope] = next; } };
}

test("shared occupancy policy defaults to 85 and triggers inclusively without subtracting reserves", () => {
	for (const window of [131072, 337673, 500000]) {
		for (const percentage of [70, 85, 90, 100]) {
			const threshold = Math.floor(window * percentage / 100);
			assert.equal(getAutoCompactionThreshold(window, percentage), threshold);
			for (const reserveTokens of [0, 16384, window - 1]) {
				const settings = { enabled: true, keepRecentTokens: 128, reserveTokens, autoCompactPercentage: percentage };
				for (const check of [shouldCompact, harnessShouldCompact]) {
					assert.equal(check(threshold - 1, window, settings), false);
					assert.equal(check(threshold, window, settings), true);
					assert.equal(check(threshold + 1, window, settings), true);
					assert.equal(check(threshold, window, { ...settings, enabled: false }), false);
				}
			}
		}
	}
	assert.equal(getAutoCompactionThreshold(500000), 425000);
});

test("percentages survive switches, reload and concurrent saves for exact provider/model pairs", async () => {
	const backing = storage(), first = SettingsManager.fromStorage(backing), second = SettingsManager.fromStorage(backing);
	assert.equal(first.getAutoCompactionPercentage("a", "same"), 85);
	await Promise.all([first.setAutoCompactionPercentage("a", "same", 70), second.setAutoCompactionPercentage("b", "same", 90)]);
	await first.reload(); await second.reload();
	await Promise.all([first.setAutoCompactionPercentage("a", "other", 80), second.setAutoCompactionPercentage("a", "third", 95)]);
	const restarted = SettingsManager.fromStorage(backing);
	for (const [provider, id, expected] of [["a", "same", 70], ["b", "same", 90], ["a", "other", 80], ["a", "third", 95], ["new", "same", 85]] as const) {
		assert.equal(restarted.getAutoCompactionPercentage(provider, id), expected);
		assert.equal(restarted.getCompactionSettings({ provider, id }).autoCompactPercentage, expected);
	}
	assert.notEqual(autoCompactionSettingKey("a/b", "c"), autoCompactionSettingKey("a", "b/c"));
	for (const value of [0, -1, 101, Infinity, NaN]) assert.throws(() => restarted.setAutoCompactionPercentage("a", "same", value));
	assert.equal(restarted.getAutoCompactionPercentage("a", "same"), 70);
});

test("percentage parsing and settings text entry accept custom values and preserve cancel/invalid input", () => {
	for (const [input, expected] of [["85%", 85], ["70", 70], [" 90 % ", 90], ["85.5%", 85.5], ["status", "status"], ["", "status"]] as const) assert.equal(parseAutoCompactionPercentage(input), expected);
	for (const value of ["0", "101%", "NaN", "85% x", "85%%", "1e2", "500k"]) assert.throws(() => parseAutoCompactionPercentage(value));
	const values: (string | undefined)[] = [];
	const submenu = new AutoCompactionPercentageSubmenu("", value => values.push(value));
	submenu.handleInput("101%"); submenu.handleInput("\r"); assert.equal(values.length, 0);
	submenu.handleInput("\x15"); submenu.handleInput("87.5%"); submenu.handleInput("\r"); assert.equal(values[0], "87.5%");
	new AutoCompactionPercentageSubmenu("85%", value => values.push(value)).handleInput("\x1b");
	assert.deepEqual(values, ["87.5%", undefined]);
	const prefilled = new AutoCompactionPercentageSubmenu("85%", value => values.push(value));
	prefilled.handleInput("\x15"); prefilled.handleInput("72%"); prefilled.handleInput("\r");
	assert.equal(values.at(-1), "72%");
	assert.match(formatAutoCompactionStatus("p", "m", 500000, 85, false), /disabled.*85%.*425000 \/ 500000/);
});

test("project files cannot reset the saved global pair and write failure is observable", async () => {
	const key = autoCompactionSettingKey("p", "m");
	const manager = SettingsManager.fromStorage(storage({ modelAutoCompactionPercentages: { [key]: 70 } }, { modelAutoCompactionPercentages: { [key]: 99 } }));
	assert.equal(manager.getAutoCompactionPercentage("p", "m"), 70);
	await manager.setAutoCompactionPercentage("p", "m", 90);
	await manager.reload();
	assert.equal(manager.getAutoCompactionPercentage("p", "m"), 90);
	const failure = new Error("fixture settings write failed");
	const broken = SettingsManager.fromStorage({ withLock(_scope, callback) { if (callback("{}") !== undefined) throw failure; } });
	assert.equal((await broken.setAutoCompactionPercentage("p", "m", 70))?.error, failure);
});

test("production command saves the current pair without changing enabled state or tool prefix", async t => {
	const f = await compactionEpochFixture(); t.after(() => f.release());
	const messages: string[] = [], errors: string[] = [];
	t.mock.method(f.internal, "showStatus", (text: string) => messages.push(text));
	t.mock.method(f.internal, "showError", (text: string) => errors.push(text));
	const prompt = f.session.agent.state.systemPrompt, tools = JSON.stringify(f.session.agent.state.tools);
	f.session.setAutoCompactionEnabled(false);
	await f.internal.handleAutoCompactionCommand("70%");
	assert.equal(f.session.autoCompactionEnabled, false);
	assert.equal(f.session.getContextUsage()!.autoCompactionThreshold, 350000);
	f.session.agent.state.model = { ...EPOCH_MODEL, provider: "other-provider", contextWindow: 200000 };
	assert.equal(f.session.getContextUsage()!.autoCompactionThreshold, 170000);
	await f.internal.handleAutoCompactionCommand("90");
	f.session.agent.state.model = EPOCH_MODEL;
	await f.session.settingsManager.reload();
	await f.internal.handleAutoCompactionCommand("status");
	assert.match(messages.at(-1)!, /70%.*350000 \/ 500000/);
	await f.internal.handleAutoCompactionCommand("101%");
	assert.equal(errors.length, 1);
	assert.equal(f.session.getContextUsage()!.autoCompactionPercentage, 70);
	assert.doesNotMatch(f.internal.footer.render(160).join("\n"), /\(auto/);
	f.session.setAutoCompactionEnabled(true);
	assert.match(f.internal.footer.render(160).join("\n"), /\(auto 70%\)/);
	f.session.agent.state.model = { ...EPOCH_MODEL, contextWindow: 750000 };
	assert.equal(f.session.getContextUsage()!.autoCompactionThreshold, 525000, "capacity refresh does not rewrite the saved percentage");
	assert.equal(f.session.getContextUsage()!.autoCompactionPercentage, 70);
	assert.equal(f.session.agent.state.systemPrompt, prompt);
	assert.equal(JSON.stringify(f.session.agent.state.tools), tools);
	const statuses = messages.length;
	t.mock.method(f.session.settingsManager, "setAutoCompactionPercentage", async () => ({ scope: "global", error: new Error("settings write failed") }));
	await f.internal.handleAutoCompactionCommand("80%");
	assert.match(errors.at(-1)!, /settings write failed/);
	assert.equal(messages.length, statuses, "failed persistence cannot report a successful setting change");
});

test("statusline consumes the engine threshold and respects disabled or uncommitted boundaries", () => {
	const usage = { tokens: 425000, contextWindow: 500000, percent: 85, autoCompactionThreshold: 425000, autoCompactionEnabled: true };
	assert.equal(exceedsAutoCompactionThreshold(usage), true);
	assert.equal(exceedsAutoCompactionThreshold({ ...usage, tokens: 424999 }), false);
	assert.equal(exceedsAutoCompactionThreshold({ ...usage, autoCompactionEnabled: false }), false);
	assert.equal(exceedsAutoCompactionThreshold({ ...usage, automaticCompactionBlocked: "paid-boundary-uncommitted" }), false);
	assert.equal(exceedsAutoCompactionThreshold({ tokens: 490000, contextWindow: 500000, percent: 98 }), false, "older host has no policy to infer");
});

test("engine compacts at the saved threshold and records the same policy", async t => {
	let summaries = 0;
	const f = await compactionEpochFixture({ extensions: [(pi: ExtensionAPI) => { pi.on("session_before_compact", event => {
		summaries++; return { compaction: { summary: "percentage checkpoint", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	}); }] });
	t.after(() => f.release());
	await f.session.setAutoCompactionPercentage(70);
	await f.session.bindExtensions({});
	f.sessionManager.appendMessage({ role: "user", content: "continue the current task", timestamp: 2 });
	const events: unknown[] = [];
	f.session.subscribe(event => { if (event.type === "compaction_end") events.push(event); });
	for (const tokens of [349999, 350000]) {
		const current = epochAssistant(tokens, Date.now() + tokens);
		f.sessionManager.appendMessage(current); f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
		const usage = f.session.getContextUsage();
		assert.equal(await (f.session as any)._checkCompaction(current), false, "no continuation is needed without queued messages");
		assert.equal(summaries, tokens === 350000 ? 1 : 0, JSON.stringify({ usage, summaries, events }));
	}
	assert.equal(summaries, 1);
	const checkpoint = f.sessionManager.getBranch().filter(entry => entry.type === "compaction").at(-1);
	assert.equal((checkpoint as any).details.contextAccounting.thresholdTokens, 350000);
	assert.equal((checkpoint as any).details.contextAccounting.autoCompactPercentage, 70);
});

test("a materialized checkpoint already at the inclusive threshold does not compact in a loop", async t => {
	const f = await compactionEpochFixture(); t.after(() => f.release());
	let starts = 0;
	f.session.subscribe(event => { if (event.type === "compaction_start") starts++; });
	const retained = epochAssistant(0, 3);
	retained.content = [{ type: "text", text: "x".repeat(1800000) }];
	const kept = f.sessionManager.appendMessage(retained);
	f.sessionManager.appendCompaction("large checkpoint", kept, 490000, { contextAccounting: { schemaVersion: 1, materializedTokensAfter: 425000 } }, true, undefined, [retained]);
	f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
	assert.ok(f.session.getContextUsage()!.tokens! >= 425000);
	assert.equal(await (f.session as any)._checkCompaction(retained), false);
	assert.equal(starts, 0);
});

test("pruning feasibility uses occupancy percentage independently of summary reserves", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	manager.appendMessage({ ...epochAssistant(0, 2), content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }], stopReason: "toolUse" });
	manager.appendMessage({ role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "x".repeat(65536) }], isError: false, timestamp: 3 });
	manager.appendMessage({ role: "user", content: "recent one", timestamp: 4 });
	manager.appendMessage({ role: "user", content: "recent two", timestamp: 5 });
	const settings = { enabled: true, reserveTokens: 1, keepRecentTokens: 128, autoCompactPercentage: 50 };
	assert.ok(prepareToolResultPruneCheckpoint(manager.getBranch(), 60000, 100000, settings));
	assert.ok(prepareToolResultPruneCheckpoint(manager.getBranch(), 60000, 100000, { ...settings, reserveTokens: 90000 }));
	assert.equal(prepareToolResultPruneCheckpoint(manager.getBranch(), 60000, 100000, { ...settings, autoCompactPercentage: 40 }), undefined);
});
