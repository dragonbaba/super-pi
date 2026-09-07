import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { hasPreciseReadIdentity } from "../packages/coding-agent/src/core/tools/read-window.ts";
import { statSync } from "node:fs";

test("write/edit execute only after workspace generation has invalidated evidence", async () => {
	const f = await fixture();
	try {
		await f.read();
		const before = f.internals._evidenceLedger!.workspaceGeneration;
		await f.runCalls([{ name: "write", arguments: { path: "unrelated", content: "new" } }]);
		assert.equal(f.internals._evidenceLedger!.workspaceGeneration, before + 1);
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
		await f.read();
		await f.runCalls([{ name: "edit", arguments: { path: "unrelated", oldText: "new", newText: "changed" } }]);
		assert.equal(f.internals._evidenceLedger!.workspaceGeneration, before + 2);
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
	} finally { f.close(); }
});

test("failed custom tool observes invalidation before execution; custom read cannot opt in", async () => {
	let inside: (() => void) | undefined;
	const f = await fixture(true, true, [pi => {
		pi.registerTool({ name: "read", label: "custom", description: "fixture", parameters: Type.Object({ path: Type.String() }),
			execute: async () => { inside!(); throw new Error("custom failed"); } });
	}]);
	try {
		inside = () => {
			assert.equal(f.internals._evidenceLedger!.workspaceGeneration, 1);
			assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
		};
		await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
		assert.equal(f.internals._evidenceLedger!.counters.argumentBytesHashed, 0);
		assert.equal(f.internals._evidenceLedger!.counters.recordsCreated, 0);
	} finally { f.close(); }
});

test("failed user shell invalidates before its operations callback", async () => {
	const f = await fixture();
	try {
		await f.read();
		const before = f.internals._evidenceLedger!.workspaceGeneration;
		await assert.rejects(f.session.executeBash("fixture", undefined, { operations: {
			exec: async () => {
				assert.equal(f.internals._evidenceLedger!.workspaceGeneration, before + 1);
				assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
				throw new Error("side-effect-capable failure");
			},
		} }));
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
	} finally { f.close(); }
});

