import assert from "node:assert/strict";
import { appendFileSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";

function reused(message: { content: unknown }): boolean { return /no new disk read/i.test(JSON.stringify(message.content)); }

test("Windows stat-only identity stays ineligible without hashing or capture", { skip: process.platform !== "win32" }, async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < 10; i++) assert.equal(reused(await f.read()), false);
		const c = f.internals._evidenceLedger!.counters;
		assert.equal(c.entries, 0);
		assert.equal(c.argumentBytesHashed, 0);
		assert.equal(c.g2ArtifactIntegrityScans, 0);
		assert.equal(c.missesByReason["uncertain-identity"], 10);
	} finally { f.close(); }
});

test("ten completed reads execute one file snapshot and no disk opens on later hits", { skip: process.platform === "win32" ? "Windows stat cannot prove unchanged identity" : false }, async t => {
	const f = await fixture();
	const original = fsPromises.open;
	let opens = 0;
	let snapshots = 0;
	const mocked = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof original>) => {
		opens++;
		const handle = await original(...args);
		const originalStat = handle.stat.bind(handle);
		let observed = false;
		t.mock.method(handle, "stat", (...statArgs: Parameters<typeof handle.stat>) => {
			if (!observed) { observed = true; snapshots++; }
			return originalStat(...statArgs);
		});
		return handle;
	});
	syncBuiltinESMExports();
	try {
		for (let i = 0; i < 10; i++) await f.read();
		assert.equal(snapshots, 1);
		assert.equal(opens, 2); // Existing first-read MIME sniff plus validated text snapshot.
		assert.equal(f.internals._evidenceLedger!.counters.realReadExecutionsPrevented, 9);
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

for (const change of ["append", "truncate", "same-size", "atomic", "delete-recreate", "touch", "symlink"] as const) {
	test(`${change} rejects old file evidence before artifact hashing`, async () => {
		const f = await fixture();
		const target = join(f.cwd, "file.txt");
		try {
			if (change === "symlink") { renameSync(target, target + ".old"); symlinkSync(target + ".old", target, "file"); }
			await f.read();
			const scans = f.counters.artifactIntegrityScans;
			if (change === "append") appendFileSync(target, "changed\n");
			if (change === "truncate") writeFileSync(target, "short\n");
			if (change === "same-size") writeFileSync(target, "x".repeat(statSync(target).size));
			if (change === "atomic" || change === "symlink") {
				writeFileSync(target + ".new", "replacement text\n".repeat(1000));
				if (change === "symlink") { unlinkSync(target); symlinkSync(target + ".new", target, "file"); }
				else renameSync(target + ".new", target);
			}
			if (change === "delete-recreate") { unlinkSync(target); writeFileSync(target, "new file\n".repeat(1000)); }
			if (change === "touch") { const stat = statSync(target); utimesSync(target, stat.atime, new Date(stat.mtimeMs + 5000)); }
			assert.equal(reused(await f.read()), false);
			assert.equal(f.counters.artifactIntegrityScans, scans);
		} finally { f.close(); }
	});
}

test("offset default equivalence and distinct windows", async () => {
	const f = await fixture();
	try {
		await f.read();
		assert.equal(reused(await f.read({ path: "./file.txt", offset: 1 })), process.platform !== "win32");
		assert.equal(reused(await f.read({ path: "file.txt", offset: 2 })), false);
		assert.equal(reused(await f.read({ path: "file.txt", offset: 2, limit: 100 })), false);
		assert.equal(reused(await f.read({ path: "file.txt", offset: 2, limit: 100 })), process.platform !== "win32");
	} finally { f.close(); }
});

test("four simultaneous first reads all execute; only later completed calls reuse", async () => {
	const f = await fixture();
	try {
		const results = await Promise.all([f.read(), f.read(), f.read(), f.read()]);
		assert.equal(results.some(reused), false);
		assert.equal(f.internals._evidenceLedger!.counters.realReadExecutions, 4);
		assert.equal(reused(await f.read()), process.platform !== "win32");
		assert.equal(f.internals._evidenceCompletedReads!.size, 0);
		assert.equal(f.internals._evidenceCompletedBytes, 0);
	} finally { f.close(); }
});

for (const hook of ["tool_result", "message_end", "context", "before_provider_request"] as const) {
	test(`${hook} handler bypasses lookup/admission and retains mutability`, async () => {
		const f = await fixture(true, true, [pi => {
			if (hook === "tool_result") pi.on("tool_result", () => undefined);
			if (hook === "message_end") pi.on("message_end", () => undefined);
			if (hook === "context") pi.on("context", () => undefined);
			if (hook === "before_provider_request") pi.on("before_provider_request", () => undefined);
		}]);
		try {
			const first = await f.read();
			assert.equal(Object.isFrozen(first.content), false);
			assert.equal(reused(await f.read()), false);
			assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
			assert.equal(f.internals._evidenceLedger!.counters.argumentBytesHashed, 0);
			assert.equal(f.internals._evidenceLedger!.counters.g2ArtifactIntegrityScans, 0);
		} finally { f.close(); }
	});
}

test("permission and final tool_call arguments run on every hit; lifecycle persists", async () => {
	let checks = 0;
	let deny = false;
	const f = await fixture(true, true, [pi => {
		pi.on("tool_call", event => { checks++; (event.input as Record<string, unknown>).path = "file.txt"; return deny ? { block: true, reason: "fixture-denied" } : undefined; });
	}]);
	try {
		const events: string[] = [];
		f.session.subscribe(event => { if (event.type.startsWith("tool_execution_") || ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult")) events.push(event.type); });
		await f.runCalls([{ name: "read", arguments: { path: "pre-hook-missing" } }]);
		events.length = 0;
		await f.runCalls([{ name: "read", arguments: { path: "another-pre-hook-path" } }]);
		assert.equal(f.internals._evidenceLedger!.counters.hits, process.platform === "win32" ? 0 : 1);
		assert.deepEqual(events, ["tool_execution_start", "tool_execution_end", "message_start", "message_end"]);
		deny = true;
		await f.runCalls([{ name: "read", arguments: { path: "denied" } }]);
		assert.equal(checks, 3);
		assert.equal(f.internals._evidenceLedger!.counters.hits, process.platform === "win32" ? 0 : 1);
		const results = f.session.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult");
		assert.equal(results.length, 3);
	} finally { f.close(); }
});

test("owner clear and registry rebuilding invalidate without historical reconstruction", async () => {
	const f = await fixture();
	try {
		await f.read();
		f.internals._toolResultPresentation!.clearProjectionRecords();
		const scans = f.counters.artifactIntegrityScans;
		assert.equal(reused(await f.read()), false);
		assert.equal(f.counters.artifactIntegrityScans, scans);
		f.internals._refreshToolRegistry();
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
		assert.equal(reused(await f.read()), false);
		f.session.dispose();
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
		assert.equal(f.internals._evidenceLedger!.counters.metadataBytes, 0);
	} finally { f.close(); }
});
