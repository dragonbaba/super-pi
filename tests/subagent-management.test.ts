import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { attachSubagentWorkspaceDelegation, SESSION_PERMISSION_EVENT } from "../packages/extensions/resource-lifecycle-guard/permission-contract.ts";
import { SubagentScheduler } from "../packages/extensions/subagent/scheduler.ts";
import { SubagentTasks } from "../packages/extensions/subagent/tasks.ts";
import { isPathInside } from "../packages/extensions/subagent/child-security.ts";

// Set before loading the extension's config-path constants; never inspect user configuration.
const fixtureRoot = mkdtempSync(join(tmpdir(), "sp-managed-subagents-"));
const oldAgentDir = process.env.SP_CODING_AGENT_DIR;
const oldLauncher = process.env.SP_SOURCE_LAUNCHER;
const oldBundled = process.env.SP_BUNDLED_AGENTS_DIR;
process.env.SP_CODING_AGENT_DIR = join(fixtureRoot, "agent");
process.env.SP_SOURCE_LAUNCHER = fileURLToPath(new URL("fixtures/subagent-managed-child.mjs", import.meta.url));
delete process.env.SP_BUNDLED_AGENTS_DIR;
mkdirSync(join(process.env.SP_CODING_AGENT_DIR, "agents"), { recursive: true });
mkdirSync(join(process.env.SP_CODING_AGENT_DIR, "config"), { recursive: true });
writeFileSync(join(process.env.SP_CODING_AGENT_DIR, "agents", "scout.md"), "---\nname: scout\ndescription: Offline test agent\ntools: read\n---\nFixture prompt.");
writeFileSync(join(process.env.SP_CODING_AGENT_DIR, "agents", "worker.md"), "---\nname: worker\ndescription: Offline writer agent\ntools: read, write\n---\nFixture prompt.");
const { default: extension, assertTaskCount, snapshotSubagentDetails, boundedMessage, SubagentProcessRun, finishCancelledProcessGroup } = await import("../packages/extensions/subagent/index.ts");
const { parseSubagentLimits, loadSubagentLimits, SUBAGENT_LIMITS_PATH } = await import("../packages/extensions/subagent/limits.ts");
test.after(() => {
	for (const [name, value] of [["SP_CODING_AGENT_DIR", oldAgentDir], ["SP_SOURCE_LAUNCHER", oldLauncher], ["SP_BUNDLED_AGENTS_DIR", oldBundled]]) {
		if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
	}
	rmSync(fixtureRoot, { recursive: true, force: true });
});

test("limits accept explicit capacity, reject invalid values, and bound file reads", () => {
	assert.deepEqual(parseSubagentLimits("{}"), { maxConcurrent: 16, maxTasks: 64 });
	assert.deepEqual(parseSubagentLimits('{"maxConcurrent":64,"maxTasks":256}'), { maxConcurrent: 64, maxTasks: 256 });
	for (const input of ["null", "[]", '{"maxConcurrent":null}', '{"maxConcurrent":65}', '{"maxTasks":257}', '{"maxConcurrent":2,"maxTasks":1}', '{"maxTasks":1.5}', '{"unexpected":1}']) assert.throws(() => parseSubagentLimits(input));
	const path = join(fixtureRoot, "oversized.json");
	writeFileSync(path, " ".repeat(4097));
	assert.throws(() => loadSubagentLimits(path), /4096/);
	assert.throws(() => assertTaskCount({ tasks: new Array(65) }, { maxConcurrent: 16, maxTasks: 64 }), /requested 65, maximum 64.*no task was started/);
});

