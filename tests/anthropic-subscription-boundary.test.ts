import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { stream } from "../packages/ai/src/api/anthropic-messages.ts";
import { anthropicProvider } from "../packages/ai/src/providers/anthropic.ts";
import { anthropicOAuth } from "../packages/ai/src/auth/oauth/anthropic.ts";
import { loadAnthropicOAuth, registerBundledOAuthFlowLoaders } from "../packages/ai/src/auth/oauth/load.ts";
import { resolveProviderAuth } from "../packages/ai/src/auth/resolve.ts";
import { getEnvApiKey } from "../packages/ai/src/env-api-keys.ts";
import { createModels } from "../packages/ai/src/models.ts";
import { isRetryableAssistantError } from "../packages/ai/src/utils/retry.ts";
import type { Credential, CredentialStore, AuthContext } from "../packages/ai/src/auth/types.ts";
import type { Context } from "../packages/ai/src/types.ts";

const disabled = /\[ANTHROPIC_SUBSCRIPTION_DISABLED\]/;
const token = "sk-ant-oat01-synthetic-only";
const provider = anthropicProvider();
const model = provider.getModels().find(m => m.id === "claude-sonnet-4-5")!;
const context: Context = { messages: [{ role: "user", content: "offline", timestamp: 1 }] };
const signal = new AbortController().signal;
function env(values: Record<string, string> = {}): AuthContext {
	return { env: async name => values[name], fileExists: async () => false };
}
function store(credential?: Credential) {
	let writes = 0;
	const storage: CredentialStore = {
		read: async () => credential,
		list: async () => credential ? [{ providerId: "anthropic", type: credential.type }] : [],
		modify: async () => { writes++; throw new Error("unexpected credential write"); },
		delete: async () => { writes++; throw new Error("unexpected credential delete"); },
	};
	return { storage, writes: () => writes };
}

test("retired login, refresh, derivation and bundled loader fail locally", async () => {
	let effects = 0;
	registerBundledOAuthFlowLoaders({ anthropic: () => { effects++; return anthropicOAuth; } } as never);
	const loaded = await loadAnthropicOAuth();
	assert.equal(loaded, anthropicOAuth);
	const credential = { type: "oauth", access: token, refresh: "synthetic", expires: 0 } as const;
	await assert.rejects(loaded.login({ signal, prompt: async () => { effects++; return ""; }, notify: () => { effects++; } }), disabled);
	await assert.rejects(loaded.refresh(credential, signal), disabled);
	await assert.rejects(loaded.toAuth(credential), disabled);
	assert.equal(effects, 0);
});

test("stored OAuth is never refreshed, mutated or replaced by an ambient key", async () => {
	for (const expires of [0, Date.now() + 3600000]) {
		const credential = { type: "oauth", access: token, refresh: "synthetic", expires } as const;
		const fixture = store(credential);
		let envReads = 0;
		const authContext = { ...env(), env: async () => { envReads++; return "sk-ant-api03-synthetic"; } };
		await assert.rejects(resolveProviderAuth(provider, fixture.storage, authContext), disabled);
		const models = createModels({ credentials: fixture.storage, authContext });
		models.setProvider(provider);
		await assert.rejects(models.login("anthropic", "oauth", { prompt: async () => "", notify: () => {} }), disabled);
		assert.equal(fixture.writes(), 0);
		assert.equal(envReads, 0);
		assert.deepEqual(await fixture.storage.read("anthropic"), credential);
		const explicit = await resolveProviderAuth(provider, fixture.storage, authContext, { apiKey: "sk-ant-api03-explicit" });
		assert.equal(explicit?.auth.apiKey, "sk-ant-api03-explicit");
	}
});

