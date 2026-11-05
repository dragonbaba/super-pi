import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CapturedProcess, CLI_LIMIT, SandboxLifecycle, parseRunning } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { blankAcceptancePassed } from "../scripts/acceptance/windows-sandbox-acceptance.mjs";
import { parseFixedEntryExit } from "../scripts/acceptance/windows-sandbox-fixed-acceptance.mjs";

const limits = { callMs: 50, startMs: 50, execMs: 1, settleMs: 50, exitMs: 50, pollMs: 1 };
function reply(stdout = "{}", exitCode = 0) { return { exitCode, signal: null, launchError: null, truncated: false, stdout, stderr: "" }; }
test("observed fixed exec reply separates wrapper status and rejects unknown or failed responses", () => {
	const observed = '{\r\n  "ExitCode": 0\r\n}\r\n';
	assert.equal(Buffer.byteLength(observed), 23); assert.equal(parseFixedEntryExit(reply(observed)), 0);
	assert.equal(parseFixedEntryExit(reply('{"ExitCode":17}')), 17);
	for (const raw of ['{}', '{"ExitCode":"0"}', '{"ExitCode":0,"extra":1}', 'null', 'invalid']) assert.throws(() => parseFixedEntryExit(reply(raw)));
	assert.throws(() => parseFixedEntryExit(reply(observed, 1)));
	assert.throws(() => parseFixedEntryExit({ ...reply(observed), truncated: true }));
});
class FakeCall extends EventEmitter {
	pid = 123;
	constructor(result) { super(); this.result = result; }
	wait = CapturedProcess.prototype.wait;
	finish(result = reply()) { this.result = result; this.emit("settled"); }
}
class FakeCli {
	running = new Set();
	kinds = [];
	startGate;
	execGate;
	settleExecOnStop = true;
	stopLag = 0;
	stopping = false;
	badList = false;
	launch(args) {
		this.kinds.push(args[0]);
		if (args[0] === "start") {
			assert.equal(args[1], "--id"); assert.equal(args[3], "--config");
			this.id = args[2];
			if (this.startGate) return this.startGate;
			this.running.add(this.id); return new FakeCall(reply());
		}
		if (args[0] === "stop") {
			assert.equal(args[2], this.id);
			if (this.execGate && this.settleExecOnStop) this.execGate.finish(reply("", 1));
			this.stopping = true; return new FakeCall(reply());
		}
		if (args[0] === "exec") {
			assert.deepEqual(args, ["exec", "--id", this.id, "-c", '"C:\\SuperPiProbe\\Input\\node.exe" "C:\\SuperPiProbe\\Input\\guest.mjs"', "-d", "C:\\SuperPiProbe\\Input", "-r", "System", "--raw"]);
			return this.execGate ?? new FakeCall(reply());
		}
		assert.deepEqual(args, ["list", "--raw"]);
		if (this.badList) return new FakeCall(reply("bad", 1));
		if (this.stopping && this.stopLag-- <= 0) this.running.delete(this.id);
		return new FakeCall(reply(JSON.stringify({ WindowsSandboxEnvironments: Array.from(this.running, Id => ({ Id })) })));
	}
}
function fixture(cli, override = {}) {
	let latest;
	const owner = new SandboxLifecycle({ cli, config: "fixed fake config", journal(record) { latest = record; }, limits: { ...limits, ...override } });
	return { owner, latest: () => latest };
}

test("CLI capture is bounded, deadlines retain physical ownership, and close releases listeners/buffers", { timeout: 5000 }, async () => {
	const call = new CapturedProcess(process.execPath, ["-e", "setTimeout(()=>{process.stdout.write(Buffer.alloc(100000,65));process.stderr.write(Buffer.alloc(20000,66));process.exitCode=7},80)"], process.cwd());
	assert.equal(await call.wait(1), "timeout");
	assert.ok(call.child); assert.equal(call.result, undefined); assert.equal(call.listenerCount("settled"), 0);
	assert.equal(await call.wait(3000), "settled");
	assert.equal(call.result.exitCode, 7); assert.equal(call.result.stdoutSeen, 100000); assert.equal(call.result.stderrSeen, 20000);
	assert.equal(call.result.stdout.length, CLI_LIMIT); assert.equal(call.result.stderr.length, CLI_LIMIT); assert.equal(call.result.truncated, true);
	assert.equal(call.child, undefined); assert.equal(call.out, undefined); assert.equal(call.err, undefined); assert.equal(call.listenerCount("settled"), 0);
	assert.throws(() => parseRunning(reply('{"WindowsSandboxEnvironments":[]}', 1)));
	assert.throws(() => parseRunning(reply('{}')));
	assert.throws(() => parseRunning(reply('{"WindowsSandboxEnvironments":[{"Id":"x"}]}')));
});