test("read source identity comes from validation, not a post-read standalone stat", async t => {
	const f = await fixture();
	const open = fsPromises.open;
	let closes = 0;
	const mocked = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		const close = handle.close.bind(handle);
		t.mock.method(handle, "close", async () => {
			await close();
			if (++closes === 2) appendFileSync(join(f.cwd, "file.txt"), "changed after validation\n");
		});
		return handle;
	});
	syncBuiltinESMExports();
	try {
		const first = await f.read();
		assert.equal(JSON.stringify(first.content).includes("changed after validation"), false);
		const scans = f.counters.artifactIntegrityScans;
		const second = await f.read();
		assert.equal(JSON.stringify(second.content).includes("changed after validation"), true);
		assert.equal(f.counters.artifactIntegrityScans, scans);
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

test("tree navigation clears evidence at successful branch replacement", async () => {
	const f = await fixture();
	try {
		await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
		const target = f.session.sessionManager.getBranch().find(e => e.type === "message" && e.message.role === "user")!;
		const generation = f.internals._evidenceLedger!.branchGeneration;
		assert.equal((await f.session.navigateTree(target.id)).cancelled, false);
		assert.ok(f.internals._evidenceLedger!.branchGeneration > generation);
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
		assert.equal(f.internals._evidenceCompletedBytes, 0);
	} finally { f.close(); }
});

test("successful manual compaction clears completed evidence", async () => {
	const f = await fixture(true, true, [pi => {
		pi.on("session_before_compact", event => ({ compaction: { summary: "fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
	}]);
	try {
		f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
		await f.runCalls([{ name: "read", arguments: { path: "file.txt", offset: 2 } }]);
		const before = f.internals._evidenceLedger!.branchGeneration;
		await f.session.compact();
		assert.ok(f.internals._evidenceLedger!.branchGeneration > before);
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
	} finally { f.close(); }
});

test("independent sessions/cwds, disposal and disabled construction own no shared evidence", async () => {
	const first = await fixture(); const second = await fixture(); const disabled = await fixture(false);
	try {
		await first.read(); await second.read(); await disabled.read();
		assert.notEqual(first.internals._evidenceLedger, second.internals._evidenceLedger);
		assert.equal(second.internals._evidenceLedger!.counters.hits, 0);
		assert.equal(disabled.internals._evidenceLedger, undefined);
		assert.equal(disabled.internals._evidenceCompletedReads, undefined);
		const messages = first.session.sessionManager.getBranch();
		const json = JSON.stringify(messages);
		assert.equal(/canonicalPath|fileGeneration|scopeFingerprint|read-evidence-identity/.test(json), false);
		first.session.dispose();
		assert.equal(first.internals._evidenceLedger!.counters.entries, 0);
		assert.equal(first.internals._evidenceCompletedReads, undefined);
	} finally { first.close(); second.close(); disabled.close(); }
});

test("missing file and abort cannot create evidence", async () => {
	const f = await fixture();
	try {
		await assert.rejects(f.read({ path: "missing" }));
		const read = f.session.agent.state.tools.find(t => t.name === "read")!;
		await assert.rejects(read.execute("abort", { path: "file.txt" }, AbortSignal.abort(), undefined));
		assert.equal(f.internals._evidenceLedger!.counters.recordsCreated, 0);
		assert.equal(f.internals._evidenceCompletedReads!.size, 0);
	} finally { f.close(); }
});

test("large bounded local-text windows carry only private metadata", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.cwd, "file.txt"), "large selected source text\n".repeat(20000));
		const first = await f.read();
		assert.ok(JSON.stringify(first.content).length < 65_536);
		for (let i = 0; i < 9; i++) {
			const message = await f.read();
			assert.equal(/no new disk read/i.test(JSON.stringify(message.content)), process.platform !== "win32");
		}
		assert.equal(f.internals._evidenceLedger!.counters.completeFileHashes, 0);
		assert.equal(f.internals._evidenceLedger!.counters.retainedSourceReferences, 0);
	} finally { f.close(); }
});

test("observer-only extension leaves the ledger eligible and model-visible tokens fall", { skip: process.platform === "win32" ? "Windows filesystem identity is unsupported for hits" : false }, async () => {
	const f = await fixture(true, true, [pi => { pi.observe("tool_execution_update", () => undefined); }]);
	try {
		const first = await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
		const second = await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
		const firstResult = first.at(-1)!.messages.filter(m => m.role === "toolResult").at(-1)!;
		const secondResult = second.at(-1)!.messages.filter(m => m.role === "toolResult").at(-1)!;
		const before = estimateToolOutputTokens(firstResult.content).estimatedTokens;
		const after = estimateToolOutputTokens(secondResult.content).estimatedTokens;
		assert.ok(after < before / 2, `${before} -> ${after}`);
		assert.equal(f.internals._evidenceLedger!.counters.hits, 1);
		assert.ok(f.internals._evidenceLedger!.counters.modelVisibleTokensAvoided <= before);
	} finally { f.close(); }
});

test("missing or coarse timestamp metadata is never trusted", async () => {
	const f = await fixture();
	try {
		const info = statSync(join(f.cwd, "file.txt"), { bigint: true });
		for (const value of [undefined, 0n, 1_000_000_000n]) {
			const missing = Object.create(info);
			Object.defineProperty(missing, "mtimeNs", { value });
			assert.equal(hasPreciseReadIdentity(missing), false);
		}
	} finally { f.close(); }
});

for (const replacement of ["new-session", "fork"] as const) {
	test(`direct SessionManager ${replacement} cannot use the previous session owner`, async () => {
		const f = await fixture();
		try {
			await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
			const previousId = f.session.sessionManager.getSessionId();
			if (replacement === "new-session") f.session.sessionManager.newSession();
			else f.session.sessionManager.createBranchedSession(f.session.sessionManager.getLeafId()!);
			assert.notEqual(f.session.sessionManager.getSessionId(), previousId);
			const hashes = f.counters.artifactIntegrityScans;
			assert.equal(/no new disk read/i.test(JSON.stringify((await f.read()).content)), false);
			assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
			assert.equal(f.counters.artifactIntegrityScans, hashes);
		} finally { f.close(); }
	});
}

test("restored historical messages do not hydrate a new ledger", async () => {
	const prior = await fixture(); const resumed = await fixture();
	try {
		await prior.read();
		resumed.session.agent.state.messages = JSON.parse(JSON.stringify(prior.session.agent.state.messages));
		assert.equal(resumed.internals._evidenceLedger!.counters.entries, 0);
		assert.equal(/no new disk read/i.test(JSON.stringify((await resumed.read()).content)), false);
	} finally { prior.close(); resumed.close(); }
});

test("built-in image reads cannot create text evidence", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.cwd, "image.gif"), Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
		await f.read({ path: "image.gif" });
		await f.read({ path: "image.gif" });
		assert.equal(f.internals._evidenceLedger!.counters.entries, 0);
		assert.equal(f.internals._evidenceLedger!.counters.g2ArtifactIntegrityScans, 0);
	} finally { f.close(); }
});
