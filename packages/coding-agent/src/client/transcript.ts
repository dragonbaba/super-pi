import type { JsonValue, SessionSnapshot, TranscriptItem, TranscriptProgress } from "@super-pi/protocol";
import { ObjectPool } from "../utils/object-pool.ts";

const SNAPSHOT_ITEM_INDEX = new WeakMap<SessionSnapshot, ReadonlyMap<string, TranscriptItem>>();
const TRANSCRIPT_ID_SET_POOL = new ObjectPool(
	() => new Set<string>(),
	(value) => value.clear(),
	4,
	(value) => value.size <= 4096,
);

export interface TranscriptState {
	readonly snapshot: SessionSnapshot;
	readonly progressItems: ReadonlyMap<string, TranscriptItem>;
	readonly progressOrder: readonly string[];
	readonly toolCallBuffers: ReadonlyMap<string, string>;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (!isJsonValue(item)) return false;
		}
		return true;
	}
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	for (const key of Object.keys(value)) {
		if (!isJsonValue((value as Record<string, unknown>)[key])) return false;
	}
	return true;
}

function getSnapshotItem(snapshot: SessionSnapshot, id: string): TranscriptItem | undefined {
	let index = SNAPSHOT_ITEM_INDEX.get(snapshot);
	if (!index) {
		const next = new Map<string, TranscriptItem>();
		for (const item of snapshot.transcript) next.set(item.id, item);
		SNAPSHOT_ITEM_INDEX.set(snapshot, next);
		index = next;
	}
	return index.get(id);
}

function parsePartialToolInput(value: string): JsonValue {
	try {
		const parsed: unknown = JSON.parse(value);
		if (isJsonValue(parsed)) return parsed;
	} catch {
		// Tool arguments are incomplete while streaming. Preserve their raw prefix until they form valid JSON.
	}
	return value;
}

export function createTranscriptState(snapshot: SessionSnapshot): TranscriptState {
	return {
		snapshot: structuredClone(snapshot),
		progressItems: new Map(),
		progressOrder: [],
		toolCallBuffers: new Map(),
	};
}

export function applyTranscriptSnapshot(state: TranscriptState, snapshot: SessionSnapshot): TranscriptState {
	if (state.snapshot.id === snapshot.id && snapshot.revision < state.snapshot.revision) return state;
	return createTranscriptState(snapshot);
}

export function applyTranscriptProgress(state: TranscriptState, progress: TranscriptProgress): TranscriptState {
	if (progress.type === "item_started" || progress.type === "item_updated") {
		return setProgressItem(state, progress.item);
	}
	if (progress.type === "item_finished") {
		const toolCallBuffers = new Map(state.toolCallBuffers);
		for (const key of toolCallBuffers.keys()) {
			if (key.startsWith(`${progress.item.id}:`)) toolCallBuffers.delete(key);
		}
		return setProgressItem({ ...state, toolCallBuffers }, progress.item);
	}

	const item =
		state.progressItems.get(progress.messageId) ??
		getSnapshotItem(state.snapshot, progress.messageId);
	if (!item || item.role !== "assistant") return state;
	let toolCallBuffers = state.toolCallBuffers;
	const content = new Array<(typeof item.content)[number]>(item.content.length);
	for (let index = 0; index < item.content.length; index++) {
		const part = item.content[index]!;
		if (index !== progress.contentIndex) {
			content[index] = structuredClone(part);
			continue;
		}
		if (progress.kind === "text" && part.type === "text") {
			content[index] = { ...part, text: part.text + progress.delta };
			continue;
		}
		if (progress.kind === "thinking" && part.type === "thinking") {
			content[index] = { ...part, thinking: part.thinking + progress.delta };
			continue;
		}
		if (progress.kind === "toolCall" && part.type === "toolCall") {
			const key = `${progress.messageId}:${progress.contentIndex}`;
			const existing = state.toolCallBuffers.get(key) ?? (typeof part.input === "string" ? part.input : "");
			const buffer = existing + progress.delta;
			toolCallBuffers = new Map(state.toolCallBuffers).set(key, buffer);
			content[index] = { ...part, input: parsePartialToolInput(buffer) };
			continue;
		}
		content[index] = structuredClone(part);
	}
	return setProgressItem({ ...state, toolCallBuffers }, { ...item, content });
}

export function selectTranscript(state: TranscriptState): readonly TranscriptItem[] {
	const transcript = new Array<TranscriptItem>(state.snapshot.transcript.length);
	const ids = TRANSCRIPT_ID_SET_POOL.acquire();
	try {
		for (let index = 0; index < state.snapshot.transcript.length; index++) {
			const snapshotItem = state.snapshot.transcript[index]!;
			const item = state.progressItems.get(snapshotItem.id) ?? snapshotItem;
			transcript[index] = item;
			ids.add(item.id);
		}
		for (const id of state.progressOrder) {
			if (ids.has(id)) continue;
			const item = state.progressItems.get(id);
			if (item) {
				transcript.push(item);
				ids.add(id);
			}
		}
		for (const item of state.snapshot.queuedSteer) {
			if (ids.has(item.id)) continue;
			transcript.push(item);
			ids.add(item.id);
		}
	} finally {
		TRANSCRIPT_ID_SET_POOL.release(ids);
	}
	return transcript;
}

function setProgressItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
	const progressItems = new Map(state.progressItems);
	const progressOrder = progressItems.has(item.id) ? state.progressOrder : [...state.progressOrder, item.id];
	progressItems.set(item.id, structuredClone(item));
	return { ...state, progressItems, progressOrder };
}
