import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../packages/coding-agent/src/config.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { RpcClient } from "../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

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

test("CLI startup and in-app resume restore model and reasoning saved before the first message", { timeout: 15000 }, async t => {
	const owned = createOwnedTaskFixture("resume-model-");
	t.after(() => owned.cleanup());
	const cwd = join(owned.root, "work"), agentDir = join(owned.root, "agent"), sessionDir = join(owned.root, "sessions");
	mkdirSync(cwd);
	mkdirSync(getConfigDir(agentDir), { recursive: true });
	const provider = "openai", defaultModel = "gpt-5.4", chosenModel = "gpt-5.4-mini";
	writeFileSync(join(getConfigDir(agentDir), "settings.json"), JSON.stringify({
		defaultProvider: provider, defaultModel, defaultThinkingLevel: "low", enabledModels: [`${provider}/${defaultModel}`],
	}));
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendModelChange(provider, defaultModel);
	manager.appendModelChange(provider, chosenModel);
	manager.appendThinkingLevelChange("high");
	const sessionFile = manager.getSessionFile()!;
	const saved = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
	// An existing journal may already contain setup entries without a conversation.
	writeFileSync(sessionFile, saved);
	const env = { TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root, HOME: owned.root, USERPROFILE: owned.root,
		LOCALAPPDATA: owned.root, XDG_CONFIG_HOME: owned.root, SP_CODING_AGENT_DIR: agentDir, SP_CODING_AGENT_SESSION_DIR: sessionDir,
		SP_OFFLINE: "1", OPENAI_API_KEY: "offline-test-placeholder" };
	const cliPath = fileURLToPath(new URL("../packages/coding-agent/dist/cli.js", import.meta.url));
	const readState = async (args: string[], switchInProcess = false) => {
		const client = new RpcClient({ cliPath, cwd, env, args: ["--no-extensions", "--no-mcp", "--no-context-files", ...args] });
		try {
			await client.start();
			if (switchInProcess) {
				assert.equal((await client.getState()).model?.id, defaultModel);
				assert.deepEqual(await client.switchSession(sessionFile), { cancelled: false });
			}
			return await client.getState();
		} finally {
			await client.stop();
		}
	};
	const resumeArgs = ["--session", sessionFile];
	for (const fromStartup of [true, false]) {
		const state = await readState(fromStartup ? resumeArgs : ["--no-session"], !fromStartup);
		assert.equal(state.model?.id, chosenModel);
		assert.equal(state.thinkingLevel, "high");
		assert.equal(state.messageCount, 0);
		assert.equal(readFileSync(sessionFile, "utf8"), saved);
	}

	const override = "gpt-5.4-nano";
	const explicit = await readState([...resumeArgs, "--model", `${provider}/${override}`, "--thinking", "medium"]);
	assert.equal(explicit.model?.id, override);
	assert.equal(explicit.thinkingLevel, "medium");
	assert.equal(explicit.messageCount, 0);
	const journal = SessionManager.open(sessionFile).buildSessionContext();
	assert.deepEqual(journal.model, { provider, modelId: override });
	assert.equal(journal.thinkingLevel, "medium");
	const resumed = await readState(resumeArgs);
	assert.equal(resumed.model?.id, override);
	assert.equal(resumed.thinkingLevel, "medium");
});

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

test("a separate process recovers the first user after the writer is killed before any reply", { timeout: 15000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "session-first-user-process-"));
	const moduleUrl = new URL("../packages/coding-agent/src/core/session-manager.ts", import.meta.url).href;
	const writer = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import { SessionManager } from ${JSON.stringify(moduleUrl)};
		const manager = SessionManager.create(process.argv[1], process.argv[1]);
		manager.appendModelChange("fixture", "fixture");
		manager.appendMessage({ role: "user", content: "recover me", timestamp: 1 });
		process.on("message", () => {});
		process.send({ file: manager.getSessionFile(), written: true });
	`, dir], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = "";
	writer.stderr!.on("data", chunk => { stderr += chunk; });
	const exited = once(writer, "exit");
	try {
		const [ready] = await Promise.race([
			once(writer, "message"),
			exited.then(() => { throw new Error(`writer exited before synchronization: ${stderr}`); }),
		]);
		assert.equal(ready.written, true);
		assert.equal(writer.kill("SIGKILL"), true);
		await exited;
		const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import { SessionManager } from ${JSON.stringify(moduleUrl)};
			const manager = SessionManager.open(process.argv[1], process.argv[2]);
			console.log(JSON.stringify(manager.buildSessionContext().messages));
		`, ready.file, dir], { windowsHide: true });
		assert.deepEqual(JSON.parse(stdout), [{ role: "user", content: "recover me", timestamp: 1 }]);
	} finally {
		if (writer.exitCode === null && writer.signalCode === null) { writer.kill("SIGKILL"); await exited; }
		rmSync(dir, { recursive: true, force: true });
	}
});