const readonlyWorkspace = { canonicalCwd: realpathSync(fixtureRoot), allowMutation: false };
test("POSIX root close escalates the recorded group and preserves cleanup failure", { skip: process.platform === "win32" }, t => {
	const calls: Array<[number, unknown]> = [];
	const kill = t.mock.method(process, "kill", (pid: number, signal: unknown) => { calls.push([pid, signal]); return true; });
	finishCancelledProcessGroup(321); assert.deepEqual(calls, [[-321, "SIGKILL"]]);
	kill.mock.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
	let finished = false;
	const run: any = Object.create(SubagentProcessRun.prototype);
	Object.assign(run, { settled: false, childClosed: false, killRequested: true, proc: { pid: 321 }, buffer: "", stdoutDecoder: new StringDecoder("utf8"),
		settle() { finished = true; } });
	run.onClose(0); assert.equal(finished, true); assert.match(run.cleanupError, /process-group cleanup failed: denied/);
});
test("shared FIFO handles multiple batches and releases cancelled queue entries", async () => {
	const scheduler = new SubagentScheduler({ maxConcurrent: 2, maxTasks: 4 });
	const first = scheduler.reserve([readonlyWorkspace, readonlyWorkspace]);
	const second = scheduler.reserve([readonlyWorkspace, readonlyWorkspace]);
	assert.throws(() => scheduler.reserve([readonlyWorkspace]), /4 reserved by unfinished calls \+ 1 requested/);
	const starts: number[] = [];
	const finish: Array<() => void> = [];
	const execute = (n: number) => async () => { starts.push(n); await new Promise<void>(resolve => { finish[n] = resolve; }); };
	const a = scheduler.run(undefined, execute(0));
	const b = scheduler.run(undefined, execute(1));
	const abort = new AbortController();
	const c = scheduler.run(abort.signal, execute(2));
	const cRejected = assert.rejects(c, /cancelled/);
	const d = scheduler.run(undefined, execute(3));
	assert.deepEqual(starts, [0, 1]);
	assert.equal(scheduler.queued, 2);
	abort.abort(new Error("cancelled"));
	await cRejected;
	finish[0](); await a; await tick();
	assert.deepEqual(starts, [0, 1, 3]);
	finish[1](); finish[3](); await Promise.all([b, d]);
	first.completed(); first.completed();
	assert.equal(scheduler.outstanding, 2);
	assert.throws(() => scheduler.reserve([readonlyWorkspace]), /4 reserved/, "completed siblings cannot accumulate in unbounded unfinished batches");
	first.release(); second.release();
	assert.equal(scheduler.highWaterMark, 2);
	assert.equal(scheduler.active + scheduler.queued + scheduler.outstanding + scheduler.reserved + scheduler.reservationCount, 0);
	scheduler.dispose();
});

test("writer overlap is rejected across batches, including nested paths", () => {
	const scheduler = new SubagentScheduler({ maxConcurrent: 2, maxTasks: 4 });
	const reservation = scheduler.reserve([{ ...readonlyWorkspace, allowMutation: true }]);
	assert.throws(() => scheduler.reserve([{ canonicalCwd: join(fixtureRoot, "nested"), allowMutation: false }]), /overlapping/);
	reservation.completed(); reservation.release(); reservation.release();
	assert.equal(scheduler.outstanding, 0);
	scheduler.reserve([readonlyWorkspace]).release();
	scheduler.dispose();
});

test("parallel admission rejects internal writer overlaps without reserving capacity", () => {
	const scheduler = new SubagentScheduler({ maxConcurrent: 2, maxTasks: 4 });
	const parent = { ...readonlyWorkspace, allowMutation: true };
	const child = { canonicalCwd: join(fixtureRoot, "nested"), allowMutation: true };
	for (const paths of [[parent, parent], [parent, child], [child, parent]]) {
		for (const writes of [[true, true], [true, false], [false, true]]) {
			assert.throws(() => scheduler.reserve(paths.map((path, i) => ({ ...path, allowMutation: writes[i] }))), /tasks 1 and 2.*overlapping.*no task was started/);
			assert.equal(scheduler.active + scheduler.queued + scheduler.outstanding + scheduler.reserved + scheduler.reservationCount, 0);
		}
	}
	const readers = scheduler.reserve([readonlyWorkspace, { ...child, allowMutation: false }]);
	readers.release();
	const isolated = scheduler.reserve([child, { canonicalCwd: join(fixtureRoot, "nested-other"), allowMutation: true }]);
	isolated.release();
	const chain = scheduler.reserve([parent, child], "chain");
	assert.throws(() => scheduler.reserve([readonlyWorkspace], "chain"), /already reserved/, "sequential steps still exclude overlapping calls");
	chain.release();
	assert.equal(scheduler.outstanding + scheduler.reserved + scheduler.reservationCount, 0);
	scheduler.dispose();
});

