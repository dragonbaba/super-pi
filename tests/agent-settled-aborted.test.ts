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
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: false }, { type: "agent_settled", aborted: true }]);
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
		try { await f.session.prompt("lifecycle"); }
		finally { unsubscribe(); f.release(); }
	}
	for (const reason of ["stop", "error", "aborted"] as const) await run(reason);
	for (let i = 0; i < 8; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
		global.gc!();
	}
	assert.equal(refs.length, 9);
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	t.diagnostic("settlement lifecycle WeakRefs=9 retained=0");
});
