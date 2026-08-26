import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
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

test("delivery timing options reject non-finite and negative values", () => {
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
		assert.throws(() => new EventDeliveryDispatcher({ defaultMinIntervalMs: value }), RangeError);
		assert.throws(() => new EventDeliveryDispatcher({ slowObserverMs: value }), RangeError);
	}
	const dispatcher = new EventDeliveryDispatcher<FixtureEvent, string>();
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
		assert.throws(
			() => dispatcher.subscribe(() => {}, { delivery: "latest", minIntervalMs: value }),
			RangeError,
		);
	}
});

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

test("flushLatest only drains its requested key and reschedules other pending keys", async () => {
	const { dispatcher, scheduler } = createDispatcher();
	const observed: number[] = [];
	dispatcher.subscribe((event) => { observed.push(event.sequence); }, { delivery: "latest" });
	dispatcher.publishLatest("first", { type: "update", sequence: 1 });
	dispatcher.publishLatest("second", { type: "update", sequence: 2 });

	await dispatcher.flushLatest("first");
	assert.deepEqual(observed, [1]);
	assert.equal(dispatcher.stats.pendingKeys, 1);
	assert.equal(scheduler.pendingTasks, 1);

	scheduler.advanceBy(16);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(observed, [1, 2]);
	assert.equal(dispatcher.stats.pendingKeys, 0);
});

test("flushLatest returns for a missing key without cancelling unrelated scheduled work", async () => {
	const { dispatcher, scheduler } = createDispatcher();
	const observed: number[] = [];
	dispatcher.subscribe((event) => { observed.push(event.sequence); }, { delivery: "latest" });
	dispatcher.publishLatest("present", { type: "update", sequence: 7 });

	await dispatcher.flushLatest("missing");
	assert.equal(dispatcher.stats.pendingKeys, 1);
	assert.equal(scheduler.pendingTasks, 1);

	scheduler.advanceBy(16);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(observed, [7]);
});

test("repeated missing-key flushes do not recurse through unrelated pending values", async () => {
	const { dispatcher, scheduler } = createDispatcher();
	dispatcher.subscribe(() => {}, { delivery: "latest" });
	dispatcher.publishLatest("present", { type: "update", sequence: 1 });

	for (let index = 0; index < 1_000; index++) await dispatcher.flushLatest("missing");

	assert.equal(dispatcher.stats.pendingKeys, 1);
	assert.equal(scheduler.pendingTasks, 1);
	await dispatcher.flushLatest("present");
	assert.equal(dispatcher.stats.pendingKeys, 0);
});

test("throwing observer filters are diagnosed without affecting healthy observers", async () => {
	const diagnostics: EventDeliveryDiagnostic[] = [];
	const { dispatcher } = createDispatcher(diagnostics);
	let healthyDeliveries = 0;
	dispatcher.subscribe(() => {}, {
		delivery: "latest",
		filter: () => { throw new Error("filter failed"); },
	});
	dispatcher.subscribe(() => { healthyDeliveries++; }, { delivery: "latest" });

	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	await dispatcher.flushAllLatest();

	assert.equal(healthyDeliveries, 1);
	assert.equal(dispatcher.stats.pendingKeys, 0);
	assert.equal(diagnostics.filter((diagnostic) => diagnostic.type === "observer-error").length, 1);
});

test("throwing diagnostics cannot escape observer error isolation", async () => {
	const scheduler = new FakeScheduler();
	const dispatcher = new EventDeliveryDispatcher<FixtureEvent, string>({
		scheduler,
		onDiagnostic: () => { throw new Error("diagnostic failed"); },
	});
	let healthyDeliveries = 0;
	dispatcher.subscribe(() => { throw new Error("observer failed"); }, { delivery: "latest" });
	dispatcher.subscribe(() => { healthyDeliveries++; }, { delivery: "latest" });

	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	await dispatcher.flushAllLatest();

	assert.equal(healthyDeliveries, 1);
	assert.equal(dispatcher.stats.observerErrors, 1);
});

test("scheduled flush isolates failures without unhandled rejections", async () => {
	const diagnostics: EventDeliveryDiagnostic[] = [];
	const { dispatcher, scheduler } = createDispatcher(diagnostics);
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	let healthyDeliveries = 0;
	try {
		dispatcher.subscribe(() => {}, {
			delivery: "latest",
			filter: () => { throw new Error("scheduled filter failed"); },
		});
		dispatcher.subscribe(() => { healthyDeliveries++; }, { delivery: "latest" });
		dispatcher.publishLatest("message", { type: "update", sequence: 1 });

		scheduler.advanceBy(16);
		await nextTask();

		assert.equal(healthyDeliveries, 1);
		assert.equal(unhandled.length, 0);
		assert.equal(diagnostics.filter((diagnostic) => diagnostic.type === "observer-error").length, 1);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