test("scheduler disposal rejects queued work and clears reservations", async () => {
	const scheduler = new SubagentScheduler({ maxConcurrent: 1, maxTasks: 2 });
	const reservation = scheduler.reserve([readonlyWorkspace, readonlyWorkspace]);
	let finish!: () => void;
	const active = scheduler.run(undefined, () => new Promise<void>(resolve => { finish = resolve; }));
	const queued = scheduler.run(undefined, async () => assert.fail("must not start"));
	const rejected = assert.rejects(queued, /ended before launch/);
	scheduler.dispose(); finish(); await active; await rejected; reservation.release();
	assert.equal(scheduler.active + scheduler.queued + scheduler.outstanding + scheduler.reservationCount, 0);
});

test("hard-ceiling batches run 64 of 256 admitted tasks and drain without oversubscription", async () => {
	const scheduler = new SubagentScheduler({ maxConcurrent: 64, maxTasks: 256 });
	const reservation = scheduler.reserve(new Array(256).fill(readonlyWorkspace));
	const jobs: Promise<void>[] = [];
	let completed = 0;
	for (let i = 0; i < 256; i++) jobs.push(scheduler.run(undefined, async () => { await tick(); completed++; reservation.completed(); }));
	assert.equal(scheduler.active, 64); assert.equal(scheduler.queued, 192);
	await Promise.all(jobs); reservation.release();
	assert.equal(completed, 256); assert.equal(scheduler.highWaterMark, 64);
	assert.equal(scheduler.active + scheduler.queued + scheduler.outstanding, 0);
	scheduler.dispose();
});

test("wait deadlines and aborted waits do not cancel tasks; result history stays bounded", async () => {
	const registry = new SubagentTasks(1);
	const first = registry.create("scout"); registry.start(first);
	await registry.wait(first.id, 1);
	assert.equal(first.state, "running");
	const abort = new AbortController();
	const waiting = registry.wait(first.id, 60_000, abort.signal);
	const rejected = assert.rejects(waiting);
	abort.abort(); await rejected;
	assert.equal(first.controller?.signal.aborted, false);
	assert.equal(registry.waiterCount, 0);
	registry.cancel(first.id);
	assert.equal(first.state, "cancelling");
	registry.finish(first, "x".repeat(60_000), true);
	assert.equal(first.state, "cancelled");
	assert.ok(first.result!.length < 12_100);
	assert.equal(first.controller, undefined);
	const second = registry.create("scout"); registry.finish(second, "done", false);
	assert.throws(() => registry.get(first.id), /expired/);
	assert.equal(first.result, undefined);
	registry.dispose();
	assert.equal(second.result, undefined);
	assert.equal(registry.size, 0);
});

test("history retains the latest completions even when an older task finishes last", () => {
	const registry = new SubagentTasks(2);
	const slow = registry.create("slow");
	const first = registry.create("first"); registry.finish(first, "first", false);
	const second = registry.create("second"); registry.finish(second, "second", false);
	registry.finish(slow, "latest", false);
	assert.throws(() => registry.get(first.id), /expired/);
	assert.equal(registry.get(slow.id).result, "latest");
	assert.equal(registry.get(second.id).result, "second");
	registry.dispose();
});

test("dispose releases waiters and ignores late results", async () => {
	const registry = new SubagentTasks(2);
	const task = registry.create("scout");
	const waiting = registry.wait(task.id, 60_000);
	const rejected = assert.rejects(waiting, /session ended/);
	registry.dispose(); await rejected;
	registry.finish(task, "late result", false);
	assert.equal(task.result, undefined);
	assert.equal(registry.waiterCount + registry.size + registry.retainedResults, 0);
});

const responsibility = { scope: "Fixture workspace only", deliverable: "Fixture result and evidence", stopCondition: "Return when the assigned fixture completes or report its blocker" };

