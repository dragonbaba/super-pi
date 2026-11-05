import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FooterComponent } from "../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { CacheOverlapCursor, detectCacheOverlapEstimate } from "../packages/coding-agent/src/core/cache-stats.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

initTheme("dark");
function message(input = 20_000, cacheRead = 20_000): AssistantMessage {
	return { role: "assistant", provider: "fixture", model: "fixture", api: "openai-responses", content: [], stopReason: "stop", timestamp: 0,
		usage: { input, cacheRead, cacheWrite: 0, output: 1, totalTokens: input + cacheRead + 1,
			cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } } };
}
function fixture(history = 1000) {
	const manager = SessionManager.inMemory(process.cwd());
	for (let i = 0; i < history; i++) manager.appendMessage(message());
	const settings = { getShowCacheMissNotices() { return true; } };
	const session = { sessionManager: manager, settingsManager: settings,
		state: { model: { id: "fixture", provider: "fixture", contextWindow: 100_000 }, thinkingLevel: "off" },
		getContextUsage() { return undefined; }, modelRuntime: { isUsingSubscription() { return false; } } };
	const statuses = new Map();
	const footer = new FooterComponent(session as any, { getGitBranch() {}, getAvailableProviderCount() { return 1; }, getExtensionStatuses() { return statuses; } } as any);
	const notices: number[] = [];
	const mode = Object.assign(Object.create(InteractiveMode.prototype), { runtimeHost: { session },
		addCacheOverlapNotice(value: { uncachedOverlapUpperBound: number }) { notices.push(value.uncachedOverlapUpperBound); } });
	return { manager, settings, footer, mode, notices };
}

test("warm footer appends and renames do not copy the historical entries", t => {
	const f = fixture(); t.after(() => f.footer.dispose());
	f.footer.render(200);
	let copies = 0;
	const original = f.manager.getEntries.bind(f.manager);
	t.mock.method(f.manager, "getEntries", () => { copies++; return original(); });
	f.manager.appendMessage(message()); f.manager.appendSessionInfo("latest fixture");
	assert.ok(f.footer.render(200).join("\n").includes("latest fixture"));
	assert.equal(copies, 0);
});

test("warm optional estimates process ordinary append without copying the historical entries", t => {
	const f = fixture(); t.after(() => f.footer.dispose());
	const first = message(); f.mode.maybeShowCacheMissNotice(first); f.manager.appendMessage(first);
	let copies = 0;
	const original = f.manager.getEntries.bind(f.manager);
	t.mock.method(f.manager, "getEntries", () => { copies++; return original(); });
	f.mode.maybeShowCacheMissNotice(message());
	assert.deepEqual(f.notices, [20_000, 20_000]);
	assert.equal(copies, 0);
});

test("repeated completion identity does not add duplicate estimates before or after persistence", t => {
	const f = fixture(); t.after(() => f.footer.dispose());
	const current = message();
	f.mode.maybeShowCacheMissNotice(current); f.mode.maybeShowCacheMissNotice(current);
	f.manager.appendMessage(current); f.mode.maybeShowCacheMissNotice(current);
	assert.deepEqual(f.notices, [20_000]);
});

