import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	type ToolResultPresentationContent,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

const SESSION_ID = "phase-5b-artifact-session";
const BUDGET_TOKENS = 128;
const ARTIFACT_MEDIA_TYPE = "application/vnd.super-pi.tool-result-content";

interface ArtifactDescriptor {
	version: 1;
	id: string;
	sha256: string;
	bytes: number;
	mediaType: string;
}

interface ArtifactRead {
	version: 1;
	descriptor: ArtifactDescriptor;
	content: readonly ToolResultPresentationContent[];
}

type ArtifactOwner = {
	readArtifact(id: string, messages: readonly unknown[]): ArtifactRead;
};

function toolResult(content: ToolResultPresentationContent[], toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
}

function canonicalArtifactIdentity(content: readonly ToolResultPresentationContent[]): { sha256: string; bytes: number } {
	const prefix = "tool-result-source-v1\0";
	const digest = createHash("sha256");
	digest.update(prefix);
	let bytes = Buffer.byteLength(prefix);
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "text") {
			const length = block.text.length.toString(36);
			digest.update("t").update(length).update(":").update(block.text, "utf16le");
			bytes += 1 + length.length + 1 + block.text.length * 2;
		} else {
			const mimeLength = block.mimeType.length.toString(36);
			const dataLength = block.data.length.toString(36);
			digest.update("i").update(mimeLength).update(":").update(block.mimeType);
			digest.update(dataLength).update(":").update(block.data);
			bytes += 1 + mimeLength.length + 1 + Buffer.byteLength(block.mimeType);
			bytes += dataLength.length + 1 + Buffer.byteLength(block.data);
		}
	}
	return { sha256: digest.digest("hex"), bytes };
}

function artifactFrom(presentation: unknown): ArtifactDescriptor | undefined {
	return (presentation as { artifact?: ArtifactDescriptor }).artifact;
}

function artifactOwner(owner: object): ArtifactOwner {
	return owner as ArtifactOwner;
}

test("truncated dual views expose a deterministic session artifact without copying the source", () => {
	const image = { type: "image" as const, data: "QUJDREVGRw==", mimeType: "image/png" };
	const content: ToolResultPresentationContent[] = [
		{ type: "text", text: "artifact-source-".repeat(20_000) },
		image,
		{ type: "text", text: "tail" },
	];
	const message = toolResult(content, "artifact-source");
	const expected = canonicalArtifactIdentity(content);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId)!;
	const descriptor = artifactFrom(presentation);
	assert.ok(descriptor);
	assert.equal(descriptor.version, 1);
	assert.match(descriptor.id, /^tra1\.[0-9a-f]{16}\.[0-9a-f]{64}$/);
	assert.equal(descriptor.sha256, expected.sha256);
	assert.equal(descriptor.bytes, expected.bytes);
	assert.equal(descriptor.mediaType, ARTIFACT_MEDIA_TYPE);
	const read = artifactOwner(owner).readArtifact(descriptor.id, [message]);
	assert.equal(read.descriptor, descriptor);
	assert.equal(read.content, content);
	assert.equal(read.content[0], content[0]);
	assert.equal(read.content[1], image);
	owner.release();
	owner.dispose();
});

test("small V1 results do not create artifact handles", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "small" }];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const presentation = owner.create(content, "small-artifact")!;
	assert.equal(presentation.version, 1);
	assert.equal(artifactFrom(presentation), undefined);
	owner.release();
	owner.dispose();
});

test("artifact handles lazily bind the persisted source after clear and resume", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "resume-artifact-".repeat(20_000) }];
	const message = toolResult(content, "resume-artifact");
	const initial = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const presentation = initial.create(content, message.toolCallId)!;
	const descriptor = artifactFrom(presentation)!;
	initial.release();
	initial.clearProjectionRecords();
	const afterClear = artifactOwner(initial).readArtifact(descriptor.id, [message]);
	assert.equal(afterClear.content, content);
	initial.dispose();

	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const afterResume = artifactOwner(resumed).readArtifact(descriptor.id, [message]);
	assert.equal(afterResume.content, content);
	assert.equal(afterResume.descriptor.id, descriptor.id);
	assert.equal(afterResume.descriptor.sha256, descriptor.sha256);
	resumed.dispose();
});

