import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTask } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { FileAuthStorageBackend } from "../packages/coding-agent/src/core/auth-storage.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { emitSessionShutdownEvent } from "../packages/coding-agent/src/core/extensions/runner.ts";
// @ts-expect-error JavaScript extension package.
import mcpBridgeExtension from "../packages/mcp-bridge/src/index.js";
// @ts-expect-error JavaScript extension package.
import { McpOAuth } from "../packages/mcp-bridge/src/oauth.js";

// runAuthCommand, stopAuth and the auth command/session lifecycle handlers are
// explicit-command/start/stop allocation boundaries, never progress/frame paths.
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "sp-mcp-auth-lifecycle-"));
	const previous = process.env.SP_CODING_AGENT_DIR, entry = process.argv[1];
	process.env.SP_CODING_AGENT_DIR = root;
	process.argv[1] = resolve("packages/coding-agent/src/cli.ts");
	const commands = new Map<string, any>(), events = new Map<string, any>();
	const operations: Promise<unknown>[] = [], gates: ReturnType<typeof deferred>[] = [];
	const cleanup: Array<() => Promise<void>> = [];
	const notes: string[] = [];
	let reloads = 0;
	t.after(async () => {
		for (const gate of gates) gate.resolve();
		try {
			await events.get("session_shutdown")?.({}, {});
			await Promise.allSettled(operations);
			for (const close of cleanup) await close();
		}
		finally {
			process.argv[1] = entry!;
			if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
	mkdirSync(join(root, "config"));
	writeFileSync(join(root, "config", "mcp.json"), JSON.stringify({ version: 1, servers: {
		fixture: { transport: "http", url: "https://fixture.invalid/mcp", oauth: true, enabled: false },
	} }));
	const pi = { registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command.handler); },
		on(name: string, handler: any) { events.set(name, handler); }, getActiveTools: (): string[] => [], setActiveTools() {} };
	mcpBridgeExtension(pi);
	const ctx = { cwd: root, isProjectTrusted: () => false, hasUI: false, signal: undefined as AbortSignal | undefined,
		ui: { notify(text: string, level: string) { notes.push(`${level}: ${text}`); } },
		async reload() { reloads++; await events.get("session_shutdown")({}, {}); } };
	await events.get("session_start")({}, ctx);
	return { root, ctx, pi, notes, events, operations, cleanup, reloads: () => reloads,
		gate() { const value = deferred(); gates.push(value); return value; },
		run(action = "login", context = ctx) {
			const pending = commands.get(`mcp-${action}`)("fixture", context);
			operations.push(pending); void pending.catch(() => {}); return pending as Promise<void>;
		},
		stop: () => events.get("session_shutdown")({}, {}) as Promise<void>,
		start: () => events.get("session_start")({}, ctx) as Promise<void>,
	};
}

for (const action of ["login", "logout"]) for (const outcome of ["rejected", "late success"]) {
	test(`MCP shutdown waits for ${outcome} ${action} cleanup and suppresses stale UI/reload`, { timeout: 5000 }, async t => {
		const f = await fixture(t), entered = f.gate(), release = f.gate();
		let signal!: AbortSignal;
		t.mock.method(McpOAuth.prototype, action, async (...args: unknown[]) => {
			signal = args.at(-1) as AbortSignal; entered.resolve(); await release.promise;
			if (outcome === "rejected") throw new Error("fixture cleanup completed");
		});
		const login = f.run(action); await entered.promise;
		let stopped = false;
		const stop = f.stop().then(() => { stopped = true; });
		f.operations.push(stop);
		await nextTask();
		assert.equal(signal.aborted, true);
		assert.equal(stopped, false, "shutdown must await the operation, not just abort its signal");
		release.resolve(); await stop; await login;
		assert.deepEqual(f.notes, []);
		assert.equal(f.reloads(), 0);
	});
}

test("MCP shutdown prevents login still awaiting its module import from starting", async t => {
	const f = await fixture(t);
	let calls = 0;
	t.mock.method(McpOAuth.prototype, "login", async () => { calls++; });
	const login = f.run();
	await f.stop(); await login;
	assert.equal(calls, 0);
	assert.deepEqual(f.notes, []);
	assert.equal(f.reloads(), 0);
});