function harness(t: test.TestContext, options: { persistent?: boolean; shutdownError?: RegExp } = {}) {
	assert.ok(SUBAGENT_LIMITS_PATH.startsWith(fixtureRoot), "configuration must stay in the recorded fixture directory");
	writeFileSync(SUBAGENT_LIMITS_PATH, '{"maxConcurrent":2,"maxTasks":8}');
	const tools = new Map<string, any>(); const commands = new Map<string, any>(); const hooks = new Map<string, any>();
	const startHooks: any[] = [], notices: Array<{ text: string; level: string }> = [];
	const events = createEventBus(); const messages: any[] = [];
	let completion!: () => void;
	let notified = new Promise<void>(resolve => { completion = resolve; });
	const pi: any = { events, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, hook: any) => { hooks.set(name, hook); if (name === "before_agent_start") startHooks.push(hook); }, sendMessage: (message: any) => { messages.push(message); completion(); } };
	extension(pi);
	const entries: any[] = [];
	pi.appendEntry = (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); };
	const cwd = realpathSync(mkdtempSync(join(fixtureRoot, "workspace-")));
	const ctx: any = { cwd, mode: "tui", hasUI: false, isIdle: () => true, isProjectTrusted: () => false, getActiveTools: () => ["subagent", "subagent_tasks"], modelRegistry: {}, model: undefined, ui: { notify(text: string, level: string) { notices.push({ text, level }); } } };
	if (options.persistent) ctx.sessionManager = { getSessionFile: () => join(cwd, "session.jsonl"), getSessionId: () => "fixture", getLeafId: () => null, getEntries: () => entries };
	let sequence = 0;
	const run = (params: any, onUpdate?: (value: any) => void) => {
		const id = `call-${++sequence}`;
		const items = params.tasks ?? params.chain ?? [params];
		for (const item of items) { item.scope ??= responsibility.scope; item.deliverable ??= responsibility.deliverable; item.stopCondition ??= responsibility.stopCondition; }
		const grants = items.map((item: any) => { const canonicalCwd = item.cwd ?? cwd; const stat = statSync(canonicalCwd); return { canonicalCwd, device: stat.dev, inode: stat.ino, permissionMode: item.readOnly ? "read-only" : "workspace-write", writable: !item.readOnly, source: isPathInside(canonicalCwd, cwd) ? "primary" : "additional" }; });
		attachSubagentWorkspaceDelegation(params, { schemaVersion: 1, sequence, toolCallId: id, grants });
		return tools.get("subagent").execute(id, params, undefined, onUpdate, ctx);
	};
	const control = async (action: string, id?: string, timeoutMs?: number) => (await tools.get("subagent_tasks").execute("control", { action, id, timeoutMs }, undefined)).content[0].text as string;
	t.after(async () => { if (options.shutdownError) await assert.rejects(hooks.get("session_shutdown")(), options.shutdownError); else await hooks.get("session_shutdown")(); events.clear(); });
	return { tools, commands, hooks, startHooks, notices, events, ctx, run, control, messages, entries, notified: () => notified, resetNotification: () => { notified = new Promise<void>(resolve => { completion = resolve; }); } };
}

test("ordinary children have no turn/token quota or per-turn control writes, even with a stale budget file", async t => {
	const stale = join(process.env.SP_CODING_AGENT_DIR!, "config", "task-budgets.json");
	writeFileSync(stale, '{"childTurns":1,"sessionTurns":1,"sessionTokens":1}');
	t.after(() => rmSync(stale));
	const h = harness(t, { persistent: true });
	const result = await h.run({ tasks: [{ agent: "scout", task: "two-turn-one", readOnly: true }, { agent: "scout", task: "two-turn-two", readOnly: true }] });
	assert.equal(result.details.results.length, 2);
	for (const item of result.details.results) { assert.equal(item.exitCode, 0); assert.equal(item.usage.turns, 2); }
	assert.equal(h.entries.length, 0);
	assert.equal(h.commands.has("task-budget"), false);
	assert.match(h.tools.get("subagent").description, /No token or turn quotas/);
});