test("artifact handles reject modified, ambiguous, foreign-session, and malformed sources", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "artifact-identity-A".repeat(20_000) }];
	const message = toolResult(content, "artifact-identity");
	const initial = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const presentation = initial.create(content, message.toolCallId)!;
	const descriptor = artifactFrom(presentation)!;
	initial.release();
	initial.dispose();

	const modified = toolResult([{ type: "text", text: "artifact-identity-B".repeat(20_000) }], message.toolCallId);
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	for (const messages of [[modified], [message, message], []]) {
		assert.throws(
			() => artifactOwner(resumed).readArtifact(descriptor.id, messages),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-artifact",
		);
	}
	assert.throws(
		() => artifactOwner(resumed).readArtifact("not-an-artifact", [message]),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "invalid-artifact",
	);
	resumed.dispose();

	const foreign = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, "foreign-session")!;
	assert.throws(
		() => artifactOwner(foreign).readArtifact(descriptor.id, [message]),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-artifact",
	);
	foreign.dispose();
});

test("resident artifact reads reject in-place source block mutation", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "mutable-artifact-A".repeat(20_000) }];
	const message = toolResult(content, "mutable-artifact");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		SESSION_ID,
	)!;
	const descriptor = artifactFrom(owner.create(content, message.toolCallId))!;
	owner.release();
	assert.equal(artifactOwner(owner).readArtifact(descriptor.id, [message]).content, content);
	assert.equal(counters.artifactIntegrityScans, 1);
	(content[0] as { type: "text"; text: string }).text = "mutable-artifact-B".repeat(20_000);
	assert.throws(
		() => artifactOwner(owner).readArtifact(descriptor.id, [message]),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-artifact",
	);
	assert.equal(counters.artifactIntegrityScans, 2);
	owner.dispose();
});

test("artifact resume resolution is independent of the current projection budget", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "budget-independent-artifact-".repeat(20_000) }];
	const message = toolResult(content, "budget-independent-artifact");
	const initial = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const descriptor = artifactFrom(initial.create(content, message.toolCallId))!;
	initial.release();
	initial.dispose();
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1 }, SESSION_ID)!;
	const read = artifactOwner(resumed).readArtifact(descriptor.id, [message]);
	assert.equal(read.content, content);
	assert.equal(read.descriptor.id, descriptor.id);
	assert.throws(
		() => resumed.projectMessagesForModel([message]),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "budget-too-small",
		"provider projection still enforces its independently configured budget",
	);
	resumed.dispose();

	const bounded = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	artifactOwner(bounded).readArtifact(descriptor.id, [message]);
	const scansAfterArtifactRead = bounded.counters.fullSourceEstimatorScans;
	const providerMessages = [message];
	bounded.projectMessagesForModel(providerMessages);
	assert.notEqual(providerMessages[0], message);
	assert.equal(bounded.counters.fullSourceEstimatorScans, scansAfterArtifactRead);
	assert.equal(bounded.counters.projectionRecordEntries, 1);
	bounded.dispose();
});

