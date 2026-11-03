import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { OfflineCandidateOwner, CANDIDATE_LIMITS, CANDIDATE_PROTOCOL } from "../scripts/acceptance/windows-sandbox-candidates.mjs";

function fixture(t, entries = [
	{ path: "new.txt", operation: "add", revision: null },
	{ path: "src/edit.txt", operation: "modify", revision: "host-r1" },
]) {
	const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, "super-pi-wsb-candidates-"));
	const rootIdentity = fs.lstatSync(root, { bigint: true });
	t.after(() => {
		const actual = fs.lstatSync(root, { bigint: true });
		assert.equal(actual.isSymbolicLink(), false); assert.equal(actual.dev, rootIdentity.dev); assert.equal(actual.ino, rootIdentity.ino);
		assert.equal(path.dirname(fs.realpathSync(root)), parent); assert.equal(path.resolve(root), root);
		// Only this newly created, identity-checked fixture root is removed.
		fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false);
	});
	const taskId = randomUUID(), snapshotId = randomUUID(), instanceId = randomUUID();
	fs.mkdirSync(path.join(root, "payload"));
	for (const item of entries) {
		const file = path.join(root, "payload", item.path);
		fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "candidate:" + item.path, { flag: "wx" });
	}
	function context() {
		return { taskId, snapshotId, instanceId, root, rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
			allowed: structuredClone(entries), budget: { ...CANDIDATE_LIMITS },
			lifecycle: { state: "closed", instanceAbsent: true, callsClosed: true, cancelled: false, timedOut: false, platformFailed: false },
			observations: { cliClose: { exitCode: 0, signal: null }, platformReceipt: null } };
	}
	function metadata() {
		return { protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
			candidates: entries.map(item => ({ path: item.path, operation: item.operation })), report: { exitCode: 23 } };
	}
	function write(value = metadata()) { fs.writeFileSync(path.join(root, "candidates.json"), JSON.stringify(value)); }
	write();
	return { root, context, metadata, write, file: name => path.join(root, "payload", name) };
}
function rejected(context, reason) {
	const before = structuredClone(context), owner = new OfflineCandidateOwner(context);
	try {
		const outcome = owner.check(); assert.equal(outcome.status, "rejected");
		if (reason) assert.equal(outcome.reason, reason);
		assert.equal(outcome.cleanup, "complete"); assert.deepEqual(context, before);
		const metrics = owner.diagnostics;
		assert.equal(metrics.activeHandles, 0); assert.equal(metrics.opened, metrics.closed);
		assert.equal(metrics.retainedBytes, 0); assert.equal(metrics.retainedCandidates, 0);
		return metrics;
	} finally { owner.dispose(); }
}

