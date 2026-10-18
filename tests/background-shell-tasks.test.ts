import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type } from "typebox";

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
const { registerLocalShellBackend } = await import("../packages/coding-agent/src/core/tools/shell-cwd.ts");
const { attachForegroundShellLaunch } = await import("../packages/coding-agent/src/core/tools/shell-background.ts");
const { Agent } = await import("../packages/agent/src/agent.ts");
const { createAssistantMessageEventStream } = await import("../packages/ai/src/utils/event-stream.ts");
const { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory, wrapRegisteredTools } = await import("../packages/coding-agent/src/core/extensions/index.ts");
const { SessionManager } = await import("../packages/coding-agent/src/core/session-manager.ts");
const { SettingsManager } = await import("../packages/coding-agent/src/core/settings-manager.ts");
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url);
const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: subagent } = await jiti.import<any>("../packages/extensions/subagent/index.ts");
const { default: falseSuccessGuard } = await jiti.import<any>("../packages/extensions/false-success-guard/index.ts");
const { createFalseSuccessState, createFalseSuccessLifecycleState, observeInputBoundary, beginPromptBoundary, observeVerificationStart, observeToolResult } = await jiti.import<any>("../packages/extensions/false-success-guard/core.ts");
const { windowsShellJobDiagnostics } = await import("../packages/coding-agent/src/utils/windows-shell-job.ts");
const bashPath = process.platform !== "win32" ? "/bin/bash" : existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : join(process.env.ProgramFiles!, "Git/bin/bash.exe");
test.after(() => {
	assert.equal(windowsShellJobDiagnostics().handles, 0); assert.equal(windowsShellJobDiagnostics().processHandles, 0);
	for (const [name, value] of [["SP_CODING_AGENT_DIR", oldAgentDir], ["SP_SOURCE_LAUNCHER", oldLauncher], ["SP_BUNDLED_AGENTS_DIR", oldBundled]]) {
		if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
	}
	assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
});

function harness(t: test.TestContext, expectedDisposalError?: RegExp) {
	assert.ok(BACKGROUND_SHELL_LIMITS_PATH.startsWith(root));
	const events = createEventBus(), tools = new Map<string, any>(), commands = new Map<string, any>(), hooks = new Map<string, any[]>();
	const messages: any[] = [];
	const pi: any = { events, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, hook: any) => { const list = hooks.get(name) ?? []; list.push(hook); hooks.set(name, list); }, sendMessage: (message: any) => messages.push(message) };
	const owner = new BackgroundShellTasks(pi);
	pi.getAllTools = () => [{ name: "bash", supportsManagedBackground: true }, ...tools.values()];
	const ctx: any = { cwd: root, mode: "tui", getActiveTools: () => ["bash", "tasks"] };
	t.after(async () => { if (expectedDisposalError) await assert.rejects(owner.dispose(), expectedDisposalError); else await owner.dispose(); events.clear(); });
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
	assert.match(h.messages.find(message => message.content.includes(`Task ${first};`))?.content, /Output excerpt: .*first/);
	assert.ok(h.messages.some(message => message.content.includes("state=cancelled")));
	for (const message of h.messages) assert.match(message.content, /source=host; user_input=false/);
});

test("queue revalidates authority and releases an unstarted request", async t => {
	const h = harness(t); let finish!: () => void, current = true, released = 0;
	const first = h.start(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { content: [], details: undefined }; });
	const second = h.start(async () => assert.fail("obsolete authorization must not execute"), undefined, () => released++, () => { if (!current) throw new Error("authority changed"); });
	current = false; finish(); await h.owner.tasks.wait(first, 1000); await h.owner.tasks.wait(second, 1000);
	assert.equal(h.owner.tasks.get(second).state, "failed"); assert.equal(released, 1);
	assert.match(h.owner.tasks.get(second).result!, /authority changed/);
});

