import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "sp-background-shell-"));
const oldAgentDir = process.env.SP_CODING_AGENT_DIR;
const oldLauncher = process.env.SP_SOURCE_LAUNCHER;
const oldBundled = process.env.SP_BUNDLED_AGENTS_DIR;
process.env.SP_CODING_AGENT_DIR = join(root, "agent");
process.env.SP_SOURCE_LAUNCHER = fileURLToPath(new URL("fixtures/subagent-managed-child.mjs", import.meta.url));
delete process.env.SP_BUNDLED_AGENTS_DIR;
mkdirSync(join(root, "agent", "config"), { recursive: true });
mkdirSync(join(root, "agent", "agents"));
writeFileSync(join(root, "agent", "agents", "scout.md"), "---\nname: scout\ndescription: Offline test agent\ntools: read\n---\nFixture prompt.");
writeFileSync(join(root, "agent", "config", "background-shell-limits.json"), '{"maxConcurrent":1,"maxTasks":3}');
const { createEventBus } = await import("../packages/coding-agent/src/core/event-bus.ts");
const { BackgroundShellTasks, BACKGROUND_SHELL_LIMITS_PATH } = await import("../packages/extensions/resource-lifecycle-guard/background-shell.ts");
const { SESSION_PERMISSION_EVENT } = await import("../packages/extensions/resource-lifecycle-guard/permission-contract.ts");
const { createBashTool, createBashToolDefinition } = await import("../packages/coding-agent/src/core/tools/bash.ts");
const { createPowerShellTool } = await import("../packages/coding-agent/src/core/tools/powershell.ts");
const { OutputAccumulator } = await import("../packages/coding-agent/src/core/tools/output-accumulator.ts");
const { Agent } = await import("../packages/agent/src/agent.ts");
const { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory, wrapRegisteredTools } = await import("../packages/coding-agent/src/core/extensions/index.ts");
const { SessionManager } = await import("../packages/coding-agent/src/core/session-manager.ts");
const { SettingsManager } = await import("../packages/coding-agent/src/core/settings-manager.ts");
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url);
const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: subagent } = await jiti.import<any>("../packages/extensions/subagent/index.ts");
const { default: falseSuccessGuard } = await jiti.import<any>("../packages/extensions/false-success-guard/index.ts");
const { createFalseSuccessState, observeToolResult } = await jiti.import<any>("../packages/extensions/false-success-guard/core.ts");
const bashPath = process.platform !== "win32" ? "/bin/bash" : existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : join(process.env.ProgramFiles!, "Git/bin/bash.exe");
test.after(() => {
	for (const [name, value] of [["SP_CODING_AGENT_DIR", oldAgentDir], ["SP_SOURCE_LAUNCHER", oldLauncher], ["SP_BUNDLED_AGENTS_DIR", oldBundled]]) {
		if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
	}
	assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
});

function harness(t: test.TestContext) {
	assert.ok(BACKGROUND_SHELL_LIMITS_PATH.startsWith(root));
	const events = createEventBus(), tools = new Map<string, any>(), commands = new Map<string, any>(), hooks = new Map<string, any[]>();
	const messages: any[] = [];
	const pi: any = { events, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, hook: any) => { const list = hooks.get(name) ?? []; list.push(hook); hooks.set(name, list); }, sendMessage: (message: any) => messages.push(message) };
	const owner = new BackgroundShellTasks(pi);
	pi.getAllTools = () => [...tools.values()];
	const ctx: any = { cwd: root, mode: "tui", getActiveTools: () => ["bash", "tasks"] };
	t.after(async () => { await owner.dispose(); events.clear(); });
	const start = (execute: any, signal?: AbortSignal, release = () => {}, check = () => {}) => owner.createLaunch("bash", "call", "npm test", root, ctx, check)(execute, signal, release).details.backgroundTask!.id;
	return { owner, events, tools, hooks, messages, ctx, start };
}