test("responsibilities are required for every item before any child starts and reach its prompt", async t => {
	const h = harness(t); const tool = h.tools.get("subagent");
	assert.throws(() => tool.prepareArguments({ agent: "scout", task: "  ", ...responsibility }), /nonblank task objective/);
	assert.throws(() => tool.prepareArguments({ agent: "scout", task: "x".repeat(16384), ...responsibility }), /responsibility fields exceeds 16384/);
	for (const item of [tool.parameters.properties.tasks.items, tool.parameters.properties.chain.items]) {
		for (const key of ["scope", "deliverable", "stopCondition"]) assert.ok(item.required.includes(key), "models see required batch fields before calling");
	}
	for (const key of ["scope", "deliverable", "stopCondition"]) {
		for (const value of [undefined, "  ", "x".repeat(1025)]) {
			const item = { agent: "scout", task: "inspect", ...responsibility, [key]: value };
			for (const params of [item, { tasks: [{ agent: "scout", task: "valid", ...responsibility }, item] }, { chain: [item] }]) {
				assert.throws(() => tool.prepareArguments(params), new RegExp(key));
				await assert.rejects(tool.execute("invalid", params, undefined, undefined, h.ctx), new RegExp(key));
			}
		}
	}
	assert.deepEqual(readdirSync(h.ctx.cwd), []);
	assert.match(await h.control("list"), /0\/8 reserved/);
	assert.match(tool.description, /Plan long work as bounded phases BEFORE delegation/);
	assert.match(tool.description, /1048576.*128 messages/);
	assert.match(tool.description, /786432.*96 messages/);
	const result = await h.run({ agent: "scout", task: "inspect", readOnly: true, timeoutMs: 120000, ...responsibility });
	assert.equal(result.details.results[0].exitCode, 0);
	const marker = readdirSync(h.ctx.cwd).find(file => file.endsWith(".ready.json"))!;
	const started = JSON.parse(readFileSync(join(h.ctx.cwd, marker), "utf8"));
	assert.equal(started.task, `Task: inspect\n\nScope: ${responsibility.scope}\nDeliverable: ${responsibility.deliverable}\nStop condition: ${responsibility.stopCondition}`);
	assert.match(started.systemPrompt, /Return immediately when done/);
	assert.match(started.systemPrompt, /Runtime limit: 120000ms.*return completed work/);
});

test("capacity handoff reaches foreground/background results and stops dependent chain launches", async t => {
	const h = harness(t, { persistent: true });
	const chain = await h.run({ checkpoint: true, chain: [
		{ agent: "scout", task: "capacity-handoff", readOnly: true },
		{ agent: "scout", task: "must-not-run", readOnly: true },
	] });
	assert.match(chain.content[0].text, /Chain paused after step 1; dependent steps were not started/);
	assert.match(chain.content[0].text, /before the hard limit/);
	assert.equal(chain.details.results[0].handoff, "Checkpoint handoff");
	assert.equal(readdirSync(h.ctx.cwd).filter(file => file.endsWith(".ready.json")).length, 1);
	const parallel = await h.run({ checkpoint: true, tasks: [
		{ agent: "scout", task: "capacity-handoff", readOnly: true },
		{ agent: "scout", task: "small-phase", readOnly: true },
	] });
	assert.match(parallel.content[0].text, /1 completed; 1 handed off/);
	const background = await h.run({ checkpoint: true, agent: "scout", task: "capacity-handoff", readOnly: true, background: true });
	const id = ids(background)[0]; await h.notified();
	assert.match(await h.control("status", id), /Checkpoint capacity handoff.*fresh bounded assignment/s);
});