async function fixture(t: test.TestContext, auxiliary?: any, preceding?: any, resume?: string) {
	const restored = resume ? SessionManager.open(resume) : undefined;
	const cwd = restored?.getCwd() ?? realpathSync(mkdtempSync(join(root, "workspace-")));
	writeFileSync(join(cwd, "fixture.mjs"), readFileSync(new URL("fixtures/background-shell-child.mjs", import.meta.url)));
	const session = restored ?? SessionManager.create(cwd, join(cwd, "sessions")), events = createEventBus(), runtime = createExtensionRuntime();
	const settings = SettingsManager.create(cwd, join(cwd, "agent"));
	const extensions = [];
	if (preceding) extensions.push(await loadExtensionFromFactory(preceding, cwd, events, runtime));
	extensions.push(await loadExtensionFromFactory(lifecycle, cwd, events, runtime));
	if (auxiliary) extensions.push(await loadExtensionFromFactory(auxiliary, cwd, events, runtime));
	const runner = new ExtensionRunner(extensions, runtime, cwd, session, {} as never);
	let beforeConsume = (_args: any) => {}, approvals = 0;
	const messages: any[] = [];
	const agent = new Agent({ streamFn: () => { throw new Error("offline test"); }, beforeToolCall: async ({ toolCall, args, parentToolCallId }) => {
		const result = await runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, parentToolCallId, input: args } as never); beforeConsume(args); return result;
	}, afterToolCall: ({ toolCall, args, result, isError, parentToolCallId }) => runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, parentToolCallId, input: args, content: result.content, details: result.details, isError } as never) });
	const active = ["bash", "powershell", "tasks"];
	runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => active, getAllTools: () => agent.state.tools, sendMessage: (message: any) => messages.push(message), appendEntry: (kind: string, data: any) => session.appendCustomEntry(kind, data) } as never,
		{ getSignal: () => agent.signal, getModel: () => undefined, isProjectTrusted: (identity?: boolean) => settings.isProjectTrusted(identity), isIdle: () => true, hasPendingMessages: () => false } as never);
	runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; return "仅允许本次"; } }, "tui");
	agent.state.tools = [createBashTool(cwd, { shellPath: bashPath }), createPowerShellTool(cwd), ...wrapRegisteredTools(runner.getAllRegisteredTools(), runner)];
	await runner.emit({ type: "session_start" } as never);
	let sequence = 0;
	const call = (name: string, args: any) => agent.dispatchHostTool({ type: "toolCall", id: `task-${++sequence}`, name, arguments: args });
	const shutdown = async () => { runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); agent.abort(); await agent.waitForIdle(); };
	t.after(async () => { await shutdown(); events.clear(); });
	return { cwd, session, call, runner, events, active, messages, shutdown, agent, approvals: () => approvals, beforeConsume: (fn: (args: any) => void) => { beforeConsume = fn; } };
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
	await tick();
	const report = h.messages.find(message => message.content.includes(`Task ${last};`));
	assert.match(report?.content, /exit=0; termination=exit; outputComplete=true/);
	assert.match(report.content, /result:fast/);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
	assert.ok(h.approvals() >= 1);
});

