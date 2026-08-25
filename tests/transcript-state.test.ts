import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSnapshot, TranscriptItem } from "../packages/protocol/src/index.ts";
import {
	applyTranscriptProgress,
	createTranscriptState,
	selectTranscript,
} from "../packages/coding-agent/src/client/transcript.ts";

function assistant(id: string, text: string): TranscriptItem {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		model: { provider: "test", id: "model" },
		timestamp: 1767225600000,
		status: "streaming",
	};
}

function user(id: string, text: string): TranscriptItem {
	return {
		id,
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1767225600000,
	};
}

function snapshot(id: string, transcript: TranscriptItem[], queuedSteer: TranscriptItem[] = []): SessionSnapshot {
	return {
		id,
		cwd: "D:/workspace",
		createdAt: 1767225600000,
		updatedAt: 1767225600000,
		phase: "idle",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		attached: true,
		locked: false,
		revision: 1,
		transcript,
		queuedSteer: queuedSteer as never,
		queuedSteerCount: queuedSteer.length,
	};
}

test("transcript delta lookup updates the indexed snapshot item", () => {
	const state = createTranscriptState(snapshot("session-1", [assistant("message-1", "a")]));
	const next = applyTranscriptProgress(state, {
		type: "assistant_delta",
		messageId: "message-1",
		contentIndex: 0,
		kind: "text",
		delta: "b",
	});
	const item = selectTranscript(next)[0];
	assert.equal(item?.role, "assistant");
	assert.deepEqual(item?.content, [{ type: "text", text: "ab" }]);
});

test("transcript selection deduplicates items and clears pooled identifier sets", () => {
	const queued = user("queued-1", "queued");
	const first = createTranscriptState(snapshot("session-1", [user("base-1", "base")], [queued]));
	assert.deepEqual(selectTranscript(first).map((item) => item.id), ["base-1", "queued-1"]);
	assert.deepEqual(selectTranscript(first).map((item) => item.id), ["base-1", "queued-1"]);

	const second = createTranscriptState(snapshot("session-2", [], [queued]));
	assert.deepEqual(selectTranscript(second).map((item) => item.id), ["queued-1"]);
});
