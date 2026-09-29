import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import { openaiCodexOAuth } from "../../packages/ai/src/auth/oauth/openai-codex.ts";
import { resolveProviderAuth } from "../../packages/ai/src/auth/resolve.ts";
import type { OAuthCredential } from "../../packages/ai/src/auth/types.ts";

// Synthetic secrets only; real credentials are never read by these tests.
const SECRET = "sentinel-secret-7f3a9c";
const jwt = (account: string) => `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.s`;
const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function withFetch<T>(responses: Array<() => Response>, run: (calls: string[]) => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		calls.push(String(url));
		const next = responses.shift();
		if (!next) throw new Error("unexpected auth request");
		return next();
	}) as typeof fetch;
	try { return await run(calls); } finally { globalThis.fetch = original; }
}

async function rejectionText(promise: Promise<unknown>): Promise<string> {
	try { await promise; } catch (error) {
		let text = "";
		for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
			text += `${current instanceof Error ? `${current.message}\n${current.stack ?? ""}` : String(current)}\n`;
		}
		return text;
	}
	throw new Error("expected rejection");
}

const credential = (expires: number): OAuthCredential => ({ type: "oauth", access: jwt("old"), refresh: `refresh-${SECRET}`, expires, accountId: "old" });
const signal = () => AbortSignal.timeout(5_000);

for (const [name, response, expected] of [
	["success missing refresh_token", () => json(200, { access_token: `access-${SECRET}`, expires_in: 3600 }), /refresh response missing fields: refresh_token$/m],
	["success missing expiry", () => json(200, { access_token: `access-${SECRET}`, refresh_token: `refresh-${SECRET}` }), /missing fields: expires_in$/m],
	["success body that is not JSON", () => json(200, `access_token=${SECRET}`), /refresh response was not valid JSON$/m],
	["OAuth error body", () => json(400, { error: "invalid_grant", error_description: `refresh token ${SECRET} revoked` }), /refresh failed \(400: invalid_grant\)$/m],
	["unstructured error body", () => json(502, `<html>${SECRET}</html>`), /refresh failed \(502\)$/m],
] as const) test(`Codex token refresh diagnostics are bounded for ${name}`, async () => {
	const text = await withFetch([response], () => rejectionText(openaiCodexOAuth.refresh(credential(0), signal())));
	assert.match(text, expected);
	assert.equal(text.includes(SECRET), false, text);
});

test("Codex device login diagnostics never echo codes or verifiers", async () => {
	const interaction: any = {
		signal: signal(),
		prompt: async () => "device_code",
		notify() {},
	};
	const text = await withFetch([
		() => json(200, { device_auth_id: `device-${SECRET}`, user_code: "ABCD-EFGH", interval: 0 }),
		() => json(200, { authorization_code: `code-${SECRET}` }),
	], () => rejectionText(openaiCodexOAuth.login(interaction)));
	assert.match(text, /Invalid OpenAI Codex device auth token response: missing code_verifier/);
	assert.equal(text.includes(SECRET), false, text);
	const invalidStart = await withFetch([() => json(200, { user_code: `user-${SECRET}`, interval: 1 })], () => rejectionText(openaiCodexOAuth.login(interaction)));
	assert.match(invalidStart, /Invalid OpenAI Codex device code response: missing device_auth_id/);
	assert.equal(invalidStart.includes(SECRET), false, invalidStart);
});

const provider = { id: "openai-codex", auth: { oauth: openaiCodexOAuth, apiKey: { resolve: async () => ({ auth: { apiKey: `env-${SECRET}` }, source: "env" }) } } } as any;
const authContext = { env: async () => `env-${SECRET}`, fileExists: async () => false };

async function seeded(expires: number) {
	const store = new InMemoryCredentialStore();
	await store.modify("openai-codex", async () => credential(expires));
	return store;
}

test("near-expiry Codex auth refreshes once at the request boundary and serves the new token", async () => {
	const store = await seeded(Date.now() + 60_000);
	await withFetch([() => json(200, { access_token: jwt("new"), refresh_token: "rotated", expires_in: 3600 })], async calls => {
		const [first, second] = await Promise.all([
			resolveProviderAuth(provider, store, authContext),
			resolveProviderAuth(provider, store, authContext),
		]);
		assert.equal(calls.length, 1);
		assert.equal(first?.auth.apiKey, jwt("new"));
		assert.equal(second?.auth.apiKey, jwt("new"));
	});
	const stored = await store.read("openai-codex") as OAuthCredential;
	assert.equal(stored.refresh, "rotated");
	assert.equal(stored.accountId, "new");
});

test("failed Codex refresh fails closed: no env key, credential kept, secrets redacted", async () => {
	const store = await seeded(Date.now() + 60_000);
	const before = await store.read("openai-codex");
	const text = await withFetch([() => json(200, { access_token: `access-${SECRET}` })], () => rejectionText(resolveProviderAuth(provider, store, authContext)));
	assert.match(text, /OAuth refresh failed for openai-codex: OpenAI Codex token refresh response missing fields: refresh_token, expires_in/);
	assert.equal(text.includes(SECRET), false, text);
	assert.deepEqual(await store.read("openai-codex"), before);
});