test("real completed checkpoint continues under a fresh ID and current authorization; memory sessions refuse storage", async t => {
	const memory = harness(t);
	await assert.rejects(memory.run({ agent: "scout", task: "persist", checkpoint: true }), /persistent parent session/);
	const h = harness(t, { persistent: true });
	const first = await h.run({ agent: "scout", task: "original", checkpoint: true, background: true, readOnly: true });
	const id = ids(first)[0]; await h.notified();
	assert.match(await h.control("status", id), /Checkpoint available/);
	await assert.rejects(h.run({ agent: "worker", task: "resume", resumeTaskId: id, readOnly: true }), /role\/workspace identity/);
	const ungranted = { agent: "scout", task: "resume", resumeTaskId: id, ...responsibility };
	await assert.rejects(h.tools.get("subagent").execute("no-grant", ungranted, undefined, undefined, h.ctx), /delegat|authoriz|permission/i);
	h.resetNotification();
	const next = await h.run({ agent: "scout", task: "verify and continue", resumeTaskId: id, background: true, readOnly: true });
	const nextId = ids(next)[0]; assert.notEqual(nextId, id); await h.notified();
	assert.match(await h.control("status", nextId), /completed.*\nCheckpoint available/);
	assert.match(await h.control("status", id), /original/);
	assert.equal(h.entries.length, 0, "continuation does not keep a budget ledger");
});

function ids(result: any): string[] { return result.content[0].text.match(/[a-f0-9-]{36}-\d+/g) ?? []; }

async function startedChild(cwd: string, task: string): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt++) {
		for (const file of readdirSync(cwd)) {
			if (!file.endsWith(".ready.json")) continue;
			let value;
			try { value = JSON.parse(readFileSync(join(cwd, file), "utf8")); } catch { continue; }
			if (value.task.startsWith(`Task: ${task}\n\nScope: `)) return value.pid;
		}
		await delay(20);
	}
	throw new Error("Offline child did not start");
}

test("effective limits are visible before first invocation and enforce preflight", async t => {
	const h = harness(t); const tool = h.tools.get("subagent");
	assert.match(tool.description, /2 running concurrently; 8 tasks/);
	assert.match(tool.description, /Hard ceilings: 64 concurrent, 256 tasks/);
	assert.match(tool.description, /fewest agents/);
	assert.equal(tool.parameters.properties.tasks.maxItems, 8);
	assert.throws(() => tool.prepareArguments({ tasks: new Array(9) }), /requested 9, maximum 8/);
	await assert.rejects(h.run({ agent: "scout", task: "x", background: true }), /isolated workspace/);
	h.ctx.mode = "json";
	await assert.rejects(h.run({ agent: "scout", task: "x", readOnly: true, background: true }), /TUI or RPC/);
	h.ctx.mode = "tui";
	h.ctx.getActiveTools = () => ["subagent"];
	await assert.rejects(h.run({ agent: "scout", task: "x", readOnly: true, background: true }), /management tool/);
	assert.match(await h.control("list"), /0\/2 running/);
});

test("foreground and background reject nested writers before launch while chains remain sequential", async t => {
	const h = harness(t);
	const workspace = realpathSync(mkdtempSync(join(fixtureRoot, "isolated-")));
	const nested = join(workspace, "nested"); mkdirSync(nested);
	const batch = [{ agent: "worker", task: "fast-parent", cwd: workspace }, { agent: "worker", task: "fast-child", cwd: nested }];
	for (const background of [false, true]) {
		await assert.rejects(h.run({ tasks: batch, background }), /tasks 1 and 2.*overlapping.*no task was started/);
		assert.doesNotMatch(await h.control("list"), /[a-f0-9-]{36}-\d+/, "rejected calls must not create task records");
		assert.match(await h.control("list"), /0\/8 reserved/);
		assert.deepEqual(readdirSync(workspace), ["nested"]);
		assert.deepEqual(readdirSync(nested), []);
	}
	const result = await h.run({ chain: batch });
	assert.match(result.content[0].text, /fixture result: Task: fast-child/);
	assert.ok(result.details.results[0].completedAt <= result.details.results[1].startedAt);
	assert.equal(readdirSync(workspace).filter(file => file.endsWith(".ready.json")).length, 1);
	assert.equal(readdirSync(nested).length, 1);
	assert.match(await h.control("list"), /0\/8 reserved/);
});

