import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { response } from "./helpers/selected-integration-fixture.ts";
import { streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { AgentSessionRuntime } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";

function chatResponse(delta: unknown, finish: string): Response {
	const chunk = (d: unknown, f: string | null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
	return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

const roles = (entries: any[]) => entries.map(entry => entry.type === "custom_message" ? "custom" : entry.message?.role).filter(Boolean);

/** Session whose first provider reply calls `note`; the tool runs `execute` with the live session. */
async function customMessageSession(execute: (session: any, signal: AbortSignal) => Promise<void>, failFirst = false) {
	const root = mkdtempSync(join(tmpdir(), "custom-order-"));
	const payloads: any[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		payloads.push(JSON.parse(String(init?.body)));
		if (failFirst && payloads.length === 1) throw new Error("offline first request failure");
		return payloads.length === 1
			? chatResponse({ tool_calls: [{ index: 0, id: "call_note", type: "function", function: { name: "codemode", arguments: JSON.stringify({ code: 'await tools.note({})' }) } }] }, "tool_calls")
			: chatResponse({ content: "done" }, "stop");
	};
	const runtime = alphaModelRuntime((model: any, context: any, options: any) =>
		streamSimple({ ...model, api: "openai-completions" }, context, { ...options, apiKey: "offline", fetch, maxRetries: 0 }));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(root);
	let session: any;
	({ session } = await createAgentSession({
		cwd: root, agentDir: root, settingsManager: settings, sessionManager, resourceLoader, model: ALPHA_MODEL, modelRuntime: runtime, noTools: "builtin",
		customTools: [{ name: "note", label: "Note", description: "fixture", parameters: { type: "object", properties: {} },
			execute: async (_id: string, _params: unknown, signal: AbortSignal) => {
				await execute(session, signal);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			} }],
	}));
	const events: string[] = [];
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "message_end") events.push(`end:${event.message.role}`);
	});
	return { session, sessionManager, payloads, events, release() {
		unsubscribe();
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	} };
}

const sendNote = (session: any) => session.sendCustomMessage({ customType: "note", content: "noted", display: true }, { triggerTurn: false });

