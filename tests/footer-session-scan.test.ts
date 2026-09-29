import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FooterComponent } from "../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

// The footer renders every frame; its whole-session usage scan must only rerun when entries change.
initTheme("dark");
const ANSI = /\x1b\[[0-9;]*m/g;
const usage = (cost: number) => ({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (cost: number) => ({ role: "assistant", content: [{ type: "text", text: "a" }], api: "openai-responses", provider: "openai", model: "m", usage: usage(cost), stopReason: "stop", timestamp: 1 }) as any;

function fixture() {
	const sessionManager = SessionManager.inMemory(process.cwd());
	sessionManager.appendMessage({ role: "user", content: "q", timestamp: 1 } as any);
	sessionManager.appendMessage(assistant(1));
	let scans = 0;
	const getEntries = sessionManager.getEntries.bind(sessionManager);
	sessionManager.getEntries = () => { scans++; return getEntries(); };
	const session: any = {
		state: { model: { id: "m", provider: "openai", reasoning: false, contextWindow: 1000 }, thinkingLevel: "off" },
		sessionManager,
		getContextUsage: () => ({ contextWindow: 1000, percent: 10, source: "provider" }),
		modelRuntime: { isUsingSubscription: () => false },
	};
	const data: any = { getGitBranch: () => undefined, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() };
	return { sessionManager, session, footer: new FooterComponent(session, data), scans: () => scans };
}

const text = (footer: FooterComponent) => footer.render(200).join("\n").replace(ANSI, "");

test("steady-state footer frames reuse one session scan", () => {
	const { footer, scans } = fixture();
	for (let index = 0; index < 100; index++) text(footer);
	assert.equal(scans(), 1);
});

test("appends, renames and session switches refresh the footer totals", () => {
	const { sessionManager, footer, scans } = fixture();
	assert.match(text(footer), /\$1\.000/);
	sessionManager.appendMessage(assistant(2));
	assert.match(text(footer), /\$3\.000/);
	sessionManager.appendSessionInfo("named");
	assert.match(text(footer), /named/);
	assert.equal(scans(), 3);

	const other = fixture();
	footer.setSession(other.session);
	const rendered = text(footer);
	assert.match(rendered, /\$1\.000/);
	assert.doesNotMatch(rendered, /named/);
});

test("session switch and dispose release the cached scan", () => {
	const { footer } = fixture();
	text(footer);
	footer.setSession(fixture().session);
	assert.equal((footer as any).sessionScan, undefined);
	text(footer);
	footer.dispose();
	assert.equal((footer as any).sessionScan, undefined);
});
