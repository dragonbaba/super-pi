export const TOOL_INPUT_REPAIRS = Symbol.for("pi.toolInputRepairs");

const MAX_REPAIRS_PER_CALL = 8;
const MAX_REPAIR_KIND_CHARS = 64;
const MAX_MODEL_CHARS = 256;
const MAX_TOOL_CHARS = 128;
const DEFAULT_MAX_ENTRIES = 256;
const VALIDATION_ERROR_PREFIX = "Validation failed for tool \"";
const KEY_SEPARATOR = "\u0000";
const EMPTY_REPAIR_KINDS: readonly string[] = Object.freeze([]);

export interface RepairStat {
	model: string;
	tool: string;
	kind: string;
	count: number;
	lastAt: number;
}

function boundedLabel(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export class ToolRepairTelemetry {
	readonly #entries = new Map<string, RepairStat>();
	readonly #maxEntries: number;
	#overflow = 0;

	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		this.#maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
	}

	record(model: string, tool: string, kind: string, now = Date.now()): void {
		const boundedModel = boundedLabel(model, MAX_MODEL_CHARS);
		const boundedTool = boundedLabel(tool, MAX_TOOL_CHARS);
		const boundedKind = boundedLabel(kind, MAX_REPAIR_KIND_CHARS);
		const key = `${boundedModel}${KEY_SEPARATOR}${boundedTool}${KEY_SEPARATOR}${boundedKind}`;
		const existing = this.#entries.get(key);
		if (existing) {
			existing.count++;
			existing.lastAt = now;
			return;
		}
		if (this.#entries.size >= this.#maxEntries) {
			this.#overflow++;
			return;
		}
		this.#entries.set(key, { model: boundedModel, tool: boundedTool, kind: boundedKind, count: 1, lastAt: now });
	}

	snapshot(): { entries: RepairStat[]; overflow: number } {
		return {
			entries: [...this.#entries.values()].map((entry) => ({ ...entry })),
			overflow: this.#overflow,
		};
	}

	reset(): void {
		this.#entries.clear();
		this.#overflow = 0;
	}
}

export function extractRepairKinds(input: unknown): readonly string[] {
	if (!input || typeof input !== "object") return EMPTY_REPAIR_KINDS;
	const value = (input as Record<PropertyKey, unknown>)[TOOL_INPUT_REPAIRS];
	if (!Array.isArray(value)) return EMPTY_REPAIR_KINDS;
	let kinds: string[] | undefined;
	const limit = Math.min(value.length, MAX_REPAIRS_PER_CALL);
	for (let index = 0; index < limit; index++) {
		const item = value[index];
		if (typeof item === "string" && item.length > 0 && item.length <= MAX_REPAIR_KIND_CHARS) {
			(kinds ??= []).push(item);
		}
	}
	return kinds ?? EMPTY_REPAIR_KINDS;
}

export function isValidationFailure(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.startsWith(VALIDATION_ERROR_PREFIX)) return true;
	}
	return false;
}

export function formatRepairStats(snapshot: { entries: RepairStat[]; overflow: number }, limit = 20): string {
	if (snapshot.entries.length === 0 && snapshot.overflow === 0) return "Tool input repairs: no repairs or validation failures recorded.";
	const sorted = [...snapshot.entries].sort((left, right) => right.count - left.count || right.lastAt - left.lastAt);
	const lines = sorted.slice(0, Math.max(1, limit)).map((entry) => `${entry.count}× ${entry.model} · ${entry.tool} · ${entry.kind}`);
	if (sorted.length > lines.length) lines.push(`… ${sorted.length - lines.length} more entries`);
	if (snapshot.overflow > 0) lines.push(`… ${snapshot.overflow} events omitted after the bounded telemetry table filled`);
	return `Tool input repair telemetry:\n${lines.join("\n")}`;
}
