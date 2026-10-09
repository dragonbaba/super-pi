import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { stream } from "../packages/ai/src/api/mistral-conversations.ts";
import type { FetchFunction, Model } from "../packages/ai/src/types.ts";
import { isRetryableAssistantError } from "../packages/ai/src/utils/retry.ts";

const model: Model<"mistral-conversations"> = {
	id: "mistral-small-latest", name: "Offline Mistral", provider: "mistral", api: "mistral-conversations",
	baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
};
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
const encoder = new TextEncoder();

function clock(t: TestContext) {
	let now = 0;
	let created = 0;
	let highWater = 0;
	const timers = new Map<object, { due: number; callback: (...args: any[]) => void; args: any[] }>();
	function schedule(callback: (...args: any[]) => void, delay = 0, ...args: any[]) {
		const handle = { unref() { return this; } };
		timers.set(handle, { due: now + delay, callback, args });
		created++;
		highWater = Math.max(highWater, timers.size);
		return handle as ReturnType<typeof setTimeout>;
	}
	t.mock.method(globalThis, "setTimeout", schedule);
	t.mock.method(globalThis, "clearTimeout", (handle: object) => { timers.delete(handle); });
	// Native AbortSignal.timeout bypasses global timers; virtualize it to reproduce the old implementation too.
	t.mock.method(AbortSignal, "timeout", (delay: number) => {
		if (!Number.isInteger(delay) || delay < 0 || delay > 0xffffffff) throw new RangeError("invalid delay");
		const controller = new AbortController();
		schedule(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), delay);
		return controller.signal;
	});
	return {
		advance(ms: number) {
			now += ms;
			for (const [handle, timer] of timers) {
				if (timer.due <= now) { timers.delete(handle); timer.callback(...timer.args); }
			}
		},
		get pending() { return timers.size; },
		get created() { return created; },
		get highWater() { return highWater; },
	};
}

