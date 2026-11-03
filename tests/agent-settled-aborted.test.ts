import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { AgentSessionRuntime } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { toJsonEvent } from "../packages/coding-agent/src/modes/json-event.ts";
import type { ExtensionAPI, ExtensionFactory } from "../packages/coding-agent/src/core/extensions/types.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createLocalShellOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { windowsShellJobDiagnostics } from "../packages/coding-agent/src/utils/windows-shell-job.ts";
import { createJiti } from "jiti";

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

test("execution transition joins prompt preparation, foreground end and settlement before publication", { timeout: 5000 }, async t => {
	const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
	const refs: WeakRef<object>[] = [], signals: AbortSignal[] = [];
	let sampled = 0, modelCalls = 0;
	async function exercise() {
		const preflight = gate(), prepared = gate(), ended = gate(), endRelease = gate(), settled = gate(), settleRelease = gate();
		let phase = "preflight", published = 0;
		let api!: ExtensionAPI;
		const f = await fixture(["stop", "stop"], pi => {
			api = pi;
			pi.on("before_agent_start", async (_event, ctx) => {
				if (phase !== "preflight") return;
				refs.push(new WeakRef(ctx)); prepared.release(); await preflight.promise;
			});
			pi.on("agent_end", async () => { if (phase === "run") { ended.release(); await endRelease.promise; } });
			pi.on("agent_settled", async (_event, ctx) => {
				if (phase !== "run") return;
				refs.push(new WeakRef(ctx)); settled.release(); await settleRelease.promise;
			});
		});
		const boundary = f.session.resourceLoader.getExtensions().runtime.executionBoundary;
		const pending: Promise<unknown>[] = [];
		const remove = f.session.subscribe(event => { if (event.type === "agent_start") signals.push(f.session.agent.signal!); });
		try {
			await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
			const preparing = assert.rejects(f.session.prompt("preparing"), /BOUNDARY_CHANGED/); pending.push(preparing);
			await prepared.promise;
			const first = api.transitionExecution!(() => { published++; }); pending.push(first);
			await tick(); assert.equal(published, 0); assert.equal(boundary.preparationCount, 1); assert.equal(f.calls(), 0);
			preflight.release(); await preparing; await first;
			assert.equal(boundary.preparationCount, 0); assert.equal(published, 1);
			phase = "run";
			const prompt = f.session.prompt("running"); pending.push(prompt); await ended.promise;
			const second = api.transitionExecution!(() => { published++; }); pending.push(second);
			await tick(); assert.equal(signals[0]!.aborted, true); assert.equal(published, 1);
			endRelease.release(); await settled.promise;
			let idle = false; const complete = api.waitForExecutionIdle!().then(() => { idle = true; }); pending.push(complete);
			await tick(); assert.equal(idle, false);
			assert.equal(f.session.isStreaming, false); assert.equal(f.session.isIdle, false); assert.equal(published, 1);
			await assert.rejects(f.session.prompt("too early"), /BOUNDARY_CHANGED/);
			settleRelease.release(); await prompt; await second; await complete; assert.equal(idle, true);
			assert.equal(published, 2); assert.equal(f.session.isIdle, true); assert.equal(boundary.preparationCount, 0);
			phase = "fresh"; await f.session.prompt("fresh"); modelCalls = f.calls(); assert.equal(modelCalls, 2);
			const { profile } = await profiler.post("HeapProfiler.stopSampling");
			const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
			refs.push(new WeakRef(f.session), new WeakRef(f.session.agent), new WeakRef(f.session.extensionRunner), new WeakRef(boundary));
		} finally {
			preflight.release(); endRelease.release(); settleRelease.release();
			await Promise.allSettled(pending); remove(); f.release(); await boundary.dispose();
		}
	}
	await exercise();
	for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
	assert.equal(refs.filter(ref => ref.deref()).length, 0); assert.ok(sampled < 8 * 1024 * 1024);
	t.diagnostic(JSON.stringify({ transitions: 2, modelCalls, revokedPreflights: 1, pendingPreparations: 0, releasedReferences: refs.length, sampledBytesExcludingFixtureStartup: sampled }));
});

