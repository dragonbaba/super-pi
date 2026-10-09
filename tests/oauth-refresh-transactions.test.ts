import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTask } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { resolveProviderAuth } from "../packages/ai/src/auth/resolve.ts";
import type { CredentialStore, OAuthAuth, OAuthCredential } from "../packages/ai/src/auth/types.ts";
import { createModels, type Provider } from "../packages/ai/src/models.ts";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import { transactionWriter } from "./helpers/oauth-transaction-process.ts";

const providerId = "refresh-transaction-fixture";
const authContext = { env: async () => undefined, fileExists: async () => false };
const credential = (generation: string, expires = 0): OAuthCredential => ({
	type: "oauth", access: `access-${generation}`, refresh: `refresh-${generation}`, expires,
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function storage(t: TestContext, kind: string): Promise<CredentialStore> {
	let store: CredentialStore;
	if (kind === "memory") store = new InMemoryCredentialStore();
	else if (kind === "auth-memory") store = AuthStorage.inMemory();
	else {
		const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, "sp-refresh-transaction-"));
		t.after(() => {
			assert.equal(dirname(root), parent);
			rmSync(root, { recursive: true, force: true });
		});
		store = AuthStorage.create(join(root, "auth.json"));
	}
	await store.modify(providerId, async () => credential("old"));
	return store;
}

function fixture(store: CredentialStore, refresh: OAuthAuth["refresh"]) {
	const networkCredentials: string[] = [];
	const provider: Provider = {
		id: providerId, name: "Fixture", getModels: () => [],
		stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); },
		auth: { oauth: { name: "Fixture", login: async () => credential("login"), refresh,
			toAuth: async (current) => ({ apiKey: current.access }) } },
		refreshModels: async (context) => {
			if (context.allowNetwork) {
				assert.equal(context.signal.aborted, false, "cancelled catalog must not start network work after persistence");
				if (context.credential?.type === "oauth") networkCredentials.push(context.credential.refresh);
			}
		},
	};
	const models = createModels({ credentials: store, authContext });
	models.setProvider(provider);
	return { models, networkCredentials, run: (entry: string, signal: AbortSignal) => entry === "request"
		? resolveProviderAuth(provider, store, authContext, { signal })
		: models.refresh({ signal, allowNetwork: true }) };
}

async function cancelled(pending: Promise<unknown>, entry: string, reason: Error) {
	if (entry === "request") await assert.rejects(pending, (error) => error === reason);
	else assert.equal((await pending as { aborted: boolean }).aborted, true);
}

for (const kind of ["memory", "auth-memory", "file"]) {
	for (const entry of ["request", "catalog"]) {
		for (const phase of ["in flight", "before commit"]) {
			test(`${kind} ${entry}: cancellation ${phase} preserves the rotated credential`, { timeout: 5000 }, async (t) => {
				const store = await storage(t, kind), started = deferred(), finish = deferred();
				const caller = new AbortController(), reason = new Error("fixture caller cancelled");
				let transactionSignal!: AbortSignal;
				const f = fixture(store, async (_current, signal) => {
					transactionSignal = signal;
					started.resolve();
					await finish.promise;
					if (phase === "before commit") caller.abort(reason);
					return credential("rotated", Date.now() + 3_600_000);
				});
				const pending = f.run(entry, caller.signal);
				const observed = cancelled(pending, entry, reason);
				try {
					await started.promise;
					if (phase === "in flight") {
						caller.abort(reason);
						await observed; // Must settle before the server returns the rotated token.
					}
				} finally { finish.resolve(); }
				await observed;
				const saved = await store.modify(providerId, async () => undefined) as OAuthCredential;
				assert.equal(saved.refresh, "refresh-rotated");
				assert.equal(transactionSignal.aborted, false);
				assert.equal(getEventListeners(caller.signal, "abort").length, 0);
				assert.equal(f.networkCredentials.length, 0);
			});
		}

		test(`${kind} ${entry}: cancellation while waiting never starts a refresh`, { timeout: 5000 }, async (t) => {
			const store = await storage(t, kind), locked = deferred(), unlock = deferred();
			const held = store.modify(providerId, async () => { locked.resolve(); await unlock.promise; return undefined; });
			await locked.promise;
			let calls = 0;
			const f = fixture(store, async () => { calls++; return credential("unexpected"); });
			const caller = new AbortController(), reason = new Error("cancel lock wait");
			const pending = f.run(entry, caller.signal), observed = cancelled(pending, entry, reason);
			try { await nextTask(); caller.abort(reason); await observed; }
			finally { unlock.resolve(); await held; }
			await store.modify(providerId, async () => undefined);
			assert.equal(calls, 0);
			assert.equal((await store.read(providerId) as OAuthCredential).refresh, "refresh-old");
			assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		});
	}

	for (const mutation of ["logout", "login"]) {
		test(`${kind}: a cancelled refresh cannot overwrite concurrent ${mutation}`, { timeout: 5000 }, async (t) => {
			const store = await storage(t, kind), started = deferred(), finish = deferred();
			const f = fixture(store, async () => { started.resolve(); await finish.promise; return credential("rotated", Date.now() + 3_600_000); });
			const caller = new AbortController(), reason = new Error("cancel refresh");
			const pending = f.run("request", caller.signal), observed = cancelled(pending, "request", reason);
			let write: Promise<unknown> | undefined;
			try {
				await started.promise; caller.abort(reason); await observed;
				write = mutation === "logout" ? store.delete(providerId) : store.modify(providerId, async () => credential("login"));
			} finally { finish.resolve(); }
			await write;
			const saved = await store.read(providerId) as OAuthCredential | undefined;
			assert.equal(saved?.refresh, mutation === "logout" ? undefined : "refresh-login");
		});
	}
}

