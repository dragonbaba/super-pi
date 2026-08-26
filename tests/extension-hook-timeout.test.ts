import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLI_EXTENSION_HOST_POLICY } from "../packages/coding-agent/src/core/extension-host-policy.ts";
import type { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import {
	createExtensionRuntime,
	ExtensionHookTimeoutError,
	ExtensionRunner,
	loadExtensionFromFactory,
} from "../packages/coding-agent/src/core/extensions/index.ts";
import { emitProjectTrustEvent } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { ProjectTrustStore } from "../packages/coding-agent/src/core/trust-manager.ts";
import { createMainProjectTrustResolver } from "../packages/coding-agent/src/main.ts";
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

test("project_trust uses the safety timeout, fails closed, and ignores a late allow result", async () => {
	const scheduler = new FakeScheduler();
	let releaseLate = () => {};
	const late = new Promise<void>((resolve) => { releaseLate = resolve; });
	let fallbackCalls = 0;
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory((pi) => {
		pi.on("project_trust", async () => {
			await late;
			return { trusted: "yes" };
		});
		pi.on("project_trust", () => {
			fallbackCalls++;
			return { trusted: "yes" };
		});
	}, cwd, createEventBus(), runtime);
	const resultPromise = emitProjectTrustEvent(
		{ extensions: [extension], errors: [], runtime },
		{ type: "project_trust", cwd },
		{ cwd, mode: "print", hasUI: false, ui: {} } as never,
		{ scheduler, hookTimeouts: { safety: { timeoutMs: 100 } } },
	);

	scheduler.advanceBy(100);
	const outcome = await resultPromise;
	assert.equal(outcome.result?.trusted, "no");
	assert.equal(outcome.errors.length, 1);
	assert.match(outcome.errors[0]?.error ?? "", /timed out after 100ms/);
	assert.equal(fallbackCalls, 0);
	releaseLate();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(outcome.result?.trusted, "no");
});

test("main runtime project trust callback applies the shared CLI safety timeout", async () => {
	const root = mkdtempSync(join(tmpdir(), "super-pi-main-trust-timeout-"));
	try {
		const projectCwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(projectCwd, ".sp", "extensions"), { recursive: true });
		const scheduler = new FakeScheduler();
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory((pi) => {
			pi.on("project_trust", async () => await new Promise(() => {}));
		}, projectCwd, createEventBus(), runtime);
		const diagnostics: string[] = [];
		let resolved: boolean | undefined;
		const extensionRunnerOptions = { ...CLI_EXTENSION_HOST_POLICY, scheduler };
		const resolveProjectTrust = createMainProjectTrustResolver({
			cwd: projectCwd,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "ask",
			projectTrustContext: { cwd: projectCwd, mode: "print", hasUI: false, ui: {} } as never,
			extensionRunnerOptions,
			onExtensionError: (message) => diagnostics.push(message),
			onResolved: (trusted) => { resolved = trusted; },
		});

		const resultPromise = resolveProjectTrust({ extensionsResult: { extensions: [extension], errors: [], runtime } });
		scheduler.advanceBy(CLI_EXTENSION_HOST_POLICY.hookTimeouts.safety.timeoutMs);
		const trusted = await resultPromise;

		assert.equal(trusted, false);
		assert.equal(resolved, false);
		assert.equal(scheduler.pendingTasks, 0);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0] ?? "", /project_trust error:.*timed out after 30000ms/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a late transform result is ignored after a fail-open timeout", async () => {
	const scheduler = new FakeScheduler();
	let releaseLate = () => {};
	const late = new Promise<void>((resolve) => { releaseLate = resolve; });
	const runner = await createRunner(
		(pi) => {
			pi.on("message_end", async (event) => {
				await late;
				return { message: { ...event.message, content: [{ type: "text", text: "late" }] } };
			});
			pi.on("message_end", (event) => ({
				message: { ...event.message, content: [{ type: "text", text: "accepted" }] },
			}));
		},
		{ scheduler, hookTimeouts: { transform: { timeoutMs: 100, onTimeout: "fail-open" } } },
	);
	const resultPromise = runner.emitMessageEnd({
		type: "message_end",
		message: { role: "assistant", content: [] },
	} as never);
	scheduler.advanceBy(100);
	const result = await resultPromise as { content: Array<{ type: string; text: string }> };
	assert.equal(result.content[0]?.text, "accepted");
	releaseLate();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(result.content[0]?.text, "accepted");
});

test("hook timeout configuration rejects non-finite and negative durations", async () => {
	for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
		await assert.rejects(
			createRunner(() => {}, { hookTimeouts: { safety: { timeoutMs } } }),
			RangeError,
		);
	}
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
