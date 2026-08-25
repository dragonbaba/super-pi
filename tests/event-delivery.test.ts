import assert from "node:assert/strict";
import test from "node:test";
import {
	EventDeliveryDispatcher,
	type EventDeliveryDiagnostic,
} from "../packages/agent/src/event-delivery.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";

interface FixtureEvent {
	type: "update" | "end";
	sequence: number;
}

function createDispatcher(diagnostics: EventDeliveryDiagnostic[] = []) {
	const scheduler = new FakeScheduler();
	const dispatcher = new EventDeliveryDispatcher<FixtureEvent, string>({
		scheduler,
		defaultMinIntervalMs: 16,
		snapshotLatest: (event) => ({ ...event }),
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	});
	return { dispatcher, scheduler };
}

test("latest delivery stays bounded by active keys and flushes the final value", async () => {
	const { dispatcher, scheduler } = createDispatcher();
	const observed: FixtureEvent[] = [];
	dispatcher.subscribe((event) => { observed.push(event); }, { delivery: "latest" });

	for (let sequence = 0; sequence < 100_000; sequence++) {
		dispatcher.publishLatest("message", { type: "update", sequence });
	}
	assert.equal(dispatcher.stats.pendingKeys, 1);
	assert.equal(dispatcher.stats.maxPendingKeys, 1);
	assert.equal(scheduler.highWaterMark.maximum, 1);
	assert.equal(observed.length, 0);

	await dispatcher.flushAllLatest();
	assert.deepEqual(observed, [{ type: "update", sequence: 99_999 }]);
	assert.equal(dispatcher.stats.pendingKeys, 0);
	assert.equal(dispatcher.stats.coalesced, 99_999);
});

test("critical delivery flushes latest values first and awaits legacy listeners in order", async () => {
	const { dispatcher } = createDispatcher();
	const order: string[] = [];
	dispatcher.subscribe(async (event) => { order.push(`critical-a:${event.type}`); });
	dispatcher.subscribe(async (event) => { order.push(`critical-b:${event.type}`); });
	dispatcher.subscribe(async (event) => { order.push(`observer:${event.type}:${event.sequence}`); }, { delivery: "latest" });

	dispatcher.publishLatest("message", { type: "update", sequence: 7 });
	await dispatcher.publishCritical({ type: "end", sequence: 8 });
	assert.deepEqual(order, [
		"observer:update:7",
		"critical-a:end",
		"critical-b:end",
		"observer:end:8",
	]);
});

test("observer failures are isolated and disposal prevents stale delivery", async () => {
	const diagnostics: EventDeliveryDiagnostic[] = [];
	const { dispatcher } = createDispatcher(diagnostics);
	let healthyDeliveries = 0;
	dispatcher.subscribe(() => { throw new Error("observer failed"); }, { delivery: "latest" });
	dispatcher.subscribe(() => { healthyDeliveries++; }, { delivery: "latest" });
	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	await dispatcher.flushAllLatest();
	assert.equal(healthyDeliveries, 1);
	assert.equal(diagnostics.filter((diagnostic) => diagnostic.type === "observer-error").length, 1);

	dispatcher.publishLatest("message", { type: "update", sequence: 2 });
	await dispatcher.dispose();
	assert.equal(healthyDeliveries, 1);
	assert.equal(dispatcher.stats.pendingKeys, 0);
});

test("reentrant observers retain the newer latest value without deadlock", async () => {
	const { dispatcher } = createDispatcher();
	const observed: number[] = [];
	dispatcher.subscribe((event) => {
		observed.push(event.sequence);
		if (event.sequence === 1) dispatcher.publishLatest("message", { type: "update", sequence: 2 });
	}, { delivery: "latest" });
	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	await dispatcher.flushAllLatest();
	assert.deepEqual(observed, [1, 2]);
	assert.equal(dispatcher.stats.pendingKeys, 0);
});
