import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createToolResultPresentationCounters } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";

async function fixture(enabled = true, owner = true) {
	const root = mkdtempSync(join(tmpdir(), "pi-evidence-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(cwd, "file.txt"), "production-shaped evidence text\n".repeat(1000));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, ...({ evidenceLedger: { enabled } } as {}) });
	const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true });
	await resources.reload();
	const counters = createToolResultPresentationCounters();
	const { session } = await createAgentSession({
		cwd, agentDir, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: resources,
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 },
		modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as unknown as ModelRuntime,
		toolResultPresentation: owner ? { enabled: true, budgetTokens: 2048, counters } : undefined,
	});
	let id = 0;
	async function read(args: Record<string, unknown> = { path: "file.txt" }) {
		const callId = `read-${++id}`;
		const tool = session.agent.state.tools.find(t => t.name === "read")!;
		const result = await tool.execute(callId, args, undefined, undefined);
		const message = { role: "toolResult" as const, toolName: "read", toolCallId: callId, content: result.content, details: result.details, isError: false, timestamp: id };
		session.agent.state.messages.push(message);
		await (session as unknown as { _handleAgentEvent(event: unknown): Promise<void> })._handleAgentEvent({ type: "message_end", message });
		return message;
	}
	return { root, cwd, session, counters, read, close() { session.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test("ten completed built-in reads reuse bounded references with one integrity scan per hit", async () => {
	const f = await fixture();
	try {
		const first = await f.read();
		const before = f.counters.artifactIntegrityScans;
		for (let i = 0; i < 9; i++) {
			const next = await f.read();
			assert.match(JSON.stringify(next.content), /no new disk read/i);
			assert.ok(JSON.stringify(next.content).length < JSON.stringify(first.content).length / 2);
		}
		assert.equal(f.counters.artifactIntegrityScans - before, 9);
	} finally { f.close(); }
});

test("same-length historical mutation is permitted and forces a real read", async () => {
	const f = await fixture();
	try {
		const first = await f.read();
		const block = first.content[0] as { type: string; text: string };
		assert.doesNotThrow(() => { block.text = "x".repeat(block.text.length); });
		const next = await f.read();
		assert.match((next.content[0] as { text: string }).text, /^production-shaped/);
		assert.match(JSON.stringify((await f.read()).content), /no new disk read/i);
	} finally { f.close(); }
});

for (const mode of ["disabled", "no-owner"] as const) {
	test(`${mode} leaves ordinary mutable read results compatible`, async () => {
		const f = await fixture(mode !== "disabled", mode !== "no-owner");
		try {
			const first = await f.read();
			const before = f.counters.artifactIntegrityScans;
			assert.deepEqual((await f.read()).content, first.content);
			assert.equal(f.counters.artifactIntegrityScans, before);
			assert.equal(Object.isFrozen(first.content), false);
		} finally { f.close(); }
	});
}