test("foreground shell ownership preserves cancellation, admission, terminal delivery and current controls", async t => {
	for (const mode of ["complete", "fail", "transfer", "parent", "permission", "tree", "dispose", "finishing", "controls", "authority"]) {
		const h = harness(t), parent = new AbortController();
		let finish!: () => void, control: any, executionSignal!: AbortSignal, releases = 0, updates = 0, stopped = 0, current = true;
		const gate = new Promise<void>(resolve => { finish = resolve; });
		const result = h.owner.createForegroundLaunch("bash", "foreground", "fixture", root, h.ctx, () => {
			if (!current) throw new Error("changed authority");
		})(async (signal, publish, state) => {
			executionSignal = signal; control = state; state.stopUpdates = () => { stopped++; };
			publish({ content: [], details: undefined });
			await gate; signal.throwIfAborted();
			if (mode === "fail") throw new Error("foreground failure");
			return { content: [{ type: "text", text: "original result" }], details: undefined };
		}, parent.signal, () => { updates++; }, () => { releases++; });
		// Attach observation before cancellation can reject the foreground promise.
		const observed = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
		const task = [...h.owner.tasks.values()][0];
		const transfer = () => h.tools.get("tasks").execute("transfer", { action: "background", id: task.id }, undefined, undefined, h.ctx);
		let boundary: Promise<void> | undefined;
		if (mode === "transfer") {
			await transfer();
			assert.equal((await observed).value!.details!.backgroundTask!.state, "running");
			assert.equal(control.background, true); assert.equal(stopped, 1);
			parent.abort(); assert.equal(executionSignal.aborted, false);
			await assert.rejects(transfer(), /Only a running/);
		} else if (mode === "parent") parent.abort();
		else if (mode === "permission") h.events.emit(SESSION_PERMISSION_EVENT, {});
		else if (mode === "tree") boundary = h.hooks.get("session_before_tree")![0]();
		else if (mode === "dispose") boundary = h.owner.dispose();
		else if (mode === "finishing") { control.completing = true; await assert.rejects(transfer(), /finishing/); }
		else if (mode === "controls") { h.ctx.getActiveTools = () => ["bash"]; await assert.rejects(transfer(), /management tool/); }
		else if (mode === "authority") { current = false; await assert.rejects(transfer(), /changed authority/); }
		finish();
		const completed = await observed;
		if (boundary) await boundary;
		else await h.owner.tasks.wait(task.id, 1000);
		await tick();
		if (["fail", "parent", "permission", "tree", "dispose"].includes(mode)) assert.ok(completed.error);
		else if (mode !== "transfer") assert.equal(completed.value!.content[0].type, "text");
		assert.equal(h.messages.length, mode === "transfer" ? 1 : 0);
		assert.equal(releases, 1); assert.equal(updates, 1);
		assert.equal((h.owner as any).foreground.size, 0); assert.equal((h.owner as any).pending.size, 0);
		assert.equal(h.owner.scheduler.active + h.owner.scheduler.reserved + h.owner.scheduler.queued, 0);
	}
	const h = harness(t);
	let finish!: () => void;
	const active = h.start(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { content: [], details: undefined }; });
	const parent = new AbortController();
	const queued = h.owner.createForegroundLaunch("bash", "queued", "fixture", root, h.ctx, () => {})(
		async () => assert.fail("cancelled queued foreground must not start"), parent.signal, undefined, () => {});
	const rejected = assert.rejects(queued);
	const queuedTask = [...h.owner.tasks.values()].find(task => task.id !== active)!;
	await assert.rejects(h.tools.get("tasks").execute("transfer", { action: "background", id: queuedTask.id }, undefined, undefined, h.ctx), /queued/);
	parent.abort(); await rejected; finish(); await h.owner.tasks.wait(active, 1000);
});

test("real bash and PowerShell foreground handoff keeps PID, stops progress and delivers one bounded terminal result", { timeout: 20_000 }, async t => {
	for (const name of process.platform === "win32" ? ["bash", "powershell"] : ["bash"]) {
		const h = await fixture(t);
		let publications = 0, listing = "";
		const unsubscribe = h.agent.subscribe(event => { if (event.type === "tool_execution_update") publications++; });
		t.after(unsubscribe);
		h.runner.setUIContext({ ...h.runner.getUIContext(), notify: value => { listing = value; } }, "tui");
		const foreground = h.call(name, { command: "node fixture.mjs handoff", cwd: ".", timeout: 10 });
		const pid = await started(h.cwd, "handoff");
		await h.runner.getCommand("tasks")!.handler("", h.runner.createCommandContext());
		const id = listing.match(/([a-f0-9-]{36}-\d+)[^\n]*foreground shell/)?.[1];
		assert.ok(id, listing);
		await h.runner.getCommand("tasks")!.handler("background " + id, h.runner.createCommandContext());
		const accepted = await foreground; assert.equal(taskId(accepted), id);
		assert.equal((accepted.details as any).backgroundTask.state, "running");
		const before = publications;
		h.agent.abort(); process.kill(pid, 0);
		writeFileSync(join(h.cwd, "handoff.release"), "release");
		const status = await h.call("tasks", { action: "wait", id, timeoutMs: 5000 });
		assert.match(text(status), /completed/); assert.ok(text(status).includes("HANDOFF-PID:" + pid));
		assert.equal((status.details as any).result.shellExecution.output.cleanup, "removed");
		assert.equal((status.details as any).result.fullOutputPath, undefined);
		assert.equal(publications, before);
		await tick(); assert.equal(h.messages.length, 1); assert.ok(h.messages[0].content.includes(id));
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	}
});

