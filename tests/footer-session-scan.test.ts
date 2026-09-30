import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FooterComponent } from "../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { FooterDataProvider } from "../packages/coding-agent/src/core/footer-data-provider.ts";

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

test("subscription cost is explicitly an API-equivalent estimate", () => {
	const { session, footer } = fixture();
	session.modelRuntime.isUsingSubscription = () => true;
	assert.match(text(footer), /\$1\.000 \(API est\., sub\)/);
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

test("extension status cache follows actual mutations, key order, empty values and disposal", () => {
	const { session } = fixture();
	const data = new FooterDataProvider(process.env.SP_CODING_AGENT_DIR ?? tmpdir());
	const footer = new FooterComponent(session, data);
	try {
		data.setExtensionStatus("z", "last\nstatus");
		data.setExtensionStatus("a", "first\t status");
		assert.equal((footer as any).getExtensionStatusLine(), "first status last status");
		const revision = data.getExtensionStatusRevision();
		data.setExtensionStatus("a", "first\t status");
		data.setExtensionStatus("absent", undefined);
		assert.equal(data.getExtensionStatusRevision(), revision);
		let enumerations = 0;
		const statuses = data.getExtensionStatuses() as Map<string, string>;
		const entries = statuses.entries.bind(statuses);
		statuses.entries = () => { enumerations++; return entries(); };
		for (let index = 0; index < 100; index++) text(footer);
		assert.equal(enumerations, 0, "warm frames must not copy/sort/sanitize statuses");
		data.setExtensionStatus("a", undefined);
		data.setExtensionStatus("b", "renamed");
		assert.equal((footer as any).getExtensionStatusLine(), "renamed last status");
		assert.equal(enumerations, 1);
		data.clearExtensionStatuses();
		assert.equal((footer as any).getExtensionStatusLine(), undefined);
		assert.equal((footer as any).extensionStatusLine, undefined);
		data.setExtensionStatus("only", "");
		assert.equal((footer as any).getExtensionStatusLine(), "");
		footer.dispose();
		assert.equal((footer as any).extensionStatusLine, undefined);
		assert.equal((footer as any).extensionStatusRevision, undefined);
	} finally { footer.dispose(); data.dispose(); }
});

test("legacy footer providers without a revision still reflect map mutations and independent owners", () => {
	const { session } = fixture();
	const statuses = new Map([["a", "old"]]);
	const data: any = { getGitBranch: () => undefined, getAvailableProviderCount: () => 1, getExtensionStatuses: () => statuses };
	const footer = new FooterComponent(session, data);
	assert.equal((footer as any).getExtensionStatusLine(), "old");
	statuses.set("a", "new");
	assert.equal((footer as any).getExtensionStatusLine(), "new");
	const other = new FooterComponent(session, { ...data, getExtensionStatuses: () => new Map([["b", "separate"]]) });
	assert.equal((other as any).getExtensionStatusLine(), "separate");
	assert.equal((footer as any).getExtensionStatusLine(), "new");
	footer.dispose(); other.dispose();
});

test("branch and compaction invalidate the scan while history and live usage stay separate", () => {
	const { footer, session, sessionManager, scans } = fixture();
	const first = sessionManager.getEntries()[0]!.id;
	text(footer);
	sessionManager.branch(first);
	assert.match(text(footer), /\$1\.000/);
	assert.equal(scans(), 3); // one explicit test read plus the two renders
	sessionManager.appendCompaction("checkpoint", first, 1000);
	assert.match(text(footer), /\$1\.000/);
	const count = scans();
	session.getContextUsage = () => ({ contextWindow: 1000, percent: 70, source: "provider" });
	session.state.model = { ...session.state.model, id: "other" };
	const rendered = text(footer);
	assert.match(rendered, /other/);
	assert.equal(scans(), count, "historical totals do not depend on the live model or context usage");
	assert.equal(sessionManager.getEntryCount(), sessionManager.getEntries().length);
});

test("same-file reload invalidates totals even when session id, leaf and entry count match", () => {
	const dir = mkdtempSync(join(tmpdir(), "footer-reload-"));
	try {
		const { footer, sessionManager } = fixture();
		const file = join(dir, "session.jsonl");
		const entries = sessionManager.getEntries();
		const save = () => writeFileSync(file, [sessionManager.getHeader(), ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
		save();
		sessionManager.setSessionFile(file);
		assert.match(text(footer), /\$1\.000/);
		(entries[1] as any).message = assistant(7);
		save();
		sessionManager.setSessionFile(file);
		assert.match(text(footer), /\$7\.000/);
		assert.equal(sessionManager.getEntryCount(), sessionManager.getEntries().length);
		// The persisted loader accepts duplicate ids; count must follow getEntries' filtering,
		// rather than the deduplicating byId index.
		writeFileSync(file, [sessionManager.getHeader(), ...entries, entries[1], sessionManager.getHeader()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
		sessionManager.setSessionFile(file);
		assert.equal(sessionManager.getEntryCount(), 3);
		assert.equal(sessionManager.getEntryCount(), sessionManager.getEntries().length);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