test("pending fixed exec permits owned stop first, but unreleased execution still blocks cleanup", async () => {
	const cli = new FakeCli(); cli.execGate = new FakeCall();
	const { owner } = fixture(cli);
	await owner.start(); await assert.rejects(owner.executeFixed(), /exec: timeout/);
	assert.ok(owner.execution); assert.equal(owner.active, undefined);
	assert.equal(await owner.cleanup(), true); assert.equal(owner.state, "closed");
	assert.equal(owner.execution, undefined); assert.equal(cli.execGate.listenerCount("settled"), 0);
	assert.equal(owner.calls.find(call => call.kind === "exec").result.exitCode, 1);
	assert.equal(cli.kinds.filter(kind => kind === "stop").length, 1);
	const stuck = new FakeCli(); stuck.execGate = new FakeCall(); stuck.settleExecOnStop = false;
	const b = fixture(stuck, { settleMs: 1 });
	await b.owner.start(); await assert.rejects(b.owner.executeFixed(), /timeout/);
	assert.equal(await b.owner.cleanup(), false); assert.equal(b.owner.state, "blocked-cleanup");
	assert.ok(b.owner.execution); assert.equal(stuck.running.size, 0);
	stuck.execGate.finish();
});

test("cancelled start retains late instance responsibility; delayed stop and repeated cleanup close once", async () => {
	const cli = new FakeCli(); cli.startGate = new FakeCall(); cli.stopLag = 2;
	const { owner } = fixture(cli), abort = new AbortController();
	const starting = owner.start(abort.signal);
	// The preflight await precedes actual dispatch. One microtask reaches start.
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.ok(cli.kinds.includes("start")); abort.abort();
	await assert.rejects(starting, /cancelled/);
	const closing = owner.cleanup();
	assert.equal(owner.state, "cleaning"); assert.ok(owner.active);
	assert.equal(cli.kinds.includes("stop"), false);
	cli.running.add(owner.id); cli.startGate.finish();
	assert.equal(await closing, true); assert.equal(owner.state, "closed"); assert.equal(owner.active, undefined);
	const count = cli.kinds.length;
	assert.equal(owner.cleanup(), closing); assert.equal(await owner.cleanup(), true); assert.equal(cli.kinds.length, count);
	assert.equal(cli.kinds.filter(kind => kind === "stop").length, 1);
	assert.equal(cli.startGate.listenerCount("settled"), 0);
	assert.equal(blankAcceptancePassed("cancel-start", owner, "cancelled", true), true);
	assert.equal(blankAcceptancePassed("timeout-start", owner, "cancelled", true), false);
});

test("query failure and unresolved start retain admission responsibility instead of claiming empty", async () => {
	const cli = new FakeCli(), a = fixture(cli);
	await a.owner.start(); cli.badList = true;
	assert.equal(await a.owner.cleanup(), false); assert.equal(a.owner.state, "blocked-cleanup");
	assert.match(a.latest().cleanupError, /Running-list/); assert.equal(cli.running.has(a.owner.id), true);
	assert.equal(cli.kinds.includes("stop"), false);
	const pending = new FakeCli(); pending.startGate = new FakeCall();
	const b = fixture(pending, { startMs: 1, settleMs: 1 });
	await assert.rejects(b.owner.start(), /timeout/);
	assert.equal(await b.owner.cleanup(), false); assert.ok(b.owner.active);
	assert.equal(b.owner.state, "blocked-cleanup"); assert.equal(pending.kinds.includes("stop"), false);
	pending.startGate.finish(); // Release only the fake event source; owner remains blocked.
});

test("pre-existing instances and pre-start cancellation never start or stop someone else's instance", async () => {
	const existing = "11111111-2222-3333-4444-555555555555";
	const cli = new FakeCli(); cli.running.add(existing);
	const a = fixture(cli);
	await assert.rejects(a.owner.start(), /Existing instances/);
	assert.equal(await a.owner.cleanup(), true); assert.deepEqual(cli.kinds, ["list"]); assert.ok(cli.running.has(existing));
	const fresh = new FakeCli(), b = fixture(fresh), abort = new AbortController(); abort.abort();
	await assert.rejects(b.owner.start(abort.signal), /Cancelled before/);
	assert.equal(await b.owner.cleanup(), true); assert.deepEqual(fresh.kinds, ["list"]);
	const preflight = new FakeCall(), c = fixture({ launch() { return preflight; } }, { callMs: 1 });
	await assert.rejects(c.owner.start(), /timeout/);
	preflight.finish(reply('{"WindowsSandboxEnvironments":[]}'));
	assert.equal(await c.owner.cleanup(), true);
	assert.equal(blankAcceptancePassed("timeout-start", c.owner, "CLI list: timeout", true), false);
	const vanished = new FakeCli(), d = fixture(vanished);
	await d.owner.start(); vanished.running.delete(d.owner.id);
	assert.equal(await d.owner.cleanup(), true);
	assert.equal(d.owner.stopAttempted, false);
	assert.equal(blankAcceptancePassed("blank", d.owner, undefined, true), false);
});

test("explicit cleanup retry re-observes retained owners after a failed list without restarting or stealing", async () => {
	const cli = new FakeCli(), {owner} = fixture(cli);
	await owner.start(); cli.badList = true;
	const first = owner.cleanup(); assert.equal(await first, false);
	assert.equal(owner.registered, true); assert.equal(owner.state, "blocked-cleanup");
	cli.badList = false;
	const second = owner.cleanup(); assert.notEqual(second, first); assert.equal(owner.cleanup(), second);
	assert.equal(await second, true); assert.equal(owner.state, "closed"); assert.equal(owner.cleanupError, undefined);
	assert.equal(owner.cleanup(), second);
	assert.equal(cli.kinds.filter(kind => kind === "start").length, 1);
	assert.equal(cli.kinds.filter(kind => kind === "stop").length, 1);
});