test("shell handoff during asynchronous startup does not resume foreground snapshots", async t => {
	const h = harness(t);
	let snapshots = 0;
	const snapshot = OutputAccumulator.prototype.snapshot;
	t.mock.method(OutputAccumulator.prototype, "snapshot", function(this: InstanceType<typeof OutputAccumulator>, options: Parameters<typeof snapshot>[0]) {
		snapshots++; return snapshot.call(this, options);
	});
	const backend = registerLocalShellBackend({ async exec(_command: string, cwd: string, options: any) {
		options.beforeSpawn?.(cwd);
		for (let i = 0; i < 4; i++) options.onData(Buffer.from("startup output\n"));
		return { exitCode: 0, termination: "exit" as const, observation: { started: true, cwd, exitCode: 0, signal: null, outputDrained: true } };
	} });
	const tool = createBashToolDefinition(root, { operations: backend, exposeSessionEnvironment: false });
	const input = { command: "fixture", cwd: ".", timeout: 10 };
	attachForegroundShellLaunch(input, h.owner.createForegroundLaunch("bash", "startup", "fixture", root, h.ctx, () => {}));
	const foreground = tool.execute("startup", input, undefined, undefined, h.ctx);
	const task = [...h.owner.tasks.values()][0];
	// Transfer before the tool's awaited directory preparation can resume.
	await h.tools.get("tasks").execute("transfer", { action: "background", id: task.id }, undefined, undefined, h.ctx);
	assert.equal((await foreground).details!.backgroundTask!.id, task.id);
	await h.owner.tasks.wait(task.id, 1000);
	assert.equal(snapshots, 1, "only terminal capture may materialize output after handoff");
	assert.equal(h.messages.length, 1);
});

test("nested shell awaits real completion and is never offered for foreground handoff", { timeout: 10_000 }, async t => {
	const h = await fixture(t);
	let listing = "", dependent = false;
	h.runner.setUIContext({ ...h.runner.getUIContext(), notify: value => { listing = value; } }, "tui");
	h.agent.state.tools.push({ name: "nested_fixture", label: "Nested fixture", description: "Fixture", parameters: Type.Object({}), orchestration: true,
		async execute(_id, _args, _signal, _update, context) {
			const result = await context!.callTool("bash", { command: "node fixture.mjs handoff small", cwd: ".", timeout: 10 });
			assert.equal(result.isError, false, text(result)); assert.equal((result.details as any).backgroundTask, undefined);
			dependent = true; return { content: result.content, details: result.details };
		} });
	let turns = 0;
	h.agent.streamFunction = (() => {
		const next = turns++ === 0;
		const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: next ? "toolUse" : "stop", content: next ? [{ type: "toolCall", id: "parent", name: "nested_fixture", arguments: {} }] : [] };
		const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message }); return stream;
	}) as any;
	const foreground = h.agent.prompt("offline nested fixture");
	await Promise.race([started(h.cwd, "handoff"), foreground.then(() => assert.fail("Nested task ended before its child started"))]);
	await h.runner.getCommand("tasks")!.handler("", h.runner.createCommandContext());
	assert.doesNotMatch(listing, /foreground shell/); assert.equal(dependent, false);
	writeFileSync(join(h.cwd, "handoff.release"), "release");
	await foreground;
	const result = h.agent.state.messages.find(message => message.role === "toolResult") as any;
	assert.equal(result.isError, false, text(result)); assert.match(text(result), /HANDOFF-PID:/); assert.equal(dependent, true);
	assert.equal(h.messages.length, 0);
});

test("foreground transfer acceptance keeps verification pending until terminal facts", () => {
	const state = createFalseSuccessState();
	const input = { command: "npm test", cwd: root, timeout: 60 };
	observeVerificationStart(state, "call");
	observeToolResult(state, { toolName: "bash", toolCallId: "call", input, cwd: root, isError: false,
		details: { backgroundTask: { id: "transferred", state: "running", kind: "shell" } } });
	assert.equal([...state.obligations.values()][0].category, "pending");
	observeToolResult(state, { toolName: "bash", toolCallId: "call", input: { ...input, background: true }, cwd: root, isError: false,
		details: { backgroundTask: { id: "transferred", state: "completed", kind: "shell" }, shellExecution: shellFacts(0) } });
	assert.equal(state.obligations.size, 0);
	observeToolResult(state, { toolName: "bash", toolCallId: "call", input, cwd: root, isError: false,
		details: { backgroundTask: { id: "transferred", state: "running", kind: "shell" } } });
	assert.equal(state.obligations.size, 0, "late foreground acceptance cannot reopen a completed task");
});