test("background availability and effective caps are advertised before submission", async t => {
	const h = harness(t);
	const prompt = h.hooks.get("before_agent_start")![0]({ systemPrompt: "base" }).systemPrompt;
	assert.match(prompt, /1 running concurrently, 3 admitted/); assert.match(prompt, /hard ceilings 64\/256/);
	assert.equal(h.tools.get("tasks").modelOnly, true);
	h.ctx.mode = "print"; assert.throws(() => h.owner.assertAvailable(h.ctx), /live TUI or RPC/);
	h.ctx.mode = "tui"; h.ctx.getActiveTools = () => ["bash"]; assert.throws(() => h.owner.assertAvailable(h.ctx), /management tool/);
	h.ctx.getActiveTools = () => ["bash", "tasks"];
	const managed = h.tools.get("tasks");
	h.tools.set("tasks", { ...managed, parameters: structuredClone(managed.parameters) });
	assert.throws(() => h.owner.assertAvailable(h.ctx), /conflicting tasks/);
	h.tools.set("tasks", managed); h.owner.assertAvailable(h.ctx);
	const tool = createBashToolDefinition(root);
	assert.throws(() => tool.prepareArguments!({ command: "echo test", background: true }), /explicit cwd/);
	assert.throws(() => tool.prepareArguments!({ command: "echo test", cwd: ".", background: true, timeout: 7201 }), /7200/);
	await assert.rejects(tool.execute("unowned", { command: "echo test", cwd: ".", background: true }, undefined, undefined, {} as any), /fresh shell authorization/);
});

test("bounded FIFO, cancellation, parent independence, waits and release", async t => {
	const h = harness(t); let releaseFirst!: () => void, releases = 0, queuedStarted = 0;
	const parent = new AbortController();
	const first = h.start(async () => { await new Promise<void>(resolve => { releaseFirst = resolve; }); return { content: [{ type: "text", text: "first" }], details: undefined }; }, parent.signal, () => releases++);
	parent.abort(); assert.equal(h.owner.tasks.get(first).controller?.signal.aborted, false);
	const queued = h.start(async () => { queuedStarted++; return { content: [], details: undefined }; }, undefined, () => releases++);
	const last = h.start(async () => ({ content: [{ type: "text", text: "last" }], details: undefined }), undefined, () => releases++);
	assert.throws(() => h.start(async () => assert.fail("overflow")), /Background shell capacity exceeded: 3.*maximum 3/);
	await h.owner.tasks.wait(first, 1); assert.equal(h.owner.tasks.get(first).state, "running");
	h.owner.tasks.cancel(queued); await h.owner.tasks.wait(queued, 1000); assert.equal(queuedStarted, 0);
	releaseFirst(); await h.owner.tasks.wait(last, 1000); await tick();
	assert.equal(releases, 3); assert.equal(h.owner.scheduler.highWaterMark, 1);
	assert.equal(h.owner.scheduler.active + h.owner.scheduler.queued + h.owner.scheduler.reserved, 0);
	assert.equal(h.messages.length, 3);
});

test("queue revalidates authority and releases an unstarted request", async t => {
	const h = harness(t); let finish!: () => void, current = true, released = 0;
	const first = h.start(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { content: [], details: undefined }; });
	const second = h.start(async () => assert.fail("obsolete authorization must not execute"), undefined, () => released++, () => { if (!current) throw new Error("authority changed"); });
	current = false; finish(); await h.owner.tasks.wait(first, 1000); await h.owner.tasks.wait(second, 1000);
	assert.equal(h.owner.tasks.get(second).state, "failed"); assert.equal(released, 1);
	assert.match(h.owner.tasks.get(second).result!, /authority changed/);
});

