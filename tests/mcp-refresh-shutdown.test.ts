import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { fileURLToPath } from "node:url";
// @ts-expect-error JavaScript extension package.
import { McpOAuth } from "../packages/mcp-bridge/src/oauth.js";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension package.
import { McpRuntimeLifecycle } from "../packages/mcp-bridge/src/lifecycle.js";
import { FileAuthStorageBackend } from "../packages/coding-agent/src/core/auth-storage.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function fixture(t: TestContext, phase = "response") {
	const root = mkdtempSync(join(tmpdir(), "sp-mcp-refresh-close-")), path = join(root, "auth.json");
	const entered = deferred(), release = deferred(), operations: Promise<unknown>[] = [];
	const backend = new FileAuthStorageBackend(path);
	const issuer = "https://auth.fixture.invalid";
	const config = { id: "fixture", source: "fixture", transport: "http", url: "https://mcp.fixture.invalid/mcp",
		headers: {}, oauth: {}, startupTimeoutMs: 3000, maxTools: 10 };
	let fetches = 0, transactionSignal: AbortSignal | undefined;
	const storage = { withLockAsync(operation: any, options: any) {
		return backend.withLockAsync(async text => {
			const result = await operation(text);
			if (result.next !== undefined && phase === "commit") { entered.resolve(); await release.promise; }
			return result;
		}, options);
	} };
	const owner = new McpOAuth(config, storage, async (input: string | URL, init: RequestInit) => {
		assert.equal(String(input), `${issuer}/token`);
		assert.equal(new URLSearchParams(init.body as string).get("grant_type"), "refresh_token");
		fetches++; transactionSignal = init.signal!;
		if (phase === "response") { entered.resolve(); await release.promise; }
		return Response.json({ token_type: "Bearer", access_token: "new", refresh_token: "rotated", expires_in: 3600 });
	});
	writeFileSync(path, JSON.stringify({ [owner.key]: {
		client: { client_id: "fixture", issuer }, tokens: { token_type: "Bearer", access_token: "old", refresh_token: "old-refresh", issuer },
		discovery: { authorizationServerUrl: issuer, authorizationServerMetadata: { issuer, token_endpoint: `${issuer}/token`,
			authorization_endpoint: `${issuer}/authorize`, response_types_supported: ["code"] }, issuerValidationVersion: 1 },
	} }));
	const runtime = new McpBridgeRuntime({ registerTool() {} }, root);
	const state = { config, oauth: owner, client: null, transport: null, tools: new Map(), status: "connected" };
	runtime.states.set(config.id, state);
	t.after(async () => {
		release.resolve();
		await Promise.allSettled(operations);
		await runtime.close();
		await backend.withLockAsync(async () => ({ result: undefined }));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	function track<T>(pending: Promise<T>): Promise<T> { operations.push(pending); void pending.catch(() => {}); return pending; }
	return { owner, runtime, state, config, backend, path, entered, release, track,
		stored: () => JSON.parse(readFileSync(path, "utf8"))[owner.key], fetches: () => fetches, signal: () => transactionSignal };
}

for (const phase of ["response", "commit"]) {
	test(`MCP runtime close waits for refresh ${phase} and file unlock after caller cancellation`, { timeout: 5000 }, async t => {
		const f = fixture(t, phase), caller = new AbortController();
		f.runtime.activeCalls.add({ abort() { caller.abort(); }, finish() {} });
		const request = f.track(assert.rejects(f.owner.refresh("old", caller.signal), { name: "AbortError" }));
		await f.entered.promise;
		let closed = false;
		const closing = f.track(f.runtime.close().then(() => { closed = true; }));
		await request;
		await nextTask();
		assert.equal(closed, false, "shutdown must not return before the protected transaction commits");
		assert.equal(f.state.oauth, f.owner);
		assert.equal(f.stored().tokens.refresh_token, "old-refresh");
		assert.equal(f.signal()!.aborted, false);
		f.release.resolve(); await closing;
		assert.equal(f.stored().tokens.refresh_token, "rotated");
		assert.equal(existsSync(`${f.path}.lock`), false);
		assert.equal(f.state.oauth, null);
		assert.equal(f.owner.cached, undefined);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.equal(f.runtime.activeCalls.size, 0);
	});
}

test("MCP failed connection waits for its detached refresh before dropping OAuth ownership", { timeout: 5000 }, async t => {
	const f = fixture(t), caller = new AbortController();
	const request = f.track(assert.rejects(f.owner.refresh("old", caller.signal), { name: "AbortError" }));
	await f.entered.promise; caller.abort(); await request;
	const connection = new AbortController();
	let failed = false;
	const connecting = f.track(assert.rejects(f.runtime.connect(f.config, connection.signal), { code: "aborted" }).then(() => { failed = true; }));
	connection.abort();
	await nextTask();
	assert.equal(failed, false);
	assert.equal(f.state.oauth, f.owner);
	f.release.resolve(); await connecting;
	assert.equal(f.stored().tokens.refresh_token, "rotated");
	assert.equal(f.state.oauth, null);
});

for (const event of ["shutdown", "begin"]) {
	test(`MCP session ${event} joins a protected refresh even when transport close throws`, { timeout: 5000 }, async t => {
		const f = fixture(t), lifecycle = new McpRuntimeLifecycle(() => {});
		const token = await lifecycle.begin();
		await lifecycle.attach(token, f.runtime); lifecycle.publish(token, f.runtime);
		const request = f.track(f.owner.refresh("old"));
		await f.entered.promise;
		Object.assign(f.state, { client: { close() { throw new Error("transport close failure"); } } });
		let closed = false;
		const closing = f.track(lifecycle[event]().then(() => { closed = true; }));
		await nextTask(); assert.equal(closed, false);
		f.release.resolve(); await closing; await request;
		assert.equal(f.stored().tokens.refresh_token, "rotated");
		assert.equal(f.state.oauth, null);
		assert.equal(f.owner.refreshCount, 0);
		await lifecycle.shutdown();
	});
}

for (const event of ["runtime close", "connection cancel"]) {
	test(`MCP SDK connect with an in-flight 401 refresh drains on ${event}`, { timeout: 5000 }, async t => {
		const f = fixture(t), connection = new AbortController();
		const attempts: string[] = [];
		t.mock.method(globalThis, "fetch", async (_input: any, init: RequestInit) => {
			attempts.push(JSON.parse(init.body as string).method);
			return new Response(null, { status: 401 });
		});
		const connecting = f.track(assert.rejects(f.runtime.connect(f.config, connection.signal), { code: "aborted" }));
		await f.entered.promise;
		let closed = false;
		if (event === "connection cancel") connection.abort();
		const closing = f.track((event === "runtime close" ? f.runtime.close() : connecting).then(() => { closed = true; }));
		await nextTask(); assert.equal(closed, false);
		f.release.resolve(); await closing; await connecting;
		assert.deepEqual(attempts, event === "connection cancel" ? ["initialize", "notifications/cancelled"] : ["initialize"],
			"the SDK may notify cancellation, but must not retry initialize");
		assert.equal(f.fetches(), 1);
		assert.equal(f.stored().tokens.refresh_token, "rotated");
		assert.equal(f.state.oauth, null);
		assert.equal(f.state.client, null);
	});
}

for (const withCaller of [false, true]) {
	test(`MCP close cancels a refresh waiting for another process's lock: caller=${withCaller}`, { timeout: 5000 }, async t => {
		const f = fixture(t), locked = deferred();
		const held = f.track(f.backend.withLockAsync(async () => { locked.resolve(); await f.release.promise; return { result: undefined }; }));
		await locked.promise;
		const caller = new AbortController();
		const request = f.track(assert.rejects(f.owner.refresh("old", withCaller ? caller.signal : undefined), { name: "AbortError" }));
		await nextTask();
		await f.runtime.close(); await request;
		assert.equal(f.fetches(), 0);
		assert.equal(f.owner.refreshCount, 0);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.equal(f.stored().tokens.refresh_token, "old-refresh");
		f.release.resolve(); await held;
	});
}

test("MCP close shares one drain across concurrent refresh waiters and rejects late admission", { timeout: 5000 }, async t => {
	const f = fixture(t);
	const first = f.track(f.owner.refresh("old"));
	await f.entered.promise;
	const waiters = Array.from({ length: 20 }, () => f.track(assert.rejects(f.owner.refresh("old"), { name: "AbortError" })));
	assert.equal(f.owner.refreshCount, 21);
	const drained = f.owner.close();
	for (let index = 0; index < 20; index++) assert.equal(f.owner.close(), drained);
	const closing = f.track(f.runtime.close());
	await Promise.all(waiters);
	assert.equal(f.owner.refreshCount, 1);
	assert.equal(f.owner.refreshDrained, drained);
	await assert.rejects(f.owner.refresh("old"), { name: "AbortError" });
	await assert.rejects(f.owner.token(), { name: "AbortError" });
	assert.equal(f.fetches(), 1);
	f.release.resolve(); await closing; await first;
	assert.equal(f.owner.refreshCount, 0);
	assert.equal(f.owner.refreshDrained, undefined);
	assert.equal(f.owner.resolveRefreshDrained, undefined);
	assert.equal(getEventListeners(f.owner.refreshController.signal, "abort").length, 0);
	await f.owner.close();
});

for (const outcome of ["failure", "deadline"]) {
	test(`MCP close drains refresh ${outcome} and cannot commit a late result`, { timeout: 5000 }, async t => {
		const f = fixture(t);
		let signal!: AbortSignal;
		f.owner.authorize = async (entry: any, transaction: AbortSignal) => {
			signal = transaction; f.entered.resolve(); await f.release.promise;
			if (outcome === "failure") throw new Error("fixture refresh failure");
			entry.tokens.refresh_token = "too-late";
			return "too-late";
		};
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const request = f.track(assert.rejects(f.owner.refresh("old"), outcome === "failure" ? /fixture refresh failure/ : /timed out/));
		await f.entered.promise;
		const closing = f.track(f.runtime.close());
		if (outcome === "failure") f.release.resolve();
		else t.mock.timers.tick(180_000);
		await closing; await request;
		assert.equal(signal.aborted, outcome === "deadline");
		assert.equal(getEventListeners(signal, "abort").length, 0);
		assert.equal(f.owner.refreshCount, 0);
		assert.equal(f.owner.refreshDrained, undefined);
		assert.equal(existsSync(`${f.path}.lock`), false);
		t.mock.timers.reset();
		const replacement = new McpOAuth(f.config, f.backend);
		await replacement.logout();
		f.release.resolve(); await nextTask();
		assert.equal(f.stored(), undefined);
		assert.equal(f.owner.cached, undefined);
	});
}

test("MCP close prevents a cold read or already-yielded warm token from repopulating credentials", { timeout: 5000 }, async t => {
	const f = fixture(t);
	const storage = f.owner.backend;
	f.owner.backend = { async withLockAsync(operation: any, options: any) {
		const result = await storage.withLockAsync(operation, options);
		f.entered.resolve(); await f.release.promise;
		return result;
	} };
	const cold = f.track(assert.rejects(f.owner.token(), { name: "AbortError" }));
	await f.entered.promise;
	await f.runtime.close(); f.release.resolve(); await cold;
	assert.equal(f.owner.cached, undefined);
	const other = new McpOAuth(f.config, f.backend);
	assert.equal(await other.token(), "old");
	const warm = assert.rejects(other.token(), { name: "AbortError" });
	await other.close(); await warm;
	assert.equal(other.cached, undefined);
});

test("MCP closed OAuth owners release transaction and cache references under controlled GC", { timeout: 15000 }, async t => {
	if (!global.gc) {
		await new Promise<void>((done, reject) => {
			execFile(process.execPath, ["--expose-gc", "--experimental-strip-types", "--test", "--test-name-pattern=MCP closed OAuth owners", fileURLToPath(import.meta.url)],
				{ windowsHide: true, timeout: 12000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } }, (error, stdout, stderr) => {
					if (error || !stdout.includes("WeakRefs=12 retained=0")) reject(new Error(`${error?.message ?? "GC child did not run"}\n${stdout}\n${stderr}`));
					else done();
				});
		});
		return;
	}
	const refs: WeakRef<object>[] = [], owners: any[] = [];
	async function runCase(outcome: string) {
		const f = fixture(t), caller = new AbortController();
		owners.push(f.owner);
		await f.owner.token();
		refs.push(new WeakRef(caller.signal), new WeakRef(f.owner.cached), new WeakRef(f.owner.cached.tokens));
		f.owner.authorize = async (entry: any, signal: AbortSignal) => {
			refs.push(new WeakRef(entry), new WeakRef(signal));
			f.entered.resolve(); await f.release.promise;
			if (outcome === "failure") throw new Error("fixture failure");
			return "new";
		};
		const request = f.track(assert.rejects(f.owner.refresh("old", caller.signal), { name: "AbortError" }));
		await f.entered.promise; caller.abort(); await request;
		const drain = f.owner.close(); refs.push(new WeakRef(drain));
		f.release.resolve(); await drain;
		// Retaining the test's callback would itself retain the fixture.
		f.owner.authorize = McpOAuth.prototype.authorize;
		await f.runtime.close();
	}
	for (const outcome of ["success", "failure"]) await runCase(outcome);
	for (let index = 0; index < 8; index++) { await nextTask(); global.gc(); }
	assert.equal(refs.length, 12);
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	for (const owner of owners) { assert.equal(owner.cached, undefined); assert.equal(owner.refreshCount, 0); }
	t.diagnostic("closed OAuth owners alive=2 WeakRefs=12 retained=0");
});
