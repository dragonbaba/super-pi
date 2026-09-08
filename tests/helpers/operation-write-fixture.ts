import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { OperationJournal } from "../../packages/coding-agent/src/core/operation-journal.ts";
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";

function eligibleFixtureBase(): string | undefined {
	if (process.platform !== "linux") return undefined;
	if (!fs.existsSync("/proc/self/fdinfo")) return undefined;
	for (const path of [tmpdir(), "/dev/shm"]) {
		try {
			const type = Number(fs.statfsSync(path).type);
			if (type === 0xef53 || type === 0x58465342 || type === 0x9123683e || type === 0x01021994) return fs.realpathSync(path);
		} catch { /* Candidate mount unavailable; never override production platform identity. */ }
	}
	return undefined;
}
const fixtureBase = eligibleFixtureBase();
export const operationFixtureSupported = fixtureBase !== undefined;
export function operationFixtureRoot(prefix: string): string { return mkdtempSync(join(fixtureBase ?? tmpdir(), prefix)); }

export async function fixture(enabled: boolean, previous?: { cwd: string; agentDir: string; file: string }, stoppedWriterToken?: string) {
	const root = previous?.cwd ?? operationFixtureRoot("pi-write-session-");
	const cwd = root, agentDir = previous?.agentDir ?? join(root, "agent");
	if (!previous) mkdirSync(agentDir);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true });
	await resourceLoader.reload();
	const sessionManager = previous ? SessionManager.open(previous.file) : SessionManager.create(cwd, agentDir);
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager,
		operationJournal: enabled ? { enabled: true, stoppedWriterToken } : undefined,
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
		modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as unknown as ModelRuntime,
	});
	let providers = 0;
	session.agent.streamFunction = () => { providers++; throw new Error("provider forbidden"); };
	return { session, cwd, agentDir, file: sessionManager.getSessionFile()!, providers: () => providers };
}

// Task-owned subprocess cutpoints. No production fault switch or alternate write adapter.
if (process.argv[2] === "--operation-crash") {
	const previous = JSON.parse(process.argv[3]);
	const cutpoint = process.argv[4];
	const intentId = process.argv[5];
	const append = fs.appendFileSync;
	fs.appendFileSync = (path, data, options) => {
		if (cutpoint === "history" && String(path) === previous.file && String(data).includes("host-operation-v1")) {
			append(path, String(data).slice(0, 80), options); process.kill(process.pid, "SIGKILL");
		}
		return append(path, data, options);
	};
	const rename = fs.renameSync;
	fs.renameSync = (source, target) => {
		if (String(target).includes(".operations-v1/")) {
			const envelope = JSON.parse(fs.readFileSync(source, "utf8"));
			const record = JSON.parse(envelope.body);
			if (record.state === "completed" && cutpoint === "unpublished") process.kill(process.pid, "SIGKILL");
			rename(source, target);
			if (record.state === cutpoint) process.kill(process.pid, "SIGKILL");
			return;
		}
		rename(source, target);
	};
	const write = fsPromises.writeFile;
	fsPromises.writeFile = async (path, data, options) => {
		if (String(path) === join(previous.cwd, "target") && cutpoint === "partial") {
			await write(path, "x", options); process.kill(process.pid, "SIGKILL");
		}
		return write(path, data, options);
	};
	syncBuiltinESMExports();
	const f = await fixture(true, previous);
	await f.session.newOperation({ intentId, originBranch: null, path: "target", content: "complete intended bytes" });
	throw new Error("Crash cutpoint was not reached");
}


if(process.argv[2]==="--operation-fifo") {
 const root=operationFixtureRoot("pi-fifo-"); const file=join(root,"session");fs.writeFileSync(file,"session");fs.mkdirSync(`${file}.operations-v1`);
 execFileSync("mkfifo",[`${file}.operations-v1/lock`]);
 assert.throws(()=>OperationJournal.inspectWriter(file),/Corrupt or oversized/);
}