async function fixture(t: test.TestContext, auxiliary?: any, preceding?: any) {
	const cwd = realpathSync(mkdtempSync(join(root, "workspace-")));
	writeFileSync(join(cwd, "fixture.mjs"), readFileSync(new URL("fixtures/background-shell-child.mjs", import.meta.url)));
	const session = SessionManager.create(cwd, join(cwd, "sessions")), events = createEventBus(), runtime = createExtensionRuntime();
	const settings = SettingsManager.create(cwd, join(cwd, "agent"));
	const extensions = [];
	if (preceding) extensions.push(await loadExtensionFromFactory(preceding, cwd, events, runtime));
	extensions.push(await loadExtensionFromFactory(lifecycle, cwd, events, runtime));
	if (auxiliary) extensions.push(await loadExtensionFromFactory(auxiliary, cwd, events, runtime));
	const runner = new ExtensionRunner(extensions, runtime, cwd, session, {} as never);
	let beforeConsume = (_args: any) => {}, approvals = 0;
	const messages: any[] = [];
	const agent = new Agent({ streamFn: () => { throw new Error("offline test"); }, beforeToolCall: async ({ toolCall, args }) => {
		const result = await runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never); beforeConsume(args); return result;
	}, afterToolCall: ({ toolCall, args, result, isError }) => runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: result.content, details: result.details, isError } as never) });
	const active = ["bash", "powershell", "tasks"];
	runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => active, getAllTools: () => runner.getAllRegisteredTools().map(tool => tool.definition), sendMessage: (message: any) => messages.push(message), appendEntry: (kind: string, data: any) => session.appendCustomEntry(kind, data) } as never,
		{ getSignal: () => agent.signal, getModel: () => undefined, isProjectTrusted: (identity?: boolean) => settings.isProjectTrusted(identity), isIdle: () => true, hasPendingMessages: () => false } as never);
	runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; return "仅允许本次"; } }, "tui");
	agent.state.tools = [createBashTool(cwd, { shellPath: bashPath }), createPowerShellTool(cwd), ...wrapRegisteredTools(runner.getAllRegisteredTools(), runner)];
	await runner.emit({ type: "session_start" } as never);
	let sequence = 0;
	const call = (name: string, args: any) => agent.dispatchHostTool({ type: "toolCall", id: `task-${++sequence}`, name, arguments: args });
	const shutdown = async () => { runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); agent.abort(); await agent.waitForIdle(); };
	t.after(async () => { await shutdown(); events.clear(); });
	return { cwd, call, runner, events, active, messages, shutdown, approvals: () => approvals, beforeConsume: (fn: (args: any) => void) => { beforeConsume = fn; } };
}

