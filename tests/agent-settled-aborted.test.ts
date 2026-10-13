import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { toJsonEvent } from "../packages/coding-agent/src/modes/json-event.ts";
import type { ExtensionFactory } from "../packages/coding-agent/src/core/extensions/types.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";

type Reason = "stop" | "error" | "aborted" | "throw";

function gate() {
	let resolve!: () => void;
	return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
}

async function fixture(reasons: Reason[], extension?: ExtensionFactory, retry = false, baseDelayMs = 60_000, autoCompact = false) {
	const root = mkdtempSync(join(tmpdir(), "pi-settled-"));
	const settings = SettingsManager.inMemory({ compaction: { enabled: autoCompact, keepRecentTokens: 32, reserveTokens: 128 },
		retry: { enabled: retry, maxRetries: 1, baseDelayMs } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: !extension, extensionFactories: extension ? [extension] : [], noContextFiles: true,
		noSkills: true, noPromptTemplates: true, noThemes: true });
	let calls = 0;
	const runtime = alphaModelRuntime(() => {
		const reason = reasons[calls++] ?? "stop";
		if (reason === "throw") throw new Error("fixture consumer failure");
		const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "fixture" }],
			api: ALPHA_MODEL.api, model: ALPHA_MODEL.id, provider: ALPHA_MODEL.provider, timestamp: 1, stopReason: reason,
			usage: { input: autoCompact ? 200_000 : 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: autoCompact ? 200_000 : 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			...(reason === "error" ? { errorMessage: "server_busy" } : {}) };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		if (reason === "stop") stream.push({ type: "done", reason, message });
		else stream.push({ type: "error", reason, error: message });
		stream.end();
		return stream;
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(root);
	if (autoCompact) sessionManager.appendMessage({ role: "user", content: "earlier history ".repeat(2048), timestamp: 0 });
	const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
		settingsManager: settings, sessionManager, model: ALPHA_MODEL,
		modelRuntime: runtime, noTools: "all" });
	const settled: unknown[] = [];
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_settled") settled.push(JSON.parse(JSON.stringify(toJsonEvent(event))));
	});
	return { session, settled, calls: () => calls, release() {
		unsubscribe();
		session.dispose();
		assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
		rmSync(root, { recursive: true, force: true });
	} };
}

for (const reason of ["stop", "error", "throw", "aborted"] as const) {
	test(`settlement distinguishes ${reason} from explicit cancellation`, async () => {
		const f = await fixture([reason]);
		try {
			await f.session.prompt("fixture");
			assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: reason === "aborted" }]);
			assert.equal(f.session.isIdle, true);
			assert.equal(f.session.agent.signal, undefined);
		} finally { f.release(); }
	});
}

for (const entry of ["session", "agent"] as const) {
	test(`${entry} cancellation after successful output survives settlement and resets on next admission`, async () => {
		const f = await fixture(["stop", "stop"]);
		let cancellation: Promise<void> | undefined;
		let rejectedAdmission: Promise<void> | undefined;
		const unsubscribe = f.session.subscribe(event => {
			if (event.type !== "agent_end" || f.calls() !== 1) return;
			if (entry === "session") cancellation = f.session.abort();
			else f.session.agent.abort();
			rejectedAdmission = assert.rejects(f.session.agent.prompt("rejected"), /already processing/);
		});
		try {
			await f.session.prompt("first");
			await cancellation;
			await rejectedAdmission;
			assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: true }]);
			await f.session.abort(); // An idle cancellation must not poison the next run.
			await f.session.prompt("second");
			assert.deepEqual(f.settled[1], { type: "agent_settled", aborted: false });
			assert.equal(f.session.agent.signal, undefined);
			assert.equal((f.session as any)._idleWaitPromise, undefined);
			assert.equal((f.session as any)._resolveIdleWait, undefined);
		} finally { unsubscribe(); f.release(); }
	});
}

test("cancellation during retry backoff is reported despite an error as the last reply", async () => {
	const f = await fixture(["error"], undefined, true);
	const unsubscribe = f.session.subscribe(event => {
		if (event.type === "auto_retry_start") queueMicrotask(() => f.session.abortRetry());
	});
	try {
		await f.session.prompt("retry");
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: true }]);
		assert.equal(f.calls(), 1);
		assert.equal(f.session.isRetrying, false);
		assert.equal((f.session as any)._retryAbortController, undefined);
	} finally { unsubscribe(); f.release(); }
});

