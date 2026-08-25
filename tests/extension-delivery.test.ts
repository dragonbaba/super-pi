import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import {
	createExtensionRuntime,
	ExtensionRunner,
	loadExtensionFromFactory,
} from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";

const cwd = "D:/workspace";

async function createRunner(
	factory: Parameters<typeof loadExtensionFromFactory>[0],
	options: ConstructorParameters<typeof ExtensionRunner>[5] = {},
) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime);
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		{} as ModelRegistry,
		options,
	);
	return { extension, runner };
}

const messageUpdate = {
	type: "message_update",
	message: { role: "assistant", content: [] },
	assistantMessageEvent: { type: "text_delta", delta: "x" },
} as never;

test("observe registrations are separate from awaited compatibility handlers", async () => {
	const calls: string[] = [];
	const { extension, runner } = await createRunner((pi) => {
		pi.on("message_update", async () => {
			calls.push("on");
		});
		pi.observe("message_update", async () => {
			calls.push("observe");
		});
	});

	assert.equal(extension.handlers.get("message_update")?.length, 1);
	assert.equal(extension.observers.get("message_update")?.length, 1);
	assert.equal(runner.hasHandlers("message_update"), true);
	assert.equal(runner.hasObservers("message_update"), true);

	await runner.emitObservers(messageUpdate);
	assert.deepEqual(calls, ["observe"]);
	await runner.emit(messageUpdate);
	assert.deepEqual(calls, ["observe", "on"]);
});

test("observer failures are isolated and open a per-observer circuit", async () => {
	const scheduler = new FakeScheduler();
	let failingCalls = 0;
	let healthyCalls = 0;
	const diagnostics: string[] = [];
	const { runner } = await createRunner(
		(pi) => {
			pi.observe(
				"message_update",
				() => {
					failingCalls++;
					throw new Error("observer failed");
				},
				{ disableAfterErrors: 2 },
			);
			pi.observe("message_update", () => {
				healthyCalls++;
				scheduler.advanceBy(50);
			}, { slowThresholdMs: 50 });
		},
		{ scheduler },
	);
	runner.onObserverDiagnostic((diagnostic) => diagnostics.push(diagnostic.type));

	for (let index = 0; index < 3; index++) await runner.emitObservers(messageUpdate);

	assert.equal(failingCalls, 2);
	assert.equal(healthyCalls, 3);
	assert.deepEqual(diagnostics, [
		"observer-error",
		"observer-slow",
		"observer-error",
		"observer-disabled",
		"observer-slow",
		"observer-slow",
	]);
	assert.deepEqual(runner.observerDeliveryStats, {
		received: 6,
		delivered: 3,
		errors: 2,
		slow: 3,
		disabled: 1,
		durationP95Ms: 50,
	});
});