function text(result: any): string { return result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"); }
function taskId(result: any): string { assert.equal(result.isError, false, text(result)); return result.details.backgroundTask.id; }
async function started(cwd: string, name: string): Promise<number> {
	for (let n = 0; n < 150; n++) {
		try { return JSON.parse(readFileSync(join(cwd, `${name}.ready.json`), "utf8")).pid; } catch {}
		await delay(20);
	}
	throw new Error("Recorded fixture child did not start");
}

for (const shell of ["bash", "powershell"]) test(`${shell} authorized background work returns IDs, cancels queued work and preserves a sibling`, { skip: shell === "powershell" && process.platform !== "win32", timeout: 15_000 }, async t => {
	const h = await fixture(t);
	const start = async (mode: string) => taskId(await h.call(shell, { command: `node fixture.mjs ${mode}`, cwd: ".", background: true }));
	const hold = await start("hold"), queued = await start("queued"), last = await start("fast");
	const pid = await started(h.cwd, "hold");
	assert.match(text(await h.call("tasks", { action: "list" })), /1\/1 running · 3\/3 active\/queued · 2 queued/);
	await h.call("tasks", { action: "cancel", id: queued });
	assert.match(text(await h.call("tasks", { action: "wait", id: queued, timeoutMs: 1000 })), /cancelled/);
	assert.equal(existsSync(join(h.cwd, "queued.ready.json")), false);
	await h.call("tasks", { action: "cancel", id: hold });
	const result = await h.call("tasks", { action: "wait", id: last, timeoutMs: 5000 });
	assert.match(text(result), /completed.*result:fast/s);
	assert.equal((result.details as any).result.shellExecution.exitCode, 0);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
	assert.ok(h.approvals() >= 1);
});

test("final authorization binds background flag and rejects auxiliary disagreement", async t => {
	const h = await fixture(t);
	h.beforeConsume(args => { args.background = false; });
	const changed = await h.call("bash", { command: "node fixture.mjs fast", cwd: ".", background: true });
	assert.equal(changed.isError, true); assert.match(text(changed), /changed|authority/);
	assert.equal(existsSync(join(h.cwd, "fast.ready.json")), false);
	const disagree = await fixture(t, (pi: any) => pi.on("tool_call", (event: any) => event.toolName === "bash" ? { finalAuthorization: {
		consume(args: any) { return { command: args.command, cwd: args.cwd, timeout: args.timeout, purpose: args.purpose, background: false }; }, release() {},
	} } : undefined));
	const result = await disagree.call("bash", { command: "node fixture.mjs fast", cwd: ".", background: true });
	assert.equal(result.isError, true); assert.match(text(result), /snapshots disagree/);
	assert.equal(existsSync(join(disagree.cwd, "fast.ready.json")), false);
});

test("real extension loading shares shell/subagent controls and keeps the legacy tool", async t => {
	const h = await fixture(t, subagent);
	h.active.push("subagent", "subagent_tasks");
	assert.equal(h.runner.getAllRegisteredTools().filter((tool: any) => tool.definition.name === "tasks").length, 1);
	const shell = taskId(await h.call("bash", { command: "node fixture.mjs fast", cwd: ".", background: true }));
	const child = await h.call("subagent", { agent: "scout", task: "fast", readOnly: true, background: true });
	assert.equal(child.isError, false, text(child));
	const id = text(child).match(/[a-f0-9-]{36}-\d+/)![0];
	const list = text(await h.call("tasks", { action: "list" }));
	assert.match(list, /shell:/); assert.match(list, /subagent:/); assert.ok(list.includes(shell) && list.includes(id));
	const result = await h.call("tasks", { action: "wait", id, timeoutMs: 5000 });
	assert.match(text(result), /completed.*fixture result/s); assert.equal((result.details as any).task.kind, "subagent");
	assert.match(text(await h.call("subagent_tasks", { action: "status", id })), /fixture result/);
	await h.call("tasks", { action: "wait", id: shell, timeoutMs: 5000 });
});

test("terminal background evidence reaches the completion guard without polling", async t => {
	const h = await fixture(t, falseSuccessGuard);
	writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts: { test: "node fixture.mjs fast" } }));
	const id = taskId(await h.call("bash", { command: "npm test", cwd: ".", background: true }));
	const pending = await h.runner.emitToolCall({ type: "tool_call", toolName: "goal_complete", toolCallId: "pending", input: {} } as never);
	assert.equal(pending?.block, true);
	for (let n = 0; h.messages.length === 0 && n < 150; n++) await delay(20);
	assert.equal(h.messages.length, 1);
	assert.ok(h.messages[0].content.includes(id));
	const terminal = await h.runner.emitToolCall({ type: "tool_call", toolName: "goal_complete", toolCallId: "done", input: {} } as never);
	assert.notEqual(terminal?.block, true);
});