test("MCP successful auth releases ownership before its own reload emits shutdown", { timeout: 5000 }, async t => {
	const f = await fixture(t);
	t.mock.method(McpOAuth.prototype, "login", async () => {});
	await f.run();
	assert.equal(f.reloads(), 1);
	assert.deepEqual(f.notes, ["info: MCP login completed for fixture. Reloading MCP servers."]);
});

test("MCP replacement admits only the latest command after old cleanup, with one live auth operation", { timeout: 5000 }, async t => {
	const f = await fixture(t), entered = f.gate(), release = f.gate();
	let calls = 0, live = 0, maximum = 0;
	let firstSignal!: AbortSignal;
	t.mock.method(McpOAuth.prototype, "login", async (_notify: unknown, signal: AbortSignal) => {
		calls++; live++; maximum = Math.max(maximum, live);
		try {
			if (calls === 1) { firstSignal = signal; entered.resolve(); await release.promise; signal.throwIfAborted(); }
		} finally { live--; }
	});
	const first = f.run(); await entered.promise;
	const replacements = Array.from({ length: 20 }, () => f.run());
	await nextTask();
	assert.equal(firstSignal.aborted, true);
	assert.equal(calls, 1);
	release.resolve(); await first; await Promise.all(replacements);
	assert.equal(calls, 2);
	assert.equal(maximum, 1);
	assert.equal(live, 0);
	assert.equal(f.reloads(), 1);
	assert.equal(f.notes.length, 1);
});

test("MCP shutdown invalidates commands queued behind cleanup and rejects later admission", async t => {
	const f = await fixture(t), entered = f.gate(), release = f.gate();
	let calls = 0;
	t.mock.method(McpOAuth.prototype, "login", async () => { calls++; entered.resolve(); await release.promise; });
	const first = f.run(); await entered.promise;
	const queued = f.run();
	const stop = f.stop();
	release.resolve(); await stop; await first; await queued;
	await f.run();
	assert.equal(calls, 1);
	assert.equal(f.reloads(), 0);
	assert.deepEqual(f.notes, []);
});

test("MCP session start waits for old auth before admitting the replacement session", async t => {
	const f = await fixture(t), entered = f.gate(), release = f.gate();
	t.mock.method(McpOAuth.prototype, "login", async () => { entered.resolve(); await release.promise; });
	const login = f.run(); await entered.promise;
	let started = false;
	const start = f.start().then(() => { started = true; });
	f.operations.push(start);
	await nextTask(); assert.equal(started, false);
	release.resolve(); await start; await login;
	assert.deepEqual(f.notes, []);
	await f.run();
	assert.equal(f.reloads(), 1);
});

test("MCP shutdown still waits for auth when connection lifecycle cleanup fails", async t => {
	const f = await fixture(t), entered = f.gate(), release = f.gate();
	const error = new Error("fixture deactivation failed");
	t.mock.method(McpOAuth.prototype, "login", async () => { entered.resolve(); await release.promise; });
	const login = f.run(); await entered.promise;
	const original = f.pi.getActiveTools;
	f.pi.getActiveTools = () => { throw error; };
	let stopped = false;
	const stop = assert.rejects(f.stop(), reason => reason === error).then(() => { stopped = true; });
	f.operations.push(stop);
	try { await nextTask(); assert.equal(stopped, false); }
	finally { f.pi.getActiveTools = original; release.resolve(); }
	await stop; await login;
	assert.deepEqual(f.notes, []);
});

test("MCP parent cancellation suppresses late authorization notifications and reload", async t => {
	const f = await fixture(t), entered = f.gate(), release = f.gate(), caller = new AbortController();
	f.ctx.signal = caller.signal;
	t.mock.method(McpOAuth.prototype, "login", async (notify: (url: string) => void) => {
		entered.resolve(); await release.promise; notify("https://fixture.invalid/late-auth");
	});
	const login = f.run(); await entered.promise;
	caller.abort(); release.resolve(); await login;
	assert.deepEqual(f.notes, []); assert.equal(f.reloads(), 0);
});

test("MCP ordinary auth errors remain visible and allow a later login", async t => {
	const f = await fixture(t);
	t.mock.method(McpOAuth.prototype, "login", async () => { throw new Error("fixture secret detail"); });
	await f.run();
	assert.deepEqual(f.notes, ["error: MCP login failed or was cancelled. No credentials are shown in diagnostics."]);
	await f.run("logout");
	assert.equal(f.reloads(), 1);
});

