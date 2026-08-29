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

class ReleaseTrackingDispatcher extends EventDeliveryDispatcher<FixtureEvent, string> {
	readonly releasedKeys: string[] = [];
	readonly releasedSequences: number[] = [];

	protected override onLatestReleased(key: string, event: FixtureEvent): void {
		this.releasedKeys.push(key);
		this.releasedSequences.push(event.sequence);
	}
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

test("latest ownership releases only after every observer has consumed the pending version", async () => {
	const scheduler = new FakeScheduler();
	let snapshots = 0;
	let slowDeliveries = 0;
	const dispatcher = new ReleaseTrackingDispatcher({
		scheduler,
		snapshotLatest: (event) => {
			snapshots++;
			return { ...event };
		},
	});
	dispatcher.subscribe(() => {}, {
		delivery: "latest",
		minIntervalMs: 0,
		filter: () => false,
	});
	dispatcher.subscribe(() => { slowDeliveries++; }, { delivery: "latest", minIntervalMs: 16 });

	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	scheduler.advanceBy(0);
	await nextTask();
	assert.equal(snapshots, 1);
	assert.equal(slowDeliveries, 0);
	assert.deepEqual(dispatcher.releasedKeys, []);
	assert.deepEqual(dispatcher.releasedSequences, []);
	assert.equal(dispatcher.stats.pendingKeys, 1);

	dispatcher.publishLatest("message", { type: "update", sequence: 2 });
	scheduler.advanceBy(0);
	await nextTask();
	assert.equal(snapshots, 2);
	assert.equal(slowDeliveries, 0);
	assert.deepEqual(dispatcher.releasedSequences, []);

	scheduler.advanceBy(16);
	await nextTask();
	assert.equal(slowDeliveries, 1);
	assert.deepEqual(dispatcher.releasedKeys, ["message"]);
	assert.deepEqual(dispatcher.releasedSequences, [2]);
	assert.equal(dispatcher.stats.pendingKeys, 0);
});

test("latest ownership releases on snapshot errors, final unsubscribe, and disposal", async () => {
	const snapshotErrorDispatcher = new ReleaseTrackingDispatcher({
		snapshotLatest: () => { throw new Error("snapshot failed"); },
	});
	snapshotErrorDispatcher.subscribe(() => {}, { delivery: "latest" });
	snapshotErrorDispatcher.publishLatest("message", { type: "update", sequence: 1 });
	await snapshotErrorDispatcher.flushAllLatest();
	assert.deepEqual(snapshotErrorDispatcher.releasedSequences, [1]);

	const unsubscribeDispatcher = new ReleaseTrackingDispatcher();
	const unsubscribe = unsubscribeDispatcher.subscribe(() => {}, { delivery: "latest", minIntervalMs: 60_000 });
	unsubscribeDispatcher.publishLatest("message", { type: "update", sequence: 2 });
	unsubscribe();
	assert.deepEqual(unsubscribeDispatcher.releasedSequences, [2]);

	const disposeDispatcher = new ReleaseTrackingDispatcher();
	disposeDispatcher.subscribe(() => {}, { delivery: "latest", minIntervalMs: 60_000 });
	disposeDispatcher.publishLatest("message", { type: "update", sequence: 3 });
	await disposeDispatcher.dispose();
	assert.deepEqual(disposeDispatcher.releasedSequences, [3]);
});

test("scheduled latest flushes reuse one class callback with explicit dispatcher context", () => {
	const callbacks: Array<(context: unknown) => void> = [];
	const contexts: unknown[] = [];
	const dispatcher = new EventDeliveryDispatcher<FixtureEvent, string>({
		scheduler: {
			now(): number { return 0; },
			schedule(callback, _delayMs, context): number {
				callbacks.push(callback);
				contexts.push(context);
				return callbacks.length;
			},
			cancel(): void {},
		},
	});
	let unsubscribe = dispatcher.subscribe(() => {}, { delivery: "latest", minIntervalMs: 16 });
	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	unsubscribe();
	unsubscribe = dispatcher.subscribe(() => {}, { delivery: "latest", minIntervalMs: 16 });
	dispatcher.publishLatest("message", { type: "update", sequence: 2 });
	unsubscribe();

	assert.equal(callbacks.length, 2);
	assert.equal(callbacks[0], callbacks[1]);
	assert.equal(contexts[0], dispatcher);
	assert.equal(contexts[1], dispatcher);
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

test("unsubscribing the final latest observer cancels its scheduled flush", () => {
	const scheduler = new FakeScheduler();
	const dispatcher = new EventDeliveryDispatcher<FixtureEvent, string>({ scheduler });
	const unsubscribe = dispatcher.subscribe(() => {}, {
		delivery: "latest",
		minIntervalMs: 60_000,
	});
	dispatcher.publishLatest("message", { type: "update", sequence: 1 });
	assert.equal(dispatcher.stats.pendingKeys, 1);
	assert.equal(scheduler.pendingTasks, 1);

	unsubscribe();

	assert.equal(dispatcher.stats.pendingKeys, 0);
	assert.equal(scheduler.pendingTasks, 0);
});

test("unsubscribing a latest observer recalculates the next remaining due time", async () => {
	const scheduler = new FakeScheduler();
	const scheduledDelays: number[] = [];
	const dispatcher = new EventDeliveryDispatcher<FixtureEvent, string>({
		scheduler: {
			now: () => scheduler.now(),
			schedule: (callback, delayMs, context) => {
				scheduledDelays.push(delayMs);
				return scheduler.schedule(callback, delayMs, context);
			},
			cancel: (handle) => scheduler.cancel(handle as number),
		},
	});
	const observed: number[] = [];
	const unsubscribeSooner = dispatcher.subscribe(() => {}, {
		delivery: "latest",
		minIntervalMs: 60_000,
	});
	dispatcher.subscribe((event) => { observed.push(event.sequence); }, {
		delivery: "latest",
		minIntervalMs: 120_000,
	});
	dispatcher.publishLatest("message", { type: "update", sequence: 1 });

	unsubscribeSooner();
	assert.deepEqual(scheduledDelays, [60_000, 120_000]);
	scheduler.advanceBy(60_000);
	await Promise.resolve();
	assert.deepEqual(observed, []);
	assert.equal(scheduler.pendingTasks, 1);

	scheduler.advanceBy(60_000);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(observed, [1]);
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
