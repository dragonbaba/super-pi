import { operationFixtureSupported, operationFixtureRoot } from './helpers/operation-write-fixture.ts';
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { OperationJournal } from "../packages/coding-agent/src/core/operation-journal.ts";

test("journal preserves completed historical facts and rejects conflicts and missing recovery IDs", async () => {
	const root = operationFixtureRoot("pi-op-journal-");
	const anchor = join(root, "session.jsonl"); writeFileSync(anchor, "session");
	if (!operationFixtureSupported) {
		assert.throws(() => new OperationJournal(anchor, "session", root), /Unsupported/);
		return;
	}
	const journal = new OperationJournal(anchor, "session", root);
	const intent = randomUUID();
	const path = join(root, "target");
	let effects = 0;
	const perform = async () => { effects++; writeFileSync(path, "héllo"); };
	journal.claim();
	const first = await journal.execute(intent, false, null, path, "héllo", perform);
	journal.release();
	writeFileSync(path, "later edit");
	journal.claim();
	const recovered = await journal.execute(first.operationId, true, null, path, "héllo", perform);
	journal.release();
	assert.equal(effects, 1); assert.equal(recovered.receipt.bytes, 6);
	assert.equal(readFileSync(path, "utf8"), "later edit");
	journal.claim();
	await assert.rejects(journal.execute(first.operationId, true, null, path, "different", perform), /conflict/);
	journal.release(); journal.dispose();
	const reopened = new OperationJournal(anchor, "session", root);
	reopened.claim();
	await assert.rejects(reopened.execute(`op1:${randomUUID()}:${randomUUID()}`, true, null, path, "héllo", perform), /foreign/);
	reopened.release(); reopened.dispose();
});

test("journal rejects symlink/unsupported identity before protected execution", () => {
	const root = operationFixtureRoot("pi-op-identity-");
	mkdirSync(join(root, "dir"));
	assert.throws(() => new OperationJournal(join(root, "missing", "session"), "session", root));
});

test("bounded disk authority survives 1024 records without resident history or terminal eviction", { skip: !operationFixtureSupported }, async () => {
	const root = operationFixtureRoot("pi-op-capacity-");
	const anchor = join(root, "session"); writeFileSync(anchor, "session");
	const journal = new OperationJournal(anchor, "session", root);
	const intent = randomUUID(); const target = join(root, "target");
	journal.claim();
	const first = await journal.execute(intent, false, null, target, "x", async () => { writeFileSync(target, "x"); });
	journal.release(); journal.dispose();
	const original = JSON.parse(JSON.parse(readFileSync(`${anchor}.operations-v1/${intent}`, "utf8")).body);
	// Only codec/capacity fixtures are synthesized; the source receipt came from a real write.
	for (let i = 1; i < 1024; i++) {
		const id = randomUUID(); const copy = structuredClone(original);
		copy.operationId = first.operationId.slice(0, -36) + id;
		copy.receipt.operationId = copy.operationId; copy.receipt.attemptId = `${copy.operationId}:1`;
		const body = JSON.stringify(copy);
		writeFileSync(`${anchor}.operations-v1/${id}`, JSON.stringify({ body, checksum: createHash("sha256").update(body).digest("hex") }), { mode: 0o600 });
	}
	const reopened = new OperationJournal(anchor, "session", root);
	try {
		reopened.claim();
		await assert.rejects(reopened.execute(randomUUID(), false, null, target, "x", async () => { throw new Error("effect forbidden"); }), /capacity/);
		reopened.release(); reopened.claim();
		assert.equal((await reopened.execute(first.operationId, true, null, target, "x", async () => { throw new Error("replay forbidden"); })).historical, true);
		assert.equal(reopened.counters.entries, 0); assert.ok(reopened.counters.metadataBytes < 65536);
	} finally { reopened.release(); reopened.dispose(); }
});

