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

test("large bounded local-text windows carry only private metadata", async t => {
	const f = await fixture();
	try {
		writeFileSync(join(f.cwd, "file.txt"), "large selected source text\n".repeat(20000));
		const first = await f.read();
		assert.ok(JSON.stringify(first.content).length < 65_536);
		for (let i = 0; i < 9; i++) {
			const message = await f.read();
			const hit = /no new disk read/i.test(JSON.stringify(message.content));
			if (hit !== (process.platform !== "win32")) {
				const ledger = f.internals._evidenceLedger!;
				t.diagnostic(JSON.stringify({ iteration: i, counters: ledger.counters,
					precise: hasPreciseReadIdentity(statSync(join(f.cwd, "file.txt"), { bigint: true })),
					originalTokens: f.internals._toolResultPresentation!.getResidentEvidenceModelTokens(first.toolCallId),
					records: [...(ledger as unknown as { records: Map<string, unknown> }).records.values()] }));
			}
			assert.equal(hit, process.platform !== "win32");
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

const lifecycleHitOptions = { skip: process.platform === "win32" ? "Windows native evidence reuse remains unsupported" : false };
const durableEvidenceFallback = "[Prior read evidence is unavailable after a session boundary. Re-run the preceding read call before relying on exact contents.]";

function lastRead(f: Awaited<ReturnType<typeof fixture>>) {
	return f.session.agent.state.messages.filter(m => m.role === "toolResult").at(-1)!;
}

test("source lifecycle: reused source call ID rejects before integrity work", lifecycleHitOptions, async t => {
	const f = await fixture();
	try {
		await f.runCalls([{ name: "read", arguments: { path: "file.txt" }, id: "same-source" }]);
		const first = lastRead(f);
		const owner = f.internals._toolResultPresentation!;
		const artifact = owner.issueEvidenceArtifact(first.toolCallId, f.session.agent.state.messages, 1, (first.content[0] as { text: string }).text.length)!;
		assert.ok(artifact, "first real read must be eligible");
		const generation = owner.getResidentEvidenceGeneration(first.toolCallId);
		const before = { ...f.internals._evidenceLedger!.counters };
		const scans = f.counters.artifactIntegrityScans;
		await f.runCalls([{ name: "read", arguments: { path: "file.txt" }, id: "same-source" }]);
		const second = lastRead(f);
		const after = f.internals._evidenceLedger!.counters;
		const delta = { hits: after.hits - before.hits, realReads: after.realReadExecutions - before.realReadExecutions,
			prevented: after.realReadExecutionsPrevented - before.realReadExecutionsPrevented,
			avoided: after.modelVisibleTokensAvoided - before.modelVisibleTokensAvoided,
			scans: f.counters.artifactIntegrityScans - scans };
		t.diagnostic(JSON.stringify({ delta, duplicateSources: f.session.agent.state.messages.filter(m => m.role === "toolResult" && m.toolCallId === "same-source").length,
			residentReplaced: owner.getResidentEvidenceGeneration(first.toolCallId) !== generation }));
		assert.equal(f.session.agent.state.messages.filter(m => m.role === "toolResult" && m.toolCallId === "same-source").length, 2);
		assert.throws(() => owner.readArtifact(artifact.id, f.session.agent.state.messages));
		assert.deepEqual(delta, { hits: 0, realReads: 1, prevented: 0, avoided: 0, scans: 0 });
		assert.deepEqual(second.content, first.content);
		assert.equal((after.missesByReason as Record<string, number>)["source-call-id-reused"], 1);
	} finally { f.close(); }
});

for (const mode of ["manual", "automatic"] as const) {
	for (const tail of [false, true]) {
		test(`source lifecycle: ${mode} compaction expires a retained hit (retainedTail=${tail})`, lifecycleHitOptions, async t => {
			let cut = "";
			const f = await fixture(true, true, [pi => {
				pi.on("session_before_compact", event => {
					const kept = event.branchEntries.slice(event.branchEntries.findIndex(e => e.id === cut));
					return { compaction: { summary: "Earlier read summarized without exact contents.", firstKeptEntryId: cut,
						tokensBefore: event.preparation.tokensBefore,
						...(tail ? { retainedTail: kept.flatMap(e => e.type === "message" ? [e.message] : []) } : {}) } };
				});
			}]);
			try {
				f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
				await f.runCalls([{ name: "read", arguments: { path: "file.txt" }, id: "original-source" }]);
				const source = lastRead(f);
				const owner = f.internals._toolResultPresentation!;
				const artifact = owner.issueEvidenceArtifact(source.toolCallId, f.session.agent.state.messages, 1, (source.content[0] as { text: string }).text.length)!;
				assert.ok(artifact);
				await f.runCalls([{ name: "read", arguments: { path: "file.txt" }, id: "later-hit" }]);
				const live = lastRead(f);
				assert.match((live.content[0] as { text: string }).text, /Evidence reused:/);
				cut = f.session.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "user").at(-1)!.id;
				let compacted = false;
				f.session.subscribe(event => { if (event.type === "compaction_end") compacted = !event.aborted && event.result !== undefined; });
				if (mode === "manual") await f.session.compact();
				else assert.equal(await (f.session as unknown as { _runAutoCompaction(reason: string, retry: boolean): Promise<boolean> })._runAutoCompaction("threshold", false), false);
				assert.equal(compacted, true);
				const rebuilt = f.session.agent.state.messages;
				assert.equal(rebuilt.some(m => m.role === "toolResult" && m.toolCallId === "original-source"), false);
				const retained = rebuilt.find(m => m.role === "toolResult" && m.toolCallId === "later-hit")!;
				assert.ok(retained?.role === "toolResult", "later assistant/tool-result pair must survive the cut");
				assert.throws(() => owner.readArtifact(artifact.id, rebuilt));
				const roundTrip = JSON.parse(JSON.stringify(rebuilt));
				assert.throws(() => owner.readArtifact(artifact.id, roundTrip));
				t.diagnostic(JSON.stringify({ mode, tail, sourceRemoved: true, retained: retained.content, oldArtifactResolvable: false }));
				assert.deepEqual(retained.content, [{ type: "text", text: durableEvidenceFallback }]);
				assert.equal(JSON.stringify(f.session.sessionManager.getEntries()).includes(artifact.id), false);
				assert.equal(JSON.stringify(roundTrip).includes("Evidence reused:"), false);
			} finally { f.close(); }
		});
	}
}

test("source lifecycle: real notice-shaped file content is durable without a text heuristic", async () => {
	let cut = "";
	const f = await fixture(true, true, [pi => {
		pi.on("session_before_compact", event => ({ compaction: { summary: "older context", firstKeptEntryId: cut, tokensBefore: event.preparation.tokensBefore } }));
	}]);
	try {
		f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
		const text = '[Evidence reused: "real.txt"; "bytes 0-10"; evidenceId=evidence-v1-1; artifact=literal-file-content. No new disk read occurred.]';
		writeFileSync(join(f.cwd, "literal.txt"), text);
		await f.runCalls([{ name: "read", arguments: { path: "literal.txt" }, id: "literal" }]);
		const live = lastRead(f);
		assert.deepEqual(live.content, [{ type: "text", text }]);
		cut = f.session.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "user").at(-1)!.id;
		await f.session.compact();
		assert.deepEqual(lastRead(f).content, live.content);
		assert.ok(JSON.stringify(f.session.sessionManager.getEntries()).includes("literal-file-content"));
	} finally { f.close(); }
});

for (const tail of ["presentation", "ordinary"] as const) {
	for (const mutation of ["unchanged", "array", "block", "text", "message-start"] as const) {
		test(`source lifecycle: ${tail} persistence respects ${mutation} listener content`, lifecycleHitOptions, async t => {
			const f = await fixture();
			try {
				await f.runCalls([{ name: "read", arguments: { path: "file.txt" }, id: "source" }]);
				if (tail === "ordinary") t.mock.method(f.internals._toolResultPresentation!, "create", () => undefined);
				const replacement = [{ type: "text" as const, text: "listener supplied final content" }];
				f.session.subscribe(event => {
					if (event.type !== (mutation === "message-start" ? "message_start" : "message_end") || event.message.role !== "toolResult" || event.message.toolCallId !== "hit") return;
					if (mutation === "array") event.message.content = replacement;
					if (mutation === "block") event.message.content[0] = replacement[0];
					if (mutation === "text" || mutation === "message-start") (event.message.content[0] as { text: string }).text = replacement[0].text;
				});
				await f.runCalls([{ name: "read", arguments: { path: "file.txt" }, id: "hit" }]);
				const live = lastRead(f);
				const entry = f.session.sessionManager.getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "hit");
				assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
				const durable = entry.message;
				assert.deepEqual(durable.content, mutation === "unchanged" ? [{ type: "text", text: durableEvidenceFallback }] : replacement);
				if (mutation === "unchanged") {
					assert.notEqual(durable, live);
					assert.notEqual(durable.content, live.content);
					assert.match((live.content[0] as { text: string }).text, /Evidence reused:/);
					assert.equal(Object.getOwnPropertySymbols(durable.content).length, 0);
					assert.equal(Object.getOwnPropertySymbols(durable.content[0]).length, 0);
					assert.deepEqual({ ...durable, content: undefined }, { ...live, content: undefined });
				} else assert.equal(durable, live);
			} finally { f.close(); }
		});
	}
}

test("source lifecycle: bounded durable clones release after session lifecycle", {
	skip: process.env.PI_EVIDENCE_LEASE_GC !== "1" ? "one explicitly requested controlled-GC run only" : false,
}, async t => {
	assert.equal(typeof global.gc, "function");
	async function released() {
		const f = await fixture();
		const weak: WeakRef<object>[] = [];
		try {
			await f.read();
			for (let i = 0; i < 8; i++) {
				const live = await f.read();
				const entry = f.session.sessionManager.getBranch().at(-1)!;
				assert.ok(entry.type === "message" && entry.message.role === "toolResult");
				const durable = entry.message;
				assert.notEqual(durable, live);
				assert.deepEqual(durable.content, [{ type: "text", text: durableEvidenceFallback }]);
				assert.equal(Object.getOwnPropertySymbols(durable).length, 0);
				assert.equal(Object.getOwnPropertySymbols(durable.content).length, 0);
				assert.equal(Object.getOwnPropertySymbols(durable.content[0]).length, 0);
				assert.equal(JSON.stringify(durable).includes("artifact="), false);
				weak.push(new WeakRef(durable), new WeakRef(durable.content), new WeakRef(durable.content[0]));
			}
			weak.push(new WeakRef(f.internals._toolResultPresentation!), new WeakRef(f.session.agent.state.messages[0]));
			assert.equal(f.internals._evidenceLedger!.counters.hits, 8);
			f.session.sessionManager.newSession();
			f.session.agent.state.messages = [];
		} finally { f.close(); }
		return weak;
	}
	const weak = await released();
	for (let i = 0; i < 12; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
		global.gc!();
	}
	assert.equal(weak.filter(ref => ref.deref() !== undefined).length, 0);
	t.diagnostic(JSON.stringify({ hits: 8, durableMessageClones: 8, freshArrays: 8, freshTextBlocks: 8,
		fallbackChars: durableEvidenceFallback.length, weakReferencesReleased: weak.length, retainedAfterLifecycle: 0,
		newStores: 0, sourceCopies: 0, noticeStringCopies: 0 }));
});