test("background returns IDs, cancellation isolates one child, and notification arrives once", { timeout: 10_000 }, async t => {
	const h = harness(t);
	const result = await h.run({ background: true, tasks: [{ agent: "scout", task: "hold", readOnly: true }, { agent: "scout", task: "slow", readOnly: true }] });
	const taskIds = ids(result); assert.equal(taskIds.length, 2);
	assert.equal(result.details.backgroundCount, 2);
	const pid = await startedChild(h.ctx.cwd, "hold");
	assert.match(await h.control("cancel", taskIds[0]), /cancelling/);
	await h.notified();
	assert.match(await h.control("status", taskIds[0]), /cancelled/);
	assert.match(await h.control("status", taskIds[1]), /completed.*\n\nfixture result/s);
	assert.equal(h.messages.length, 1);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
	assert.match(await h.control("list"), /0\/2 running · 0\/8 active\/queued/);
});

test("foreground publishes only isolated lifecycle snapshots and preserves final output", async t => {
	const h = harness(t); const updates: any[] = [];
	const result = await h.run({ agent: "scout", task: "fast", readOnly: true }, update => updates.push(update));
	assert.equal(updates.length, 2);
	assert.match(result.content[0].text, /fixture result/);
	assert.equal(updates[0].details.results[0].exitCode, -1);
	assert.equal(updates[0].details.results[0].usage.turns, 0);
	assert.equal(updates[1].details.results[0].usage.turns, 1);
	assert.equal(updates[1].details.results[0].messages.length, 0);
	assert.equal(updates[1].details.results[0].task, "");
	assert.equal(h.messages.length, 0);
});

test("real background calls share capacity and a cancelled queued child never launches", { timeout: 10_000 }, async t => {
	const h = harness(t);
	const make = (label: string) => ({ agent: "scout", task: `hold-${label}`, readOnly: true });
	const first = await h.run({ background: true, tasks: [make("a"), make("b"), make("c"), make("d")] });
	const second = await h.run({ background: true, tasks: [make("e"), make("f"), make("g"), make("h")] });
	const allIds = [...ids(first), ...ids(second)];
	await startedChild(h.ctx.cwd, "hold-a"); await startedChild(h.ctx.cwd, "hold-b");
	assert.match(await h.control("list"), /2\/2 running · 8\/8 active\/queued/);
	await assert.rejects(h.run({ background: true, ...make("overflow") }), /8 reserved by unfinished calls \+ 1 requested/);
	await h.control("cancel", allIds[7]);
	assert.match(await h.control("wait", allIds[7], 1000), /cancelled/);
	assert.equal(readdirSync(h.ctx.cwd).length, 2, "six queued children must not create a process");
	await h.hooks.get("session_shutdown")();
	assert.equal(h.messages.length, 0);
});

test("permission changes cancel owned children and suppress stale notifications", { timeout: 10_000 }, async t => {
	const h = harness(t);
	const result = await h.run({ agent: "scout", task: "hold", readOnly: true, background: true });
	const [id] = ids(result);
	const pid = await startedChild(h.ctx.cwd, "hold");
	h.events.emit(SESSION_PERMISSION_EVENT, {});
	assert.match(await h.control("wait", id, 5000), /cancelled/);
	assert.equal(h.messages.length, 0);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
	assert.match(await h.control("list"), /0\/2 running/);
});

test("tree navigation drains owned children before new branch work", async t => {
	const h = harness(t);
	const result = await h.run({ agent: "scout", task: "hold-tree", readOnly: true, background: true });
	const pid = await startedChild(h.ctx.cwd, "hold-tree");
	await h.hooks.get("session_before_tree")();
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
	assert.match(await h.control("status", ids(result)[0]), /cancelled/); assert.equal(h.messages.length, 0);
	assert.match((await h.run({ agent: "scout", task: "fast-new-branch", readOnly: true })).content[0].text, /fixture result/);
});

test("shutdown waits for real child exit and suppresses late delivery", { timeout: 10_000 }, async t => {
	const h = harness(t);
	await h.run({ agent: "scout", task: "hold", readOnly: true, background: true });
	const pid = await startedChild(h.ctx.cwd, "hold");
	await h.hooks.get("session_shutdown")();
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
	assert.equal(h.messages.length, 0);
	await assert.rejects(h.control("list"), /session is closed/);
});

