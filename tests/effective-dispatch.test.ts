import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	closeOpenAICodexWebSocketSessions,
	stream,
} from "../packages/ai/src/api/openai-codex-responses.ts";
import { deriveModelCapabilities } from "../packages/ai/src/model-capabilities.ts";
import type {
	Context,
	EffectiveDispatchObservation,
	Model,
} from "../packages/ai/src/types.ts";

const terminalResponse = {
	type: "response.completed",
	response: {
		id: "response-test",
		status: "completed",
		output: [],
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			total_tokens: 2,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	},
};

class FakeCodexWebSocket {
	static mode: "success" | "fail" = "success";
	static sentBodies: Array<Record<string, unknown>> = [];
	readonly listeners = new Map<string, Set<(event: unknown) => void>>();
	readyState = 0;

	constructor(_url: string, _options?: unknown) {
		queueMicrotask(() => {
			if (FakeCodexWebSocket.mode === "fail") {
				this.emit("error", new Error("synthetic websocket failure"));
				return;
			}
			this.readyState = 1;
			this.emit("open", {});
		});
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		FakeCodexWebSocket.sentBodies.push(JSON.parse(data) as Record<string, unknown>);
		queueMicrotask(() => this.emit("message", { data: JSON.stringify(terminalResponse) }));
	}

	close(): void {
		this.readyState = 3;
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function model(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.test/backend-api",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function modelWithoutPreviousResponse(): Model<"openai-codex-responses"> {
	const base = model();
	return {
		...base,
		capabilities: {
			...deriveModelCapabilities(base),
			previousResponseId: false,
			websocketContinuation: false,
			remoteCompaction: false,
		},
	};
}

function context(): Context {
	return {
		systemPrompt: "effective instructions",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		}],
	};
}

function token(): string {
	const payload = btoa(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
	}));
	return `header.${payload}.signature`;
}

function sseResponse(): Response {
	return new Response(`data: ${JSON.stringify(terminalResponse)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function jsonHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("auto transport records the successful effective WebSocket dispatch", async () => {
	const originalWebSocket = globalThis.WebSocket;
	FakeCodexWebSocket.mode = "success";
	globalThis.WebSocket = FakeCodexWebSocket as unknown as typeof WebSocket;
	const observations: EffectiveDispatchObservation[] = [];
	try {
		await stream(model(), context(), {
			apiKey: token(),
			transport: "auto",
			sessionId: "effective-ws",
			onEffectiveDispatch: (observation) => { observations.push(observation); },
		}).result();
		assert.equal(observations.length, 1);
		assert.equal(observations[0]?.transport, "websocket");
		assert.equal(observations[0]?.previousResponseMode, "none");
		assert.equal(typeof observations[0]?.requestTransformOutputHash, "string");
	} finally {
		closeOpenAICodexWebSocketSessions("effective-ws");
		globalThis.WebSocket = originalWebSocket;
	}
});

test("auto transport records SSE only after WebSocket fallback wins dispatch", async () => {
	const originalWebSocket = globalThis.WebSocket;
	FakeCodexWebSocket.mode = "fail";
	globalThis.WebSocket = FakeCodexWebSocket as unknown as typeof WebSocket;
	const observations: EffectiveDispatchObservation[] = [];
	try {
		await stream(model(), context(), {
			apiKey: token(),
			transport: "auto",
			sessionId: "effective-sse",
			fetch: async () => sseResponse(),
			onPayload: (payload) => ({ ...(payload as object), instructions: "transformed instructions" }),
			onEffectiveDispatch: (observation) => { observations.push(observation); },
		}).result();
		assert.equal(observations.length, 1);
		assert.equal(observations[0]?.transport, "sse");
		assert.equal(observations[0]?.previousResponseMode, "none");
		assert.equal(observations[0]?.instructionsHash, jsonHash("transformed instructions"));
		assert.equal(typeof observations[0]?.prefixHash, "string");
		assert.equal(JSON.stringify(observations[0]).includes("transformed instructions"), false);
	} finally {
		closeOpenAICodexWebSocketSessions("effective-sse");
		globalThis.WebSocket = originalWebSocket;
	}
});

test("Codex previousResponseMode follows previous_response_id on the actual dispatched body", async () => {
	const originalWebSocket = globalThis.WebSocket;
	FakeCodexWebSocket.mode = "success";
	FakeCodexWebSocket.sentBodies = [];
	globalThis.WebSocket = FakeCodexWebSocket as unknown as typeof WebSocket;
	const observations: EffectiveDispatchObservation[] = [];
	try {
		for (let index = 0; index < 2; index++) {
			await stream(model(), context(), {
				apiKey: token(),
				transport: "auto",
				sessionId: "effective-ws-delta",
				onEffectiveDispatch: (observation) => { observations.push(observation); },
			}).result();
		}
		assert.equal(FakeCodexWebSocket.sentBodies[0]?.previous_response_id, undefined);
		assert.equal(FakeCodexWebSocket.sentBodies[1]?.previous_response_id, "response-test");
		assert.deepEqual(observations.map((observation) => observation.previousResponseMode), ["none", "response-id"]);
	} finally {
		closeOpenAICodexWebSocketSessions("effective-ws-delta");
		globalThis.WebSocket = originalWebSocket;
	}
});

test("Codex previousResponseId=false disables cached continuation", async () => {
	const originalWebSocket = globalThis.WebSocket;
	FakeCodexWebSocket.mode = "success";
	FakeCodexWebSocket.sentBodies = [];
	globalThis.WebSocket = FakeCodexWebSocket as unknown as typeof WebSocket;
	const dispatchedPayloads: Array<Record<string, unknown>> = [];
	let sseRequests = 0;
	const observations: EffectiveDispatchObservation[] = [];
	try {
		for (let index = 0; index < 2; index++) {
			await stream(modelWithoutPreviousResponse(), context(), {
				apiKey: token(),
				transport: "auto",
				sessionId: "effective-ws-no-continuation",
				fetch: async () => {
					sseRequests++;
					return sseResponse();
				},
				onPayload: (payload) => {
					dispatchedPayloads.push(structuredClone(payload as Record<string, unknown>));
					return payload;
				},
				onEffectiveDispatch: (observation) => { observations.push(observation); },
			}).result();
		}
		assert.deepEqual(FakeCodexWebSocket.sentBodies, []);
		assert.equal(sseRequests, 2);
		assert.deepEqual(dispatchedPayloads.map((body) => body.previous_response_id), [undefined, undefined]);
		assert.deepEqual(observations.map((observation) => observation.transport), ["sse", "sse"]);
		assert.deepEqual(observations.map((observation) => observation.previousResponseMode), ["none", "none"]);
	} finally {
		closeOpenAICodexWebSocketSessions("effective-ws-no-continuation");
		globalThis.WebSocket = originalWebSocket;
	}
});

test("async effective dispatch observer rejection cannot fail or become unhandled by provider delivery", async () => {
	const originalWebSocket = globalThis.WebSocket;
	FakeCodexWebSocket.mode = "fail";
	globalThis.WebSocket = FakeCodexWebSocket as unknown as typeof WebSocket;
	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", listener);
	try {
		await stream(model(), context(), {
			apiKey: token(),
			transport: "auto",
			sessionId: "effective-async-isolation",
			fetch: async () => sseResponse(),
			onEffectiveDispatch: async () => { throw new Error("observer rejected"); },
		}).result();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		closeOpenAICodexWebSocketSessions("effective-async-isolation");
		process.off("unhandledRejection", listener);
		globalThis.WebSocket = originalWebSocket;
	}
});