test("execution transition owns manual summary preparation and late cleanup without committing a stale branch", { timeout: 5000 }, async t => {
	const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
	const refs: WeakRef<object>[] = [], signals: AbortSignal[] = [];
	let sampled = 0;
	async function exercise() {
		let entered = gate(), release = gate(), cleanup = gate(), finish = gate(), phase = "compact";
		const f = await fixture([], pi => {
			pi.on("session_before_compact", async event => { signals.push(event.signal); entered.release(); await release.promise; return { cancel: true }; });
			pi.on("session_compact_failed", async (_event, ctx) => { refs.push(new WeakRef(ctx)); cleanup.release(); await finish.promise; });
			pi.on("session_before_tree", async event => { signals.push(event.signal); entered.release(); await release.promise; return { summary: { summary: "stale summary" } }; });
		});
		const boundary = f.session.resourceLoader.getExtensions().runtime.executionBoundary;
		const pending: Promise<unknown>[] = [];
		try {
			for (let i = 0; i < 8; i++) f.session.sessionManager.appendMessage({ role: "user", content: "history ".repeat(1024), timestamp: i });
			const target = f.session.sessionManager.getEntries()[0]!.id;
			const leaf = f.session.sessionManager.getLeafId(), entries = f.session.sessionManager.getEntries().length;
			await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
			for (phase of ["compact", "tree", "preparation"]) {
				entered = gate(); release = gate(); cleanup = gate(); finish = gate();
				const abort = f.session.abort;
				if (phase === "preparation") f.session.abort = async () => { entered.release(); await release.promise; };
				const operation = phase === "tree" ? f.session.navigateTree(target, { summarize: true }) : f.session.compact();
				const rejected = assert.rejects(operation, /cancelled|BOUNDARY_CHANGED/); pending.push(rejected);
				await entered.promise;
				let published = false; const transition = boundary.transition(() => { published = true; }); pending.push(transition);
				await tick(); assert.equal(published, false); assert.equal(boundary.preparationCount, 1);
				if (phase !== "preparation") assert.equal(signals.at(-1)!.aborted, true);
				release.release();
				if (phase === "compact") { await cleanup.promise; assert.equal(f.session.isCompacting, false); assert.equal(published, false); finish.release(); }
				await rejected; await transition; f.session.abort = abort;
				assert.equal(boundary.preparationCount, 0); assert.equal(f.session.sessionManager.getLeafId(), leaf); assert.equal(f.session.sessionManager.getEntries().length, entries);
			}
			assert.equal(f.calls(), 0);
			const { profile } = await profiler.post("HeapProfiler.stopSampling"); const nodes = [profile.head];
			while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
			refs.push(new WeakRef(f.session), new WeakRef(boundary));
		} finally { release.release(); finish.release(); await Promise.allSettled(pending); f.release(); await boundary.dispose(); }
	}
	await exercise(); for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
	assert.equal(refs.filter(ref => ref.deref()).length, 0); assert.ok(sampled < 8 * 1024 * 1024);
	t.diagnostic(JSON.stringify({ transitions: 3, providerCalls: 0, staleCommits: 0, pendingPreparations: 0, releasedReferences: refs.length, sampledBytes: sampled }));
});

