import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";

const linux = { skip: process.platform === "win32" ? "Windows evidence identity conservatively misses" : false };
const tokens = (text: string) => estimateToolOutputTokens([{ type: "text", text }]).estimatedTokens;

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
			assert.match(JSON.stringify(again.content), /Evidence reused.*alias-b/);
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
