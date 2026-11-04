import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { AssistantMessage } from "@super-pi/ai";
import { Container } from "@super-pi/tui";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { collectCacheOverlapEstimates, computeCacheOverlapTotals, detectCacheOverlapEstimate } from "../packages/coding-agent/src/core/cache-stats.ts";
import { SessionManager, type SessionEntry } from "../packages/coding-agent/src/core/session-manager.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { FooterComponent } from "../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

initTheme("dark");
function message(input: number, cacheRead = 0, cacheWrite = 0): AssistantMessage {
	return { role: "assistant", content: [], provider: "fixture", model: "model", api: "openai-responses", timestamp: 1,
		stopReason: "stop", usage: { input, cacheRead, cacheWrite, output: 0, totalTokens: input + cacheRead + cacheWrite,
			cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } } };
}
function entries(...messages: AssistantMessage[]): SessionEntry[] {
	return messages.map((message, i) => ({ type: "message", message, id: String(i), parentId: i ? String(i - 1) : null, timestamp: "fixture" }));
}
const bound = (value: number) => ({ uncachedOverlapUpperBound: value });

test("same-length unrelated prompts have only a length bound, with no invented cost or cause", () => {
	const prior = message(0, 40_000), current = message(40_000);
	prior.content = [{ type: "text", text: "old topic" }];
	current.content = [{ type: "text", text: "unrelated topic" }];
	current.timestamp = prior.timestamp + 86_400_000;
	current.usage.cost.input = current.usage.cost.total = 10;
	assert.deepEqual(detectCacheOverlapEstimate(entries(prior), current), bound(40_000));
	assert.deepEqual(computeCacheOverlapTotals(entries(prior, current)), { ...bound(40_000), estimatedTurns: 1 });
});

test("cached tokens outside the shared content cannot reduce its uncached upper bound", () => {
	// A prior 10k prompt and a new 30k prompt can share all 10k uncached tokens,
	// while 20k unrelated tokens are cached. min(lengths)-cacheRead would be negative.
	assert.deepEqual(detectCacheOverlapEstimate(entries(message(10_000)), message(10_000, 20_000)), bound(10_000));
	assert.deepEqual(detectCacheOverlapEstimate(entries(message(50_000)), message(20_000, 10_000)), bound(20_000));
});

test("first, unreported, full-hit and small-bound turns produce no estimate", () => {
	assert.equal(detectCacheOverlapEstimate([], message(40_000, 1000)), undefined);
	assert.equal(detectCacheOverlapEstimate(entries(message(40_000)), message(40_000)), undefined);
	assert.equal(detectCacheOverlapEstimate(entries(message(0, 40_000)), message(0, 50_000)), undefined);
	assert.equal(detectCacheOverlapEstimate(entries(message(0, 40_000)), message(1024, 40_000)), undefined);
});

test("read-only and cache-write reports retain their normalized prompt volume", () => {
	assert.deepEqual(detectCacheOverlapEstimate(entries(message(0, 40_000)), message(40_000)), bound(40_000));
	assert.deepEqual(detectCacheOverlapEstimate(entries(message(30_000)), message(1000, 1000, 25_000)), bound(26_000));
	assert.deepEqual(detectCacheOverlapEstimate(entries(message(0, 0, 30_000)), message(10_000, 20_000)), bound(10_000));
});

test("provider/model/API boundaries do not inherit earlier cache activity", () => {
	for (const field of ["provider", "model", "api"] as const) {
		const foreign = message(40_000);
		Object.assign(foreign, { [field]: "other" });
		assert.equal(detectCacheOverlapEstimate(entries(message(0, 40_000)), foreign), undefined);
		assert.equal(detectCacheOverlapEstimate(entries(message(0, 40_000), foreign), { ...foreign }), undefined);
	}
});

test("zero, invalid usage and failed responses cut the comparison segment", () => {
	const invalid = [message(0), message(NaN), message(Infinity), message(-1), message(1, -1), message(1, 0, NaN),
		{ ...message(40_000), stopReason: "error" as const }, { ...message(40_000), stopReason: "aborted" as const }];
	for (const current of invalid) {
		const history = entries(message(0, 40_000));
		assert.equal(detectCacheOverlapEstimate(history, current), undefined);
		assert.equal(detectCacheOverlapEstimate([...history, ...entries(current)], message(40_000)), undefined);
	}
});

