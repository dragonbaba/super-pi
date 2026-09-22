import assert from "node:assert/strict";
import test from "node:test";
import { EventStream } from "../packages/ai/src/utils/event-stream.ts";

type FixtureEvent = { kind: "value" | "final" | "error"; value: number };

function stream(): EventStream<FixtureEvent, number> {
	return new EventStream(
		(event) => event.kind === "final" || event.kind === "error",
		(event) => event.value,
	);
}

function queueState(value: EventStream<any, any>): { queue: { length: number }; waiting: { length: number } } {
	const internal = value as unknown as { queue: { length: number }; waiting: { length: number } };
	return { queue: { length: internal.queue.length }, waiting: { length: internal.waiting.length } };
}

test("prequeued events remain FIFO and final result resolves independently", async () => {
	const events = stream();
	events.push({ kind: "value", value: 1 });
	events.push({ kind: "value", value: 2 });
	events.push({ kind: "final", value: 3 });
	const received: number[] = [];
	for await (const event of events) received.push(event.value);
	assert.deepEqual(received, [1, 2, 3]);
	assert.equal(await events.result(), 3);
	assert.deepEqual(queueState(events), { queue: { length: 0 }, waiting: { length: 0 } });
});

test("waiting consumers receive events in registration order and end releases waiters", async () => {
	const events = stream();
	const iterator = events[Symbol.asyncIterator]();
	const first = iterator.next();
	const second = iterator.next();
	events.push({ kind: "value", value: 10 });
	events.push({ kind: "value", value: 20 });
	assert.deepEqual(await first, { value: { kind: "value", value: 10 }, done: false });
	assert.deepEqual(await second, { value: { kind: "value", value: 20 }, done: false });
	const finished = iterator.next();
	events.end(99);
	assert.deepEqual(await finished, { value: undefined, done: true });
	assert.equal(await events.result(), 99);
	assert.equal(queueState(events).waiting.length, 0);
});

test("early iterator exit preserves undelivered provider events for a later consumer", async () => {
	const events = stream();
	events.push({ kind: "value", value: 1 });
	events.push({ kind: "value", value: 2 });
	events.push({ kind: "final", value: 3 });
	for await (const event of events) {
		assert.equal(event.value, 1);
		break;
	}
	assert.equal(queueState(events).queue.length, 2);
	const remainder: number[] = [];
	for await (const event of events) remainder.push(event.value);
	assert.deepEqual(remainder, [2, 3]);
	assert.equal(await events.result(), 3);
	assert.equal(queueState(events).queue.length, 0);
});

test("error completion and post-end pushes preserve result and release queue state", async () => {
	const events = stream();
	events.push({ kind: "error", value: 17 });
	assert.equal(await events.result(), 17);
	events.push({ kind: "value", value: 18 });
	events.end(19);
	const received: number[] = [];
	for await (const event of events) received.push(event.value);
	assert.deepEqual(received, [17]);
	assert.equal(await events.result(), 17);
	assert.deepEqual(queueState(events), { queue: { length: 0 }, waiting: { length: 0 } });
});

test("high backlog drains in order without retaining queue slots", async () => {
	const events = stream();
	const count = 50_000;
	for (let index = 0; index < count; index++) events.push({ kind: "value", value: index });
	events.push({ kind: "final", value: count });
	let next = 0;
	for await (const event of events) assert.equal(event.value, next++);
	assert.equal(next, count + 1);
	assert.equal(queueState(events).queue.length, 0);
	assert.equal(queueState(events).waiting.length, 0);
});
