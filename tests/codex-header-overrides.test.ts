import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
	buildOpenAICodexRequestBody,
	closeOpenAICodexWebSocketSessions,
	compactOpenAICodexRequest,
	resetOpenAICodexWebSocketDebugStats,
	setOpenAICodexRemoteCompactionCapability,
	stream,
} from "../packages/ai/src/api/openai-codex-responses.ts";
import type { ProviderHeaders } from "../packages/ai/src/types.ts";
import { FakeCodexWebSocket, terminalResponse } from "./helpers/codex-websocket-fixture.ts";
import { codexModel, codexToken, responsesContext, sseFrames, textEvents } from "./helpers/responses-sse-fixture.ts";

function fixture(t: TestContext) {
	const sessionId = `headers-${createHash("sha256").update(t.name).digest("hex").slice(0, 16)}`;
	const originalWebSocket = globalThis.WebSocket;
	const wsHeaders: Headers[] = [];
	const sseHeaders: Headers[] = [];
	const sockets: FakeCodexWebSocket[] = [];
	FakeCodexWebSocket.mode = "success";
	FakeCodexWebSocket.sentBodies = [];
	FakeCodexWebSocket.replies = undefined;
	FakeCodexWebSocket.connections = 0;
	FakeCodexWebSocket.closes = 0;
	class Socket extends FakeCodexWebSocket {
		constructor(url: string, options: { headers: Record<string, string> }) {
			super(url, options);
			wsHeaders.push(new Headers(options.headers));
			sockets.push(this);
		}
	}
	globalThis.WebSocket = Socket as unknown as typeof WebSocket;
	t.after(() => {
		closeOpenAICodexWebSocketSessions(sessionId);
		resetOpenAICodexWebSocketDebugStats(sessionId);
		setOpenAICodexRemoteCompactionCapability(sessionId, false);
		globalThis.WebSocket = originalWebSocket;
		FakeCodexWebSocket.mode = "success";
		FakeCodexWebSocket.sentBodies = [];
		FakeCodexWebSocket.replies = undefined;
	});
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		sseHeaders.push(new Headers(init?.headers));
		return new Response(sseFrames([terminalResponse]), { headers: { "content-type": "text/event-stream" } });
	};
	return { sessionId, fetch, wsHeaders, sseHeaders, sockets };
}

