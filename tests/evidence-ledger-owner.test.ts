import assert from "node:assert/strict";
import test from "node:test";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
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

test("native revision groups reuse bounded evidence with one scan and release their source", async t => {
  const inspector = new InspectorSession(); inspector.connect(); t.after(() => inspector.disconnect());
  async function exercise() {
    const counters = createToolResultPresentationCounters();
    const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 512, counters }, "native-revision")!;
    const content = [{ type: "text" as const, readBoundary: "lines" as const, text: "1#ABCD|exact native source\n".repeat(500) },
      { type: "text" as const, readBoundary: "metadata" as const, text: "[Snapshot edit] snapshot=snap_abcdefghijklmnopqrstuv; editable lines=1-500." }];
    const message = { role: "toolResult", toolName: "read", toolCallId: "source", content, isError: false }, messages = [message];
    const chars = content[0].text.length + content[1].text.length;
    owner.create(content, "source"); owner.release();
    const descriptor = owner.issueEvidenceArtifact("source", messages, 2, chars)!; assert.ok(descriptor);
    const before = counters.artifactIntegrityScans;
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    try {
      for (let index = 0; index < 1000; index++) assert.equal(owner.validateEvidenceArtifact("source", descriptor.id, messages, 2, chars), true);
      assert.equal(counters.artifactIntegrityScans - before, 1000);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      let sampled = 0; const nodes = [profile.head];
      while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
      content[1].text = "x".repeat(65537);
      assert.equal(owner.validateEvidenceArtifact("source", descriptor.id, messages, 2, chars), false);
      assert.equal(counters.artifactIntegrityScans - before, 1000, "oversized metadata rejects before hashing");
      owner.clearProjectionRecords();
      assert.equal(owner.validateEvidenceArtifact("source", descriptor.id, messages, 2, chars), false);
      return { sampled, refs: [new WeakRef(owner), new WeakRef(content), new WeakRef(message), new WeakRef(messages)] };
    } finally { owner.dispose(); }
  }
  const { sampled, refs } = await exercise();
  assert.ok(sampled < 8 * 1024 * 1024, "fixed allocation envelope for 1000 two-block integrity lookups");
  for (let index = 0; index < 4; index++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  t.diagnostic(JSON.stringify({ lookups: 1000, scans: 1000, blocks: 2, sampledBytes: sampled, bytesPerLookup: sampled / 1000, references: refs.length, live: 0 }));
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

test("a replacement resident source cannot inherit an older evidence lease", () => {
	const f = fixture();
	try {
		const chars = f.content[0].text.length;
		const descriptor = f.api.issueEvidenceArtifact("source", [f.message], 1, chars)!;
		const generation = f.owner.getResidentEvidenceGeneration("source")!;
		f.message.content = [{ ...f.content[0] }];
		f.owner.create(f.message.content, "source"); f.owner.release();
		const scans = f.counters.artifactIntegrityScans;
		assert.equal(f.owner.validateEvidenceArtifact("source", descriptor.id, [f.message], 1, chars, generation), false);
		assert.equal(f.counters.artifactIntegrityScans, scans);
	} finally { f.owner.dispose(); }
});

test("owner retention eviction is an evidence miss, never lazy reconstruction", () => {
	const f = fixture();
	try {
		const chars = f.content[0].text.length;
		const descriptor = f.api.issueEvidenceArtifact("source", [f.message], 1, chars)!;
		for (let i = 0; i < 128; i++) { f.owner.create([{ type: "text", text: "resident" }], `other-${i}`); f.owner.release(); }
		const before = f.counters.projectionRecordMisses;
		assert.equal(f.api.validateEvidenceArtifact("source", descriptor.id, [f.message], 1, chars), false);
		assert.equal(f.counters.projectionRecordMisses, before);
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