test("offline candidates keep host authority, distinct result sources, and owned checked bytes", t => {
	const f = fixture(t), input = f.context(), original = structuredClone(input);
	input.observations.platformReceipt = { exitCode: 0 };
	const owner = new OfflineCandidateOwner(input);
	try {
		// Input mutation after construction cannot replace the captured baseline or budget.
		input.allowed[1].revision = "guest-r2"; input.allowed.length = 0; input.budget.totalBytes = 1;
		input.lifecycle.cancelled = true; input.observations.cliClose.exitCode = 99;
		const checked = owner.check(); assert.equal(checked.status, "candidate-checked");
		assert.deepEqual(checked.binding, { taskId: original.taskId, snapshotId: original.snapshotId, instanceId: original.instanceId });
		assert.equal(checked.records[0].sourceRevision, null); assert.equal(checked.records[1].sourceRevision, "host-r1");
		assert.deepEqual(checked.observations, { cliClose: { source: "host-cli-process", exitCode: 0, signal: null },
			platformReceipt: { source: "platform-interface", exitCode: 0 }, guestReport: { source: "guest-report", exitCode: 23 } });
		assert.equal("committed" in checked, false); assert.equal("authorized" in checked, false); assert.equal("success" in checked, false);
		const bytes = checked.copyBytes(0), expected = Buffer.from(bytes);
		assert.equal(checked.records[0].sha256, createHash("sha256").update(bytes).digest("hex"));
		bytes.fill(0); fs.writeFileSync(f.file("new.txt"), "changed after checking");
		assert.deepEqual(checked.copyBytes(0), expected); // No path reread and no mutable alias to internal bytes.
		assert.throws(() => checked.records.push({})); assert.throws(() => checked.records[1].sourceRevision = "changed");
		assert.equal(owner.check().reason, "owner-already-checked");
		const metrics = owner.diagnostics;
		assert.equal(metrics.opened, 3); assert.equal(metrics.closed, 3); assert.equal(metrics.peakHandles, 1);
		assert.equal(metrics.readBuffers, 3); assert.equal(metrics.activeHandles, 0); assert.equal(metrics.retainedCandidates, 2);
		assert.equal(metrics.retainedBytes, checked.records.reduce((sum, record) => sum + record.bytes, 0));
		t.diagnostic(JSON.stringify({ normal: metrics }));
		checked.dispose(); checked.dispose(); assert.equal(checked.status, "disposed");
		assert.throws(() => checked.copyBytes(0)); assert.throws(() => checked.records);
		assert.equal(owner.diagnostics.retainedBytes, 0); assert.equal(owner.diagnostics.retainedCandidates, 0);
		assert.deepEqual(expected, Buffer.from("candidate:new.txt")); // External copies remain caller-owned.
	} finally { owner.dispose(); }
});

test("guest authority, source labels, revisions and foreign associations are rejected", t => {
	const f = fixture(t);
	for (const key of ["authorized", "committed", "allProcessesExited", "done", "revision", "source", "budget", "root", "owner"]) {
		const value = f.metadata(); value[key] = true; f.write(value); rejected(f.context(), "schema");
	}
	for (const mutate of [v => v.candidates[0].revision = "evil", v => v.report.source = "host-cli-process",
		v => v.report.authorized = true, v => v.report.exitCode = "0", v => v.taskId = randomUUID(), v => v.snapshotId = randomUUID()]) {
		const value = f.metadata(); mutate(value); f.write(value); rejected(f.context());
	}
	f.write(); const wrongRoot = f.context(); wrongRoot.rootIdentity.ino += 1n;
	assert.equal(rejected(wrongRoot, "root-identity").opened, 0);
});

test("host lifecycle and revocation cannot be bypassed by any guest report", t => {
	const f = fixture(t);
	for (const mutate of [c => c.lifecycle.state = "active", c => c.lifecycle.state = "unknown", c => c.lifecycle.callsClosed = false,
		c => c.lifecycle.instanceAbsent = false, c => c.lifecycle.cancelled = true, c => c.lifecycle.timedOut = true,
		c => c.lifecycle.platformFailed = true, c => c.observations.cliClose.exitCode = null,
		c => c.observations.cliClose.exitCode = 1, c => c.observations.cliClose.signal = "SIGTERM",
		c => c.observations.platformReceipt = { exitCode: 1 }]) {
		const input = f.context(); mutate(input); assert.equal(rejected(input, "owner-not-settled").opened, 0);
	}
	const missing = f.context(); delete missing.lifecycle.callsClosed; assert.throws(() => new OfflineCandidateOwner(missing));
	const owner = new OfflineCandidateOwner(f.context()); owner.revoke();
	assert.equal(owner.check().reason, "owner-revoked"); assert.equal(owner.diagnostics.opened, 0); owner.dispose();
	const after = new OfflineCandidateOwner(f.context()), checked = after.check();
	after.revoke(); assert.equal(checked.status, "disposed"); assert.throws(() => checked.copyBytes(0));
	assert.equal(after.diagnostics.retainedBytes, 0); after.dispose();
});

