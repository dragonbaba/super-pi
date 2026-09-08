import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { OperationJournal } from "../packages/coding-agent/src/core/operation-journal.ts";
import test from "node:test";
import { fixture, operationFixtureSupported } from './helpers/operation-write-fixture.ts';

test("SDK host first execution and durable historical recovery never request a provider", async () => {
	const f = await fixture(true);
	const intent = { intentId: randomUUID(), originBranch: null, path: "target", content: "héllo" };
	try {
		if (!operationFixtureSupported) {
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

test("post-hook arguments bind the effect; result and persistence failures cannot revoke completed facts", { skip: !operationFixtureSupported }, async () => {
	const f = await fixture(true);
	const intent = { intentId: randomUUID(), originBranch: null, path: "target", content: "before hook" };
	try {
		f.session.agent.beforeToolCall = async ({ args }) => { (args as { content: string }).content = "post hook"; return undefined; };
		f.session.agent.afterToolCall = async () => { throw new Error("result hook failed"); };
		await assert.rejects(f.session.newOperation(intent), /durable receipt/);
		assert.equal(readFileSync(join(f.cwd, "target"), "utf8"), "post hook");
		writeFileSync(join(f.cwd, "target"), "later edit");
		f.session.agent.afterToolCall = undefined;
		const recovered = await f.session.newOperation(intent); // same explicit intent, new delivery ID
		assert.equal(recovered.historical, true);
		const append = f.session.sessionManager.appendMessage.bind(f.session.sessionManager);
		f.session.sessionManager.appendMessage = message => { if (message.role === "toolResult") throw new Error("append failed"); return append(message); };
		await assert.rejects(f.session.resumeOperation(recovered.operationId, intent), /append failed/);
		f.session.sessionManager.appendMessage = append;
		assert.equal((await f.session.resumeOperation(recovered.operationId, intent)).historical, true);
		assert.equal(readFileSync(join(f.cwd, "target"), "utf8"), "later edit");
		assert.equal(f.providers(), 0);
	} finally { f.session.dispose(); }
});

test("a copied session header cannot transfer the live journal to another storage anchor", { skip: !operationFixtureSupported }, async () => {
	const f = await fixture(true);
	try {
		const intent = { intentId: randomUUID(), originBranch: null, path: "target", content: "original" };
		const completed = await f.session.newOperation(intent);
		const copied = join(f.cwd, "copied-session.jsonl");
		writeFileSync(copied, readFileSync(f.file));
		f.session.sessionManager.setSessionFile(copied);
		await assert.rejects(f.session.resumeOperation(completed.operationId, intent), /storage anchor changed/);
		assert.equal(f.providers(), 0);
	} finally { f.session.dispose(); }
});

test("post-effect abort preserves a receipt; failed lock release still retires live session ownership", { skip: !operationFixtureSupported }, async () => {
	const f = await fixture(true);
	const intent = { intentId: randomUUID(), originBranch: null, path: "target", content: "acknowledged" };
	const originalWrite = fsPromises.writeFile;
	try {
		fsPromises.writeFile = async (path, data, options) => {
			await originalWrite(path, data, options);
			if (String(path) === join(f.cwd, "target")) f.session.agent.abort();
		};
		syncBuiltinESMExports();
		await assert.rejects(f.session.newOperation(intent), /aborted after durable completion/);
	} finally { fsPromises.writeFile = originalWrite; syncBuiltinESMExports(); }
	try {
		const recovered = await f.session.newOperation(intent);
		assert.equal(recovered.historical, true); assert.equal(f.providers(), 0);
		const internals = f.session as unknown as { _operationJournal?: OperationJournal; _hostOperation?: unknown };
		const owner = internals._operationJournal!;
		const originalUnlink = fs.unlinkSync;
		try {
			fs.unlinkSync = path => { if (String(path) === `${f.file}.operations-v1/lock`) throw new Error("injected lock-release failure"); originalUnlink(path); };
			syncBuiltinESMExports();
			assert.doesNotThrow(() => f.session.dispose());
		} finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
		assert.equal(owner.counters.effects, 1); assert.equal(owner.counters.ownershipFailures, 1);
		assert.equal(internals._operationJournal, undefined); assert.equal(internals._hostOperation, undefined);
		assert.equal(existsSync(`${f.file}.operations-v1/lock`), true);
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
		f.session.agent.beforeToolCall = async ({ args }) => { (args as { path: string }).path = "./".repeat(600) + "target"; return undefined; };
		await assert.rejects(f.session.newOperation(intent), /Post-hook operation path capacity/);
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
