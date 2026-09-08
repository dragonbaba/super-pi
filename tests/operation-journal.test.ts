import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { OperationJournal } from "../packages/coding-agent/src/core/operation-journal.ts";

test("journal preserves completed historical facts and rejects conflicts and missing recovery IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-op-journal-"));
	const anchor = join(root, "session.jsonl"); writeFileSync(anchor, "session");
	if (process.platform !== "linux") {
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
	const root = mkdtempSync(join(tmpdir(), "pi-op-identity-"));
	mkdirSync(join(root, "dir"));
	assert.throws(() => new OperationJournal(join(root, "missing", "session"), "session", root));
});