test("operation and target binding rejects baseline substitution, duplicates and unsupported operations", t => {
	const f = fixture(t);
	for (const mutate of [v => v.candidates[0].operation = "modify", v => v.candidates[1].operation = "add",
		v => v.candidates[0].operation = "delete", v => v.candidates[0].operation = "move",
		v => v.candidates[0].path = "unapproved.txt", v => v.candidates.push({ ...v.candidates[0] }),
		v => v.candidates.push({ ...v.candidates[0], path: "NEW.TXT" })]) {
		const value = f.metadata(); mutate(value); f.write(value); rejected(f.context());
	}
	for (const mutate of [c => c.allowed[0].revision = "exists", c => c.allowed[1].revision = null,
		c => c.allowed.push({ ...c.allowed[0], path: "NEW.TXT" }), c => c.allowed.push({ ...c.allowed[0], path: "new.txt/child" })]) {
		const input = f.context(); mutate(input); assert.throws(() => new OfflineCandidateOwner(input));
	}
});

test("minimal Windows path subset rejects aliases, protected paths and escape syntax", t => {
	const f = fixture(t);
	for (const name of ["../new.txt", "./new.txt", "/new.txt", "C:/new.txt", "C:new.txt", "\\\\host\\share", "src\\edit.txt",
		"src//edit.txt", "new.txt:stream", ".git/config", "src/.SP/state", "new.txt.", "new.txt ", "NEW~1.TXT",
		"CON", "con.txt", "LPT9.log", "NUL", "aux.json", "文件.txt", "a/b/c/d/e", "a".repeat(65), ""]) {
		const value = f.metadata(); value.candidates[0].path = name; f.write(value); rejected(f.context(), "path");
	}
	const value = f.metadata(); value.candidates[0].path = "NEW.TXT"; f.write(value); rejected(f.context(), "target-or-operation");
});

test("actual hardlinks, junction parents and missing files are rejected with no retained candidates", t => {
	const f = fixture(t), file = f.file("new.txt"), alias = path.join(f.root, "hardlink");
	fs.linkSync(file, alias); rejected(f.context(), "file-kind"); fs.unlinkSync(alias);
	const source = path.join(f.root, "original-src");
	fs.renameSync(f.file("src"), source); fs.symlinkSync(source, f.file("src"), "junction");
	rejected(f.context(), "directory"); fs.unlinkSync(f.file("src")); fs.renameSync(source, f.file("src"));
	fs.unlinkSync(f.file("src/edit.txt")); const metrics = rejected(f.context(), "io-failure");
	assert.equal(metrics.opened, 2); assert.equal(metrics.closed, 2); // Manifest and first candidate released.
});

test("budgets apply before allocation, with exact per-file and aggregate boundaries", t => {
	const f = fixture(t);
	fs.writeFileSync(f.file("new.txt"), Buffer.alloc(4096));
	let owner = new OfflineCandidateOwner(f.context()); let checked = owner.check(); assert.equal(checked.status, "candidate-checked");
	assert.equal(checked.records[0].bytes, 4096); owner.dispose();
	fs.appendFileSync(f.file("new.txt"), "x"); assert.equal(rejected(f.context(), "byte-budget").readBuffers, 1);
	fs.writeFileSync(f.file("new.txt"), Buffer.alloc(8)); fs.writeFileSync(f.file("src/edit.txt"), Buffer.alloc(8));
	let input = f.context(); input.budget.totalBytes = 16; owner = new OfflineCandidateOwner(input); checked = owner.check();
	assert.equal(checked.status, "candidate-checked"); assert.equal(owner.diagnostics.retainedBytes, 16); owner.dispose();
	input = f.context(); input.budget.totalBytes = 15;
	const limited = rejected(input, "byte-budget"); assert.equal(limited.readBuffers, 2); // No allocation for second candidate.
	const raw = JSON.stringify(f.metadata()); fs.writeFileSync(path.join(f.root, "candidates.json"), raw);
	input = f.context(); input.budget.manifestBytes = Buffer.byteLength(raw); owner = new OfflineCandidateOwner(input);
	assert.equal(owner.check().status, "candidate-checked"); owner.dispose();
	input = f.context(); input.budget.manifestBytes = Buffer.byteLength(raw) - 1; assert.equal(rejected(input, "byte-budget").opened, 0);
	for (const value of [0, -1, Infinity, 16385]) { input = f.context(); input.budget.totalBytes = value; assert.throws(() => new OfflineCandidateOwner(input)); }
});