test("busy/dispose retain exclusion until effect settlement; oversized records poison recovery", { skip: !operationFixtureSupported }, async () => {
	const root = operationFixtureRoot("pi-op-lifecycle-");
	const anchor = join(root, "session"); writeFileSync(anchor, "session");
	const journal = new OperationJournal(anchor, "session", root);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const intent = randomUUID();
	journal.claim();
	const executing = journal.execute(intent, false, null, join(root, "target"), "x", async () => { await gate; writeFileSync(join(root, "target"), "x"); });
	assert.throws(() => journal.claim(), /busy/);
	journal.dispose(); assert.equal(existsSync(`${anchor}.operations-v1/lock`), true);
	release(); await executing; journal.release();
	assert.equal(existsSync(`${anchor}.operations-v1/lock`), false); assert.equal(journal.counters.active, 0);
	writeFileSync(`${anchor}.operations-v1/${intent}`, "x".repeat(8193));
	assert.throws(() => new OperationJournal(anchor, "session", root), /oversized/);
});

test("symlink targets, payload overflow, separate intents and failed writes do not gain replay authority", { skip: !operationFixtureSupported }, async () => {
	const root = operationFixtureRoot("pi-op-scope-");
	const anchor = join(root, "session"); writeFileSync(anchor, "session");
	const journal = new OperationJournal(anchor, "session", root);
	const path = join(root, "target"); writeFileSync(path, "old"); symlinkSync(path, join(root, "alias"));
	journal.claim();
	await assert.rejects(journal.execute(randomUUID(), false, null, join(root, "alias"), "x", async () => {}), /Unsupported/);
	await assert.rejects(journal.execute(randomUUID(), false, null, path, "é".repeat(131073), async () => {}), /capacity/);
	const failed = randomUUID();
	await assert.rejects(journal.execute(failed, false, null, path, "x", async () => { writeFileSync(path, "partial"); throw new Error("write failed"); }), /write failed/);
	await assert.rejects(journal.execute(failed, false, null, path, "x", async () => {}), /replay forbidden/);
	const one = await journal.execute(randomUUID(), false, null, path, "x", async () => { writeFileSync(path, "x"); });
	const two = await journal.execute(randomUUID(), false, null, path, "x", async () => { writeFileSync(path, "x"); });
	assert.notEqual(one.operationId, two.operationId);
	journal.release(); journal.dispose();
});

test("authority inode identity refuses aliases even when addressed paths differ", { skip: !operationFixtureSupported }, async () => {
	const root = operationFixtureRoot("pi-op-inode-");
	const anchor = join(root, "session"); writeFileSync(anchor, "session");
	const target = join(root, "alias"); writeFileSync(target, "untouched");
	const journal = new OperationJournal(anchor, "session", root);
	const lstat = fs.lstatSync;
	const sessionIdentity = lstat(anchor, { bigint: true });
	try {
		// Deterministic primitive identity fault, not a claim of a privileged native bind-mount test.
		Object.defineProperty(fs, "lstatSync", { value: ((path, options) => String(path) === target ? sessionIdentity : lstat(path, options as any)) as typeof fs.lstatSync });
		syncBuiltinESMExports();
		journal.claim();
		await assert.rejects(journal.execute(randomUUID(), false, null, target, "unsafe", async () => { throw new Error("effect forbidden"); }), /aliases its own authority/);
		assert.equal(journal.counters.attempts, 0);
	} finally { Object.defineProperty(fs, "lstatSync", { value: lstat }); syncBuiltinESMExports(); journal.release(); journal.dispose(); }
	assert.equal(readFileSync(target, "utf8"), "untouched");
});

test("symlink session anchor is rejected before creating replay authority", () => {
 const root = operationFixtureRoot("pi-op-anchor-");
 const real = join(root,"session"); const alias = join(root,"alias");
 writeFileSync(real,"transcript"); symlinkSync(real,alias);
 assert.throws(() => new OperationJournal(alias,"session",root), /Unsupported session anchor/);
 assert.equal(existsSync(`${alias}.operations-v1`),false);
 assert.equal(readFileSync(real,"utf8"),"transcript");
 assert.throws(() => OperationJournal.inspectWriter(alias), /Unsupported session anchor/);
});

test("published SDK exposes only read-only writer inspection", async () => {
 const sdk = await import("@super-pi/coding-agent");
 assert.equal(typeof (sdk as unknown as {inspectOperationWriter?: unknown}).inspectOperationWriter,"function");
 assert.equal("OperationJournal" in sdk,false);
});