test("retired environment sources fail without fallback; ordinary API and proxy auth remain", async () => {
	for (const source of ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
		const values = { ANTHROPIC_API_KEY: "sk-ant-api03-fallback", [source]: source === "ANTHROPIC_OAUTH_TOKEN" ? "opaque-old-token" : token };
		await assert.rejects(resolveProviderAuth(provider, store().storage, env(values)), disabled);
		assert.throws(() => getEnvApiKey("anthropic", { ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_OAUTH_TOKEN: "", ...values }), disabled);
	}
	const proxy = await resolveProviderAuth(provider, store().storage, env({ ANTHROPIC_AUTH_TOKEN: "proxy-synthetic" }));
	assert.equal(proxy?.auth.headers?.Authorization, "Bearer proxy-synthetic");
	const api = await resolveProviderAuth(provider, store().storage, env({ ANTHROPIC_API_KEY: "sk-ant-api03-synthetic" }));
	assert.equal(api?.auth.apiKey, "sk-ant-api03-synthetic");
	await assert.rejects(resolveProviderAuth(provider, store({ type: "api_key", key: token }).storage, env()), disabled);
});

test("direct Messages calls reject retired credentials before transport, payload hooks or retries", async () => {
	let effects = 0;
	const fetch: typeof globalThis.fetch = async () => { effects++; throw new Error("offline network sentinel"); };
	for (const options of [
		{ apiKey: token },
		{ headers: { aUtHoRiZaTiOn: `Bearer ${token}` } },
		{ headers: { "X-Api-Key": token } },
		{ client: new Anthropic({ apiKey: null, authToken: token, fetch }) },
		{ client: new Anthropic({ apiKey: "ordinary", authToken: null, defaultHeaders: { Authorization: `Bearer ${token}` }, fetch }) },
		{ client: new Anthropic({ apiKey: "ordinary", authToken: null, defaultHeaders: new Headers({ "x-api-key": token }), fetch }) },
	]) {
		const result = await stream(model, context, { ...options, fetch, maxRetries: 3, onPayload: () => { effects++; } } as never).result();
		assert.match(result.errorMessage!, disabled);
		assert.equal(isRetryableAssistantError(result), false);
		assert.equal(result.errorMessage!.includes(token), false);
	}
	const result = await stream({ ...model, headers: { Authorization: `Bearer ${token}` } }, context, { apiKey: "ordinary", fetch }).result();
	assert.match(result.errorMessage!, disabled);
	assert.equal(effects, 0);
});

function response(): Response {
	const events = [
		{ type: "message_start", message: { id: "offline", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-new", name: "read", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("SDK structured and anonymous client authentication is rejected before hooks or token resolution", async (t) => {
	let resolutions = 0;
	let effects = 0;
	// Discovery can start in the SDK constructor. Stub it before constructing any
	// anonymous/profile client so this regression never reads real credentials.
	t.mock.method(Anthropic.prototype as any, "_resolveDefaultCredentials", async () => {});
	const fetch: typeof globalThis.fetch = async () => { effects++; return response(); };
	const credentials = async () => { resolutions++; return { token, expiresAt: null }; };
	const configured = new Anthropic({ apiKey: null, authToken: null, credentials, fetch });
	const clients = [
		configured, configured.withOptions({ timeout: 1000 }),
		new Anthropic({ apiKey: null, authToken: null, profile: "offline-fixture", fetch }),
		new Anthropic({ apiKey: null, authToken: null, config: {
			authentication: { type: "user_oauth", credentials_path: ".git/f06-inline-tools-20261012/never-read-fixture.json" },
		}, fetch }),
		new Anthropic({ apiKey: null, authToken: null, defaultHeaders: { Authorization: "Bearer offline-proxy" }, fetch }),
	];
	for (const client of clients) {
		const result = await stream(model, context, { client, maxRetries: 0, onPayload: () => { effects++; } }).result();
		assert.match(result.errorMessage ?? "", /\[ANTHROPIC_CLIENT_AUTH_UNSUPPORTED\]/);
		assert.equal(isRetryableAssistantError(result), false);
		assert.equal(result.errorMessage!.includes(token), false);
	}
	assert.equal(resolutions, 0);
	assert.equal(effects, 0);
});

test("built-in proxy authentication disables SDK ambient discovery", async (t) => {
	let discoveries = 0;
	t.mock.method(Anthropic.prototype as any, "_resolveDefaultCredentials", async () => { discoveries++; });
	const fetch: typeof globalThis.fetch = async () => response();
	const result = await stream(model, context, { headers: { Authorization: "Bearer offline-proxy" }, fetch }).result();
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	class HeaderClient extends Anthropic {
		protected override _shouldResolveDefaultCredentials(): boolean { return false; }
	}
	for (const client of [
		new Anthropic({ apiKey: "offline-key", authToken: null, fetch }),
		new Anthropic({ apiKey: null, authToken: "offline-proxy", fetch }),
		new HeaderClient({ apiKey: null, authToken: null, defaultHeaders: { Authorization: "Bearer offline-proxy" }, fetch }),
	]) {
		const injected = await stream(model, context, { client }).result();
		assert.equal(injected.stopReason, "toolUse", injected.errorMessage);
	}
	assert.equal(discoveries, 0);
});

test("SDK ambient custom headers cannot inject retired credentials into built-in requests", async (t) => {
	const previous = process.env.ANTHROPIC_CUSTOM_HEADERS;
	t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS; else process.env.ANTHROPIC_CUSTOM_HEADERS = previous; });
	process.env.ANTHROPIC_CUSTOM_HEADERS = `Authorization: Bearer ${token}`;
	let effects = 0;
	const result = await stream(model, context, { apiKey: "offline-key", fetch: async () => { effects++; return response(); }, onPayload: () => { effects++; } }).result();
	assert.match(result.errorMessage ?? "", disabled);
	assert.equal(effects, 0);
});

