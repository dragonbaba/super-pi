import assert from "node:assert/strict";
import { mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { formatEvidenceReference, type EvidenceRecordV1 } from "../packages/coding-agent/src/core/evidence-ledger.ts";
import { hasPreciseReadIdentity, readFileGeneration } from "../packages/coding-agent/src/core/tools/read-window.ts";

const linux = { skip: process.platform === "win32" ? "Windows evidence identity conservatively misses" : false };
const tokens = (text: string) => estimateToolOutputTokens([{ type: "text", text }]).estimatedTokens;

for (const corpus of ["medium", "large"]) {
	test(`${corpus} retains one real read, exact reference fit and over 50 percent total token reduction`, linux, async t => {
		const f = await fixture();
		try {
			if (corpus === "large") writeFileSync(join(f.cwd, "file.txt"), "large selected source text\n".repeat(20000));
			const first = await f.read();
			const owner = f.internals._toolResultPresentation!;
			const originalTokens = owner.getResidentEvidenceModelTokens(first.toolCallId)!;
			const firstGeneration = readFileGeneration(statSync(join(f.cwd, "file.txt"), { bigint: true }));
			const scans = f.counters.artifactIntegrityScans;
			let totalTokens = originalTokens;
			let referenceTokens = 0;
			for (let i = 0; i < 9; i++) {
				const message = await f.read();
				if (!/Evidence reused/.test(JSON.stringify(message.content))) {
					const ledger = f.internals._evidenceLedger!;
					const info = statSync(join(f.cwd, "file.txt"), { bigint: true });
					t.diagnostic(JSON.stringify({ corpus, iteration: i, originalTokens, firstGeneration,
						currentGeneration: readFileGeneration(info), precise: hasPreciseReadIdentity(info), counters: ledger.counters,
						records: [...(ledger as unknown as { records: Map<string, unknown> }).records.values()] }));
				}
				assert.match(JSON.stringify(message.content), /Evidence reused/);
				referenceTokens = estimateToolOutputTokens(message.content).estimatedTokens;
				assert.ok(referenceTokens < originalTokens);
				assert.ok(referenceTokens <= owner.getEvidenceBudgetTokens()!);
				assert.equal(owner.getResidentEvidenceModelTokens(message.toolCallId), referenceTokens);
				totalTokens += referenceTokens;
			}
			assert.ok(totalTokens < originalTokens * 10 / 2);
			assert.equal(f.counters.artifactIntegrityScans - scans, 9);
			assert.equal(f.internals._evidenceLedger!.counters.realReadExecutions, 1);
			assert.equal(f.internals._evidenceLedger!.counters.hits, 9);
			t.diagnostic(JSON.stringify({ corpus, originalTokens, referenceTokens, totalTokens, baselineTokens: originalTokens * 10 }));
		} finally { f.close(); }
	});
}

for (const budget of [tokens("x"), tokens("x") + 1, 128, 2048]) {
	test(`tiny repeated read stays successful and unamplified at budget ${budget}`, linux, async t => {
		const f = await fixture(true, true, [], budget);
		try {
			writeFileSync(join(f.cwd, "file.txt"), "x");
			const first = await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
			assert.equal(f.session.agent.state.errorMessage, undefined);
			const original = first.at(-1)!.messages.filter(m => m.role === "toolResult").at(-1)!;
			const originalTokens = estimateToolOutputTokens(original.content).estimatedTokens;
			assert.equal(originalTokens, tokens("x"));
			const second = await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
			const raw = f.session.agent.state.messages.filter(m => m.role === "toolResult").at(-1)!;
			t.diagnostic(JSON.stringify({ budget, originalTokens, repeatedRawTokens: estimateToolOutputTokens(raw.content).estimatedTokens, error: f.session.agent.state.errorMessage }));
			assert.equal(f.session.agent.state.errorMessage, undefined);
			const repeated = second.at(-1)!.messages.filter(m => m.role === "toolResult").at(-1)!;
			assert.equal(estimateToolOutputTokens(repeated.content).estimatedTokens, originalTokens);
			const c = f.internals._evidenceLedger!.counters;
			assert.equal(c.hits, 0);
			assert.equal(c.realReadExecutions, 2);
			assert.equal(c.realReadExecutionsPrevented, 0);
			assert.equal(c.modelVisibleTokensAvoided, 0);
			assert.ok((c.missesByReason as Record<string, number>)["not-beneficial"] > 0);
		} finally { f.close(); }
	});
}

test("tiny budget sweep brackets the actual final artifact reference estimate", linux, async t => {
	let referenceTokens = 0;
	const probe = await fixture();
	try {
		writeFileSync(join(probe.cwd, "file.txt"), "x");
		const ledger = probe.internals._evidenceLedger!;
		const admit = ledger.admit.bind(ledger);
		t.mock.method(ledger, "admit", (input: EvidenceRecordV1, budget: number) => {
			referenceTokens = tokens(formatEvidenceReference(input));
			return admit(input, budget);
		});
		await probe.read();
	} finally { probe.close(); }
	assert.ok(referenceTokens > tokens("x"));
	t.diagnostic(JSON.stringify({ originalTokens: tokens("x"), referenceTokens }));
	for (const budget of [referenceTokens - 1, referenceTokens, referenceTokens + 1]) {
		const f = await fixture(true, true, [], budget);
		try {
			writeFileSync(join(f.cwd, "file.txt"), "x");
			for (let i = 0; i < 2; i++) {
				const contexts = await f.runCalls([{ name: "read", arguments: { path: "file.txt" } }]);
				assert.equal(f.session.agent.state.errorMessage, undefined);
				const result = contexts.at(-1)!.messages.filter(m => m.role === "toolResult").at(-1)!;
				assert.equal(estimateToolOutputTokens(result.content).estimatedTokens, 1);
			}
			assert.equal(f.internals._evidenceLedger!.counters.hits, 0);
			assert.equal(f.internals._evidenceLedger!.counters.realReadExecutions, 2);
		} finally { f.close(); }
	}
});

for (const metadata of [undefined, -1, 1, 1_000_000]) {
	test(`missing or inconsistent reference tokens reject before integrity: ${metadata}`, linux, async t => {
		const f = await fixture();
		try {
			await f.read();
			const ledger = f.internals._evidenceLedger!;
			const lookup = ledger.lookup.bind(ledger);
			t.mock.method(ledger, "lookup", (key: string) => {
				const record = lookup(key);
				return record ? { ...record, referenceTokens: metadata } : undefined;
			});
			const scans = f.counters.artifactIntegrityScans;
			assert.doesNotMatch(JSON.stringify((await f.read()).content), /Evidence reused/);
			assert.equal(f.counters.artifactIntegrityScans, scans);
			assert.equal(ledger.counters.hits, 0);
			assert.equal(ledger.counters.realReadExecutions, 2);
			assert.equal(ledger.counters.missesByReason["not-beneficial"], 1);
		} finally { f.close(); }
	});
}

for (const removeFirst of [false, true]) {
	test(`addressed symlink aliases never share path-dependent evidence; deleted=${removeFirst}`, linux, async t => {
		const f = await fixture();
		try {
			writeFileSync(join(f.cwd, "target.txt"), "x".repeat(100_000));
			symlinkSync("target.txt", join(f.cwd, "alias-a.txt"));
			symlinkSync("target.txt", join(f.cwd, "alias-b.txt"));
			const a = await f.read({ path: "alias-a.txt" });
			assert.match(JSON.stringify(a.content), /alias-a/);
			if (removeFirst) unlinkSync(join(f.cwd, "alias-a.txt"));
			const scans = f.counters.artifactIntegrityScans;
			const b = await f.read({ path: "alias-b.txt" });
			t.diagnostic(JSON.stringify({ removeFirst, result: b.content, hits: f.internals._evidenceLedger!.counters.hits }));
			assert.doesNotMatch(JSON.stringify(b.content), /Evidence reused|alias-a/);
			assert.match(JSON.stringify(b.content), /alias-b/);
			assert.equal(f.counters.artifactIntegrityScans, scans);
			assert.equal(f.internals._evidenceLedger!.counters.realReadExecutions, 2);
			const again = await f.read({ path: "alias-b.txt" });
			// This short fallback is itself cheaper than a reference. The benefit
			// gate can decline both aliases; profitable alias hits are covered below.
			assert.match(JSON.stringify(again.content), /alias-b/);
			assert.doesNotMatch(JSON.stringify(again.content), /alias-a/);
		} finally { f.close(); }
	});
}

test("normalized addressed spellings preserve equivalence", linux, async () => {
	const f = await fixture();
	try {
		mkdirSync(join(f.cwd, "dir"));
		await f.read();
		for (const path of ["./file.txt", "dir/../file.txt"]) {
			assert.match(JSON.stringify((await f.read({ path })).content), /Evidence reused/);
		}
		assert.equal(f.internals._evidenceLedger!.counters.realReadExecutions, 1);
	} finally { f.close(); }
});

test("profitable aliases bind references and artifacts to their own addressed paths", linux, async () => {
	const f = await fixture();
	try {
		symlinkSync("file.txt", join(f.cwd, "alias-a.txt"));
		symlinkSync("file.txt", join(f.cwd, "alias-b.txt"));
		await f.read({ path: "alias-a.txt" });
		unlinkSync(join(f.cwd, "alias-a.txt"));
		const scans = f.counters.artifactIntegrityScans;
		assert.doesNotMatch(JSON.stringify((await f.read({ path: "alias-b.txt" })).content), /Evidence reused/);
		assert.equal(f.counters.artifactIntegrityScans, scans);
		const again = await f.read({ path: "alias-b.txt" });
		assert.match(JSON.stringify(again.content), /Evidence reused.*alias-b/);
		assert.doesNotMatch(JSON.stringify(again.content), /alias-a/);
		assert.equal(f.counters.artifactIntegrityScans, scans + 1);
		assert.equal(f.internals._evidenceLedger!.counters.realReadExecutions, 2);
	} finally { f.close(); }
});

test("record addressed-path mismatch invalidates before any G2 integrity scan", linux, async t => {
	const f = await fixture();
	try {
		await f.read();
		const ledger = f.internals._evidenceLedger!;
		const lookup = ledger.lookup.bind(ledger);
		t.mock.method(ledger, "lookup", (key: string) => {
			const record = lookup(key);
			return record ? { ...record, relativePath: "other.txt" } : undefined;
		});
		const scans = f.counters.artifactIntegrityScans;
		assert.doesNotMatch(JSON.stringify((await f.read()).content), /Evidence reused/);
		assert.equal(f.counters.artifactIntegrityScans, scans);
		assert.equal(ledger.counters.missesByReason["args-mismatch"], 1);
		assert.equal(ledger.counters.realReadExecutions, 2);
		assert.equal(ledger.counters.hits, 0);
	} finally { f.close(); }
});

test("control and delimiter filename characters stay inside the escaped path field", linux, async () => {
	const f = await fixture();
	try {
		const path = 'line\n\x1b]; evidenceId="pretend".txt';
		symlinkSync("file.txt", join(f.cwd, path));
		await f.read({ path });
		const message = await f.read({ path });
		const text = (message.content[0] as { text: string }).text;
		assert.doesNotMatch(text, /[\n\x1b]/);
		const encoded = /^\[Evidence reused: ("(?:\\.|[^"\\])*");/.exec(text)![1];
		assert.equal(JSON.parse(encoded), path);
		assert.equal(f.internals._evidenceLedger!.counters.hits, 1);
	} finally { f.close(); }
});
