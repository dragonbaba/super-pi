import assert from "node:assert/strict";
import test from "node:test";
import extension from "../../packages/openai-server-compaction/src/index.ts";
import { callRemoteCompactionEndpoint } from "../../packages/openai-server-compaction/src/remote-compaction.ts";

// Remote compaction may retry through unary /compact only after an explicit pre-output 400/404
// saying compaction_trigger / remote_compaction_v2 is unsupported. Everything else fails once.
const KEY = "sk-sentinel-compaction-key";
const model: any = { id: "gpt-5.1", name: "fixture", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 128_000 };
const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
const compaction = { type: "compaction", encrypted_content: "opaque" };
const v2Stream = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const v2Success = () => v2Stream([{ type: "response.output_item.done", item: compaction }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
const error = (status: number, message: string) => () => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const unsupported = "Unsupported input item type: compaction_trigger";

async function run(responses: Array<(signal: AbortSignal) => Response | Promise<Response>>, signal?: AbortSignal) {
	const original = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		urls.push(new URL(String(url)).pathname);
		assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${KEY}`);
		const next = responses.shift();
		if (!next) throw new Error("unexpected compaction request");
		return next(init!.signal!);
	}) as typeof fetch;
	try {
		const result = await callRemoteCompactionEndpoint({ model, apiKey: KEY, sessionId: "s", regularPayload: { model: model.id, input }, input: input as never, signal })
			.then(value => ({ value }), (reason: unknown) => ({ reason }));
		return { urls, ...result };
	} finally {
		globalThis.fetch = original;
	}
}

for (const [name, first] of [
	["400 unsupported compaction_trigger", error(400, unsupported)],
	["404 remote_compaction_v2 not enabled", error(404, "remote_compaction_v2 is not enabled for this account")],
] as const) test(`remote compaction falls back to unary exactly once for ${name}`, async () => {
	const result = await run([first, () => new Response(JSON.stringify({ output: [compaction] }), { status: 200 })]);
	assert.deepEqual(result.urls, ["/v1/responses", "/v1/responses/compact"]);
	assert.equal((result as any).value.protocol, "responses_compact_v1");
});

for (const [name, first] of [
	["generic 400", error(400, "Invalid request: context too long")],
	["401 with unsupported wording", error(401, unsupported)],
	["403 entitlement", error(403, `${unsupported} for this plan`)],
	["429 quota", error(429, `Rate limited; ${unsupported}`)],
	["500", error(500, unsupported)],
	["malformed success stream", () => new Response("data: {not json}\n\n", { status: 200 })],
	["success stream without completion", () => v2Stream([{ type: "response.output_item.done", item: compaction }])],
	["stream error after output", () => v2Stream([{ type: "response.output_item.done", item: compaction }, { type: "error", message: unsupported }])],
] as const) test(`remote compaction fails once without unary retry for ${name}`, async () => {
	const result = await run([first]);
	assert.deepEqual(result.urls, ["/v1/responses"]);
	assert.ok("reason" in result);
	assert.equal(String((result.reason as Error).message).includes(KEY), false);
});

test("remote compaction does not retry after the unary fallback also fails", async () => {
	const result = await run([error(400, unsupported), error(400, unsupported)]);
	assert.deepEqual(result.urls, ["/v1/responses", "/v1/responses/compact"]);
	assert.ok("reason" in result);
});

test("aborted remote compaction sends no second request", async () => {
	const controller = new AbortController();
	const result = await run([signal => new Promise<Response>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		controller.abort(new Error("user cancelled"));
	})], controller.signal);
	assert.deepEqual(result.urls, ["/v1/responses"]);
	assert.match(String((result as any).reason?.message), /user cancelled/);
});

test("successful v2 compaction uses one request and keeps the opaque item", async () => {
	const result = await run([v2Success]);
	assert.deepEqual(result.urls, ["/v1/responses"]);
	const value = (result as any).value;
	assert.equal(value.protocol, "responses_compaction_v2");
	assert.ok(JSON.stringify(value.output).includes("opaque"));
});

// GPT compaction is failed-closed at the extension boundary; non-GPT keeps default fallback.
async function beforeCompact(modelId: string, authError: string) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const entries: Array<[string, unknown]> = [];
	const notices: string[] = [];
	const pi: any = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerProvider() {}, registerCommand() {}, sendMessage() {}, getThinkingLevel: () => "off",
		appendEntry: (type: string, data: unknown) => entries.push([type, data]),
	};
	extension(pi);
	const ctx = {
		cwd: process.cwd(), isProjectTrusted: () => false, hasUI: true, model: { ...model, id: modelId },
		ui: { notify: (message: string) => notices.push(message) },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: authError }) },
		sessionManager: { getSessionId: () => "s", getBranch: () => [], buildContextEntries: () => [] },
	};
	const previous = process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED;
	process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = "1";
	try {
		const result = await handlers.get("session_before_compact")!({ signal: new AbortController().signal, preparation: {} }, ctx);
		return { result, entries, notices };
	} finally {
		if (previous === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED;
		else process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = previous;
	}
}

test("GPT compaction auth failure cancels compaction with enum-only telemetry", async () => {
	const { result, entries, notices } = await beforeCompact("gpt-5.1", `OAuth refresh failed for openai: token ${KEY}`);
	assert.deepEqual(result, { cancel: true });
	assert.equal(entries.length, 1);
	const [type, data] = entries[0]!;
	assert.equal(type, "compaction-telemetry-v1");
	assert.deepEqual(Object.keys(data as object).sort(), ["failureClass", "model", "outcome", "producerVersion", "reason", "schemaVersion", "strategy"]);
	assert.equal((data as any).outcome, "failed_closed");
	assert.equal(JSON.stringify(data).includes(KEY), false);
	assert.equal(notices.length, 1);
});

test("non-GPT compaction auth failure keeps the default fallback", async () => {
	const { result, entries } = await beforeCompact("o3", "API key unavailable");
	assert.equal(result, undefined);
	assert.equal(entries.length, 0);
});
