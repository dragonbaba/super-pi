import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ENV_AGENT_DIR } from "../packages/coding-agent/src/config.ts";
import { CURRENT_SESSION_VERSION, findMostRecentSession, getDefaultSessionDir, SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

function fixture(t: TestContext) {
	const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-session-cwd-")));
	t.diagnostic(`ownedFixture=${root}`);
	t.after(() => removeOwnedFixture(root));
	const cwd = join(root, "Project"), other = `${cwd}-other`, sessions = join(root, "SharedSessions");
	for (const path of [cwd, other, sessions]) fs.mkdirSync(path);
	const previousAgent = process.env[ENV_AGENT_DIR]; process.env[ENV_AGENT_DIR] = join(root, "Agent");
	t.after(() => { if (previousAgent === undefined) delete process.env[ENV_AGENT_DIR]; else process.env[ENV_AGENT_DIR] = previousAgent; });
	return { root, cwd, other, sessions };
}
function writeSession(dir: string, name: string, cwd: unknown, time = 1000): string {
	const path = join(dir, `${name}.jsonl`);
	fs.writeFileSync(path, `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: name, timestamp: new Date(time).toISOString(), cwd })}\n`);
	fs.utimesSync(path, new Date(time), new Date(time)); return path;
}
function link(target: string, alias: string): void { fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir"); }

test("shared sessions match Windows cwd case/drive/namespace aliases and exclude other projects", { skip: process.platform !== "win32" }, async t => {
	const f = fixture(t), older = writeSession(f.sessions, "older", f.cwd.toLowerCase(), 1000), newer = writeSession(f.sessions, "newer", f.cwd.toUpperCase(), 2000);
	writeSession(f.sessions, "other", f.other, 3000);
	for (const cwd of [f.cwd, f.cwd.toLowerCase(), toNamespacedPath(f.cwd)]) {
		assert.deepEqual((await SessionManager.list(cwd, f.sessions)).map(session => session.path), [newer, older]);
		assert.equal(findMostRecentSession(f.sessions, cwd), newer);
		assert.equal(SessionManager.continueRecent(cwd, f.sessions).getSessionFile(), newer);
	}
});

test("shared sessions match cwd junctions/symlinks in either direction", async t => {
	const f = fixture(t), alias = join(f.root, "Alias"); link(f.cwd, alias);
	const real = writeSession(f.sessions, "real", f.cwd, 1000), linked = writeSession(f.sessions, "linked", alias, 2000);
	writeSession(f.sessions, "other", f.other, 3000);
	for (const cwd of [f.cwd, alias]) {
		assert.deepEqual((await SessionManager.list(cwd, f.sessions)).map(session => session.path), [linked, real]);
		assert.equal(findMostRecentSession(f.sessions, cwd), linked);
		assert.equal(SessionManager.continueRecent(cwd, f.sessions).getSessionFile(), linked);
	}
});

test("default session directory aliases preserve bucket discovery and all-scope classification", async t => {
	const f = fixture(t), defaultDir = getDefaultSessionDir(f.cwd), alias = join(f.root, "DefaultAlias"); link(defaultDir, alias);
	// Default buckets historically load valid headers even if cwd is absent/different.
	writeSession(defaultDir, "legacy", undefined);
	assert.equal((await SessionManager.list(f.cwd)).length, 1);
	for (const dir of [defaultDir, alias, ...(process.platform === "win32" ? [defaultDir.toUpperCase()] : [])]) {
		assert.equal((await SessionManager.list(f.cwd, dir)).length, 1);
		const manager = SessionManager.continueRecent(f.cwd, dir);
		assert.equal(manager.getSessionId(), "legacy");
		assert.equal(manager.usesDefaultSessionDir(), true);
	}
	assert.equal(SessionManager.create(f.cwd, f.sessions).usesDefaultSessionDir(), false);
	assert.equal(SessionManager.inMemory(f.cwd).usesDefaultSessionDir(), false);
	assert.equal(getDefaultSessionDir(f.cwd), defaultDir, "historical bucket name is unchanged");
});

test("missing cwd matches only exact lexical identity; empty/non-string headers are excluded", async t => {
	const f = fixture(t), missing = join(f.root, "Missing"), expected = writeSession(f.sessions, "missing", missing);
	writeSession(f.sessions, "other-missing", `${missing}-other`, 2000);
	for (const [name, cwd] of [["empty", ""], ["absent", undefined], ["number", 42]] as const) writeSession(f.sessions, name, cwd, 3000);
	fs.writeFileSync(join(f.sessions, "corrupt.jsonl"), "not json\n");
	assert.deepEqual((await SessionManager.list(missing, f.sessions)).map(session => session.path), [expected]);
	assert.equal(findMostRecentSession(f.sessions, missing), expected);
	assert.equal(findMostRecentSession(f.sessions, join(f.root, "NoMatch")), null);
	assert.equal(findMostRecentSession(join(f.root, "NoSessions"), f.cwd), null);
});

test("case-sensitive distinct cwd objects are isolated", async t => {
	const f = fixture(t), sensitive = join(f.root, "Sensitive"); fs.mkdirSync(sensitive);
	if (process.platform === "win32") {
		try { execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", sensitive, "enable"], { stdio: "pipe", windowsHide: true }); }
		catch { t.skip("Host cannot enable per-directory case sensitivity"); return; }
	}
	const upper = join(sensitive, "Case"), lower = join(sensitive, "case"); fs.mkdirSync(upper); fs.mkdirSync(lower);
	assert.notEqual(fs.statSync(upper, { bigint: true }).ino, fs.statSync(lower, { bigint: true }).ino);
	const expected = writeSession(f.sessions, "upper", upper); writeSession(f.sessions, "lower", lower, 2000);
	assert.deepEqual((await SessionManager.list(upper, f.sessions)).map(session => session.path), [expected]);
	assert.equal(findMostRecentSession(f.sessions, upper), expected);
});

for (const size of [100, 1000]) {
	test(`one scan resolves each distinct cwd once across ${size} headers`, async t => {
		const f = fixture(t), alias = join(f.root, "Alias"); link(f.cwd, alias);
		for (let i = 0; i < size; i++) writeSession(f.sessions, `session-${i}`, i % 10 === 0 ? f.other : alias, 1000 + i);
		const native = fs.realpathSync.native, calls = new Map<string, number>();
		t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { const path = String(args[0]); calls.set(path, (calls.get(path) ?? 0) + 1); return native(...args); });
		assert.ok(findMostRecentSession(f.sessions, f.cwd));
		assert.deepEqual([...calls.values()], [1, 1, 1]);
		assert.equal(calls.get(f.cwd), 1); assert.equal(calls.get(alias), 1); assert.equal(calls.get(f.other), 1);
		calls.clear(); assert.equal((await SessionManager.list(f.cwd, f.sessions)).length, size * 0.9);
		assert.equal(calls.size, 5, "two session-directory identities + query and two header cwd identities");
		assert.ok([...calls.values()].every(value => value === 1));
		calls.clear(); assert.ok(SessionManager.continueRecent(f.cwd, f.sessions).getSessionFile());
		assert.equal(calls.size, 5); assert.ok([...calls.values()].every(value => value === 1));
		t.diagnostic(`headers=${size}; recentNative=3; listNative=5; continueNative=5`);
	});
}

test("exact cwd discovery does no canonical I/O", t => {
	const f = fixture(t); for (let i = 0; i < 10; i++) writeSession(f.sessions, `exact-${i}`, f.cwd);
	let calls = 0; const native = fs.realpathSync.native;
	t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { calls++; return native(...args); });
	assert.ok(findMostRecentSession(f.sessions, f.cwd)); assert.equal(calls, 0);
});

test("scan-owned cwd maps collect while returned sessions and manager remain live", { skip: !globalThis.gc }, async t => {
	const f = fixture(t), alias = join(f.root, "Alias"); link(f.cwd, alias); writeSession(f.sessions, "fixture", alias);
	const OriginalMap = Map, refs: WeakRef<Map<unknown, unknown>>[] = [];
	class ObservedMap extends OriginalMap<unknown, unknown> { constructor(entries?: Iterable<readonly [unknown, unknown]> | null) { super(entries); refs.push(new WeakRef(this)); } }
	let sessions, manager, failedScanRefs: typeof refs;
	try {
		globalThis.Map = ObservedMap as MapConstructor;
		sessions = await SessionManager.list(f.cwd, f.sessions);
		manager = SessionManager.continueRecent(f.cwd, f.sessions);
		findMostRecentSession(f.sessions, f.cwd);
		const beforeFailedScan = refs.length;
		assert.equal(findMostRecentSession(join(f.root, "MissingSessions"), f.cwd), null);
		failedScanRefs = refs.slice(beforeFailedScan);
	} finally { globalThis.Map = OriginalMap; }
	const matcherRefs = refs.filter(ref => ref.deref()?.get(alias) === true);
	assert.equal(matcherRefs.length, 3);
	assert.equal(failedScanRefs.length, 1);
	for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); }
	assert.equal(matcherRefs.filter(ref => ref.deref() !== undefined).length, 0);
	assert.equal(failedScanRefs.filter(ref => ref.deref() !== undefined).length, 0);
	assert.equal(sessions.length, 1); assert.equal(manager.getSessionId(), "fixture");
	t.diagnostic(`releasedCwdMaps=${matcherRefs.length}; failedScanMapsReleased=${failedScanRefs.length}; resultAndManagerAlive=true`);
});