test("independent commands confirm owned descendants and keep unknown custom cleanup closed", { timeout: 10000 }, async t => {
	const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
	const refs: WeakRef<object>[] = [], signals: AbortSignal[] = [];
	const initialJobs = windowsShellJobDiagnostics(); let sampled = 0, stoppedDescendants = 0;
	async function exercise() {
		const f = await fixture([]), boundary = f.session.resourceLoader.getExtensions().runtime.executionBoundary;
		const operations = createLocalShellOperations("node fixture", () => ({ shell: process.execPath, args: ["-e"] }));
		try {
			await profiler.post("HeapProfiler.startSampling", { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
			for (const stop of [false, true]) {
				const ready = gate(); let output = "", pid = 0;
				const command = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');c.unref();${stop ? "setInterval(()=>{},1000)" : ""}`;
				const execution = f.session.executeBash(command, chunk => { output += chunk; if (output.includes("\n")) { pid = Number(output.trim()); ready.release(); } }, { operations });
				let transition: Promise<void> | undefined;
				try {
					if (stop) { await ready.promise; transition = boundary.transition(() => {}); }
					const result = await execution; await transition;
					assert.equal(result.processCleanup, "complete"); assert.equal(result.cancelled, stop);
					assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0), error => (error as NodeJS.ErrnoException).code === "ESRCH"); stoppedDescendants++;
				} finally { f.session.abortBash(); await execution.catch(() => {}); await transition; }
			}
			const ready = gate(), release = gate();
			const execution = f.session.executeBash("custom", undefined, { operations: { async exec(_command, _cwd, options) {
				signals.push(options.signal!); ready.release(); await release.promise; throw new Error("custom cancelled without cleanup proof");
			} } });
			await ready.promise;
			let published = false; const transition = assert.rejects(boundary.transition(() => { published = true; }), /CLEANUP_UNCONFIRMED/);
			try { await tick(); assert.equal(signals[0]!.aborted, true); assert.equal(published, false); }
			finally { release.release(); await execution; await transition; }
			assert.equal(boundary.preparationCount, 0); assert.equal(f.session.isBashRunning, false);
			await assert.rejects(f.session.executeBash("must not start", undefined, { operations }), /BOUNDARY_CHANGED/);
			await assert.rejects(boundary.dispose(), /CLEANUP_UNCONFIRMED/);
			assert.ok(boundary.participantCount > 0, "unknown cleanup retains the original owner");
			const { profile } = await profiler.post("HeapProfiler.stopSampling"); const nodes = [profile.head];
			while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
			refs.push(new WeakRef(f.session), new WeakRef(operations), new WeakRef(boundary));
		} finally { f.release(); }
	}
	await exercise(); for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
	assert.equal(refs.filter(ref => ref.deref()).length, 0); assert.ok(sampled < 16 * 1024 * 1024);
	const jobs = windowsShellJobDiagnostics(); assert.equal(jobs.handles, initialJobs.handles); assert.equal(jobs.processHandles, initialJobs.processHandles);
	t.diagnostic(JSON.stringify({ stoppedDescendants, unknownCleanupBlocked: 1, pendingPreparations: 0, releasedReferences: refs.length, sampledBytes: sampled }));
});