test("MCP shutdown joins real callback close and pending reservation cleanup under a file lock", { timeout: 5000 }, async t => {
	const f = await fixture(t), entered = f.gate(), closed = f.gate(), locked = f.gate(), release = f.gate();
	let callback = "";
	t.mock.method(McpOAuth.prototype, "authorize", async (_entry: unknown, signal: AbortSignal, receiver: any) => {
		callback = receiver.url;
		const close = receiver.close;
		receiver.close = async () => { await close(); closed.resolve(); };
		const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		entered.resolve(); await aborted; signal.throwIfAborted();
	});
	const login = f.run(); await entered.promise;
	const path = join(f.root, "mcp-auth.json");
	const backend = new FileAuthStorageBackend(path);
	const held = backend.withLockAsync(async () => { locked.resolve(); await release.promise; return { result: undefined }; });
	f.operations.push(held); await locked.promise;
	let stopped = false;
	const stop = f.stop().then(() => { stopped = true; }); f.operations.push(stop);
	await closed.promise;
	assert.equal(stopped, false);
	assert.ok(Object.values(JSON.parse(readFileSync(path, "utf8"))).some((value: any) => value.loginAttempt));
	await assert.rejects(fetch(callback));
	release.resolve(); await held; await stop; await login;
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
	assert.deepEqual(f.notes, []); assert.equal(f.reloads(), 0);
});

test("real AgentSession reload waits for MCP auth before invalidating the old command context", { timeout: 10000 }, async t => {
	const f = await fixture(t), entered = f.gate(), release = f.gate();
	const errors: unknown[] = [];
	t.mock.method(McpOAuth.prototype, "login", async () => { entered.resolve(); await release.promise; });
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resources = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [mcpBridgeExtension] });
	await resources.reload(); assert.deepEqual(resources.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: f.root, agentDir: f.root, resourceLoader: resources,
		settingsManager: settings, sessionManager: SessionManager.create(f.root, join(f.root, "sessions")),
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "http://unused", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 },
		modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never });
	f.cleanup.push(async () => { try { await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); } });
	await session.bindExtensions({ onError: error => { errors.push(error); } });
	const command = session.prompt("/mcp-login fixture"); f.operations.push(command); void command.catch(() => {});
	await entered.promise;
	let reloaded = false;
	const reload = session.reload().then(() => { reloaded = true; }); f.operations.push(reload);
	await nextTask(); assert.equal(reloaded, false);
	release.resolve(); await reload; await command;
	assert.deepEqual(errors, []);
});

test("MCP auth releases owner, signal and command context references with the extension kept alive", { timeout: 15000 }, async t => {
	if (!global.gc) {
		await new Promise<void>((done, reject) => {
			execFile(process.execPath, ["--expose-gc", "--experimental-strip-types", "--test", "--test-name-pattern=MCP auth releases owner", fileURLToPath(import.meta.url)],
				{ windowsHide: true, timeout: 12000 }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : done());
		});
		return;
	}
	const f = await fixture(t), entered = f.gate(), release = f.gate();
	const refs: WeakRef<object>[] = [];
	let outcome = "success";
	const mocked = t.mock.method(McpOAuth.prototype, "login", async function (this: object, _notify: unknown, signal: AbortSignal) {
		refs.push(new WeakRef(this), new WeakRef(signal));
		if (outcome === "error") throw new Error("fixture error");
		if (outcome === "shutdown") { entered.resolve(); await release.promise; signal.throwIfAborted(); }
	});
	async function runCase(value: string) {
		outcome = value;
		await f.start();
		const context = { ...f.ctx }; refs.push(new WeakRef(context));
		const command = f.run("login", context);
		if (value === "shutdown") {
			await entered.promise;
			const stop = f.stop(); release.resolve(); await stop;
		}
		await command;
		mocked.mock.resetCalls();
	}
	for (const value of ["success", "error", "shutdown"]) await runCase(value);
	await f.stop();
	for (let index = 0; index < 8; index++) { await nextTask(); global.gc(); }
	assert.equal(refs.length, 9);
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	assert.ok(f.events.has("session_start"), "the owning extension remains reachable");
	t.diagnostic("auth lifecycle WeakRefs=9 retained=0");
});