test("old task completion cannot contaminate verification after session tree navigation", async t => {
	const h = await fixture(t, falseSuccessGuard);
	writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts: { test: "node fixture.mjs hold" } }));
	const id = taskId(await h.call("bash", { command: "npm test", cwd: ".", background: true }));
	const pid = await started(h.cwd, "hold");
	for (const source of ["interactive", "rpc"] as const) {
		await h.runner.emitInput("continue", undefined, source);
		await h.runner.emitBeforeAgentStart("continue", undefined, "base", { cwd: h.cwd });
		const pending = await h.runner.emitToolCall({ type: "tool_call", toolName: "goal_complete", toolCallId: source, input: {} } as never);
		assert.equal(pending?.block, true, "ordinary input must preserve a running verification");
	}
	await h.runner.emit({ type: "session_tree" } as never);
	assert.throws(() => process.kill(pid, 0), /ESRCH/); assert.equal(h.messages.length, 0);
	assert.match(text(await h.call("tasks", { action: "status", id })), /cancelled/);
	const result = await h.runner.emitToolCall({ type: "tool_call", toolName: "goal_complete", toolCallId: "new-branch", input: {} } as never);
	assert.notEqual(result?.block, true);
});

test("session tree navigation drains cleanup before admitting work on the new branch", async t => {
	const h = harness(t); let finish!: () => void, released = 0, settled = false;
	const id = h.start(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { content: [], details: undefined }; }, undefined, () => released++);
	const boundary = h.hooks.get("session_tree")![0]().then(() => { settled = true; });
	await tick();
	assert.equal(settled, false); assert.equal(h.owner.tasks.get(id).controller?.signal.aborted, true);
	assert.throws(() => h.start(async () => assert.fail("must wait for old cleanup")), /session is changing/);
	finish(); await boundary;
	assert.equal(released, 1); assert.equal(h.owner.scheduler.outstanding, 0); assert.equal(h.messages.length, 0);
	h.owner.assertAvailable(h.ctx);
});

test("an earlier unrelated tasks registration prevents unmanaged background execution", async t => {
	const h = await fixture(t, subagent, (pi: any) => pi.registerTool({ name: "tasks", label: "Unrelated tasks", description: "Collision fixture", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }));
	const result = await h.call("bash", { command: "node fixture.mjs fast", cwd: ".", background: true });
	assert.equal(result.isError, true); assert.match(text(result), /conflicting tasks/);
	assert.equal(existsSync(join(h.cwd, "fast.ready.json")), false);
	h.active.push("subagent");
	const child = await h.call("subagent", { agent: "scout", task: "fast", readOnly: true, background: true });
	assert.equal(child.isError, true); assert.match(text(child), /subagent_tasks|management tool/);
});

test("permission invalidation and shutdown wait for the owned child and suppress notifications", { timeout: 15_000 }, async t => {
	for (const mode of ["permissions", "shutdown"]) {
		const h = await fixture(t);
		const id = taskId(await h.call("bash", { command: "node fixture.mjs hold", cwd: ".", background: true }));
		const pid = await started(h.cwd, "hold");
		if (mode === "permissions") {
			h.events.emit(SESSION_PERMISSION_EVENT, {});
			assert.match(text(await h.call("tasks", { action: "wait", id, timeoutMs: 5000 })), /cancelled/);
		} else await h.shutdown();
		assert.throws(() => process.kill(pid, 0), /ESRCH/); assert.equal(h.messages.length, 0);
	}
});

test("background failure/timeout facts and large-output tail survive bounded retention", { timeout: 15_000 }, async t => {
	const h = await fixture(t);
	for (const [mode, timeout] of [["fail", 10], ["hold", 0.2], ["burst", 10]] as const) {
		const id = taskId(await h.call("bash", { command: `node fixture.mjs ${mode}`, cwd: ".", background: true, timeout }));
		const result = await h.call("tasks", { action: "wait", id, timeoutMs: 10_000 });
		const details = (result.details as any).result;
		assert.ok(text(result).length < 12_200);
		if (mode === "fail") { assert.match(text(result), /failed/); assert.equal(details.shellExecution.exitCode, 7); }
		else if (mode === "hold") { assert.match(text(result), /failed/); assert.equal(details.shellExecution.termination, "timeout"); }
		else { assert.match(text(result), /FINAL-SHELL-SENTINEL/); assert.equal(details.fullOutputPath, undefined); assert.equal(details.truncation.content, ""); assert.equal(details.shellExecution.output.cleanup, "removed"); }
	}
});