test("foreground shell eligibility preserves ordinary execution and transfer keeps timeout/cancellation", { timeout: 20_000 }, async t => {
	for (const [cwd, timeout, mode] of [[undefined, 10, "tui"], [".", undefined, "tui"], [".", 7201, "tui"], [".", 10, "print"], [".", 10, "tui"]] as const) {
		const h = await fixture(t);
		h.runner.setUIContext(h.runner.getUIContext(), mode);
		const result = await h.call("bash", { command: "node fixture.mjs fast", cwd, timeout });
		assert.equal(result.isError, false, text(result)); assert.match(text(result), /result:fast/);
		assert.equal((result.details as any).backgroundTask, undefined);
		const listing = text(await h.call("tasks", { action: "list" }));
		assert.equal(/ · bash · completed/.test(listing), cwd === "." && timeout === 10 && mode === "tui");
		assert.equal(h.messages.length, 0);
	}
	for (const finish of ["timeout", "cancel", "permission", "tree"]) {
		const h = await fixture(t);
		let listing = "";
		h.runner.setUIContext({ ...h.runner.getUIContext(), notify: value => { listing = value; } }, "tui");
		const foreground = h.call("bash", { command: "node fixture.mjs hold", cwd: ".", timeout: finish === "timeout" ? 2 : 10 });
		const pid = await started(h.cwd, "hold");
		await h.runner.getCommand("tasks")!.handler("", h.runner.createCommandContext());
		const id = listing.match(/([a-f0-9-]{36}-\d+)[^\n]*foreground shell/)?.[1];
		assert.ok(id, listing);
		await h.runner.getCommand("tasks")!.handler("background " + id, h.runner.createCommandContext());
		assert.equal(taskId(await foreground), id);
		if (finish === "cancel") await h.call("tasks", { action: "cancel", id });
		else if (finish === "permission") h.events.emit(SESSION_PERMISSION_EVENT, {});
		else if (finish === "tree") await h.runner.emit({ type: "session_before_tree" } as never);
		const status = await h.call("tasks", { action: "wait", id, timeoutMs: 5000 });
		assert.equal((status.details as any).result.shellExecution.termination, finish === "timeout" ? "timeout" : "cancelled");
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		await tick();
		assert.equal(h.messages.length, finish === "permission" || finish === "tree" ? 0 : 1);
	}
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
	const child = await h.call("subagent", { agent: "scout", task: "fast", scope: "Fixture workspace", deliverable: "Fixture result", stopCondition: "Return when done", readOnly: true, background: true });
	assert.equal(child.isError, false, text(child));
	const id = text(child).match(/[a-f0-9-]{36}-\d+/)![0];
	const list = text(await h.call("tasks", { action: "list" }));
	assert.match(list, /shell:/); assert.match(list, /subagent:/); assert.ok(list.includes(shell) && list.includes(id));
	const result = await h.call("tasks", { action: "wait", id, timeoutMs: 5000 });
	assert.match(text(result), /completed.*fixture result/s); assert.equal((result.details as any).task.kind, "subagent");
	assert.match(text(await h.call("subagent_tasks", { action: "status", id })), /fixture result/);
	await h.call("tasks", { action: "wait", id: shell, timeoutMs: 5000 });
	const unsupported = await h.call("tasks", { action: "background", id: shell });
	assert.equal(unsupported.isError, true); assert.match(text(unsupported), /Only a running foreground shell/);
	const shellSteer = await h.call("tasks", { action: "steer", id: shell, text: "inspect" });
	assert.equal(shellSteer.isError, true); assert.match(text(shellSteer), /executor does not support steering/);
	const guided = await h.call("subagent", { agent: "scout", task: "guidance-gate-integration", scope: "Fixture workspace", deliverable: "Fixture result", stopCondition: "Return when done", readOnly: true, checkpoint: true, background: true });
	assert.equal(guided.isError, false, text(guided));
	const guidedId = text(guided).match(/[a-f0-9-]{36}-\d+/)![0];
	let guidedPid: number | undefined;
	for (let n = 0; n < 100 && !guidedPid; n++) {
		for (const file of readdirSync(h.cwd)) if (file.endsWith(".ready.json")) {
			const marker = JSON.parse(readFileSync(join(h.cwd, file), "utf8"));
			if (marker.task?.includes("guidance-gate-integration")) guidedPid = marker.pid;
		}
		if (!guidedPid) await delay(20);
	}
	assert.ok(guidedPid);
	const correction = await h.call("tasks", { action: "steer", id: guidedId, text: "report the verified path" });
	assert.equal(correction.isError, false, text(correction)); assert.match(text(correction), /1 accepted, 0 sent/);
	assert.match(text(await h.call("tasks", { action: "status", id: guidedId })), /queued at parent/);
	writeFileSync(join(h.cwd, `child-${guidedPid}.release`), "release");
	const guidedResult = await h.call("subagent_tasks", { action: "wait", id: guidedId, timeoutMs: 5000 });
	assert.match(text(guidedResult), /completed.*fixture received:.*source=parent.*report the verified path/s);
	const foreground = h.call("subagent", { agent: "scout", task: "hold-transfer", scope: "Fixture workspace", deliverable: "Fixture result", stopCondition: "Return when done", readOnly: true });
	let foregroundId: string | undefined;
	let listing = "";
	h.runner.setUIContext({ ...h.runner.getUIContext(), notify: value => { listing = value; } }, "tui");
	for (let n = 0; n < 100 && !foregroundId; n++) {
		await h.runner.getCommand("tasks")!.handler("", h.runner.createCommandContext());
		foregroundId = listing.match(/([a-f0-9-]{36}-\d+)[^\n]*foreground single/)?.[1];
		if (!foregroundId) await delay(20);
	}
	assert.ok(foregroundId);
	await h.runner.getCommand("tasks")!.handler(`background ${foregroundId}`, h.runner.createCommandContext());
	const transferred = await foreground; assert.equal(transferred.isError, false, text(transferred));
	assert.ok(text(transferred).includes(foregroundId));
	await h.call("tasks", { action: "cancel", id: foregroundId });
	assert.match(text(await h.call("tasks", { action: "wait", id: foregroundId, timeoutMs: 5000 })), /cancelled/);
});