test("entry count and manifest parse work remain bounded; duplicate JSON keys are rejected", t => {
	const entries = Array.from({ length: 16 }, (_, i) => ({ path: `f${i}.txt`, operation: "add", revision: null }));
	const f = fixture(t, entries), owner = new OfflineCandidateOwner(f.context());
	assert.equal(owner.check().records.length, 16); assert.equal(owner.diagnostics.opened, 17); assert.equal(owner.diagnostics.peakHandles, 1); owner.dispose();
	const value = f.metadata(); value.candidates.push({ path: "extra.txt", operation: "add" }); f.write(value); rejected(f.context(), "entry-budget");
	const raw = JSON.stringify(f.metadata());
	for (const malformed of [raw.replace('"report":', '"taskId":"forged","report":'), "{", "null", "[]", " ".repeat(4097)]) {
		fs.writeFileSync(path.join(f.root, "candidates.json"), malformed); rejected(f.context());
	}
	fs.writeFileSync(path.join(f.root, "candidates.json"), Buffer.from([0xff])); rejected(f.context(), "manifest-invalid");
});

test("observed content or identity changes during reads release opened handles and prior bytes", t => {
	const f = fixture(t), originalRead = fs.readSync;
	for (const mode of ["grow", "replace"]) {
		fs.writeFileSync(f.file("new.txt"), "before"); let calls = 0;
		fs.readSync = function (...args) {
			const count = originalRead(...args);
			if (++calls === 2) {
				if (mode === "grow") fs.appendFileSync(f.file("new.txt"), "x");
				else { fs.renameSync(f.file("new.txt"), f.file("replaced.txt")); fs.writeFileSync(f.file("new.txt"), "before"); }
			}
			return count;
		};
		try { rejected(f.context(), "file-changed"); } finally { fs.readSync = originalRead; }
	}
});

test("revocation during a read prevents acceptance and releases partial data", t => {
	const f = fixture(t), owner = new OfflineCandidateOwner(f.context()), originalRead = fs.readSync; let calls = 0;
	fs.readSync = function (...args) { const count = originalRead(...args); if (++calls === 3) owner.revoke(); return count; };
	try {
		assert.equal(owner.check().reason, "owner-revoked");
		assert.equal(owner.diagnostics.activeHandles, 0); assert.equal(owner.diagnostics.retainedBytes, 0);
		assert.equal(owner.diagnostics.opened, owner.diagnostics.closed);
	} finally { fs.readSync = originalRead; owner.dispose(); }
});

test("close failure is an unknown cleanup result, never candidate acceptance", t => {
	const f = fixture(t), owner = new OfflineCandidateOwner(f.context()), originalClose = fs.closeSync; let calls = 0, held;
	fs.closeSync = function (fd) { if (++calls === 2) { held = fd; throw new Error("synthetic pre-close failure"); } return originalClose(fd); };
	try {
		assert.deepEqual(owner.check(), { status: "rejected", reason: "close-unknown", cleanup: "unknown" });
		assert.equal(owner.diagnostics.retainedBytes, 0); assert.equal(owner.diagnostics.activeHandles, 1);
		assert.deepEqual(owner.diagnostics.uncertainHandles, [held]);
		t.diagnostic(JSON.stringify({ injectedCloseFailure: owner.diagnostics }));
	} finally {
		fs.closeSync = originalClose;
		// The test knows the injected failure preceded close; production cannot assume this.
		if (held !== undefined) originalClose(held);
		owner.dispose();
	}
});