test("incremental preview matches the full active-branch oracle across usage and context boundaries", () => {
	const manager = SessionManager.inMemory(process.cwd()), cursor = new CacheOverlapCursor();
	const forks: string[] = [];
	try {
		for (let i = 0; i < 120; i++) {
			if (i === 17 || i === 38) manager.branch(forks[2]!);
			if (i === 29) manager.resetLeaf();
			if (i === 52) manager.appendCompaction("fixture", manager.getLeafId()!, 100);
			if (i === 65) manager.branchWithSummary(forks[4]!, "fixture");
			if (i === 80) manager.newSession();
			manager.appendMessage({ role: "user", content: "fixture", timestamp: i });
			const current = message(i % 5 === 0 ? 0 : 30_000, i % 3 === 0 ? 10_000 : 0);
			if (i % 13 === 0) current.usage.cacheWrite = 10_000;
			if (i % 7 === 0) current.stopReason = "error";
			if (i % 11 === 0) current.provider = "other";
			if (i % 19 === 0) current.model = "other";
			if (i % 23 === 0) current.api = "anthropic-messages";
			if (i % 31 === 0) current.usage.input = NaN;
			assert.deepEqual(cursor.estimate(manager, current), detectCacheOverlapEstimate(manager.getBranch(), current), `turn ${i}`);
			assert.equal(cursor.estimate(manager, current), undefined, "duplicate preview");
			forks.push(manager.appendMessage(current));
			assert.equal(cursor.estimate(manager, current), undefined, "duplicate persisted completion");
		}
	} finally { cursor.clear(); }
});

test("branch estimates use the selected ancestor rather than the last off-branch response", () => {
	const manager = SessionManager.inMemory(process.cwd()), cursor = new CacheOverlapCursor();
	const first = manager.appendMessage(message(0, 10_000));
	manager.appendMessage(message(90_000));
	assert.deepEqual(cursor.estimate(manager, message(80_000)), { uncachedOverlapUpperBound: 80_000 });
	manager.branch(first);
	assert.deepEqual(cursor.estimate(manager, message(80_000)), { uncachedOverlapUpperBound: 10_000 });
	manager.resetLeaf(); assert.equal(cursor.estimate(manager, message(80_000)), undefined);
	cursor.clear();
});

test("disabled estimates do not allocate or scan; the settings-change boundary releases an existing cursor", t => {
	const f = fixture(); t.after(() => f.footer.dispose());
	let shown = false;
	f.settings.getShowCacheMissNotices = () => shown;
	t.mock.method(f.manager, "getBranch", () => { throw new Error("disabled scan"); });
	t.mock.method(f.manager, "visitAppendedEntries", () => { throw new Error("disabled tail scan"); });
	f.mode.maybeShowCacheMissNotice(message()); assert.equal(f.mode.cacheOverlapCursor, undefined);
	t.mock.restoreAll();
	shown = true;
	f.mode.maybeShowCacheMissNotice(message()); const retained = f.mode.cacheOverlapCursor;
	assert.ok(retained);
	(f.settings as any).setShowCacheMissNotices = (value: boolean) => { shown = value; };
	let rebuilds = 0;
	f.mode.rebuildChatFromMessages = () => { rebuilds++; assert.equal(f.mode.cacheOverlapCursor, undefined); };
	f.mode.setCacheOverlapNotices(false);
	f.mode.maybeShowCacheMissNotice(message());
	assert.equal(rebuilds, 1); assert.equal(shown, false);
	assert.equal(f.mode.cacheOverlapCursor, undefined); assert.equal(retained.manager, undefined); assert.equal(retained.latest, undefined);
});

test("append cursor skips repeated headers and preserves duplicate ids without exposing the backing array", t => {
	const root = mkdtempSync(join(tmpdir(), "incremental-stats-")); t.after(() => removeOwnedFixture(root));
	const manager = SessionManager.inMemory(root);
	manager.appendMessage(message());
	const copy = manager.getEntries(), header = manager.getHeader();
	const file = join(root, "fixture.jsonl");
	writeFileSync(file, [header, copy[0], header, copy[0]].map(item => JSON.stringify(item)).join("\n") + "\n");
	manager.setSessionFile(file);
	const seen: unknown[] = [];
	let cursor = manager.visitAppendedEntries(0, { visitSessionEntry(entry) { seen.push(entry); } });
	assert.equal(cursor, 4); assert.equal(seen.length, 2); assert.deepEqual(seen, manager.getEntries());
	copy.length = 0; assert.equal(manager.getEntryCount(), 2);
	const id = manager.appendMessage(message());
	cursor = manager.visitAppendedEntries(cursor, { visitSessionEntry(entry) { seen.push(entry); } });
	assert.equal(cursor, manager.getAppendCursor()); assert.equal(seen.at(-1), manager.getEntry(id));
	for (const invalid of [-1, .5, NaN, Infinity, cursor + 1]) assert.throws(() => manager.visitAppendedEntries(invalid, { visitSessionEntry() {} }), RangeError);
});

