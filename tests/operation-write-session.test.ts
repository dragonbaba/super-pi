import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture } from './helpers/operation-write-fixture.ts';

test("SDK host first execution and durable historical recovery never request a provider", async () => {
	const f = await fixture(true);
	const intent = { intentId: randomUUID(), originBranch: null, path: "target", content: "héllo" };
	try {
		if (process.platform !== "linux") {
			await assert.rejects(f.session.newOperation(intent), /Unsupported/);
			assert.equal(existsSync(join(f.cwd, "target")), false);
			assert.equal(f.providers(), 0);
			return;
		}
		const first = await f.session.newOperation(intent);
		assert.equal(first.receipt.bytes, 6); assert.equal(first.historical, false);
		writeFileSync(join(f.cwd, "target"), "external later edit");
		const second = await f.session.resumeOperation(first.operationId, intent);
		assert.equal(second.historical, true);
		assert.equal(readFileSync(join(f.cwd, "target"), "utf8"), "external later edit");
		assert.equal(f.providers(), 0);
		f.session.dispose();
		const reopened = await fixture(true, f);
		try {
			const third = await reopened.session.resumeOperation(first.operationId, intent);
			assert.equal(third.historical, true); assert.equal(reopened.providers(), 0);
		} finally { reopened.session.dispose(); }
	} finally { f.session.dispose(); }
});

test("permission denial, hook errors and disabled SDK never create a journal or invoke a provider", async () => {
	const f = await fixture(true);
	try {
		const intent = { intentId: randomUUID(), originBranch: null, path: "target", content: "data" };
		f.session.agent.beforeToolCall = async () => ({ block: true, reason: "denied" });
		await assert.rejects(f.session.newOperation(intent), /not executed/);
		f.session.agent.beforeToolCall = async () => { throw new Error("policy failed"); };
		await assert.rejects(f.session.newOperation(intent), /not executed/);
		assert.equal(existsSync(`${f.file}.operations-v1`), false);
		assert.equal(f.providers(), 0);
	} finally { f.session.dispose(); }
	const off = await fixture(false);
	try {
		await assert.rejects(off.session.newOperation({ intentId: randomUUID(), originBranch: null, path: "target", content: "data" }), /disabled/);
		await off.session.agent.dispatchHostTool({ type: "toolCall", id: "ordinary", name: "write", arguments: { path: "target", content: "ordinary" } });
		assert.equal(readFileSync(join(off.cwd, "target"), "utf8"), "ordinary");
		assert.equal(existsSync(`${off.file}.operations-v1`), false); assert.equal(off.providers(), 0);
	} finally { off.session.dispose(); }
});
