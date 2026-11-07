import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionHarness, emitAll } from "./extension-harness.mjs";

// AGENT_ROOT is resolved when the dist modules load, so set it first.
const agentDirectory = await mkdtemp(join(tmpdir(), "super-pi-memory-digest-"));
const projectDirectory = join(agentDirectory, "digest-project");
await mkdir(projectDirectory);
process.env.SP_CODING_AGENT_DIR = agentDirectory;
const originalCwd = process.cwd();
process.chdir(projectDirectory);

const { default: extension } = await import("../dist/index.js");
const { buildMemoryDigest, MEMORY_DIGEST_CUSTOM_TYPE } = await import("../dist/memory-digest.js");
const { MEMORY_POLICY_PROMPT } = await import("../dist/constants.js");

const BASE_PROMPT = "base system prompt";
const DELIMITER = "\n§\n";

test.after(async () => {
	process.chdir(originalCwd);
	await rm(agentDirectory, { recursive: true, force: true });
});

function sessionContext(entries = []) {
	return { cwd: projectDirectory, sessionManager: { buildContextEntries: () => entries } };
}

async function startSession(contextEntries = []) {
	const harness = createExtensionHarness();
	extension(harness.api);
	await emitAll(harness, "session_start", { type: "session_start", reason: "startup" }, sessionContext(contextEntries));
	const beforeAgentStart = harness.handlers.get("before_agent_start")[0];
	const turn = (entries = []) => beforeAgentStart({ type: "before_agent_start", prompt: "hi", systemPrompt: BASE_PROMPT }, sessionContext(entries));
	return { harness, turn };
}

async function shutdown(harness) {
	await emitAll(harness, "session_shutdown", { type: "session_shutdown", reason: "exit" }, sessionContext());
}

async function writeMemory() {
	const globalDirectory = join(agentDirectory, "@super-pi", "memory");
	await writeFile(join(globalDirectory, "USER.md"), ["Prefers pnpm over npm.", "Wants reports in Chinese."].join(DELIMITER));
	const projects = await readdir(join(agentDirectory, "projects-memory"));
	assert.equal(projects.length, 1);
	const projectMemory = join(agentDirectory, "projects-memory", projects[0]);
	await writeFile(join(projectMemory, "MEMORY.md"), "Build with npm run build:offline.\nPlain build fetches the network.");
	await writeFile(join(projectMemory, "failures.md"), "[tool-quirk] python - hangs in the Windows REPL.");
	return projects[0];
}

test("buildMemoryDigest is deterministic, one line per entry, and bounded", () => {
	const sources = { user: ["  \nFirst line\nsecond line", "x".repeat(400)], project: ["Project fact"], projectName: "p", failures: [] };
	const digest = buildMemoryDigest(sources);
	assert.equal(digest, buildMemoryDigest(sources));
	assert.match(digest, /^<memory-context>\n/);
	assert.match(digest, /\n- First line\n/);
	assert.doesNotMatch(digest, /second line/);
	assert.match(digest, /\n- x{159}…\n/);
	assert.match(digest, /## Project p\n- Project fact\n<\/memory-context>$/);
	assert.equal(buildMemoryDigest({ user: [], project: ["  "], projectName: "", failures: [] }), "");

	const many = { user: Array.from({ length: 200 }, (_, index) => `entry ${index} ${"y".repeat(40)}`), project: [], projectName: "", failures: [] };
	const bounded = buildMemoryDigest(many, 2000);
	assert.ok(bounded.length <= 2000, `digest length ${bounded.length}`);
	assert.match(bounded, /\(\d+ more not shown; use memory_search\.\)\n<\/memory-context>$/);
});

test("digest mode keeps the system prompt constant and sends saved memory once as a hidden message", async () => {
	const empty = await startSession();
	const emptyResult = await empty.turn();
	assert.equal(emptyResult.message, undefined, "nothing saved yet, so no digest message");
	const emptySystemPrompt = emptyResult.systemPrompt;
	assert.equal(emptySystemPrompt, `${BASE_PROMPT}\n\n${MEMORY_POLICY_PROMPT}`);
	await shutdown(empty.harness);

	const projectName = await writeMemory();
	const session = await startSession();
	const first = await session.turn();
	assert.equal(first.systemPrompt, emptySystemPrompt, "system prompt bytes do not depend on saved memory");
	assert.doesNotMatch(first.systemPrompt, /Prefers pnpm/);
	assert.equal(first.message.customType, MEMORY_DIGEST_CUSTOM_TYPE);
	assert.equal(first.message.display, false);
	assert.match(first.message.content, /## User\n- Prefers pnpm over npm\.\n- Wants reports in Chinese\./);
	assert.match(first.message.content, new RegExp(`## Project ${projectName}\\n- Build with npm run build:offline\\.\\n`));
	assert.doesNotMatch(first.message.content, /Plain build fetches/);
	assert.match(first.message.content, /## Recent failures and corrections\n- \[tool-quirk\] python - hangs/);

	const persisted = [{ type: "message" }, { type: "custom_message", customType: MEMORY_DIGEST_CUSTOM_TYPE }];
	const second = await session.turn(persisted);
	assert.equal(second.message, undefined, "the digest is injected once per session context");
	assert.equal(second.systemPrompt, first.systemPrompt);
	assert.equal((await session.turn([])).message, undefined, "confirmed once; later turns do not rescan");

	await emitAll(session.harness, "session_compact", { type: "session_compact" }, sessionContext([]));
	const afterCompaction = await session.turn();
	assert.equal(afterCompaction.message.content, first.message.content, "re-sent with identical bytes after compaction drops it");
	const retryAfterFailedAdmission = await session.turn([]);
	assert.equal(retryAfterFailedAdmission.message?.content, first.message.content, "re-sent when the previous prompt never persisted it");

	const retainedTail = [{ type: "compaction", retainedTail: [{ role: "user" }, { role: "custom", customType: MEMORY_DIGEST_CUSTOM_TYPE }] }];
	await emitAll(session.harness, "session_compact", { type: "session_compact" }, sessionContext(retainedTail));
	assert.equal((await session.turn(retainedTail)).message, undefined, "a compaction retained tail still holds the digest");
	await emitAll(session.harness, "session_tree", { type: "session_tree" }, sessionContext(persisted));
	assert.equal((await session.turn(persisted)).message, undefined, "still in context after tree navigation");
	await shutdown(session.harness);

	const resumed = await startSession([{ type: "message" }, { type: "custom_message", customType: MEMORY_DIGEST_CUSTOM_TYPE }]);
	assert.equal((await resumed.turn()).message, undefined, "a resumed session already holds its digest");
	await shutdown(resumed.harness);
});

test("policy-only mode sends no digest message", async () => {
	await mkdir(join(agentDirectory, "config"), { recursive: true });
	await writeFile(join(agentDirectory, "config", "hermes-memory-config.json"), JSON.stringify({ memoryMode: "policy-only" }));
	try {
		const session = await startSession();
		const result = await session.turn();
		assert.equal(result.message, undefined);
		assert.equal(result.systemPrompt, `${BASE_PROMPT}\n\n${MEMORY_POLICY_PROMPT}`);
		await shutdown(session.harness);
	} finally {
		await rm(join(agentDirectory, "config"), { recursive: true, force: true });
	}
});
