import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceLedger, type EvidenceRecordV1, EVIDENCE_MAX_METADATA_BYTES } from "../packages/coding-agent/src/core/evidence-ledger.ts";

function record(key: string): EvidenceRecordV1 {
	return { version: 1, evidenceId: key, toolKind: "builtin-read", canonicalArgsHash: key, scopeFingerprint: "scope",
		resultHandle: "artifact", sourceToolCallId: key, relativePath: "file", location: "lines 1-100", createdTurn: 1,
		workspaceGeneration: 0, branchGeneration: 0, canonicalPath: "canonical", fileGeneration: "generation",
		sessionId: "session", cwd: "cwd", blocks: 1, chars: 1024, artifactBytes: 2048, modelTokens: 512 };
}

test("128-entry insertion eviction, metadata-only admission and release", () => {
	const ledger = new EvidenceLedger();
	for (let i = 0; i < 129; i++) assert.equal(ledger.admit(record(String(i))), true);
	assert.equal(ledger.lookup("0"), undefined);
	assert.ok(ledger.lookup("1"));
	assert.equal(ledger.counters.entries, 128);
	assert.equal(ledger.counters.recordsEvicted, 1);
	assert.ok(ledger.counters.metadataBytes <= EVIDENCE_MAX_METADATA_BYTES);
	const input = { ...record("extra"), source: { text: "secret" } };
	assert.equal(ledger.admit(input), true);
	assert.equal("source" in ledger.lookup("extra")!, false);
	assert.notEqual(ledger.lookup("extra"), input);
	ledger.clear();
	assert.equal(ledger.counters.entries, 0);
	assert.equal(ledger.counters.metadataBytes, 0);
	assert.equal(ledger.counters.retainedSourceReferences, 0);
});

test("metadata bound, oversized locations and argument inputs are rejected", () => {
	const ledger = new EvidenceLedger();
	assert.equal(ledger.admit({ ...record("huge"), location: "x".repeat(8193) }), false);
	assert.equal(ledger.admit({ ...record("huge"), relativePath: "x".repeat(256 * 1024) }), false);
	assert.equal(ledger.hashArguments("x".repeat(65537)), undefined);
	assert.equal(ledger.hashArguments("界".repeat(30000)), undefined);
	assert.equal(ledger.counters.argumentBytesHashed, 0);
	for (let i = 0; i < 128; i++) ledger.admit({ ...record(String(i)), location: "x".repeat(8192) });
	assert.ok(ledger.counters.entries < 128);
	assert.ok(ledger.counters.metadataBytes <= EVIDENCE_MAX_METADATA_BYTES);
	ledger.dispose();
	assert.equal(ledger.admit(record("after")), false);
	assert.equal(ledger.counters.metadataBytes, 0);
});

test("mutation/branch generations invalidate completed evidence before work", () => {
	const ledger = new EvidenceLedger();
	ledger.admit(record("old"));
	ledger.mutate();
	assert.equal(ledger.lookup("old"), undefined);
	assert.equal(ledger.admit(record("late-completion")), false);
	ledger.changeBranch();
	assert.equal(ledger.branchGeneration, 1);
	assert.equal(ledger.counters.entries, 0);
});
