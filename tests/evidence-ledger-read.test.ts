import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";

test("ten completed built-in reads reuse bounded references with one integrity scan per hit", { skip: process.platform === "win32" ? "Windows stat is not a reliable change generation; uncertainty must miss" : false }, async () => {
	const f = await fixture();
	try {
		const first = await f.read();
		const before = f.counters.artifactIntegrityScans;
		for (let i = 0; i < 9; i++) {
			const next = await f.read();
			assert.match(JSON.stringify(next.content), /no new disk read/i);
			assert.ok(JSON.stringify(next.content).length < JSON.stringify(first.content).length / 2);
		}
		assert.equal(f.counters.artifactIntegrityScans - before, 9);
	} finally { f.close(); }
});

test("same-length historical mutation is permitted and forces a real read", async () => {
	const f = await fixture();
	try {
		const first = await f.read();
		const block = first.content[0] as { type: string; text: string };
		assert.doesNotThrow(() => { block.text = "x".repeat(block.text.length); });
		const next = await f.read();
		assert.match((next.content[0] as { text: string }).text, /^production-shaped/);
		assert.equal(/no new disk read/i.test(JSON.stringify((await f.read()).content)), process.platform !== "win32");
	} finally { f.close(); }
});

for (const mode of ["disabled", "no-owner"] as const) {
	test(`${mode} leaves ordinary mutable read results compatible`, async () => {
		const f = await fixture(mode !== "disabled", mode !== "no-owner");
		try {
			const first = await f.read();
			const before = f.counters.artifactIntegrityScans;
			assert.deepEqual((await f.read()).content, first.content);
			assert.equal(f.counters.artifactIntegrityScans, before);
			assert.equal(Object.isFrozen(first.content), false);
		} finally { f.close(); }
	});
}
