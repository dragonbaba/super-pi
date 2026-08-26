import type {
	Api,
	EffectiveDispatchObservation,
	Model,
	ProviderRequestOptions,
} from "../types.ts";
import { sha256Utf8 } from "./sha256.ts";

const UTF8_ENCODER = new TextEncoder();

function sha256Json(value: unknown): string | undefined {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return undefined;
	return sha256Utf8(serialized);
}

function serializedBytes(value: unknown): number | undefined {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	return serialized === undefined ? undefined : UTF8_ENCODER.encode(serialized).byteLength;
}

export interface EffectiveDispatchHashInput {
	transport: "sse" | "websocket";
	previousResponseMode: EffectiveDispatchObservation["previousResponseMode"];
	instructionPrefix: unknown;
	orderedToolDefinitions: readonly unknown[];
	orderedToolIdentifiers: readonly string[];
	cacheKey?: unknown;
	/** Provider-owned retention/TTL selected from the actual transformed wire request. */
	cacheRetention: unknown;
	/** Provider-owned cache policy selected from the actual transformed wire request. */
	cachePolicy: unknown;
	/** Semantic cache breakpoint anchors selected from the actual transformed wire request. */
	cacheBoundary: unknown;
}

function normalizeJsonLike(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJsonLike);
	if (!value || typeof value !== "object") return value;
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		normalized[key] = normalizeJsonLike((value as Record<string, unknown>)[key]);
	}
	return normalized;
}

function uniqueNormalizedValues(values: readonly unknown[]): unknown[] {
	const unique = new Map<string, unknown>();
	for (const value of values) {
		const normalized = normalizeJsonLike(value);
		const serialized = JSON.stringify(normalized);
		if (serialized !== undefined) unique.set(serialized, normalized);
	}
	return [...unique.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([, value]) => value);
}

/** Split marker values into retention/TTL and all other policy fields without retaining positions. */
export function summarizeCacheMarkerMetadata(markers: readonly unknown[]): {
	retention: unknown;
	policy: unknown;
} {
	const retentionValues: unknown[] = [];
	const policyValues: unknown[] = [];
	for (const marker of markers) {
		if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
			retentionValues.push(null);
			policyValues.push(marker);
			continue;
		}
		const record = marker as Record<string, unknown>;
		retentionValues.push({
			retention: record.retention ?? null,
			ttl: record.ttl ?? null,
		});
		const policy: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			if (key !== "retention" && key !== "ttl") policy[key] = record[key];
		}
		policyValues.push(policy);
	}
	return {
		retention: { enabled: markers.length > 0, values: uniqueNormalizedValues(retentionValues) },
		policy: { enabled: markers.length > 0, values: uniqueNormalizedValues(policyValues) },
	};
}

/** Deliver metadata without allowing either synchronous throws or asynchronous rejections to escape. */
export function deliverEffectiveDispatchObservation<TApi extends Api>(
	options: ProviderRequestOptions<Model<TApi>> | undefined,
	model: Model<TApi>,
	observation: EffectiveDispatchObservation,
): void {
	try {
		const result = options?.onEffectiveDispatch?.(Object.freeze(observation), model);
		if (result && typeof result.then === "function") {
			void Promise.resolve(result).catch(() => undefined);
		}
	} catch {
		// Effective dispatch instrumentation is observational and cannot fail provider dispatch.
	}
}

/** Hash adapter-selected components from the exact transformed request selected for dispatch. */
export function observeEffectiveDispatch<TApi extends Api>(
	options: ProviderRequestOptions<Model<TApi>> | undefined,
	model: Model<TApi>,
	input: EffectiveDispatchHashInput,
): void {
	if (!options?.onEffectiveDispatch) return;
	try {
		const instructionsHash = sha256Json(input.instructionPrefix);
		const instructionsBytes = serializedBytes(input.instructionPrefix);
		const toolsHash = sha256Json(input.orderedToolDefinitions);
		const toolOrderHash = sha256Json(input.orderedToolIdentifiers);
		const toolIdentifierSetHash = sha256Json([...input.orderedToolIdentifiers].sort());
		const cacheRetentionHash = sha256Json(input.cacheRetention);
		const cachePolicyHash = sha256Json(input.cachePolicy);
		const cacheBoundaryHash = sha256Json(input.cacheBoundary);
		if (
			!instructionsHash ||
			instructionsBytes === undefined ||
			!toolsHash ||
			!toolOrderHash ||
			!toolIdentifierSetHash ||
			!cacheRetentionHash ||
			!cachePolicyHash ||
			!cacheBoundaryHash
		) return;
		const cacheKeyHash = input.cacheKey === undefined ? undefined : sha256Json(input.cacheKey);
		const prefixTransformOutput = {
			instructionsHash,
			toolOrderHash,
			toolIdentifierSetHash,
			toolsHash,
			cacheKeyHash: cacheKeyHash ?? null,
			cacheRetentionHash,
			cachePolicyHash,
			cacheBoundaryHash,
		};
		const requestTransformOutputHash = sha256Json(prefixTransformOutput);
		if (!requestTransformOutputHash) return;
		const prefixHash = requestTransformOutputHash;
		deliverEffectiveDispatchObservation(options, model, {
			transport: input.transport,
			previousResponseMode: input.previousResponseMode,
			instructionsHash,
			instructionsBytes,
			toolOrderHash,
			toolIdentifierSetHash,
			toolsHash,
			toolCount: input.orderedToolDefinitions.length,
			...(cacheKeyHash === undefined ? {} : { cacheKeyHash }),
			cacheRetentionHash,
			cachePolicyHash,
			cacheBoundaryHash,
			prefixHash,
			requestTransformOutputHash,
		});
	} catch {
		// Invalid transformed payloads cannot turn observational hashing into provider failure.
	}
}
