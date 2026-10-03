import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

test("complete repository default configuration supports Codemode verification and real test-fix-test", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-codemode-default-config-"));
	const cwd = join(root, "work"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
	const names = ["HOME", "USERPROFILE", "SP_CODING_AGENT_DIR", "SP_OFFLINE"];
	const previous = names.map(name => process.env[name]);
	process.env.HOME = process.env.USERPROFILE = root; process.env.SP_CODING_AGENT_DIR = agentDir; process.env.SP_OFFLINE = "1";
	const originalFetch = globalThis.fetch;
	const originalEntry = process.argv[1];
	let network = 0;
	globalThis.fetch = async () => { network++; throw new Error("This fixture must remain offline"); };
	let session: any;
	try {
		// Imports follow environment isolation: extension modules may capture their config root.
		const { createAgentSession } = await import("../packages/coding-agent/src/core/sdk.ts");
		const { DefaultResourceLoader } = await import("../packages/coding-agent/src/core/resource-loader.ts");
		const { SettingsManager } = await import("../packages/coding-agent/src/core/settings-manager.ts");
		const { SessionManager } = await import("../packages/coding-agent/src/core/session-manager.ts");
		const { AssistantMessageEventStream } = await import("../packages/ai/src/utils/event-stream.ts");
		const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		// These extensions discover the host version from the actual CLI package path.
		process.argv[1] = join(repo, "packages/coding-agent/dist/cli.js");
		const configDir = join(repo, ".sp/config");
		const config = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
		assert.equal(config.packages.length, 14);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: config.packages.map((name: string) => resolve(configDir, name)) });
		const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await resources.reload();
		assert.deepEqual(resources.getExtensions().errors, []);
		assert.equal(resources.getExtensions().extensions.length, 22);
		writeFileSync(join(cwd, "file.txt"), "hello\nworld\n");
		({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd),
			model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
			modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never }));
		await session.bindExtensions({});
		assert.ok(session._toolRegistry.has("mcp_search_tools"), "MCP extension must be enabled, not just imported");
		const scripts = [
			'await show((await tools.read({path:"file.txt"})).ref)',
			'try {await tools.bash({command:"grep -q changed file.txt"})} catch {} await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]});await tools.bash({command:"grep -q changed file.txt"});await show((await tools.read({path:"file.txt"})).ref)',
		];
		let index = 0;
		session.agent.streamFunction = (_model: any, context: any) => {
			assert.ok(context.tools.some((tool: any) => tool.name === "codemode"));
			assert.ok(!context.tools.some((tool: any) => tool.name === "read" || tool.name === "bash"));
			const code = scripts[index++];
			const message: any = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", timestamp: index,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: code ? [{ type: "toolCall", id: `default-${index}`, name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }], stopReason: code ? "toolUse" : "stop" };
			const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
		};
		await session.prompt("Run offline verification");
		const results = session.agent.state.messages.filter((m: any) => m.role === "toolResult");
		assert.equal(results.length, 2);
		assert.equal(results[0].isError, false);
		assert.equal(results[1].isError, true, "the first failed test remains visible even though the fix succeeds");
		const calls = results[1].details.codemode.calls;
		assert.deepEqual(calls.map((call: any) => [call.toolName, call.isError]), [["bash", true], ["edit", false], ["bash", false], ["read", false]], JSON.stringify(results[1]));
		assert.equal(calls[0].exitCode, 1); assert.equal(calls[2].exitCode, 0);
		assert.doesNotMatch(JSON.stringify(results), /DUPLICATE_CALL|NESTED_TOOL_ERRORS/);
		assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "changed\nworld\n");
		assert.equal(network, 0);
	} finally {
		try {
			if (session) {
				session.agent.abort(); await session.agent.waitForIdle();
				const { emitSessionShutdownEvent } = await import("../packages/coding-agent/src/core/extensions/runner.ts");
				await emitSessionShutdownEvent(session._extensionRunner, { type: "session_shutdown", reason: "quit" });
				await session._codemode.close(); session.dispose();
			}
		} finally {
			globalThis.fetch = originalFetch;
			process.argv[1] = originalEntry!;
			for (let i = 0; i < names.length; i++) { if (previous[i] === undefined) delete process.env[names[i]!]; else process.env[names[i]!] = previous[i]; }
			rmSync(root, { recursive: true, force: true });
		}
	}
});