test("lazy artifact binding revalidates in-place content before first provider projection", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "lazy-projection-A".repeat(20_000) }];
	const message = toolResult(content, "lazy-projection-integrity");
	const initial = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const descriptor = artifactFrom(initial.create(content, message.toolCallId))!;
	initial.release();
	initial.dispose();

	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	assert.equal(artifactOwner(resumed).readArtifact(descriptor.id, [message]).content, content);
	const scansAfterArtifactRead = resumed.counters.fullSourceEstimatorScans;
	const integrityScansAfterArtifactRead = resumed.counters.artifactIntegrityScans;
	(content[0] as { type: "text"; text: string }).text = "lazy-projection-B".repeat(20_000);

	const providerMessages = [message];
	resumed.projectMessagesForModel(providerMessages);
	const projected = providerMessages[0] as ToolResultMessage;
	const notice = projected.content.find(
		(block) => block.type === "text" && block.text.startsWith("[Tool result truncated. Continue with cursor "),
	);
	assert.ok(notice && notice.type === "text");
	const cursor = notice.text.substring("[Tool result truncated. Continue with cursor ".length, notice.text.length - 2);
	assert.equal(resumed.counters.artifactIntegrityScans, integrityScansAfterArtifactRead + 1);
	assert.equal(resumed.counters.fullSourceEstimatorScans, scansAfterArtifactRead + 1);

	const fresh = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const chunk = fresh.readContinuation(cursor, [message], BUDGET_TOKENS);
	assert.ok(chunk.content.length > 0);
	assert.ok(chunk.estimatedTokens > 0);
	assert.ok(chunk.estimatedTokens <= BUDGET_TOKENS);
	assert.throws(
		() => artifactOwner(resumed).readArtifact(descriptor.id, [message]),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-artifact",
	);
	fresh.dispose();
	resumed.dispose();
});

test("owners without a session identity do not issue or accept session-bound artifacts", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "anonymous-artifact-".repeat(20_000) }];
	const anonymous = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS })!;
	const presentation = anonymous.create(content, "anonymous-artifact")!;
	assert.equal(presentation.version, 2);
	assert.equal(artifactFrom(presentation), undefined);
	anonymous.release();
	const sessionOwner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		SESSION_ID,
	)!;
	const descriptor = artifactFrom(sessionOwner.create(content, "anonymous-artifact"))!;
	sessionOwner.release();
	assert.throws(
		() => artifactOwner(anonymous).readArtifact(descriptor.id, [toolResult(content, "anonymous-artifact")]),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-artifact",
	);
	anonymous.dispose();
	sessionOwner.dispose();
});

test("first artifact read scans active history once and subsequent reads stay indexed", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "indexed-artifact-".repeat(20_000) }];
	const message = toolResult(content, "indexed-artifact");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		SESSION_ID,
	)!;
	const descriptor = artifactFrom(owner.create(content, message.toolCallId))!;
	owner.release();
	owner.clearProjectionRecords();
	const history: unknown[] = new Array(50_000);
	for (let index = 0; index < history.length - 1; index++) history[index] = { role: "user", index };
	history[history.length - 1] = message;
	const scansBefore = counters.fullSourceEstimatorScans;
	const probesBefore = counters.artifactSourceLookupProbes;
	const first = artifactOwner(owner).readArtifact(descriptor.id, history);
	assert.equal(first.content, content);
	assert.equal(counters.fullSourceEstimatorScans - scansBefore, 1);
	assert.equal(counters.artifactSourceLookupProbes - probesBefore, history.length);
	assert.equal(counters.projectionRecordEntries, 1);
	const steadyScans = counters.fullSourceEstimatorScans;
	const steadyProbes = counters.artifactSourceLookupProbes;
	const steadyHits = counters.artifactRecordHits;
	const steadyIntegrityScans = counters.artifactIntegrityScans;
	const second = artifactOwner(owner).readArtifact(descriptor.id, history);
	assert.equal(second.content, content);
	assert.equal(counters.fullSourceEstimatorScans, steadyScans);
	assert.equal(counters.artifactSourceLookupProbes, steadyProbes);
	assert.equal(counters.artifactRecordHits, steadyHits + 1);
	assert.equal(counters.artifactIntegrityScans, steadyIntegrityScans + 1);
	assert.equal(counters.artifactReads, 2);
	owner.clearProjectionRecords();
	assert.equal(counters.projectionRecordEntries, 0);
	assert.equal(counters.retainedProjectionCodeUnits, 0);
	owner.dispose();
});
