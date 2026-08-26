import type * as NodeCrypto from "node:crypto";
import type {
	Api,
	EffectiveDispatchObservation,
	Model,
	ProviderRequestOptions,
} from "../types.ts";

type ProcessWithCryptoBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:crypto") => typeof NodeCrypto;
};

const UTF8_ENCODER = new TextEncoder();

function sha256Json(value: unknown): string | undefined {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return undefined;
	const crypto = (process as ProcessWithCryptoBuiltinModule).getBuiltinModule?.("node:crypto");
	if (!crypto) return undefined;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return undefined;
	return crypto.createHash("sha256").update(serialized).digest("hex");
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
	/** Provider-owned cache policy selected from the actual transformed wire request. */
	cachePolicy: unknown;
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
		const cachePolicyHash = sha256Json(input.cachePolicy);
		if (
			!instructionsHash ||
			instructionsBytes === undefined ||
			!toolsHash ||
			!toolOrderHash ||
			!toolIdentifierSetHash ||
			!cachePolicyHash
		) return;
		const cacheKeyHash = input.cacheKey === undefined ? undefined : sha256Json(input.cacheKey);
		const prefixTransformOutput = {
			instructionsHash,
			toolOrderHash,
			toolIdentifierSetHash,
			toolsHash,
			cacheKeyHash: cacheKeyHash ?? null,
			cachePolicyHash,
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
			cachePolicyHash,
			prefixHash,
			requestTransformOutputHash,
		});
	} catch {
		// Invalid transformed payloads cannot turn observational hashing into provider failure.
	}
}
