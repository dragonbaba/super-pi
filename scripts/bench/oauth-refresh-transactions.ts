import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { setImmediate as nextTask } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import type { OAuthCredential } from "../../packages/ai/src/auth/types.ts";
import { InMemoryAuthStorageBackend } from "../../packages/coding-agent/src/core/auth-storage.ts";
// @ts-expect-error JavaScript extension package.
import { McpOAuth } from "../../packages/mcp-bridge/src/oauth.js";

const resolverUrl = process.argv[3] ? pathToFileURL(process.argv[3]) : new URL("../../packages/ai/src/auth/resolve.ts", import.meta.url);
const { resolveProviderAuth } = await import(resolverUrl.href) as typeof import("../../packages/ai/src/auth/resolve.ts");
const sourceHash = createHash("sha256").update(readFileSync(resolverUrl)).digest("hex");
const context = { env: async () => undefined, fileExists: async () => false };
const token = (generation: string): OAuthCredential => ({ type: "oauth", access: generation, refresh: generation, expires: Date.now() + 3_600_000 });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

if ((process.argv[2] ?? "counts") === "counts") {
	const store = new InMemoryCredentialStore(), caller = new AbortController();
	await store.modify("fixture", async () => token("valid"));
	let refreshes = 0, promises = 0, controllers = 0, timers = 0;
	const provider = { id: "fixture", auth: { oauth: {
		name: "fixture", login: async () => token("login"),
		refresh: async () => { refreshes++; return token("rotated"); },
		toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
	} } };
	const originalController = globalThis.AbortController, originalTimeout = globalThis.setTimeout;
	const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
	globalThis.AbortController = class extends originalController { constructor() { super(); controllers++; } };
	globalThis.setTimeout = new Proxy(originalTimeout, { apply(target, receiver, args) { timers++; return Reflect.apply(target, receiver, args); } });
	try {
		hook.enable();
		for (let index = 0; index < 10_000; index++) {
			assert.equal((await resolveProviderAuth(provider, store, context, { signal: caller.signal }))?.auth.apiKey, "valid");
		}
	} finally { hook.disable(); globalThis.AbortController = originalController; globalThis.setTimeout = originalTimeout; }
	assert.equal(refreshes, 0); assert.equal(controllers, 0); assert.equal(timers, 0);
	assert.equal(promises, 120_000); // Existing request-boundary async calls: twelve per lookup.
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	console.log(JSON.stringify({ mode: "counts", sourceHash, reads: 10_000, promises, controllers, timers, refreshes, listeners: 0 }));
} else if (process.argv[2] === "gc") {
	assert.ok(global.gc, "requires --expose-gc");
	async function aiCycle() {
		const owner = new InMemoryCredentialStore(), started = deferred(), finish = deferred(), caller = new AbortController();
		const refs: WeakRef<object>[] = [new WeakRef(caller.signal)];
		await owner.modify("fixture", async () => {
			const old = { ...token("old"), expires: 0 }; refs.push(new WeakRef(old)); return old;
		});
		const provider = { id: "fixture", auth: { oauth: {
			name: "fixture", login: async () => token("login"),
			refresh: async (_current: OAuthCredential, signal: AbortSignal) => {
				refs.push(new WeakRef(signal)); started.resolve(); await finish.promise;
				const next = token("rotated"); refs.push(new WeakRef(next)); return next;
			},
			toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
		} } };
		const pending = resolveProviderAuth(provider, owner, context, { signal: caller.signal });
		const observed = assert.rejects(pending, { name: "AbortError" });
		try { await started.promise; caller.abort(); await observed; } finally { finish.resolve(); }
		await owner.modify("fixture", async () => undefined);
		await owner.delete("fixture");
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		return { owner, refs };
	}
	async function mcpCycle() {
		const backend = new InMemoryAuthStorageBackend(), started = deferred(), finish = deferred(), caller = new AbortController();
		const refs: WeakRef<object>[] = [new WeakRef(caller.signal)];
		const issuer = "https://auth.fixture.invalid";
		const owner = new McpOAuth({ id: "fixture", source: "fixture", url: "https://mcp.fixture.invalid/mcp" }, backend);
		backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [owner.key]: {
			client: { client_id: "fixture", issuer }, tokens: { access_token: "old", refresh_token: "old", token_type: "Bearer", issuer },
			discovery: { authorizationServerUrl: issuer, authorizationServerMetadata: { issuer }, issuerValidationVersion: 1 },
		} }) }));
		owner.authorize = async (entry: any, signal: AbortSignal) => {
			refs.push(new WeakRef(signal), new WeakRef(entry), new WeakRef(entry.tokens));
			started.resolve(); await finish.promise; entry.tokens.access_token = "rotated"; return "rotated";
		};
		const observed = assert.rejects(owner.refresh("old", caller.signal), { name: "AbortError" });
		try { await started.promise; caller.abort(); await observed; } finally { finish.resolve(); }
		await backend.withLockAsync(async () => ({ result: undefined }));
		await owner.logout();
		assert.equal(owner.cached, undefined);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		return { owner, refs };
	}
	const ai = await aiCycle(), mcp = await mcpCycle();
	for (let index = 0; index < 8; index++) { await nextTask(); global.gc(); }
	const retained = [...ai.refs, ...mcp.refs].filter((ref) => ref.deref() !== undefined).length;
	assert.equal(retained, 0);
	assert.equal(await ai.owner.read("fixture"), undefined);
	assert.equal(await mcp.owner.token(), undefined);
	console.log(JSON.stringify({ mode: "gc", sourceHash, weakRefs: ai.refs.length + mcp.refs.length, retained, ownersAlive: 2 }));
} else throw new Error("unknown benchmark mode");