test("failed Windows tree cleanup blocks queued children and successful quit acknowledgement", { skip: process.platform !== "win32", timeout: 10_000 }, async t => {
	const h = harness(t, { shutdownError: /process-tree cleanup failed/ });
	const accepted = await h.run({ tasks: [
		{ agent: "scout", task: "hold-cleanup-one", readOnly: true },
		{ agent: "scout", task: "hold-cleanup-two", readOnly: true },
		{ agent: "scout", task: "must-not-launch", readOnly: true },
	], background: true });
	const one = await startedChild(h.ctx.cwd, "hold-cleanup-one"), two = await startedChild(h.ctx.cwd, "hold-cleanup-two");
	const native = createRequire(import.meta.url)("node:child_process"), spawnSync = native.spawnSync;
	// Force an inspection failure; production fallback still stops these exact owned roots.
	native.spawnSync = () => ({ error: new Error("fixture tree cleanup denied") }); syncBuiltinESMExports();
	t.after(() => { native.spawnSync = spawnSync; syncBuiltinESMExports(); });
	await h.control("cancel", ids(accepted)[0]); await h.notified();
	assert.throws(() => process.kill(one, 0), /ESRCH/); assert.throws(() => process.kill(two, 0), /ESRCH/);
	assert.equal(readdirSync(h.ctx.cwd).some(file => readFileSync(join(h.ctx.cwd, file), "utf8").includes("must-not-launch")), false);
	await assert.rejects(h.run({ agent: "scout", task: "later" }), /process-tree cleanup failed/);
	await assert.rejects(h.hooks.get("session_shutdown")(), /process-tree cleanup failed/);
});

test("partial parallel failure keeps successful output; a chain cancels unstarted steps", async t => {
	const h = harness(t);
	const result = await h.run({ tasks: [{ agent: "scout", task: "fail", readOnly: true }, { agent: "scout", task: "fast", readOnly: true }] });
	assert.match(result.content[0].text, /1\/2 succeeded; 1 failed/);
	assert.match(result.content[0].text, /fixture result: Task: fast/);
	await assert.rejects(h.run({ chain: [{ agent: "scout", task: "fail", readOnly: true }, { agent: "scout", task: "must-not-run", readOnly: true }] }), /Chain stopped at step 1/);
	const listing = await h.control("list");
	assert.match(listing, /cancelled/);
	assert.match(listing, /0\/8 active\/queued/);
	assert.equal(readdirSync(h.ctx.cwd).some(file => readFileSync(join(h.ctx.cwd, file), "utf8").includes("must-not-run")), false);
});

test("large UTF-8 completion retains bounded head/tail and no large tool arguments", () => {
	const message: any = { role: "assistant", content: [{ type: "text", text: "开头" + "😀中文".repeat(30_000) + "结尾" }, { type: "toolCall", name: "read", arguments: { huge: "x".repeat(100_000) } }], usage: { input: 1, output: 2, cost: { total: 3, ignored: "x".repeat(100_000) } } };
	const bounded: any = boundedMessage(message, 600_000);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 32 * 1024);
	assert.ok(bounded.content[0].text.startsWith("开头"));
	assert.ok(bounded.content[0].text.endsWith("结尾"));
	assert.equal(bounded.content[0].text.includes("�"), false);
	assert.equal(bounded.content[1].arguments.truncated, true);
	assert.equal(bounded.usage.cost.total, 3);
});

test("snapshot ownership does not retain or alias task text, messages or mutable usage", () => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 };
	const source: any = { agent: "scout", agentSource: "user", task: "private", stderr: "private", messages: [{ role: "user", content: "private" }], exitCode: -1, usage };
	const snapshot = snapshotSubagentDetails("single", "user", null, [source]);
	usage.turns++;
	assert.equal(snapshot.results[0].usage.turns, 1);
	assert.equal(JSON.stringify(snapshot).includes("private"), false);
});
