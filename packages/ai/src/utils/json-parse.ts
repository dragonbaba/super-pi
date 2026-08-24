import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const MAX_TOOL_ARGUMENT_CACHE_HEAP_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CACHE_ENTRY_HEAP_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CACHE_ENTRIES = 4096;
const stableToolArgumentGraphs = new WeakSet<object>();
const incompleteToolArgumentGraphs = new WeakSet<object>();
const toolArgumentJsonCache = new WeakMap<object, string>();
let retainedToolArgumentCacheBytes = 0;
let retainedToolArgumentCacheEntries = 0;

interface ToolArgumentCacheEntry {
	bytes: number;
}

function releaseToolArgumentCacheEntry(entry: ToolArgumentCacheEntry): void {
	retainedToolArgumentCacheBytes = Math.max(0, retainedToolArgumentCacheBytes - entry.bytes);
	retainedToolArgumentCacheEntries = Math.max(0, retainedToolArgumentCacheEntries - 1);
}

const toolArgumentCacheRegistry = new FinalizationRegistry<ToolArgumentCacheEntry>(releaseToolArgumentCacheEntry);

/** Deep-freeze a finalized JSON-compatible tool argument graph. */
export function stabilizeToolArguments<T>(value: T): T {
	if (!value || typeof value !== "object") return value;
	const pending: object[] = [value];
	const visited = new WeakSet<object>();
	let stableJsonGraph = true;
	try {
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			const prototype = Object.getPrototypeOf(current);
			if (
				(prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) ||
				"toJSON" in current
			) {
				stableJsonGraph = false;
			}
			const descriptors = Object.getOwnPropertyDescriptors(current);
			for (const key of Object.keys(current)) {
				const descriptor = descriptors[key];
				if (!("value" in descriptor)) {
					stableJsonGraph = false;
					continue;
				}
				const child = descriptor.value;
				if (child && typeof child === "object") pending.push(child);
			}
			Object.freeze(current);
		}
	} catch {
		return value;
	}
	if (stableJsonGraph) stableToolArgumentGraphs.add(value);
	return value;
}

/** Serialize deeply frozen tool arguments through a bounded weak identity cache. */
export function stringifyToolArguments(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return JSON.stringify(value);
	const cached = toolArgumentJsonCache.get(value);
	if (cached !== undefined) return cached;
	if (!stableToolArgumentGraphs.has(value)) return JSON.stringify(value);
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return serialized;
	const estimatedHeapBytes = serialized.length * 2;
	if (
		estimatedHeapBytes <= MAX_TOOL_ARGUMENT_CACHE_ENTRY_HEAP_BYTES &&
		retainedToolArgumentCacheEntries < MAX_TOOL_ARGUMENT_CACHE_ENTRIES &&
		retainedToolArgumentCacheBytes + estimatedHeapBytes <= MAX_TOOL_ARGUMENT_CACHE_HEAP_BYTES
	) {
		toolArgumentJsonCache.set(value, serialized);
		retainedToolArgumentCacheBytes += estimatedHeapBytes;
		retainedToolArgumentCacheEntries++;
		toolArgumentCacheRegistry.register(value, { bytes: estimatedHeapBytes });
	}
	return serialized;
}

/** Read-only diagnostics for the bounded tool-argument JSON cache. */
export function getToolArgumentJsonCacheStats(): Readonly<{
	entries: number;
	estimatedHeapBytes: number;
	maxEntries: number;
	maxEstimatedHeapBytes: number;
	maxEntryEstimatedHeapBytes: number;
}> {
	return Object.freeze({
		entries: retainedToolArgumentCacheEntries,
		estimatedHeapBytes: retainedToolArgumentCacheBytes,
		maxEntries: MAX_TOOL_ARGUMENT_CACHE_ENTRIES,
		maxEstimatedHeapBytes: MAX_TOOL_ARGUMENT_CACHE_HEAP_BYTES,
		maxEntryEstimatedHeapBytes: MAX_TOOL_ARGUMENT_CACHE_ENTRY_HEAP_BYTES,
	});
}

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
function markIncompleteToolArguments<T>(value: T): T {
	if (value && typeof value === "object") incompleteToolArgumentGraphs.add(value);
	return value;
}

/** True only for argument objects produced by incomplete streaming JSON salvage. */
export function hasIncompleteToolArguments(value: unknown): boolean {
	return !!value && typeof value === "object" && incompleteToolArgumentGraphs.has(value);
}

export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return markIncompleteToolArguments({} as T);
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return markIncompleteToolArguments((result ?? {}) as T);
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return markIncompleteToolArguments((result ?? {}) as T);
			} catch {
				return markIncompleteToolArguments({} as T);
			}
		}
	}
}