test("cleanup failure preserves the owned log path and stops further background admission", async t => {
	const h = await fixture(t); let path: string | undefined, attempts = 0;
	t.mock.method(OutputAccumulator.prototype, "discardTempFile", async function(this: any) {
		path = this.tempFilePath; attempts++; throw new Error(`Fixture cleanup refused: ${path}`);
	});
	t.after(() => { if (path) { assert.equal(dirname(path), tmpdir()); rmSync(path, { force: true }); rmSync(path + ".sp-owned", { force: true }); } });
	const id = taskId(await h.call("bash", { command: "node fixture.mjs burst", cwd: ".", background: true }));
	const result = await h.call("tasks", { action: "wait", id, timeoutMs: 5000 });
	assert.equal(attempts, 1); assert.ok(path && existsSync(path));
	assert.equal((result.details as any).result.shellExecution.output.cleanup, "failed");
	assert.equal((result.details as any).result.fullOutputPath, path);
	assert.match(text(result), /failed/); assert.doesNotMatch(text(result), /temporary log removed/);
	const next = await h.call("bash", { command: "node fixture.mjs fast", cwd: ".", background: true });
	assert.equal(next.isError, true); assert.match(text(next), /cleanup failed/);
	assert.equal(existsSync(join(h.cwd, "fast.ready.json")), false);
});

test("verification acceptance stays pending and one completion cannot clear another task", () => {
	const state = createFalseSuccessState();
	const input = { command: "npm test", cwd: root, background: true };
	const acceptance = (id: string) => ({ toolName: "bash", input, isError: false, details: { backgroundTask: { id, state: "queued", kind: "shell" } }, cwd: root });
	observeToolResult(state, acceptance("one")); observeToolResult(state, acceptance("two"));
	assert.equal(state.obligations.size, 2); assert.ok([...state.obligations.values()].every((item: any) => item.category === "pending"));
	const complete = { ...acceptance("one"), details: { backgroundTask: { id: "one", state: "completed", kind: "shell" }, shellExecution: { version: 1, producer: "local-shell", started: true, cwd: realpathSync.native(root), executionStatus: "exited", sideEffects: "unknown", retryGuidance: "inspect_before_retry", exitCode: 0, signal: null, termination: "exit", output: { complete: true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" } } } };
	observeToolResult(state, complete); assert.equal(state.obligations.size, 1);
	observeToolResult(state, acceptance("one")); assert.equal(state.obligations.size, 1, "late acceptance must not undo terminal evidence");
	observeToolResult(state, { ...complete, isError: true, details: { ...complete.details, backgroundTask: { id: "two", state: "failed", kind: "shell" }, shellExecution: { ...complete.details.shellExecution, exitCode: 1 } } });
	assert.equal(state.obligations.size, 1); assert.equal([...state.obligations.values()][0].category, "command_failed");
	observeToolResult(state, acceptance("retry")); assert.equal(state.obligations.size, 2);
	observeToolResult(state, { ...complete, details: { ...complete.details, backgroundTask: { id: "retry", state: "completed", kind: "shell" } } });
	assert.equal(state.obligations.size, 0, "a successful retry repairs terminal failure");
	for (let i = 0; i < 256; i++) observeToolResult(state, acceptance(`many-${i}`));
	for (let i = 0; i < 40; i++) observeToolResult(state, { toolName: "edit", input: { path: `file-${i}.ts` }, isError: true, cwd: complete.details.shellExecution.cwd });
	assert.equal(state.obligations.size, 256 + 32, "pending checks and failure history have separate bounded capacities");
	for (let i = 32; i < 256; i++) observeToolResult(state, { ...complete, details: { ...complete.details, backgroundTask: { id: `many-${i}`, state: "completed", kind: "shell" } } });
	assert.equal(state.obligations.size, 32, "newer completions cannot erase older running checks");
});