for (const entry of ["request", "catalog"]) {
	test(`${entry}: refresh deadline releases the lock even if the provider ignores abort`, { timeout: 5000 }, async (t) => {
		const store = await storage(t, "memory"), started = deferred(), finish = deferred();
		let transactionSignal!: AbortSignal;
		const f = fixture(store, async (_current, signal) => {
			transactionSignal = signal; started.resolve(); await finish.promise; return credential("late");
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const caller = new AbortController();
		const pending = f.run(entry, caller.signal);
		const observed = entry === "request" ? assert.rejects(pending, /timed out|timeout/i) : pending;
		try {
			await started.promise;
			t.mock.timers.tick(15_000);
			await observed;
			assert.equal(transactionSignal.aborted, true);
			await store.modify(providerId, async () => credential("replacement"));
		} finally { finish.resolve(); }
		await nextTask();
		assert.equal((await store.read(providerId) as OAuthCredential).refresh, "refresh-replacement");
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	});
}

test("superseding a catalog refresh reuses the committed rotation and suppresses the old network phase", { timeout: 5000 }, async (t) => {
	const store = await storage(t, "memory"), started = deferred(), finish = deferred();
	let refreshes = 0;
	const f = fixture(store, async () => {
		refreshes++; started.resolve(); await finish.promise;
		return credential("rotated", Date.now() + 3_600_000);
	});
	const first = f.models.refresh({ allowNetwork: true });
	await started.promise;
	const second = f.models.refresh({ allowNetwork: true });
	try { await first; } finally { finish.resolve(); }
	assert.equal((await second).errors.size, 0);
	assert.equal(refreshes, 1);
	assert.deepEqual(f.networkCredentials, ["refresh-rotated"]);
});

for (const action of ["login", "logout"]) {
	test(`a second process ${action} sees the cancelled request's committed rotation`, { timeout: 10000 }, async (t) => {
		const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, "sp-refresh-process-"));
		let writer: ReturnType<typeof transactionWriter> | undefined;
		t.after(async () => {
			try { await writer?.stop(); }
			finally { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); }
		});
		const path = join(root, "auth.json"), store = AuthStorage.create(path);
		const started = deferred(), finish = deferred();
		await store.modify(providerId, async () => credential("old"));
		const f = fixture(store, async () => { started.resolve(); await finish.promise; return credential("rotated", Date.now() + 3_600_000); });
		const caller = new AbortController(), reason = new Error("cancel parent wait");
		const observed = cancelled(f.run("request", caller.signal), "request", reason);
		try {
			await started.promise;
			caller.abort(reason); await observed;
			writer = transactionWriter(t, path, providerId, action);
			await writer.waiting;
		} finally { finish.resolve(); }
		assert.equal(await writer!.done(), "refresh-rotated");
		const saved = JSON.parse(readFileSync(path, "utf8"))[providerId];
		assert.equal(saved?.refresh, action === "login" ? "refresh-login" : undefined);
	});
}

for (const mode of ["counts", "gc"]) {
	test(`OAuth transaction ${mode} gate`, () => {
		const result = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types",
			fileURLToPath(new URL("../scripts/bench/oauth-refresh-transactions.ts", import.meta.url)), mode], {
			encoding: "utf8", windowsHide: true, timeout: 10000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error));
		const report = JSON.parse(result.stdout.trim());
		assert.equal(report.mode, mode);
		if (mode === "gc") { assert.equal(report.weakRefs, 8); assert.equal(report.retained, 0); }
		else { assert.equal(report.promises, 120_000); assert.equal(report.controllers, 0); assert.equal(report.timers, 0); }
	});
}

for (const outcome of ["success", "failure"]) {
	test(`completed refresh ${outcome} clears its deadline and signal listeners`, async (t) => {
		const store = await storage(t, "memory");
		let signal!: AbortSignal;
		const caller = new AbortController();
		const f = fixture(store, async (_current, transactionSignal) => {
			signal = transactionSignal;
			if (outcome === "failure") throw new Error("fixture declined");
			return credential("rotated", Date.now() + 3_600_000);
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pending = f.run("request", caller.signal);
		if (outcome === "failure") await assert.rejects(pending, /fixture declined/);
		else await pending;
		t.mock.timers.tick(15_000);
		assert.equal(signal.aborted, false, "a completed transaction must not retain its deadline");
		assert.equal(getEventListeners(signal, "abort").length, 0);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	});
}
