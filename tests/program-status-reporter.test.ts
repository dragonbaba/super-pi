import assert from "node:assert/strict";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { ProgramStatusReporter } from "../packages/coding-agent/src/modes/interactive/program-status-reporter.ts";
import type { AgentSessionEvent } from "../packages/coding-agent/src/core/agent-session.ts";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import { alphaModelRuntime, alphaSession } from "./helpers/alpha-session.ts";
import { alphaMessage, finalStream } from "./helpers/alpha-stream.ts";

function fixture() {
	const reports: unknown[][] = [];
	const terminal = { setProgramStatus: (...args: unknown[]) => reports.push(args) } as unknown as Terminal;
	let name = "Session";
	const reporter = new ProgramStatusReporter(() => terminal, () => name);
	return { reporter, reports, name(value: string) { name = value; }, last() { return reports.at(-1)?.slice(0, 3); } };
}
const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };
function assistant(stopReason: "stop" | "error" | "aborted") {
	return { type: "message_end", message: { ...alphaMessage([{ type: "text", text: "secret response" }]),
		stopReason, errorMessage: "Fixture error\nsecret details" } } as AgentSessionEvent;
}

test("reporter follows retry outcome, late cancellation and waiting for user input", () => {
	const f = fixture(), r = f.reporter;
	r.report(); assert.deepEqual(f.last(), ["idle", undefined, undefined]);
	r.handleEvent({ type: "agent_start" }); r.handleEvent(assistant("error"));
	assert.deepEqual(f.last(), ["working", "Session", undefined]);
	r.handleEvent(assistant("stop")); r.handleEvent(settled);
	assert.deepEqual(f.last(), ["done", "Session", undefined]);
	r.handleEvent({ type: "agent_start" }); r.handleEvent(assistant("error")); r.handleEvent(settled);
	assert.deepEqual(f.last(), ["error", "Fixture error", undefined]);
	r.handleEvent({ type: "agent_start" }); r.handleEvent(assistant("stop")); r.handleEvent({ type: "agent_settled", aborted: true });
	assert.deepEqual(f.last(), ["idle", undefined, undefined]);
	r.handleEvent({ type: "agent_start" }); r.handleEvent({ type: "agent_end", messages: [], willRetry: false, requiresUserInput: true }); r.handleEvent(settled);
	assert.deepEqual(f.last(), ["blocked", "Waiting for input", "question"]);
	r.handleEvent({ type: "agent_start" });
	assert.deepEqual(f.last(), ["working", "Session", undefined]);
	assert.ok(!JSON.stringify(f.reports).includes("secret"));
	r.dispose();
});

