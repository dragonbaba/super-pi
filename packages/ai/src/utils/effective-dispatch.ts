import type * as NodeCrypto from "node:crypto";
import type { Api, Model, ProviderRequestOptions } from "../types.ts";

type ProcessWithCryptoBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:crypto") => typeof NodeCrypto;
};

function sha256Json(value: unknown): string | undefined {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return undefined;
	const crypto = (process as ProcessWithCryptoBuiltinModule).getBuiltinModule?.("node:crypto");
	if (!crypto) return undefined;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return undefined;
	return crypto.createHash("sha256").update(serialized).digest("hex");
}

function payloadField(payload: unknown, names: readonly string[]): unknown {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	for (const name of names) {
		if (record[name] !== undefined) return record[name];
	}
	return undefined;
}

function toolIdentifiers(tools: unknown): string[] {
	const entries = Array.isArray(tools) ? tools : tools === undefined ? [] : [tools];
	return entries.map((tool) => {
		if (!tool || typeof tool !== "object") return typeof tool;
		const record = tool as Record<string, unknown>;
		for (const key of ["name", "type"]) {
			if (typeof record[key] === "string") return record[key];
		}
		const functionDefinition = record.function;
		if (functionDefinition && typeof functionDefinition === "object") {
			const name = (functionDefinition as Record<string, unknown>).name;
			if (typeof name === "string") return name;
		}
		return "unknown";
	});
}

/** Observe a transformed JSON provider payload immediately before its SSE dispatch. */
export function observeEffectiveSseDispatch<TApi extends Api>(
	options: ProviderRequestOptions<Model<TApi>> | undefined,
	model: Model<TApi>,
	payload: unknown,
): void {
	if (!options?.onEffectiveDispatch) return;
	try {
		const instructions = payloadField(payload, [
			"instructions",
			"system",
			"systemInstruction",
			"system_instruction",
			"systemPrompt",
			"system_prompt",
		]) ?? null;
		const tools = payloadField(payload, ["tools", "toolConfig", "tool_config"]);
		const cacheKey = payloadField(payload, ["prompt_cache_key", "cache_key", "sessionId"]);
		const previousResponse = payloadField(payload, ["previous_response_id"]);
		const instructionsHash = sha256Json(instructions);
		const toolsHash = sha256Json(tools ?? []);
		const toolOrderHash = sha256Json(toolIdentifiers(tools));
		const requestTransformOutputHash = sha256Json(payload);
		if (!instructionsHash || !toolsHash || !toolOrderHash || !requestTransformOutputHash) return;
		const cacheKeyHash = cacheKey === undefined ? undefined : sha256Json(cacheKey);
		const prefixHash = sha256Json({
			instructionsHash,
			toolsHash,
			cacheKeyHash: cacheKeyHash ?? null,
		});
		if (!prefixHash) return;
		const serializedInstructions = typeof instructions === "string" ? instructions : JSON.stringify(instructions);
		options.onEffectiveDispatch(Object.freeze({
			transport: "sse",
			previousResponseMode: previousResponse === undefined ? "none" : "response-id",
			instructionsHash,
			instructionsBytes: new TextEncoder().encode(serializedInstructions).byteLength,
			toolOrderHash,
			toolsHash,
			toolCount: Array.isArray(tools) ? tools.length : tools === undefined ? 0 : 1,
			...(cacheKeyHash === undefined ? {} : { cacheKeyHash }),
			prefixHash,
			requestTransformOutputHash,
		}), model);
	} catch {
		// Effective dispatch instrumentation is observational and cannot fail provider dispatch.
	}
}