test("failed persistence does not advance an incremental estimate; same-count reload invalidates it", t => {
	const root = mkdtempSync(join(tmpdir(), "incremental-reload-")); t.after(() => removeOwnedFixture(root));
	const manager = SessionManager.create(root, root), cursor = new CacheOverlapCursor();
	manager.appendMessage(message(0, 10_000));
	assert.deepEqual(cursor.estimate(manager, message(90_000)), { uncachedOverlapUpperBound: 10_000 });
	const persist = (manager as any)._persist;
	(manager as any)._persist = () => { throw new Error("fixture persist"); };
	assert.throws(() => manager.appendMessage(message(90_000)), /fixture persist/);
	(manager as any)._persist = persist;
	assert.deepEqual(cursor.estimate(manager, message(90_000)), { uncachedOverlapUpperBound: 10_000 });
	const file = manager.getSessionFile()!, entry = manager.getEntries()[0]!;
	writeFileSync(file, [manager.getHeader(), { ...entry, message: message(0, 50_000) }].map(value => JSON.stringify(value)).join("\n") + "\n");
	manager.setSessionFile(file);
	assert.deepEqual(cursor.estimate(manager, message(90_000)), { uncachedOverlapUpperBound: 50_000 });
	const generation = manager.getHistoryGeneration();
	writeFileSync(file, "invalid session\n"); assert.throws(() => manager.setSessionFile(file));
	assert.equal(manager.getHistoryGeneration(), generation + 1);
	assert.equal(cursor.estimate(manager, message(90_000)), undefined);
	cursor.clear();
});

test("a completion already present on the first lookup is not compared with itself", () => {
	const manager = SessionManager.inMemory(process.cwd()), cursor = new CacheOverlapCursor();
	manager.appendMessage(message()); const current = message(); manager.appendMessage(current);
	assert.equal(cursor.estimate(manager, current), undefined);
	cursor.clear();
});

for (const history of [1000, 10000, 50000]) test(`append work is independent of ${history} historical entries`, t => {
	const f = fixture(history); t.after(() => { f.footer.dispose(); f.mode.clearCacheOverlapCursor(); });
	const first = message(); f.mode.maybeShowCacheMissNotice(first); f.footer.render(200);
	const cursor = f.mode.cacheOverlapCursor;
	let noticeVisits = 0, footerVisits = 0, copies = 0, rebuilds = 0;
	const noticeVisit = cursor.visitSessionEntry.bind(cursor), footerVisit = f.footer.visitSessionEntry.bind(f.footer);
	t.mock.method(cursor, "visitSessionEntry", (entry: any) => { noticeVisits++; noticeVisit(entry); });
	t.mock.method(f.footer, "visitSessionEntry", (entry: any) => { footerVisits++; footerVisit(entry); });
	t.mock.method(f.manager, "getEntries", () => { copies++; throw new Error("warm history copy"); });
	t.mock.method(f.manager, "getBranch", () => { rebuilds++; throw new Error("warm branch rebuild"); });
	f.manager.appendMessage(first);
	f.manager.appendMessage({ role: "user", content: "next", timestamp: 0 });
	f.manager.appendSessionInfo("next name");
	f.mode.maybeShowCacheMissNotice(message()); f.footer.render(200);
	assert.deepEqual({ noticeVisits, footerVisits, copies, rebuilds }, { noticeVisits: 3, footerVisits: 3, copies: 0, rebuilds: 0 });
	t.diagnostic(JSON.stringify({ history, noticeVisits, footerVisits, copies, rebuilds }));
});