test("real reload restores both providers with historical facts but no notification, verification event or process replay", async t => {
	const h = await fixture(t, subagent); h.active.push("subagent", "subagent_tasks");
	h.session.appendMessage({ role: "user", content: "offline history fixture", timestamp: Date.now() });
	const shell = taskId(await h.call("bash", { command: "node fixture.mjs fast", cwd: ".", background: true }));
	await h.call("tasks", { action: "wait", id: shell, timeoutMs: 5000 });
	const children = await h.call("subagent", { agent: "scout", task: "hold", scope: "Fixture workspace", deliverable: "Fixture result", stopCondition: "Return when done", readOnly: true, background: true });
	const child = text(children).match(/[a-f0-9-]{36}-\d+/)![0];
	await h.shutdown();
	let terminalEvents = 0;
	const restored = await fixture(t, subagent, (pi: any) => { pi.events.on("super-pi:shell-task-result", () => { terminalEvents++; }); }, h.session.getSessionFile());
	restored.active.push("subagent", "subagent_tasks");
	const status = await restored.call("tasks", { action: "status", id: shell });
	assert.match(text(status), /completed · historical/); assert.equal((status.details as any).result.shellExecution.exitCode, 0);
	assert.equal((status.details as any).task.historical, true); assert.equal(realpathSync.native((status.details as any).task.cwd), realpathSync.native(h.cwd));
	assert.match(text(await restored.call("subagent_tasks", { action: "wait", id: child, timeoutMs: 60_000 })), /cancelled · historical/);
	assert.equal(restored.messages.length, 0); assert.equal(terminalEvents, 0); assert.equal(restored.approvals(), 0);
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
	const child = await h.call("subagent", { agent: "scout", task: "fast", scope: "Fixture workspace", deliverable: "Fixture result", stopCondition: "Return when done", readOnly: true, background: true });
	assert.equal(child.isError, true); assert.match(text(child), /subagent_tasks|management tool/);
});