test("settlement snapshots cancellation before extension code changes the event or starts another run", async () => {
	const extensionEvents: unknown[] = [];
	let nested: (() => Promise<void>) | undefined;
	const f = await fixture(["stop", "stop"], pi => {
		pi.on("agent_settled", async event => {
			extensionEvents.push(structuredClone(event));
			if (extensionEvents.length === 1) {
				event.aborted = false;
				await nested!();
			}
		});
	});
	nested = () => f.session.prompt("nested");
	const unsubscribe = f.session.subscribe(event => {
		if (event.type === "agent_end" && f.calls() === 1) f.session.agent.abort();
	});
	try {
		await f.session.prompt("first");
		assert.deepEqual(extensionEvents, [{ type: "agent_settled", aborted: true }, { type: "agent_settled", aborted: false }]);
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: false }], "public settlement describes only the latest admission");
	} finally { nested = undefined; unsubscribe(); f.release(); }
});

test("a successful automatic retry is not cancellation", async () => {
	const f = await fixture(["error", "stop"], undefined, true, 0);
	try {
		await f.session.prompt("retry");
		assert.equal(f.calls(), 2);
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: false }]);
		assert.equal(f.session.isRetrying, false);
	} finally { f.release(); }
});

test("completion messages arriving during final custom cleanup wake one successor without polling", async () => {
	const entered = gate(), released = gate();
	const f = await fixture(["stop", "stop"], pi => {
		pi.on("message_end", async event => {
			if (event.message.role === "custom" && event.message.content === "cleanup-note") {
				entered.release(); await released.promise;
			}
		});
	});
	f.session.agent.followUpMode = "all";
	const off = f.session.subscribe(event => {
		if (event.type === "agent_end" && f.calls() === 1)
			void f.session.sendCustomMessage({ customType: "note", content: "cleanup-note", display: false }, { triggerTurn: false });
	});
	const run = f.session.prompt("first");
	try {
		await entered.promise;
		for (const content of ["completed-A", "completed-B"])
			await f.session.sendCustomMessage({ customType: "note", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		released.release(); await run;
		assert.equal(f.calls(), 2);
		assert.equal(f.session.agent.hasQueuedMessages(), false);
		for (const content of ["completed-A", "completed-B"])
			assert.equal(f.session.messages.filter(m => m.role === "custom" && m.content === content).length, 1);
		assert.equal(f.settled.length, 1);
		assert.equal(f.session.isIdle, true);
	} finally { released.release(); await run; off(); f.release(); }
});

test("a completion at agent_end joins an already flushed note without an empty model turn", async () => {
	const f = await fixture(["stop", "stop"]);
	const off = f.session.subscribe(event => {
		if (f.calls() !== 1) return;
		if (event.type === "turn_end") void f.session.sendCustomMessage({ customType: "note", content: "context", display: false }, { triggerTurn: false });
		if (event.type === "agent_end") void f.session.sendCustomMessage({ customType: "note", content: "completed", display: true }, { triggerTurn: true, deliverAs: "followUp" });
	});
	try {
		await f.session.prompt("first");
		assert.equal(f.calls(), 2);
		assert.equal(f.session.agent.hasQueuedMessages(), false);
	} finally { off(); f.release(); }
});

test("old settlement cannot clear a still-running successor or resolve its idle waiter", async () => {
	const entered = gate(), released = gate();
	let successor: Promise<void> | undefined;
	let startSuccessor!: () => Promise<void>;
	let started = false;
	const f = await fixture(["stop", "stop"], pi => {
		pi.on("agent_settled", async () => {
			if (started) return;
			started = true;
			successor = startSuccessor();
			await entered.promise;
		});
	});
	startSuccessor = () => f.session.sendCustomMessage({ customType: "note", content: "successor", display: true }, { triggerTurn: true });
	let admissions = 0;
	const off = f.session.agent.subscribe(async event => {
		if (event.type === "agent_start" && ++admissions === 2) { entered.release(); await released.promise; }
	});
	try {
		await f.session.prompt("first");
		assert.equal(f.session.isStreaming, true);
		assert.equal(f.session.isIdle, false);
		assert.equal(f.settled.length, 0, "RPC/UI subscribers must not see the predecessor settle after successor start");
		let idle = false;
		const waiting = f.session.waitForIdle().then(() => { idle = true; });
		await Promise.resolve();
		assert.equal(idle, false);
		released.release(); await successor; await waiting;
		assert.equal(idle, true);
		assert.equal(f.session.isIdle, true);
		assert.equal(f.calls(), 2);
		assert.equal(f.settled.length, 1);
	} finally { released.release(); await successor; off(); f.release(); }
});

for (const boundary of ["during-cleanup", "after-queue-check"] as const) test(`cancellation ${boundary} retains a completion until an explicit next prompt`, async t => {
	const entered = gate(), released = gate();
	const f = await fixture(["stop", "stop"], pi => {
		pi.on("message_end", async event => {
			if (event.message.role === "custom" && event.message.content === "cleanup-note") {
				entered.release(); await released.promise;
			}
		});
	});
	const off = f.session.subscribe(event => {
		if (event.type === "agent_end" && f.calls() === 1)
			void f.session.sendCustomMessage({ customType: "note", content: "cleanup-note", display: false }, { triggerTurn: false });
	});
	let cancelled: Promise<void> | undefined;
	if (boundary === "after-queue-check") {
		const internal = f.session as any, settle = internal._emitAgentSettled.bind(internal);
		t.mock.method(internal, "_emitAgentSettled", async (continueQueued: boolean) => {
			const resume = await settle(continueQueued);
			if (resume && !cancelled) cancelled = f.session.abort();
			return resume;
		});
	}
	const run = f.session.prompt("first");
	try {
		await entered.promise;
		await f.session.sendCustomMessage({ customType: "note", content: "completed", display: true }, { triggerTurn: true, deliverAs: "followUp" });
		if (boundary === "during-cleanup") cancelled = f.session.abort();
		released.release(); await run; await cancelled;
		assert.equal(f.calls(), 1);
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: true }]);
		await f.session.prompt("continue");
		assert.equal(f.session.messages.filter(m => m.role === "custom" && m.content === "completed").length, 1);
	} finally { released.release(); await run; off(); f.release(); }
});

