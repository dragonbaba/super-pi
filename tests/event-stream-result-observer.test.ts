import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { AssistantMessageEventStream, EventStream } from "../packages/ai/src/utils/event-stream.ts";

function response(): AssistantMessage {
	return { role: "assistant", content: [], api: "openai-responses", provider: "fixture", model: "fixture",
		timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
			totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("result observer receives the finalized immutable response identity before consumers", async () => {
	const stream = new AssistantMessageEventStream(), original = Object.freeze(response());
	let observed: AssistantMessage | undefined;
	const observer = { onResult(message: AssistantMessage | undefined) { observed = message; } };
	stream.observeResult(observer);
	assert.throws(() => stream.observeResult(observer), /already registered/);
	for (let i = 0; i < 1000; i++) stream.push({ type: "start", partial: original });
	assert.equal(observed, undefined);
	stream.push(Object.freeze({ type: "done", reason: "stop", message: original }));
	assert.ok(observed);
	const finalized = await stream.result();
	assert.equal(observed, finalized);
	assert.notEqual(observed, original); assert.equal(typeof finalized.durationMs, "number");
	assert.equal((stream as any).resultObserver, undefined);
	for await (const event of stream) if (event.type === "done") assert.equal(event.message, observed);
});

test("synchronously completed and end-only streams support late observation without a Promise tail", async () => {
	for (const terminal of ["push", "end"] as const) {
		const stream = new AssistantMessageEventStream(), original = response();
		if (terminal === "push") stream.push({ type: "done", reason: "stop", message: original });
		else stream.end(original);
		let observed: AssistantMessage | undefined;
		stream.observeResult({ onResult(message) { observed = message; } });
		assert.equal(observed, await stream.result());
		stream.end(response());
		assert.equal(observed, await stream.result(), "later end cannot replace the settled identity");
		assert.equal((stream as any).resultObserver, undefined);
	}
});

test("observer errors cannot break terminal delivery and missing result releases the observer", async () => {
	const stream = new AssistantMessageEventStream();
	stream.observeResult({ onResult() { throw new Error("observer fixture"); } });
	stream.push({ type: "done", reason: "stop", message: response() });
	assert.equal((await stream.result()).stopReason, "stop");
	const incomplete = new AssistantMessageEventStream();
	let calls = 0;
	incomplete.observeResult({ onResult(message) { assert.equal(message, undefined); calls++; } });
	incomplete.end(); incomplete.end();
	assert.equal(calls, 1); assert.equal((incomplete as any).resultObserver, undefined);
});

test("generic stream result can legitimately be undefined", async () => {
	const stream = new EventStream<number, undefined>(() => true, () => undefined);
	let calls = 0;
	stream.observeResult({ onResult(value) { assert.equal(value, undefined); calls++; } });
	stream.push(1);
	assert.equal(await stream.result(), undefined); assert.equal(calls, 1);
});

test("an external asynchronous observer rejection is isolated at the completion boundary", async () => {
	const stream = new AssistantMessageEventStream();
	stream.observeResult({ async onResult() { throw new Error("async observer fixture"); } });
	stream.end(response());
	assert.equal((await stream.result()).stopReason, "stop");
	await nextTurn();
});