test("pre-tree cleanup finishes before earlier new-branch evidence handlers run", async t => {
	let checkBranch!: () => Promise<void>;
	const h = await fixture(t, undefined, async (pi: any) => {
		falseSuccessGuard(pi);
		pi.on("session_tree", async () => { await checkBranch(); await tick(); });
	});
	writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts: { test: "node fixture.mjs hold" } }));
	const id = taskId(await h.call("bash", { command: "npm test", cwd: ".", background: true }));
	const pid = await started(h.cwd, "hold");
	checkBranch = async () => {
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		assert.match(text(await h.call("tasks", { action: "status", id })), /cancelled/);
		assert.equal(h.messages.length, 0);
	};
	await h.runner.emit({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal } as never);
	await h.runner.emit({ type: "session_tree" } as never);
	const complete = await h.runner.emitToolCall({ type: "tool_call", toolName: "goal_complete", toolCallId: "after-tree", input: {} } as never);
	assert.notEqual(complete?.block, true);
});

test("process cleanup failure blocks queued and new launches before the slot drains", async t => {
	const h = harness(t, /Process-tree cleanup failed: fixture/); let finish!: () => void, queuedStarted = 0;
	const first = h.start(async () => {
		await new Promise<void>(resolve => { finish = resolve; });
		return { content: [], details: { shellExecution: shellFacts(1, "Process-tree cleanup failed: fixture") } };
	});
	const queued = h.start(async () => { queuedStarted++; return { content: [], details: undefined }; });
	finish(); await h.owner.tasks.wait(first, 1000); await h.owner.tasks.wait(queued, 1000);
	assert.equal(queuedStarted, 0);
	assert.throws(() => h.owner.assertAvailable(h.ctx), /cleanup failed/);
	await h.hooks.get("session_before_tree")![0]();
	assert.throws(() => h.owner.assertAvailable(h.ctx), /cleanup failed/);
});

function shellFacts(code: number, observationError?: string) {
	return { version: 1, producer: "local-shell", started: true, cwd: realpathSync.native(root), executionStatus: "exited", sideEffects: "unknown", retryGuidance: "inspect_before_retry", exitCode: code, signal: null, termination: "exit", observationError, output: { complete: true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" } };
}

test("queued input and concurrent successes cannot erase a task-specific failed check", () => {
	const state = createFalseSuccessState(), lifecycleState = createFalseSuccessLifecycleState();
	const observation = (id: string, command: string, phase: "queued" | "failed" | "completed") => ({ toolName: "bash", toolCallId: id, input: { command, cwd: root, background: true }, isError: phase === "failed", cwd: root,
		details: { backgroundTask: { id, state: phase, kind: "shell" }, shellExecution: phase === "queued" ? undefined : shellFacts(phase === "failed" ? 1 : 0) } });
	observeToolResult(state, observation("fails", "npm test -- first", "queued"));
	observeToolResult(state, observation("sibling", "npm test -- first", "queued"));
	observeInputBoundary(lifecycleState, { source: "rpc", streamingBehavior: "followUp" });
	observeToolResult(state, observation("fails", "npm test -- first", "failed"));
	beginPromptBoundary(state, lifecycleState, "continue");
	observeToolResult(state, observation("sibling", "npm test -- first", "completed"));
	assert.equal(state.obligations.size, 1); assert.equal([...state.obligations.values()][0].category, "command_failed");
	observeToolResult(state, observation("other-target", "npm test -- second", "queued"));
	observeToolResult(state, observation("other-target", "npm test -- second", "completed"));
	assert.equal(state.obligations.size, 1, "a different targeted test is not a retry");
	observeVerificationStart(state, "foreground-retry");
	observeToolResult(state, { toolName: "bash", toolCallId: "foreground-retry", input: { command: "npm test -- first", cwd: root }, isError: false, cwd: root, details: { shellExecution: shellFacts(0) } });
	assert.equal(state.obligations.size, 0);
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
		await tick();
		const report = h.messages.find(message => message.content.includes(`Task ${id};`));
		assert.ok(report.content.length <= 8192);
		assert.ok(report.content.includes(`exit=${details.shellExecution.exitCode ?? "unknown"}; termination=${details.shellExecution.termination}`));
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
	await tick();
	assert.match(h.messages.find(message => message.content.includes(`Task ${id};`))?.content, /cleanup=failed/);
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
