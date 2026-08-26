import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import {
	createExtensionRuntime,
	ExtensionHookTimeoutError,
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
	return new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		{} as ModelRegistry,
		options,
	);
}

test("legacy on handlers remain serial and awaited by default", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const runner = await createRunner((pi) => {
		pi.on("message_update", async () => {
			calls.push("first-start");
			await gate;
			calls.push("first-end");
		});
		pi.on("message_update", async () => {
			calls.push("second");
		});
	});

	const emitted = runner.emit({
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	} as never);
	await Promise.resolve();
	assert.deepEqual(calls, ["first-start"]);
	release();
	await emitted;
	assert.deepEqual(calls, ["first-start", "first-end", "second"]);
});

test("transform timeout can fail open while preserving handler order", async () => {
	const scheduler = new FakeScheduler();
	const calls: string[] = [];
	const runner = await createRunner(
		(pi) => {
			pi.on("message_end", async () => {
				calls.push("timed-out");
				await new Promise(() => {});
			});
			pi.on("message_end", (event) => {
				calls.push("replacement");
				return { message: { ...event.message, content: [{ type: "text", text: "replacement" }] } };
			});
		},
		{
			scheduler,
			hookTimeouts: { transform: { timeoutMs: 100, onTimeout: "fail-open" } },
		},
	);

	const resultPromise = runner.emitMessageEnd({
		type: "message_end",
		message: { role: "assistant", content: [] },
	} as never);
	scheduler.advanceBy(100);
	const result = await resultPromise;

	assert.deepEqual(calls, ["timed-out", "replacement"]);
	const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	assert.equal(content?.[0]?.type, "text");
	assert.equal(content?.[0]?.text, "replacement");
	assert.equal(runner.hookDeliveryStats.timeouts, 1);
});

test("configured safety hook timeout is fail-closed", async () => {
	const scheduler = new FakeScheduler();
	const runner = await createRunner(
		(pi) => {
			pi.on("tool_call", async () => await new Promise(() => {}));
		},
		{ scheduler, hookTimeouts: { safety: { timeoutMs: 100 } } },
	);

	const resultPromise = runner.emitToolCall({
		type: "tool_call",
		toolName: "read",
		toolCallId: "tool-1",
		input: {},
	});
	scheduler.advanceBy(100);
	await assert.rejects(resultPromise, ExtensionHookTimeoutError);
	assert.equal(runner.hookDeliveryStats.timeouts, 1);
});

test("AgentSession routes high-frequency display events through subscribeObserver", async () => {
	const source = await import("node:fs/promises").then((fs) =>
		fs.readFile(new URL("../packages/coding-agent/src/core/agent-session.ts", import.meta.url), "utf8"),
	);
	assert.match(source, /agent\.subscribeObserver\(this\._handleAgentObserverEvent/);
	assert.match(source, /_extensionObserverDelivery\.publishLatest\(key, event\)/);
	assert.match(source, /_extensionObserverDelivery\.flushAllLatest\(\)/);
	assert.match(source, /this\._emit\(event\);[\s\S]*_extensionObserverDelivery\.publishLatest/);
	assert.match(source, /hasObservers\(event\.type\)/);
	assert.doesNotMatch(source, /agent\.subscribe\(this\._handleAgentEvent\);/);
});