test("Plan switches publish after cleanup, reject failed drains and run ready actions after settlement", { timeout: 5000 }, async t => {
	const jiti = createJiti(import.meta.url);
	const { default: planMode } = await jiti.import<typeof import("../packages/plan-mode/src/plan-mode.ts")>("../packages/plan-mode/src/plan-mode.ts");
	const interactiveUi = await jiti.import<typeof import("../packages/plan-mode/src/interactive-ui.ts")>("../packages/plan-mode/src/interactive-ui.ts");
	const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
	const refs: WeakRef<object>[] = [], signals: AbortSignal[] = [];
	let sampled = 0, nativeSwitches = 0, readyActions = 0, handoffs = 0;
	let emergencyCleanup: (() => void) | undefined; t.after(() => emergencyCleanup?.());
	async function exercise() {
	let held: ReturnType<typeof gate> | undefined, fail = false, mode = "idle", menuShown = gate(), menuRelease = gate(), menuDone = gate();
	let menuSignal: AbortSignal | undefined;
	const f = await fixture([], pi => {
		const transition = pi.transitionExecution!;
		const api = { ...pi, transitionExecution: (publish: () => undefined) => { nativeSwitches++; return transition(publish); },
			sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => { if (typeof args[0] === "string" && args[0].includes("Implement this proposed plan")) handoffs++; pi.sendUserMessage(...args); } };
		refs.push(new WeakRef(api));
		planMode(api, { readSettings: async () => ({ kind: "missing" }), loadInteractiveUi: async () => interactiveUi });
		pi.registerExecutionOwner!("plan-fixture", { revoke() {}, async drain() { await held?.promise; if (fail) throw new Error("controlled Plan cleanup"); } });
	});
	const boundary = f.session.resourceLoader.getExtensions().runtime.executionBoundary;
	const state = () => {
		const saved = (f.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "plan-mode-state").at(-1) as { data?: { enabled: boolean } } | undefined)?.data;
		assert.equal(f.session.getToolCatalog().selectionMode, saved?.enabled ? "plan" : "default");
		return saved;
	};
	const run = (args: string) => f.session.extensionRunner.getCommand("plan")!.handler(args, f.session.extensionRunner.createCommandContext());
	const pending: Promise<unknown>[] = [];
	emergencyCleanup = () => { held?.release(); menuRelease.release(); menuDone.release(); f.release(); };
	try {
		await f.session.bindExtensions({ mode: "rpc", uiContext: { ...f.session.extensionRunner.getUIContext(),
			select: async (_title, choices, options) => {
				if (options?.signal) signals.push(options.signal);
				if (mode === "held") { menuSignal = options?.signal; menuShown.release(); await menuRelease.promise; return undefined; }
				assert.equal(f.session.isIdle, true, "automatic ready actions run outside settlement");
				return choices.find(choice => choice.includes(mode === "save" ? "Save for later" : mode === "export" ? "Export plan" : "Discard plan and exit"));
			},
			input: async () => join(f.session.sessionManager.getCwd(), "plan-export.md"),
			notify: (message, type) => { if (type === "error") { menuDone.release(); assert.fail(message); } if (/Proposed plan discarded|Plan saved for later|Plan exported to/.test(message)) menuDone.release(); },
		} });
		await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		assert.equal(nativeSwitches, 0, "off startup does not suspend all services");
		held = gate(); const starting = run("start"); pending.push(starting);
		await tick(); assert.equal(state()?.enabled ?? false, false); held.release(); await starting; held = undefined;
		assert.equal(state()?.enabled, true);
		fail = true; await assert.rejects(run("exit"), /controlled Plan cleanup/); assert.equal(state()?.enabled, true);
		assert.throws(() => boundary.assertCurrent(), /BOUNDARY_CHANGED/);
		fail = false; await run("exit"); assert.equal(state()?.enabled, false);
		await run("start"); mode = "held";
		const menu = run(""); pending.push(menu); await menuShown.promise;
		const exiting = run("exit"); pending.push(exiting); await tick();
		assert.equal(menuSignal?.aborted, true); assert.equal(state()?.enabled, true, "cancelled UI must really finish before publication");
		menuRelease.release(); await menu; await exiting; assert.equal(state()?.enabled, false);
		f.session.agent.streamFunction = () => {
			const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "<proposed_plan>\nInspect the current implementation, make the scoped change, and verify its result.\n</proposed_plan>" }],
				api: ALPHA_MODEL.api, model: ALPHA_MODEL.id, provider: ALPHA_MODEL.provider, timestamp: 1, stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
		};
		for (mode of ["save", "export", "discard"]) {
			menuDone = gate(); await run("start");
			await f.session.prompt("Produce the plan"); await menuDone.promise; await tick(); readyActions++;
			assert.equal(state()?.enabled, false);
			if (mode === "export") assert.match(readFileSync(join(f.session.sessionManager.getCwd(), "plan-export.md"), "utf8"), /Inspect the current implementation/);
			if (mode === "save") await run("exit");
		}
		mode = "held"; menuShown = gate(); menuRelease = gate(); await run("start");
		await f.session.prompt("Produce another plan"); await menuShown.promise;
		const previousMenu = menuRelease; menuShown = gate(); menuRelease = gate();
		await f.session.prompt("Revise that plan"); assert.equal(menuSignal?.aborted, true);
		previousMenu.release(); await menuShown.promise;
		const implementing = run("implement"); pending.push(implementing); await tick(); assert.equal(state()?.enabled, true);
		menuRelease.release(); await implementing; await tick(); await boundary.waitForPreparations(); await f.session.waitForIdle();
		assert.equal(handoffs, 1);
		assert.equal(state()?.enabled, false); assert.equal(boundary.preparationCount, 0); assert.equal(f.session.isIdle, true);
		const { profile } = await profiler.post("HeapProfiler.stopSampling"); const nodes = [profile.head];
		while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
		refs.push(new WeakRef(f.session), new WeakRef(boundary), new WeakRef(f.session.extensionRunner));
	} finally { held?.release(); menuRelease.release(); fail = false; await Promise.allSettled(pending); f.release(); await boundary.dispose(); emergencyCleanup = undefined; }
	}
	await exercise(); for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
	assert.equal(refs.filter(ref => ref.deref()).length, 0); assert.ok(sampled < 16 * 1024 * 1024);
	t.diagnostic(JSON.stringify({ nativeSwitches, rejectedCleanup: 1, realUiWaits: 2, automaticReadyActions: readyActions, handoffs, pendingPreparations: 0, releasedReferences: refs.length, sampledBytes: sampled }));
});

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
	const extensionIdle: boolean[] = [];
	const beforeNested = gate(), startNested = gate(), afterNested = gate(), finishOuter = gate();
	let nested: (() => Promise<void>) | undefined;
	const f = await fixture(["stop", "stop"], pi => {
		pi.on("agent_settled", async (event, ctx) => {
			extensionEvents.push(structuredClone(event));
			extensionIdle.push(ctx.isIdle());
			if (extensionEvents.length === 1) {
				event.aborted = false;
				beforeNested.release(); await startNested.promise;
				await nested!();
				afterNested.release(); await finishOuter.promise;
			}
		});
	});
	nested = () => f.session.prompt("nested");
	const runtime = new AgentSessionRuntime(f.session, { cwd: process.cwd(), agentDir: process.cwd() } as never,
		async () => { throw new Error("unexpected replacement"); });
	let invalidated = false, disposal: Promise<void> | undefined;
	runtime.setBeforeSessionInvalidate(() => { invalidated = true; });
	const unsubscribe = f.session.subscribe(event => {
		if (event.type === "agent_end" && f.calls() === 1) f.session.agent.abort();
	});
	const run = f.session.prompt("first");
	try {
		await beforeNested.promise;
		assert.equal(f.session.isStreaming, false, "a settled hook may admit a successor");
		assert.equal(f.session.isIdle, false, "cleanup still owns the session before successor admission");
		let idle = false;
		const waiting = f.session.waitForIdle().then(() => { idle = true; });
		await Promise.resolve();
		assert.equal(idle, false);
		startNested.release(); await afterNested.promise;
		assert.equal(f.session.isIdle, false, "nested completion must not release its enclosing cleanup");
		assert.equal(idle, false);
		assert.equal(f.settled.length, 0, "RPC/UI also wait for all settlement hooks");
		disposal = runtime.dispose();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(invalidated, false, "runtime disposal waits for the enclosing settlement hook");
		finishOuter.release(); await run; await waiting; await disposal;
		assert.equal(invalidated, true);
		assert.equal(idle, true);
		assert.equal(f.session.isIdle, true);
		assert.equal((f.session as any)._settlementDepth, 0);
		assert.equal((f.session as any)._pendingSettledAborted, undefined);
		assert.deepEqual(extensionIdle, [true, true], "Goal/Plan handlers must observe admission-ready idle during settlement");
		assert.deepEqual(extensionEvents, [{ type: "agent_settled", aborted: true }, { type: "agent_settled", aborted: false }]);
		assert.deepEqual(f.settled, [{ type: "agent_settled", aborted: false }], "public settlement describes only the latest admission");
	} finally { startNested.release(); finishOuter.release(); await run; await disposal; nested = undefined; unsubscribe(); f.release(); }
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
			if (reason === "error") {
				const owner = f.session as any;
				const append = owner._appendCustomMessage.bind(owner);
				owner._appendCustomMessage = async (message: any) => { await append(message); throw new Error("fixture drain failure"); };
				const first = owner.sendCustomMessage({ customType: "note", content: "failed drain", display: false }, { triggerTurn: false });
				refs.push(new WeakRef(owner._customMessageFlush));
				const second = owner.sendCustomMessage({ customType: "note", content: "unconsumed report", display: false }, { triggerTurn: true });
				const results = await Promise.allSettled([first, second]);
				assert.ok(results.every(result => result.status === "rejected"));
				assert.equal(owner._pendingCustomMessages.length, 1);
				refs.push(new WeakRef(owner._pendingCustomMessages[0]));
				assert.equal(owner._customMessageFlush, undefined);
			}
		}
		finally { unsubscribe(); f.release(); }
	}
	for (const reason of ["stop", "error", "aborted"] as const) await run(reason);
	for (let i = 0; i < 8; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
		global.gc!();
	}
	assert.equal(refs.length, 14);
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	t.diagnostic("settlement lifecycle WeakRefs=14 retained=0 (includes failed drain and unconsumed report)");
});