test("standard API actual wire keeps identity, tools/history IDs, images, thinking, cache and legal betas", async () => {
	const captured: { headers: Headers; body: any }[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		captured.push({ headers: request.headers, body: await request.json() });
		return response();
	};
	const history: Context = {
		systemPrompt: "Super Pi fixture",
		tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
		messages: [
			{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 },
			{ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [
				{ type: "thinking", thinking: "offline thought", thinkingSignature: "synthetic-signature" },
				{ type: "toolCall", id: "historic-id", name: "Read", arguments: {} },
			], stopReason: "toolUse", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			{ role: "toolResult", toolCallId: "historic-id", toolName: "Read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 },
		],
	};
	const output = await stream(model, history, { apiKey: "sk-ant-api03-synthetic", fetch, thinkingEnabled: true, thinkingBudgetTokens: 1024, cacheRetention: "long" }).result();
	assert.equal(output.stopReason, "toolUse", output.errorMessage);
	assert.equal(output.content[0].type === "toolCall" && output.content[0].name, "read");
	assert.equal(captured.length, 1);
	const { headers, body } = captured[0];
	assert.equal(headers.get("x-api-key"), "sk-ant-api03-synthetic");
	assert.equal(headers.has("authorization"), false);
	assert.equal(headers.has("x-app"), false);
	assert.match(headers.get("user-agent")!, /^pi \(/i);
	assert.doesNotMatch(headers.get("anthropic-beta") ?? "", /claude-code|oauth/);
	assert.match(headers.get("anthropic-beta")!, /interleaved-thinking/);
	assert.equal(body.system.length, 1);
	assert.equal(body.system[0].text, history.systemPrompt);
	assert.equal(body.system[0].cache_control.type, "ephemeral");
	assert.equal(body.thinking.type, "enabled");
	assert.equal(body.tools[0].name, "read");
	assert.equal(body.messages[0].content[0].type, "image");
	assert.equal(body.messages[1].content[0].signature, "synthetic-signature");
	assert.equal(body.messages[1].content[1].name, "Read");
	assert.equal(body.messages[1].content[1].id, body.messages[2].content[0].tool_use_id);
	await stream({ ...model, provider: "proxy" }, context, { headers: { Authorization: "Bearer proxy-synthetic" }, fetch }).result();
	assert.equal(captured[1].headers.get("authorization"), "Bearer proxy-synthetic");
	assert.equal(captured[1].headers.has("x-app"), false);
});
