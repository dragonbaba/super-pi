import assert from "node:assert/strict";
import test from "node:test";
import {
	BENCHMARK_FIXTURE_VERSION,
	benchmarkFixtureManifest,
	createAssistantDeltas,
	createResourceOrderings,
	createToolOutput,
	createToolProgress,
	createTranscriptItems,
} from "../scripts/bench/fixtures.ts";
import { CounterRegistry, FakeClock, FakeProviderStream, FakeScheduler, HighWaterMark } from "./helpers/runtime-instrumentation.ts";

test("benchmark fixture manifest is versioned and deterministic", () => {
	const first = benchmarkFixtureManifest();
	const second = benchmarkFixtureManifest();
	assert.equal(first.version, BENCHMARK_FIXTURE_VERSION);
	assert.deepEqual(first, second);
	assert.deepEqual(
		Object.fromEntries(Object.entries(first.fixtures).map(([name, fixture]) => [name, fixture.sha256])),
		{
			assistantDeltas100k: "d951fcc60ce64a712e4e5942cddd19c09a4654821a545ce28a8c3be5edfbbfd8",
			toolProgress100k: "63f6c593e0917043e1831a2849942d59a5a1367004be97f755516c050225b889",
			transcript5k: "e7491d8a45fff1879998a8ba914f2abd740002c66ed102b0780c853690e573e9",
			transcript50k: "38888f343b0cd1bb016e24380b4d067622599871470e58c307817bb95cfba43c",
			toolOutput1m: "34400900ebb4c42d1e8d2f292ed5655c1f69e930e325da12b1c80d6e5d138c94",
			toolOutput10m: "177f87570538aa3ee086eb2a16d093fc371d422c00d79ee978de76a75123efbd",
			resourceOrderings100: "c9c890a15a88cc2b2f3003acc87f24b8c0b6a08169c7f2057bf9d386bc6d6832",
			modelProfiles: "9e6f8ddda601fa4a19236f6d359173225e16f7b1357c17de805fb9d24df9eb52",
		},
	);
	for (const fixture of Object.values(first.fixtures)) {
		assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
		assert.ok(fixture.items > 0);
	}
});

test("large fixtures have the phase 0 cardinalities without committed result blobs", () => {
	assert.equal(createAssistantDeltas(100_000).length, 100_000);
	assert.equal(createToolProgress(100_000, 4).length, 100_000);
	assert.equal(createTranscriptItems(5_000).length, 5_000);
	assert.equal(createTranscriptItems(50_000).length, 50_000);
	assert.equal(Buffer.byteLength(createToolOutput(1), "utf8"), 1024 * 1024);
	assert.equal(Buffer.byteLength(createToolOutput(10), "utf8"), 10 * 1024 * 1024);
});

test("resource ordering fixtures vary enumeration order but preserve logical identity", () => {
	const orderings = createResourceOrderings(100);
	assert.equal(orderings.length, 100);
	const canonical = orderings[0]!.slice().sort().join("\n");
	assert.ok(orderings.some((ordering) => ordering.join("\n") !== orderings[0]!.join("\n")));
	for (const ordering of orderings) assert.equal(ordering.slice().sort().join("\n"), canonical);
});

test("structural instrumentation is deterministic and independent of wall-clock timers", async () => {
	const clock = new FakeClock();
	const counters = new CounterRegistry();
	const highWater = new HighWaterMark();
	const delivered: number[] = [];
	clock.setTimeout(() => delivered.push(clock.now()), 10);
	clock.setTimeout(() => delivered.push(clock.now()), 5);
	clock.advanceBy(10);
	assert.deepEqual(delivered, [5, 10]);
	assert.equal(clock.pendingTimers, 0);
	const scheduler = new FakeScheduler(clock);
	const scheduled: string[] = [];
	scheduler.schedule(() => scheduled.push("first"), 2);
	const cancelled = scheduler.schedule(() => scheduled.push("cancelled"), 1);
	scheduler.cancel(cancelled);
	scheduler.advanceBy(2);
	assert.deepEqual(scheduled, ["first"]);
	assert.equal(scheduler.pendingTasks, 0);
	assert.equal(scheduler.highWaterMark.maximum, 2);

	counters.increment("render");
	counters.increment("render", 2);
	highWater.set(2);
	highWater.set(1);
	assert.deepEqual(counters.snapshot(), { render: 3 });
	assert.equal(highWater.maximum, 2);

	const events: number[] = [];
	for await (const event of new FakeProviderStream([1, 2, 3])) events.push(event);
	assert.deepEqual(events, [1, 2, 3]);
});