test("manual and recovery compaction report working, error, success and cancellation", () => {
	const f = fixture(), r = f.reporter;
	for (const reason of ["manual", "overflow"] as const) {
		if (reason === "overflow") r.handleEvent({ type: "agent_start" });
		r.handleEvent({ type: "compaction_start", reason });
		assert.deepEqual(f.last(), ["working", "Compacting context", undefined]);
		r.handleEvent({ type: "compaction_end", reason, result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed\nprivate" });
		if (reason === "overflow") r.handleEvent(settled);
		assert.deepEqual(f.last(), ["error", "Compaction failed", undefined]);
	}
	r.handleEvent({ type: "compaction_start", reason: "manual" });
	r.handleEvent({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
	assert.deepEqual(f.last(), ["idle", undefined, undefined]);
	r.dispose();
});

test("two dialog sources restore underlying status, session changes reset and disposal releases references", () => {
	const f = fixture(), r = f.reporter;
	r.handleEvent({ type: "agent_start" });
	r.setBlocked("extension-dialog", "permission", "Allow?");
	r.setBlocked("login", "auth", "Log in"); assert.deepEqual(f.last(), ["blocked", "Log in", "auth"]);
	r.setBlocked("extension-dialog", "question", "Choose"); assert.deepEqual(f.last(), ["blocked", "Choose", "question"]);
	r.setBlocked("extension-dialog"); assert.deepEqual(f.last(), ["blocked", "Log in", "auth"]);
	r.setBlocked("login"); r.handleEvent(settled);
	f.name("Renamed"); r.handleEvent({ type: "session_info_changed", name: "Renamed" });
	assert.deepEqual(f.last(), ["done", "Renamed", undefined]);
	r.setBlocked("extension-dialog", "question", "old"); r.reset();
	assert.deepEqual(f.last(), ["idle", undefined, undefined]);
	r.dispose(); const count = f.reports.length; r.report(); r.handleEvent({ type: "agent_start" });
	assert.equal(f.reports.length, count);
	assert.equal((r as any).lastTerminal, undefined); assert.equal((r as any).dialogMessage, undefined);
});

test("100,000 message/tool updates create no reports, Promises or payload reads", () => {
	const f = fixture(), r = f.reporter;
	r.handleEvent({ type: "agent_start" });
	let promises = 0;
	const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
	const message = { type: "message_update", get message(): never { throw new Error("delta payload read"); },
		get assistantMessageEvent(): never { throw new Error("delta event read"); } } as AgentSessionEvent;
	const tool = { type: "tool_execution_update", get partialResult() { throw new Error("tool payload read"); } } as AgentSessionEvent;
	hook.enable();
	try { for (let i = 0; i < 100_000; i++) { r.handleEvent(message); r.handleEvent(tool); } }
	finally { hook.disable(); }
	assert.equal(promises, 0); assert.equal(f.reports.length, 1);
	r.dispose();
});

for (const mode of ["regular", "fullscreen"] as const) test(`real ${mode} interactive session reports outcomes and dialog cancellation`, async () => {
	const prior = process.env.SP_PROGRAM_STATUS; process.env.SP_PROGRAM_STATUS = "1";
	const f = await alphaSession({ mode, runtime: alphaModelRuntime(() => finalStream(alphaMessage([{ type: "text", text: "secret output" }]))),
		settings: { compaction: { enabled: false }, retry: { enabled: false }, showTerminalProgress: false } });
	const statuses = () => f.sink.controls.filter(value => value.startsWith("\x1b]7501;state="));
	try {
		assert.equal(await f.mode.init(), true);
		await f.session.prompt("secret prompt"); await f.internal.ui.flushTerminalFrames();
		assert.ok(statuses().some(value => value.includes("state=working")));
		assert.ok(statuses().at(-1)?.includes("state=done"));
		const controller = new AbortController();
		const confirmation = f.internal.showExtensionConfirm("Allow action?", "private details", { signal: controller.signal });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(statuses().at(-1)?.includes("state=blocked:app=superpi:kind=permission"));
		controller.abort(); assert.equal(await confirmation, false);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(statuses().at(-1)?.includes("state=done"));
		const beforeSwitch = statuses().length;
		assert.equal(await f.internal.switchTuiMode(mode === "regular" ? "fullscreen" : "regular"), true);
		await f.internal.ui.flushTerminalFrames();
		assert.ok(statuses().length > beforeSwitch && statuses().at(-1)?.includes("state=done"));
		const unsubscribe = f.session.subscribe(event => { if (event.type === "agent_end") f.session.agent.abort(); });
		await f.session.prompt("cancel"); unsubscribe(); await f.internal.ui.flushTerminalFrames();
		assert.ok(statuses().at(-1)?.includes("state=idle"));
		for (const sequence of statuses()) {
			const encoded = sequence.match(/:msg=([^\x1b]+)/)?.[1];
			if (encoded) assert.doesNotMatch(Buffer.from(encoded, "base64").toString(), /secret|private/);
		}
	} finally {
		await f.release();
		if (prior === undefined) delete process.env.SP_PROGRAM_STATUS; else process.env.SP_PROGRAM_STATUS = prior;
	}
});

test("disposed reporter releases terminal and dialog references", { skip: !global.gc }, async () => {
	let reference: WeakRef<ProgramStatusReporter>;
	function run() {
		const f = fixture(); reference = new WeakRef(f.reporter);
		f.reporter.setBlocked("extension-dialog", "permission", "bounded"); f.reporter.dispose();
	}
	run();
	for (let i = 0; i < 8; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc!(); }
	assert.equal(reference!.deref(), undefined);
});