test("compaction and branch summaries reset bounds; tools leave valid observations intact", () => {
	for (const type of ["compaction", "branch_summary"] as const) {
		assert.equal(detectCacheOverlapEstimate([...entries(message(0, 40_000)), { type } as SessionEntry], message(40_000)), undefined);
	}
	const history = entries(message(0, 40_000));
	history.push({ type: "message", message: { role: "toolResult" } } as SessionEntry);
	assert.deepEqual(detectCacheOverlapEstimate(history, message(40_000)), bound(40_000));
});

test("live, rebuild and totals agree by response identity and do not retain previous calls", () => {
	const messages = [message(0, 40_000), message(40_000), message(10_000, 30_000), message(0), message(40_000)];
	const history = entries(...messages), estimates = collectCacheOverlapEstimates(history);
	for (let i = 0; i < messages.length; i++) assert.deepEqual(detectCacheOverlapEstimate(history.slice(0, i), messages[i]!), estimates.get(messages[i]!));
	assert.equal(estimates.get({ ...messages[1]! }), undefined);
	assert.deepEqual(computeCacheOverlapTotals(history), { ...bound(50_000), estimatedTurns: 2 });
	assert.deepEqual(computeCacheOverlapTotals([]), { ...bound(0), estimatedTurns: 0 });
});

function uiFixture(messages: AssistantMessage[]) {
	const manager = SessionManager.inMemory(process.cwd());
	for (const item of messages) manager.appendMessage(item);
	const session = { sessionManager: manager, state: { model: { id: "model", provider: "fixture", contextWindow: 100_000 } },
		settingsManager: { getShowCacheMissNotices() { return true; } },
		getContextUsage() { return undefined; }, modelRuntime: { isUsingSubscription() { return false; } },
		getSessionStats() { return AgentSession.prototype.getSessionStats.call(this as unknown as AgentSession); } };
	const chat = new Container();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), { runtimeHost: { session }, chatContainer: chat,
		ui: { requestRender() {} } }) as any;
	const footer = new FooterComponent(session as any, { getGitBranch() {}, getAvailableProviderCount() { return 1; },
		getExtensionStatuses() { return new Map(); } } as any);
	return { manager, mode, chat, footer };
}
function plain(chat: Container): string { return chat.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, ""); }

test("optional notice and session command explicitly label bounds and preserve token-weighted rates", () => {
	const { manager, mode, chat, footer } = uiFixture([message(0, 10_000)]);
	try {
		const current = message(90_000);
		mode.maybeShowCacheMissNotice(current);
		assert.equal(chat.children.length, 0, "10k bound is below optional notice threshold");
		manager.appendMessage(current);
		mode.handleSessionCommand();
		const output = plain(chat);
		assert.match(output, /Cached: 10,000 \(10\.0%\)/);
		assert.match(output, /Uncached overlap upper bound: 10,000 tokens \(1 turn; repeated content unverified\)/);
		assert.doesNotMatch(output, /re-billed|miss|idle|expired|\$/i);
		assert.match(footer.render(200).join("\n"), /CH0\.0%/, "footer remains the latest turn, not cumulative ratio");
		chat.clear();
		mode.maybeShowCacheMissNotice(message(90_000));
		assert.match(plain(chat), /Cache overlap estimate: up to 90k uncached prompt tokens; repeated content and cache cause unknown/);
		const liveNotice = plain(chat);
		manager.appendMessage(message(90_000));
		Object.assign(mode, { pendingTools: new Map(), clearToolResultDiscoveries() {}, finalizeReadToolGroup() {},
			clearDeferredReadArtifacts() {}, addMessageToChat() {} });
		chat.clear();
		mode.renderSessionEntries(manager.getEntries());
		assert.equal(plain(chat), liveNotice, "actual rebuild uses the same response-bound estimate and text");
		chat.clear();
		mode.settingsManager.getShowCacheMissNotices = () => false;
		manager.getEntries = () => { throw new Error("disabled notices must not scan"); };
		mode.maybeShowCacheMissNotice(message(90_000));
		assert.equal(chat.children.length, 0);
	} finally { chat.clear(); footer.dispose(); }
});

test("cache estimation adds no closures, regex, promises, controllers or caches to the scan chain", () => {
	const source = ts.createSourceFile("cache-stats.ts", readFileSync(new URL("../packages/coding-agent/src/core/cache-stats.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	let maps = 0, objects = 0;
	function visit(node: ts.Node): void {
		assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral, false);
		if (ts.isNewExpression(node)) { assert.equal(node.expression.getText(source), "Map"); maps++; }
		if (ts.isObjectLiteralExpression(node)) objects++;
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.equal(maps, 1, "one existing transient scan Map remains for PF05");
	assert.equal(objects, 4, "estimate, previous state, totals and scan return only");
});
