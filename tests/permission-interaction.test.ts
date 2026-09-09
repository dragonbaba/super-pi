import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SessionPermissionController } from "../packages/extensions/resource-lifecycle-guard/permission-controller.ts";
import { ExtensionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";

initTheme("dark");

async function permissionFixture(t: test.TestContext) {
 const cwd = mkdtempSync(join(tmpdir(), "pi-permission-wait-"));
	t.after(() => rmSync(cwd, { recursive: true }));
 const runtime = createExtensionRuntime();
 let permission!: SessionPermissionController;
 const extension = await loadExtensionFromFactory((pi) => {
  // Persistence is deliberately observed, not sent to the installed session.
  pi.appendEntry = () => {};
  permission = new SessionPermissionController(pi);
  pi.on("tool_call", (event, ctx) => permission.authorizeToolCall(event, ctx));
 }, cwd, createEventBus(), runtime);
 const scheduler = new FakeScheduler();
 const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), {} as never,
  { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
 const abort = new AbortController();
 runner.bindCore({} as never, { getSignal: () => abort.signal } as never);
 let choose!: (value: string | undefined) => void;
 let shown!: () => void;
 const visible = new Promise<void>((resolve) => { shown = resolve; });
 let choices: string[] = [];
 let dialogOptions: any;
 runner.setUIContext({ ...runner.getUIContext(),
  select: async (_title, options, opts) => {
   choices = options; dialogOptions = opts; shown();
   return new Promise<string | undefined>((resolve) => { choose = resolve; });
  },
	}, "tui");
 await permission.restore(runner.createContext());
 const call = () => runner.emitToolCall({ type: "tool_call", toolName: "browser_exec", toolCallId: "approval-1",
  input: { code: "print('controlled fixture')", purpose: "permission regression" } } as never);
 return { runner, scheduler, permission, visible, call, abort, choose: (index: number) => choose(choices[index]),
  dialogOptions: () => dialogOptions };
}

test("real permission selection outlasts the 30-second machine budget", async (t) => {
	const f = await permissionFixture(t);
 const result = f.call();
 const outcome = result.then((value) => ({ value }), (error) => ({ error }));
 await f.visible;
 f.scheduler.advanceBy(60_000);
 await Promise.resolve();
 f.choose(0);
 assert.deepEqual(await outcome, { value: undefined });
 assert.equal(f.runner.hookDeliveryStats.timeouts, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("invalidating a pending approval revokes its signal and late selection", async (t) => {
	const f = await permissionFixture(t);
 const result = f.call();
 const outcome = result.then(() => "allowed", () => "rejected");
 await f.visible;
 const signal = f.dialogOptions()?.signal;
 f.runner.invalidate();
 f.choose(0);
 assert.equal(await outcome, "rejected");
 assert.equal(signal?.aborted, true);
 assert.equal(f.permission.state.allowRules.length, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("permission details never push controls beyond the terminal viewport", () => {
 const terminal = { rows: 16, columns: 48 };
 const selector = new ExtensionSelectorComponent("Permission: bash", ["Approve once", "Deny"], () => {}, () => {},
  { tui: { terminal } as never, details: ("脚本 ".repeat(1000) + "\n").repeat(10) } as never);
 assert.ok(selector.render(48).length <= terminal.rows);
 terminal.rows = 9;
 const resized = selector.render(24);
 assert.ok(resized.length <= terminal.rows);
 assert.ok(resized.some((line) => line.includes("Approve")));
 selector.dispose();
});


test("concurrent permission requests cannot replace the active selection", async (t) => {
	const f = await permissionFixture(t);
	const first = f.call();
	await f.visible;
	await assert.rejects(f.call(), /Another approval dialog/);
	f.choose(0);
	assert.equal(await first, undefined);
	assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("real interactive selection isolates cancellation, late clicks and disposal", async () => {
	const { InteractiveMode } = await import("../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const { Container } = await import("@super-pi/tui");
	const mode: any = Object.create(InteractiveMode.prototype);
	mode.ui = { terminal: { rows: 12, columns: 60 }, setFocus() {}, requestRender() {} };
	mode.editor = new Container(); mode.editorContainer = new Container();
	mode.disposeActiveSelector = () => {};
	const abort = new AbortController();
	const first = mode.showExtensionSelector("first", ["Approve", "Deny"], { signal: abort.signal, details: "FULL-FIRST" });
	const old = mode.extensionSelector;
 await assert.rejects(mode.showExtensionCustom(() => new Container()), /Another dialog/);
 assert.equal(await mode.showExtensionEditor("other"), undefined);
	assert.equal(await mode.showExtensionSelector("second", ["Approve"]), undefined);
	abort.abort();
	assert.equal(await first, undefined);
	const second = mode.showExtensionSelector("second", ["Approve"], { details: "FULL-SECOND" });
	const current = mode.extensionSelector;
	old.handleInput("\n");
	assert.equal(mode.extensionSelector, current);
	current.handleInput("\n");
	assert.equal(await second, "Approve");
	const third = mode.showExtensionSelector("third", ["Approve"], { details: "FULL-THIRD" });
	mode.hideExtensionSelector();
	assert.equal(await third, undefined);
	assert.equal(mode.extensionSelector, undefined);
	assert.equal(mode.extensionSelectorCancel, undefined);
});

test("details cache survives navigation, escapes controls, and releases on close", () => {
	const terminal = { rows: 10, columns: 40 };
	let selected = 0; let cancelled = 0;
	const selector: any = new ExtensionSelectorComponent("permission", ["Approve", "Deny"], () => selected++, () => cancelled++,
		{ tui: { terminal } as never, details: "\x1b[2J" + "中".repeat(2000) + "\nFINAL-DETAIL" });
	selector.render(40);
	const cache = selector.detailLines;
	for (let index = 0; index < 40; index++) { selector.handleInput("j"); selector.render(40); }
	assert.equal(selector.detailLines, cache);
	assert.ok(cache[0].includes("\\u001b"));
	for (let index = 0; index < 100; index++) selector.handleInput("\x1b[6~");
	assert.ok(selector.render(40).some((line: string) => line.includes("FINAL-DETAIL")));
	selector.render(12); selector.handleInput("\n");
	assert.equal(selected, 0, "a clipped viewport cannot approve invisibly");
	terminal.rows = 3;
	selector.render(40); selector.handleInput("\n");
	assert.equal(selected, 0);
	selector.handleInput("\x1b");
	assert.equal(cancelled, 1);
	selector.dispose();
	assert.equal(selector.detailLines.length, 0);
	assert.equal(selector.details, undefined);
	assert.equal(selector.terminal, undefined);
});

test("two stalled tool calls produce two results, zero effects, and correlated compact diagnostics", async () => {
	const { Agent } = await import("../packages/agent/src/agent.ts");
	const { Type } = await import("typebox");
	const { InteractiveMode } = await import("../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const { Container } = await import("@super-pi/tui");
	const { createAssistantMessageEventStream } = await import("../packages/ai/src/utils/event-stream.ts");
	const runtime = createExtensionRuntime();
	const scheduler = new FakeScheduler();
	let entered!: () => void;
	const extension = await loadExtensionFromFactory((pi) => pi.on("tool_call", async () => {
		entered(); await new Promise(() => {});
	}), process.cwd(), createEventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
		{ scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
	const mode: any = Object.create(InteractiveMode.prototype);
	mode.chatContainer = new Container(); mode.ui = { requestRender() {} };
	const diagnostics: string[] = [];
	runner.onError(error => {
		diagnostics.push(error.toolCallId!);
		mode.showExtensionError(error.extensionPath, error.error, error.stack, error.toolCallId);
	});
	let effects = 0, providerResponses = 0, starts = 0, ends = 0, results = 0;
	const agent = new Agent({ streamFn: () => {
		const stream = createAssistantMessageEventStream();
		const withTools = providerResponses++ === 0;
		const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: withTools ? "toolUse" : "stop",
			content: withTools ? ["call-a", "call-b"].map(id => ({ type: "toolCall", id, name: "controlled", arguments: {} })) : [] };
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		return stream;
	} });
	agent.state.tools = [{ name: "controlled", label: "controlled", description: "fixture", parameters: Type.Object({}),
		execute: async () => { effects++; return { content: [], details: undefined }; } }];
	agent.beforeToolCall = ({ toolCall, args }) => runner.emitToolCall({ type: "tool_call", toolName: toolCall.name,
		toolCallId: toolCall.id, input: args } as never);
	agent.subscribe(event => {
		if (event.type === "tool_execution_start") starts++;
		if (event.type === "tool_execution_end") ends++;
		if (event.type === "message_end" && event.message.role === "toolResult") results++;
	});
	let first!: () => void;
	const firstHook = new Promise<void>(resolve => { first = resolve; });
	let second!: () => void;
	const secondHook = new Promise<void>(resolve => { second = resolve; });
	let calls = 0; entered = () => { if (++calls === 1) first(); else second(); };
	const run = agent.prompt("offline fixture");
	await firstHook; scheduler.advanceBy(30_000);
	await secondHook; scheduler.advanceBy(30_000);
	await run;
	assert.deepEqual({ effects, starts, ends, results }, { effects: 0, starts: 2, ends: 2, results: 2 });
	assert.deepEqual(diagnostics, ["call-a", "call-b"]);
	assert.equal(mode.chatContainer.children.length, 2);
	const collapsed = mode.chatContainer.render(100).join("\n");
	assert.match(collapsed, /call-a/); assert.match(collapsed, /call-b/);
	assert.doesNotMatch(collapsed, /timed out after/);
	mode.chatContainer.children[0].setExpanded(true);
	assert.match(mode.chatContainer.render(100).join("\n"), /timed out after 30000ms/);
	assert.equal(scheduler.highWaterMark.current, 0);
});

test("machine work after a human selection still consumes the remaining deadline", async () => {
	const runtime = createExtensionRuntime(); const scheduler = new FakeScheduler();
	let selected!: () => void; let shown!: () => void;
	const visible = new Promise<void>(resolve => { shown = resolve; });
	const extension = await loadExtensionFromFactory(pi => pi.on("tool_call", async (_event, ctx) => {
		await ctx.ui.select("Approve", ["yes"]);
		await new Promise(() => {});
	}), process.cwd(), createEventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
		{ scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
	runner.setUIContext({ ...runner.getUIContext(), select: () => { shown(); return new Promise(resolve => { selected = () => resolve("yes"); }); } }, "tui");
	const run = runner.emitToolCall({ type: "tool_call", toolName: "controlled", toolCallId: "after-wait", input: {} } as never);
	const rejected = assert.rejects(run, /timed out after 30000ms/);
	await visible; scheduler.advanceBy(90_000); selected();
	for (let i = 0; i < 8; i++) await Promise.resolve();
	scheduler.advanceBy(29_999); assert.equal(runner.hookDeliveryStats.timeouts, 0);
	scheduler.advanceBy(1); await rejected;
	assert.equal(runner.hookDeliveryStats.timeouts, 1);
	assert.equal(scheduler.highWaterMark.current, 0);
});


test("run abort revokes the real permission wait before a late approval", async (t) => {
 const f = await permissionFixture(t);
 const run = f.call(); const rejection = assert.rejects(run, /abort/i);
 await f.visible; const signal = f.dialogOptions().signal;
 f.abort.abort(); await rejection;
 f.choose(0); await Promise.resolve();
 assert.equal(signal.aborted, true);
 assert.equal(f.permission.state.allowRules.length, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});