const cases: Array<{
	name: string;
	model?: Record<string, string>;
	caller?: ProviderHeaders;
	originator: string | null;
	userAgent: string | null | RegExp;
}> = [
	{ name: "defaults", originator: "pi", userAgent: /^Super Pi \(/ },
	{ name: "model overrides defaults", model: { Originator: "model", "USER-AGENT": "model-agent" }, originator: "model", userAgent: "model-agent" },
	{ name: "caller overrides defaults", caller: { originator: "caller", "User-Agent": "caller-agent" }, originator: "caller", userAgent: "caller-agent" },
	{ name: "caller overrides model case-insensitively", model: { ORIGINATOR: "model", "User-Agent": "model-agent" }, caller: { Originator: "caller", "user-agent": "caller-agent" }, originator: "caller", userAgent: "caller-agent" },
	{ name: "caller null suppresses defaults", caller: { originator: null, "User-Agent": null }, originator: null, userAgent: null },
	{ name: "caller null removes model values", model: { Originator: "model", "User-Agent": "model-agent" }, caller: { ORIGINATOR: null, "user-agent": null }, originator: null, userAgent: null },
	{ name: "model empty values remain explicit", model: { originator: "", "User-Agent": "" }, originator: "", userAgent: "" },
	{ name: "caller empty values remain explicit", model: { originator: "model", "User-Agent": "model-agent" }, caller: { originator: "", "User-Agent": "" }, originator: "", userAgent: "" },
	{ name: "authentication cannot be overridden", model: { Authorization: "model-token", "chatgpt-account-id": "model-account" }, caller: { authorization: "caller-token", "ChatGPT-Account-ID": "caller-account" }, originator: "pi", userAgent: /^Super Pi \(/ },
	{ name: "authentication cannot be removed", model: { Authorization: "model-token", "chatgpt-account-id": "model-account" }, caller: { AUTHORIZATION: null, "CHATGPT-ACCOUNT-ID": null }, originator: "pi", userAgent: /^Super Pi \(/ },
];

for (const transport of ["sse", "websocket"] as const) {
	for (const entry of cases) {
		test(`Codex ${transport}: ${entry.name}`, async (t) => {
			const f = fixture(t);
			const modelHeaders = entry.model && Object.freeze({ ...entry.model });
			const callerHeaders = entry.caller && Object.freeze({ ...entry.caller });
			const result = await stream({ ...codexModel, headers: modelHeaders }, responsesContext, {
				apiKey: codexToken(), transport, sessionId: f.sessionId, fetch: f.fetch, headers: callerHeaders, maxRetries: 0,
			}).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			const captures = transport === "sse" ? f.sseHeaders : f.wsHeaders;
			assert.equal(captures.length, 1);
			if (transport === "websocket") assert.equal(f.sseHeaders.length, 0, "must exercise WebSocket, not fallback");
			const headers = captures[0]!;
			assert.equal(headers.get("originator"), entry.originator);
			if (entry.userAgent instanceof RegExp) assert.match(headers.get("user-agent")!, entry.userAgent);
			else assert.equal(headers.get("user-agent"), entry.userAgent);
			assert.equal(headers.get("authorization"), `Bearer ${codexToken()}`);
			assert.equal(headers.get("chatgpt-account-id"), "fixture");
			assert.equal(headers.get("session-id"), f.sessionId);
			assert.equal(headers.get("x-client-request-id"), f.sessionId);
			assert.equal(headers.get("accept"), transport === "sse" ? "text/event-stream" : null);
			assert.equal(headers.get("content-type"), transport === "sse" ? "application/json" : null);
			assert.equal(headers.get("openai-beta"), transport === "sse" ? "responses=experimental" : "responses_websockets=2026-02-06");
			assert.deepEqual(modelHeaders, entry.model);
			assert.deepEqual(callerHeaders, entry.caller);
		});
	}
}

test("Codex fallback preserves configured headers across WebSocket and SSE", async (t) => {
	const f = fixture(t);
	FakeCodexWebSocket.mode = "fail";
	const result = await stream({ ...codexModel, headers: { originator: "model" } }, responsesContext, {
		apiKey: codexToken(), transport: "auto", sessionId: f.sessionId, fetch: f.fetch,
		headers: { originator: "caller", "User-Agent": null }, maxRetries: 0,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(f.wsHeaders.length, 1);
	assert.equal(f.sseHeaders.length, 1);
	for (const headers of [f.wsHeaders[0]!, f.sseHeaders[0]!]) {
		assert.equal(headers.get("originator"), "caller");
		assert.equal(headers.get("user-agent"), null);
		assert.equal(headers.get("authorization"), `Bearer ${codexToken()}`);
	}
});

test("Codex reuses matching WebSocket headers and reconnects when either client header changes", async (t) => {
	const f = fixture(t);
	for (const [originator, userAgent, connections] of [
		["first", "agent-one", 1], ["first", "agent-one", 1],
		["second", "agent-one", 2], ["second", "agent-two", 3],
	] as const) {
		const result = await stream(codexModel, responsesContext, {
			apiKey: codexToken(), transport: "websocket", sessionId: f.sessionId, fetch: f.fetch,
			headers: { originator, "User-Agent": userAgent }, maxRetries: 0,
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(FakeCodexWebSocket.connections, connections);
		assert.equal(f.wsHeaders.at(-1)!.get("originator"), originator);
		assert.equal(f.wsHeaders.at(-1)!.get("user-agent"), userAgent);
	}
	assert.equal(f.sseHeaders.length, 0);
	closeOpenAICodexWebSocketSessions(f.sessionId);
	for (const socket of f.sockets) {
		assert.equal(socket.readyState, 3);
		for (const listeners of socket.listeners.values()) assert.equal(listeners.size, 0);
	}
});

for (const transport of ["sse", "websocket"] as const) {
	test(`Codex ${transport} compaction preserves overrides and rejects changed client headers before dispatch`, async (t) => {
		const f = fixture(t);
		setOpenAICodexRemoteCompactionCapability(f.sessionId, true);
		const headers = { originator: "compact-client", "User-Agent": null };
		FakeCodexWebSocket.replies = () => textEvents();
		const options = {
			apiKey: codexToken(), transport: transport === "sse" ? "sse" as const : "websocket-cached" as const,
			sessionId: f.sessionId, headers, maxRetries: 0,
			fetch: (async (_url, init) => {
				f.sseHeaders.push(new Headers(init?.headers));
				return new Response(sseFrames(textEvents()), { headers: { "content-type": "text/event-stream" } });
			}) as typeof globalThis.fetch,
		};
		const result = await stream(codexModel, responsesContext, options).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const regularPayload = buildOpenAICodexRequestBody(codexModel, {
			...responsesContext, messages: [...responsesContext.messages, result],
		}, options, f.sessionId) as unknown as Record<string, unknown>;
		const captures = transport === "sse" ? f.sseHeaders : f.wsHeaders;
		assert.equal(captures[0]!.get("originator"), "compact-client");
		assert.equal(captures[0]!.get("user-agent"), null);
		for (const changed of [{ ...headers, originator: "other" }, { ...headers, "User-Agent": "other" }]) {
			await assert.rejects(compactOpenAICodexRequest(codexModel, regularPayload, { ...options, headers: changed }), /cache-relevant headers differ/);
		}
		assert.equal(f.sseHeaders.length, transport === "sse" ? 1 : 0);
		assert.equal(FakeCodexWebSocket.sentBodies.length, transport === "websocket" ? 1 : 0);
		const artifact = { type: "compaction", encrypted_content: "synthetic-compaction" };
		const compactEvents = [
			{ type: "response.output_item.done", output_index: 0, item: artifact },
			{ type: "response.completed", response: { id: "compacted-response", status: "completed", output: [artifact] } },
		];
		FakeCodexWebSocket.replies = () => compactEvents;
		const compact = await compactOpenAICodexRequest(codexModel, regularPayload, {
			...options, shapeDiagnostics: true,
			fetch: async (_url, init) => {
				f.sseHeaders.push(new Headers(init?.headers));
				return new Response(sseFrames(compactEvents), { headers: { "content-type": "text/event-stream" } });
			},
		});
		assert.equal(compact.diagnostics?.headers, true);
		assert.equal(compact.diagnostics?.inputPrefix, true);
		assert.equal(captures.at(-1)!.get("originator"), "compact-client");
		assert.equal(captures.at(-1)!.get("user-agent"), null);
		assert.equal(captures.at(-1)!.get("authorization"), `Bearer ${codexToken()}`);
		assert.equal(f.sseHeaders.length, transport === "sse" ? 2 : 0);
		assert.equal(FakeCodexWebSocket.connections, transport === "websocket" ? 1 : 0);
	});
}
