import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultPresentationOwner, createToolResultPresentationCounters } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

// These interfaces describe the new internal seam without changing the public artifact API.
interface ResidentEvidenceOwner {
	issueEvidenceArtifact(call: string, messages: readonly unknown[], blocks: number, chars: number): { id: string; bytes: number } | undefined;
	validateEvidenceArtifact(call: string, id: string, messages: readonly unknown[], blocks: number, chars: number): boolean;
}

function fixture() {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, "evidence-owner")!;
	const content = [{ type: "text" as const, text: "exact local file text\n".repeat(1000) }];
	const message = { role: "toolResult", toolName: "read", toolCallId: "source", content, isError: false };
	owner.create(content, "source");
	owner.release();
	return { owner, api: owner as unknown as ResidentEvidenceOwner, content, message, counters };
}

test("resident evidence uses the existing descriptor and exactly one integrity scan", () => {
	const f = fixture();
	try {
		assert.equal(typeof f.api.issueEvidenceArtifact, "function", "missing resident evidence admission");
		const descriptor = f.api.issueEvidenceArtifact("source", [f.message], 1, f.content[0].text.length)!;
		assert.ok(descriptor);
		const before = f.counters.artifactIntegrityScans;
		assert.equal(f.api.validateEvidenceArtifact("source", descriptor.id, [f.message], 1, f.content[0].text.length), true);
		assert.equal(f.counters.artifactIntegrityScans - before, 1);
		assert.equal(f.owner.readArtifact(descriptor.id, [f.message]).content, f.content);
	} finally { f.owner.dispose(); }
});

test("same-length canonical mutation stays legal and rejects evidence", () => {
	const f = fixture();
	try {
		const chars = f.content[0].text.length;
		const descriptor = f.api.issueEvidenceArtifact("source", [f.message], 1, chars)!;
		assert.doesNotThrow(() => { f.content[0].text = "x".repeat(chars); });
		const before = f.counters.artifactIntegrityScans;
		assert.equal(f.api.validateEvidenceArtifact("source", descriptor.id, [f.message], 1, chars), false);
		assert.equal(f.counters.artifactIntegrityScans - before, 1);
	} finally { f.owner.dispose(); }
});

for (const mutation of ["giant", "array", "image", "duplicate", "missing", "clear", "history"] as const) {
	test(`resident evidence rejects ${mutation} before hashing or rebuilding`, () => {
		const f = fixture();
		try {
			const chars = f.content[0].text.length;
			const descriptor = f.api.issueEvidenceArtifact("source", [f.message], 1, chars)!;
			let messages: unknown[] = [f.message];
			if (mutation === "giant") f.content[0].text = "x".repeat(1_000_000);
			if (mutation === "array") f.message.content = [{ ...f.content[0] }];
			if (mutation === "image") (f.content[0] as { type: string }).type = "image";
			if (mutation === "duplicate") messages.push({ ...f.message });
			if (mutation === "missing") messages = [];
			if (mutation === "clear") f.owner.clearProjectionRecords();
			if (mutation === "history") messages = new Array(50_000).fill(null);
			const before = f.counters.artifactIntegrityScans;
			const scans = f.counters.projectionRecordMisses;
			assert.equal(f.api.validateEvidenceArtifact("source", descriptor.id, messages, 1, chars), false);
			assert.equal(f.counters.artifactIntegrityScans, before);
			assert.equal(f.counters.projectionRecordMisses, scans);
		} finally { f.owner.dispose(); }
	});
}