function transport(t: TestContext, status = 200, obeyAbort = true) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let signal: AbortSignal | undefined;
	let resolveHeaders!: (response: Response) => void;
	let rejectHeaders!: (error: unknown) => void;
	let calls = 0;
	let cancellations = 0;
	let headersSent = false;
	let closed = false;
	function detach() { signal?.removeEventListener("abort", onAbort); }
	function onAbort() {
		detach();
		if (!headersSent) rejectHeaders(signal!.reason);
		if (!closed) { closed = true; controller.error(signal!.reason); }
	}
	const response = new Response(new ReadableStream<Uint8Array>({
		start(value) { controller = value; },
		cancel() { cancellations++; closed = true; detach(); },
	}), { status, headers: { "content-type": "text/event-stream" } });
	const fetch: FetchFunction = (_input, init) => {
		calls++;
		signal = init?.signal ?? undefined;
		return new Promise<Response>((resolve, reject) => {
			resolveHeaders = resolve;
			rejectHeaders = reject;
			if (obeyAbort) {
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			}
		});
	};
	t.after(async () => {
		detach();
		if (!response.body!.locked) await response.body!.cancel().catch(() => {});
	});
	return {
		fetch, response,
		headers() { headersSent = true; resolveHeaders(response); },
		reject(error: unknown) { detach(); rejectHeaders(error); },
		text(text: string) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)); },
		thinking(text: string) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: [{ type: "thinking", thinking: [{ text }] }] } }] })}\n\n`)); },
		raw(text: string) { controller.enqueue(encoder.encode(text)); },
		finish() {
			controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n'));
			closed = true; controller.close(); detach();
		},
		close() { closed = true; controller.close(); detach(); },
		fail(error: Error) { closed = true; controller.error(error); detach(); },
		get signal() { return signal; },
		get calls() { return calls; },
		get cancellations() { return cancellations; },
	};
}

for (const withCaller of [false, true]) {
	test(`Mistral active thinking/text survives the header deadline (caller=${withCaller})`, async t => {
		const time = clock(t);
		const wire = transport(t);
		const caller = new AbortController();
		const events = stream(model, context, { apiKey: "fixture", fetch: wire.fetch, signal: withCaller ? caller.signal : undefined });
		await nextTurn();
		wire.headers();
		await nextTurn();
		wire.thinking("before");
		await nextTurn();
		time.advance(70_000);
		assert.equal(wire.signal!.aborted, false, "headers must disarm the total request deadline");
		wire.thinking(" after");
		wire.text("done");
		wire.finish();
		const result = await events.result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(result.content.map(block => block.type === "thinking" ? block.thinking : block.type === "text" ? block.text : "tool"), ["before after", "done"]);
		assert.equal(time.highWater, 1);
		assert.equal(time.pending, 0);
		assert.equal(wire.response.body!.locked, false);
		assert.equal(getEventListeners(wire.signal!, "abort").length, 0);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	});
}

for (const timeoutMs of [undefined, 25]) {
	test(`Mistral headers still time out after ${timeoutMs ?? 60_000}ms`, async t => {
		const time = clock(t);
		const wire = transport(t);
		const events = stream(model, context, { apiKey: "fixture", fetch: wire.fetch, timeoutMs });
		await nextTurn();
		time.advance((timeoutMs ?? 60_000) - 1);
		assert.equal(wire.signal!.aborted, false);
		time.advance(1);
		const result = await events.result();
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, `Mistral response headers timed out after ${timeoutMs ?? 60_000}ms`);
		assert.equal(isRetryableAssistantError(result), true);
		assert.equal(time.pending, 0);
		assert.equal(getEventListeners(wire.signal!, "abort").length, 0);
	});
}

for (const phase of ["before request", "headers", "body", "HTTP error body"] as const) {
	test(`Mistral caller cancellation remains effective during ${phase}`, async t => {
		const time = clock(t);
		const wire = transport(t, phase === "HTTP error body" ? 500 : 200);
		const caller = new AbortController();
		if (phase === "before request") caller.abort("fixture canceled");
		const events = stream(model, context, { apiKey: "fixture", fetch: wire.fetch, signal: caller.signal });
		await nextTurn();
		if (phase === "body" || phase === "HTTP error body") {
			wire.headers();
			await nextTurn();
			time.advance(70_000);
			assert.equal(wire.signal!.aborted, false);
		}
		caller.abort("fixture canceled");
		const result = await events.result();
		assert.equal(result.stopReason, "aborted");
		assert.equal(isRetryableAssistantError(result), false);
		assert.equal(time.pending, 0);
		assert.equal(wire.response.body!.locked, false);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		if (phase === "before request") {
			assert.equal(wire.calls, 0);
			assert.equal(time.created, 0);
		}
	});
}

test("Mistral delayed response hook and quiet body do not inherit the header deadline", async t => {
	const time = clock(t);
	const wire = transport(t);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const events = stream(model, context, { apiKey: "fixture", fetch: wire.fetch, onResponse: () => gate });
	await nextTurn();
	wire.headers();
	await nextTurn();
	try {
		time.advance(70_000);
		assert.equal(wire.signal!.aborted, false);
		assert.equal(time.pending, 0);
	} finally { release(); }
	await nextTurn();
	time.advance(70_000);
	wire.text("after quiet period");
	wire.finish();
	assert.equal((await events.result()).stopReason, "stop");
});

test("Mistral throwing response hook cancels its unread body and clears the deadline", async t => {
	const time = clock(t);
	const wire = transport(t);
	const events = stream(model, context, { apiKey: "fixture", fetch: wire.fetch, onResponse() { throw new Error("hook failed"); } });
	await nextTurn();
	wire.headers();
	const result = await events.result();
	assert.equal(result.errorMessage, "hook failed");
	assert.equal(time.pending, 0);
	assert.equal(wire.cancellations, 1);
	assert.equal(wire.response.body!.locked, false);
	assert.equal(getEventListeners(wire.signal!, "abort").length, 0);
});

for (const failure of ["fetch", "HTTP", "idle", "SSE", "missing body"] as const) {
	test(`Mistral ${failure} failure preserves its error and releases request resources`, async t => {
		const time = clock(t);
		const wire = transport(t, failure === "HTTP" ? 503 : 200);
		const events = stream(model, context, { apiKey: "fixture", fetch: failure === "missing body" ? async () => new Response(null, { status: 204 }) : wire.fetch });
		await nextTurn();
		if (failure === "fetch") wire.reject(new Error("connection failed"));
		else if (failure !== "missing body") {
			wire.headers();
			await nextTurn();
			if (failure === "HTTP") { wire.raw("service unavailable"); wire.close(); }
			if (failure === "idle") { time.advance(70_000); wire.fail(new Error("transport body timeout")); }
			if (failure === "SSE") { wire.raw("data: {invalid-json}\n\n"); wire.close(); }
		}
		const result = await events.result();
		assert.equal(result.stopReason, "error");
		if (failure === "fetch") assert.equal(result.errorMessage, "connection failed");
		if (failure === "HTTP") assert.equal(result.errorMessage, "Mistral API error (503): service unavailable");
		if (failure === "idle") assert.equal(result.errorMessage, "transport body timeout");
		if (failure === "missing body") assert.equal(result.errorMessage, "Mistral response has no body");
		assert.equal(time.pending, 0);
		assert.equal(wire.response.body!.locked, false);
		if (wire.signal) assert.equal(getEventListeners(wire.signal, "abort").length, 0);
	});
}

test("Mistral discards a late custom-fetch response after the header timeout", async t => {
	const time = clock(t);
	const wire = transport(t, 200, false);
	let responses = 0;
	const events = stream(model, context, { apiKey: "fixture", fetch: wire.fetch, timeoutMs: 5, onResponse() { responses++; } });
	await nextTurn();
	time.advance(5);
	wire.headers();
	const result = await events.result();
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "Mistral response headers timed out after 5ms");
	assert.equal(responses, 0);
	assert.equal(wire.cancellations, 1);
	assert.equal(time.pending, 0);
});

test("Mistral rejects invalid timeouts before allocating a deadline or sending", async t => {
	const time = clock(t);
	let calls = 0;
	for (const timeoutMs of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
		const result = await stream(model, context, { apiKey: "fixture", timeoutMs, fetch: async () => { calls++; return new Response(); } }).result();
		assert.equal(result.stopReason, "error");
	}
	assert.equal(calls, 0);
	assert.equal(time.created, 0);
});

test("Mistral native fetch keeps a local HTTP body alive after headers and still cancels it", { timeout: 15_000 }, async t => {
	let serverResponse!: ServerResponse;
	let bodyClosed!: () => void;
	let closed = new Promise<void>(resolve => { bodyClosed = resolve; });
	const server = createServer((_request, response) => {
		serverResponse = response;
		response.once("close", () => bodyClosed());
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
	});
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close(error => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const localModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}` };
	for (const cancel of [false, true]) {
		closed = new Promise<void>(resolve => { bodyClosed = resolve; });
		const caller = new AbortController();
		const events = stream(localModel, context, { apiKey: "fixture", timeoutMs: 1000, signal: caller.signal });
		let first = true;
		for await (const event of events) {
			if (event.type !== "text_delta" || !first) continue;
			first = false;
			if (cancel) caller.abort("fixture canceled");
			else {
				await delay(1100);
				serverResponse.end('data: {"choices":[{"finish_reason":"stop","delta":{"content":" last"}}]}\n\ndata: [DONE]\n\n');
			}
		}
		const result = await events.result();
		assert.equal(first, false);
		assert.equal(result.stopReason, cancel ? "aborted" : "stop", result.errorMessage);
		if (!cancel) {
			assert.equal(result.content[0].type, "text");
			assert.equal(result.content[0].text, "first last");
		}
		await closed;
	}
});