test("completion reports cannot revive a disposed session", async () => {
	const f = await fixture(["stop"]);
	try {
		f.session.dispose();
		await assert.rejects(f.session.sendCustomMessage({ customType: "note", content: "late report", display: true }, { triggerTurn: true }), /disposed/i);
		assert.equal(f.calls(), 0);
	} finally { f.release(); }
});

test("automatic compaction cancellation survives controller release", async () => {
	let cancel!: () => void;
	let compactions = 0;
	const f = await fixture(["stop"], pi => {
		pi.on("session_before_compact", event => {
			compactions++;
			cancel();
			assert.equal(event.signal.aborted, true);
			return { cancel: true };
		});
	}, false, 0, true);
	cancel = () => f.session.abortCompaction();
	try {
		await f.session.prompt("history ".repeat(2048));
		assert.equal(compactions, 1);
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: true }]);
		assert.equal((f.session as any)._autoCompactionAbortController, undefined);
		assert.equal(f.session.isIdle, true);
	} finally { f.release(); }
});

test("settlement releases run signals and disposed owners", { skip: !global.gc }, async t => {
	const refs: WeakRef<object>[] = [];
	async function run(reason: Reason) {
		const f = await fixture([reason]);
		refs.push(new WeakRef(f.session), new WeakRef(f.session.agent));
		const unsubscribe = f.session.subscribe(event => {
			if (event.type === "agent_start") refs.push(new WeakRef(f.session.agent.signal!));
		});
		try {
			const note = f.session.sendCustomMessage({ customType: "note", content: "lifecycle", display: false }, { triggerTurn: false });
			refs.push(new WeakRef((f.session as any)._customMessageFlush));
			await note;
			assert.equal((f.session as any)._customMessageFlush, undefined);
			await f.session.prompt("lifecycle");
		}
		finally { unsubscribe(); f.release(); }
	}
	for (const reason of ["stop", "error", "aborted"] as const) await run(reason);
	for (let i = 0; i < 8; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
		global.gc!();
	}
	assert.equal(refs.length, 12);
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	t.diagnostic("settlement lifecycle WeakRefs=12 retained=0 (includes custom-message drain owners)");
});