test("FIFO custom messages including a reentrant delivery reach the very next provider request exactly once", async () => {
	const send = (session: any, content: string) => session.sendCustomMessage({ customType: "note", content, display: true }, { triggerTurn: false });
	const f = await customMessageSession(async session => {
		await send(session, "FIRST_CUSTOM");
		await send(session, "SECOND_CUSTOM");
	});
	const off = f.session.subscribe((event: any) => {
		if (event.type === "message_end" && event.message.role === "custom" && event.message.content === "FIRST_CUSTOM") {
			void send(f.session, "REENTRANT_CUSTOM");
		}
	});
	try {
		await f.session.prompt("Take a note.");
		const notes = f.session.messages.filter((message: any) => message.role === "custom").map((message: any) => message.content);
		assert.deepEqual(notes, ["FIRST_CUSTOM", "SECOND_CUSTOM", "REENTRANT_CUSTOM"]);
		assert.deepEqual(f.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").map((entry: any) => entry.content), notes);
		const wire = JSON.stringify(f.payloads[1].messages);
		for (const note of notes) assert.equal(wire.split(note).length - 1, 1, note);
		assert.ok(wire.indexOf("FIRST_CUSTOM") < wire.indexOf("SECOND_CUSTOM"));
		assert.ok(wire.indexOf("SECOND_CUSTOM") < wire.indexOf("REENTRANT_CUSTOM"));
		assert.equal(f.events.filter(event => event === "end:custom").length, 3);
		assert.deepEqual(roles(f.sessionManager.getEntries()), ["user", "assistant", "toolResult", "custom", "custom", "custom", "assistant"]);
	} finally { off(); f.release(); }
});

// A context-only custom message sent while a tool runs must not split a tool call from its result.
test("custom message sent during a tool call is appended after the turn's tool results", async () => {
	const f = await customMessageSession(async session => {
		await sendNote(session);
		f.events.push(`queued:${session.messages.some((m: any) => m.role === "custom")}`);
	});
	try {
		await f.session.prompt("Take a note.");
		await f.session.agent.waitForIdle();
		assert.deepEqual(roles(f.sessionManager.getEntries()), ["user", "assistant", "toolResult", "custom", "assistant"]);
		assert.deepEqual(f.session.messages.map((m: any) => m.role), ["user", "assistant", "toolResult", "custom", "assistant"]);
		// Nothing is announced before it exists in session history.
		assert.deepEqual(f.events, ["end:user", "end:assistant", "queued:false", "end:toolResult", "end:custom", "end:assistant"]);
		// The next request replays history; the tool result must still follow its call.
		await f.session.prompt("Again.");
		await f.session.agent.waitForIdle();
		const wire = f.payloads[2].messages.map((m: any) => m.role);
		assert.equal(wire[wire.indexOf("assistant") + 1], "tool", JSON.stringify(wire));
	} finally {
		f.release();
	}
});

test("custom message queued before an abort is released exactly once after the aborted tool result", async () => {
	let queued!: () => void;
	const ready = new Promise<void>(resolve => { queued = resolve; });
	const f = await customMessageSession(async (session, signal) => {
		await sendNote(session);
		queued();
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	try {
		const run = f.session.prompt("Take a note.");
		await ready;
		await f.session.abort();
		await run;
		const history = roles(f.sessionManager.getEntries());
		assert.equal(history.filter(role => role === "custom").length, 1);
		assert.ok(history.indexOf("custom") > history.indexOf("toolResult"), JSON.stringify(history));
		assert.equal(f.events.filter(event => event === "end:custom").length, 1);
		assert.equal((f.session as any)._pendingCustomMessages.length, 0);
		assert.equal((f.session as any)._pendingCustomContextMessages.length, 0);
		assert.equal(f.payloads.length, 1);
	} finally {
		f.release();
	}
});

test("settle drains custom messages after request failure and the next prompt replays them once", async () => {
	const f = await customMessageSession(async () => {}, true);
	const off = f.session.subscribe((event: any) => {
		if (event.type === "message_end" && event.message.role === "user" && f.payloads.length === 0) void sendNote(f.session);
	});
	try {
		await f.session.prompt("first failure");
		assert.equal(f.session.messages.filter((message: any) => message.role === "custom").length, 1);
		assert.equal(f.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").length, 1);
		assert.equal((f.session as any)._pendingCustomMessages.length, 0);
		assert.equal((f.session as any)._pendingCustomContextMessages.length, 0);
		await f.session.prompt("next prompt");
		assert.equal(f.payloads.length, 2);
		assert.equal(JSON.stringify(f.payloads[1].messages).split("noted").length - 1, 1);
	} finally { off(); f.release(); }
});

test("runtime replacement settles pending notes in the outgoing session without crossing sessions", async () => {
	let queued!: () => void;
	const ready = new Promise<void>(resolve => { queued = resolve; });
	const outgoing = await customMessageSession(async (session, signal) => {
		await sendNote(session); queued();
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	const incoming = await customMessageSession(async () => {});
	const runtime = new AgentSessionRuntime(outgoing.session, { cwd: process.cwd(), agentDir: process.cwd() } as any,
		async () => ({ session: incoming.session, services: { cwd: process.cwd(), agentDir: process.cwd() }, diagnostics: [] }) as any);
	try {
		const run = outgoing.session.prompt("outgoing"); await ready;
		assert.equal((await runtime.newSession()).cancelled, false); await run;
		assert.equal(outgoing.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").length, 1);
		assert.equal(outgoing.session._pendingCustomMessages.length, 0);
		assert.equal(outgoing.session._pendingCustomContextMessages.length, 0);
		await runtime.session.prompt("incoming");
		assert.doesNotMatch(JSON.stringify(incoming.payloads), /noted/);
		assert.equal(incoming.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").length, 0);
	} finally { await runtime.dispose(); outgoing.release(); incoming.release(); }
});

test("idle custom-message drain precedes concurrent triggers without losing either report", async () => {
	const root = mkdtempSync(join(tmpdir(), "custom-idle-"));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
	let entered!: () => void, release!: () => void, calls = 0;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const done = new Promise<void>(resolve => { release = resolve; });
	let teardownEntered!: () => void, releaseTeardown!: () => void;
	const teardownReady = new Promise<void>(resolve => { teardownEntered = resolve; });
	const teardownDone = new Promise<void>(resolve => { releaseTeardown = resolve; });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [pi => { pi.on("message_end", async event => {
			if (event.message.role === "custom" && event.message.content === "noted") {
				pi.sendMessage({ customType: "note", content: "reentrant", display: true }, { triggerTurn: false });
				entered(); await done;
			}
			if (event.message.role === "custom" && event.message.content === "teardown report") { teardownEntered(); await teardownDone; }
		}); }] });
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(root);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, sessionManager, resourceLoader, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), noTools: "all" });
	session.agent.streamFunction = model => { calls++; return response(model, [{ type: "text", text: "done" }]); };
	const pending: Promise<void>[] = [];
	const runtime = new AgentSessionRuntime(session, { cwd: root, agentDir: root } as never,
		async () => { throw new Error("unexpected replacement"); });
	let invalidated = false, disposal: Promise<void> | undefined;
	runtime.setBeforeSessionInvalidate(() => { invalidated = true; });
	try {
		pending.push(sendNote(session)); await ready;
		assert.deepEqual(session.messages.map((m: any) => m.role), ["custom"]);
		assert.equal(calls, 0, "context-only delivery does not start a provider turn");
		for (const content of ["first report", "second report"]) pending.push(session.sendCustomMessage({ customType: "note", content, display: true }, { triggerTurn: true, deliverAs: "followUp" }));
		release(); await Promise.all(pending);
		assert.equal(calls, 2);
		assert.deepEqual(sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").map((entry: any) => entry.content), ["noted", "reentrant", "first report", "second report"]);
		assert.equal((session as any)._customMessageFlush, undefined);
		pending.push(session.sendCustomMessage({ customType: "note", content: "teardown report", display: true }, { triggerTurn: false }));
		await teardownReady;
		assert.equal(session.isStreaming, false);
		assert.equal(session.isIdle, false);
		disposal = runtime.dispose();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(invalidated, false, "teardown must join report persistence even with no agent run");
		releaseTeardown(); await Promise.all(pending); await disposal;
		assert.equal(invalidated, true);
		assert.equal((session as any)._customMessageFlush, undefined);
		assert.equal((session as any)._idleWaitPromise, undefined);
		assert.equal(sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message" && entry.content === "teardown report").length, 1);
	} finally {
		release(); releaseTeardown(); await Promise.allSettled(pending); await disposal;
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

for (const mode of ["context", "trigger", "disposed"]) test(`concurrent idle SDK sends retain reports after a failed shared drain: ${mode}`, async t => {
	const f = await customMessageSession(async () => {});
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	const failure = new Error("fixture custom hook failure");
	const append = f.session._appendCustomMessage.bind(f.session);
	t.mock.method(f.session, "_appendCustomMessage", async (message: any) => {
		await append(message); // Like a failed hook, the consumed entry is still persisted once.
		if (message.content === "first") { entered(); await gate; throw failure; }
	});
	const send = (content: string, triggerTurn = false) => f.session.sendCustomMessage({ customType: "note", content, display: true }, { triggerTurn, deliverAs: "followUp" });
	let results: Promise<PromiseSettledResult<void>[]> | undefined;
	try {
		const first = send("first"); await ready;
		let completed = false;
		const second = send("second", mode !== "context").then(() => { completed = true; });
		results = Promise.allSettled([first, second]);
		await Promise.resolve();
		assert.equal(completed, false, "queue acceptance must not report successful SDK delivery");
		if (mode === "disposed") f.session.dispose();
		release();
		assert.deepEqual(await results, [{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
		assert.equal(f.session._customMessageFlush, undefined);
		if (mode === "disposed") {
			assert.equal(f.session._pendingCustomMessages.length, 0, "a failed waiter must not requeue into a disposed session");
			assert.equal(f.payloads.length, 0);
			return;
		}
		assert.equal(f.session._pendingCustomMessages.length, 1);
		assert.equal(f.payloads.length, 0, "failure must not start an automatic model retry");
		await send("retry drain");
		assert.deepEqual(f.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").map((entry: any) => entry.content), ["first", "second", "retry drain"]);
		assert.equal(f.session._pendingCustomMessages.length, 0);
		await f.session.prompt("Continue explicitly");
		assert.equal(JSON.stringify(f.payloads[0].messages).split("second").length - 1, 1);
	} finally { release(); await results; f.release(); }
});
