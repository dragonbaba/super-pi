import { createHash, type Hash } from "node:crypto";

export type PreviousResponseMode = "none" | "response-id" | "websocket";

export interface PrefixManifestV1 {
	schemaVersion: 1;
	provider: string;
	model: string;
	api: string;
	transport: string;
	cacheRetention?: string;
	systemPromptHash: string;
	systemPromptBytes: number;
	toolOrderHash: string;
	toolSchemaHash: string;
	toolCount: number;
	persistentContextHash: string;
	dynamicInstructionGeneration: number;
	dynamicInstructionHash: string;
	requestTransformChainHash: string;
	compactionGeneration: number;
	compactionArtifactHash?: string;
	cacheKeyHash?: string;
	previousResponseMode: PreviousResponseMode;
}

export interface PrefixManifestToolInput {
	name: string;
	schema: unknown;
}

export interface PrefixManifestContextInput {
	identifier: string;
	content: string;
	/** Entries with the same precedence are unordered siblings and are canonically sorted. */
	precedence: number;
}

export interface PrefixManifestBuildInput {
	provider: string;
	model: string;
	api: string;
	transport: string;
	cacheRetention?: string;
	systemPrompt: string;
	/** Tool order is semantic and is never sorted. */
	tools: readonly PrefixManifestToolInput[];
	/** Precedence is semantic; only sibling identifiers within a precedence are sorted. */
	persistentContext?: readonly PrefixManifestContextInput[];
	dynamicInstructionGeneration?: number;
	dynamicInstructions?: string;
	/** Transform order is semantic and is never sorted. */
	requestTransformChain?: readonly string[];
	compactionGeneration?: number;
	compactionArtifact?: unknown;
	cacheKey?: string;
	previousResponseMode: PreviousResponseMode;
}

export type PrefixManifestSegment =
	| "model"
	| "transport"
	| "system-prompt"
	| "tool-order"
	| "tool-schema"
	| "persistent-context"
	| "dynamic-instructions"
	| "request-transform-chain"
	| "compaction"
	| "cache-key";

export type PrefixDriftReasonCode =
	| "MODEL_CHANGED"
	| "TOOL_ACTIVATED"
	| "TOOL_SCHEMA_CHANGED"
	| "PROJECT_CONTEXT_CHANGED"
	| "DYNAMIC_INSTRUCTION_CHANGED"
	| "COMPACTION_BOUNDARY"
	| "TRANSPORT_CHANGED"
	| "CACHE_KEY_CHANGED"
	| "UNKNOWN_PREFIX_DRIFT";

export interface PrefixDriftDiagnostic {
	firstDivergentSegment: PrefixManifestSegment;
	oldGeneration: number;
	newGeneration: number;
	expectedMiss: boolean;
	reasonCode: PrefixDriftReasonCode;
	changedIdentifiers: string[];
}

interface SegmentMetadata {
	toolOrder: string[];
	toolSchemas: Map<string, string>;
	persistentContext: Map<string, string>;
	requestTransforms: string[];
}

const SEGMENT_METADATA = new WeakMap<PrefixManifestV1, SegmentMetadata>();

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function compareCanonicalIdentifiers(left: string, right: string): number {
	return compareCodeUnits(left.normalize("NFC"), right.normalize("NFC"));
}

export function canonicalizeLogicalPath(
	value: string,
	options: { root?: string; caseInsensitive?: boolean } = {},
): string {
	const normalize = (input: string): string => {
		const replaced = input.normalize("NFC").replaceAll("\\", "/");
		const prefix = replaced.startsWith("/") ? "/" : "";
		const parts: string[] = [];
		for (const part of replaced.split("/")) {
			if (!part || part === ".") continue;
			if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
			else if (part !== ".." || !prefix) parts.push(part);
		}
		return `${prefix}${parts.join("/")}` || ".";
	};
	// Default to case-preserving logical identities so the same repository hash
	// is stable across operating systems. Callers may opt into a case-insensitive
	// comparison for host-local path equivalence checks.
	const caseInsensitive = options.caseInsensitive ?? false;
	let canonical = normalize(value);
	if (options.root) {
		const root = normalize(options.root).replace(/\/$/, "");
		const comparablePath = caseInsensitive ? canonical.toLowerCase() : canonical;
		const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
		if (comparablePath === comparableRoot) canonical = ".";
		else if (comparablePath.startsWith(`${comparableRoot}/`)) canonical = canonical.slice(root.length + 1);
	}
	return caseInsensitive ? canonical.toLowerCase() : canonical;
}

function normalizeText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function assertGeneration(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
	return value;
}

function updateCanonicalHash(hash: Hash, value: unknown, seen: Set<object>): void {
	if (value === null) {
		hash.update("null");
		return;
	}
	switch (typeof value) {
		case "string":
			hash.update(JSON.stringify(value));
			return;
		case "number":
			hash.update(Number.isFinite(value) ? JSON.stringify(value) : "null");
			return;
		case "boolean":
			hash.update(value ? "true" : "false");
			return;
		case "undefined":
			hash.update("null");
			return;
		case "bigint":
		case "function":
		case "symbol":
			throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
	}
	if (seen.has(value)) throw new TypeError("Cannot hash a cyclic canonical value");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			hash.update("[");
			for (let index = 0; index < value.length; index++) {
				if (index > 0) hash.update(",");
				updateCanonicalHash(hash, value[index], seen);
			}
			hash.update("]");
			return;
		}
		const object = value as Record<string, unknown>;
		const keys = Object.keys(object)
			.filter((key) => object[key] !== undefined)
			.sort(compareCanonicalIdentifiers);
		hash.update("{");
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index]!;
			if (index > 0) hash.update(",");
			hash.update(JSON.stringify(key));
			hash.update(":");
			updateCanonicalHash(hash, object[key], seen);
		}
		hash.update("}");
	} finally {
		seen.delete(value);
	}
}

export function sha256Canonical(value: unknown): string {
	const hash = createHash("sha256");
	updateCanonicalHash(hash, value, new Set());
	return hash.digest("hex");
}

function hashText(value: string): string {
	return createHash("sha256").update(normalizeText(value)).digest("hex");
}

function symmetricDifference(previous: readonly string[], current: readonly string[]): string[] {
	const previousSet = new Set(previous);
	const currentSet = new Set(current);
	const changed = current.filter((identifier) => !previousSet.has(identifier));
	for (const identifier of previous) if (!currentSet.has(identifier)) changed.push(identifier);
	return changed;
}

function changedMapKeys(previous: Map<string, string> | undefined, current: Map<string, string> | undefined): string[] {
	if (!previous || !current) return [];
	const keys = new Set([...previous.keys(), ...current.keys()]);
	return [...keys].filter((key) => previous.get(key) !== current.get(key)).sort(compareCanonicalIdentifiers);
}

export function buildPrefixManifest(input: PrefixManifestBuildInput): PrefixManifestV1 {
	const normalizedPrompt = normalizeText(input.systemPrompt);
	const toolOrder = input.tools.map((tool) => tool.name.normalize("NFC"));
	const toolSchemas = new Map<string, string>();
	for (const tool of input.tools) toolSchemas.set(tool.name, sha256Canonical(tool.schema));
	const contextEntries = [...(input.persistentContext ?? [])]
		.map((entry) => ({
			identifier: canonicalizeLogicalPath(entry.identifier),
			content: normalizeText(entry.content),
			precedence: assertGeneration("persistentContext.precedence", entry.precedence),
		}))
		.sort((left, right) => left.precedence - right.precedence || compareCanonicalIdentifiers(left.identifier, right.identifier));
	const persistentContext = new Map<string, string>();
	for (const entry of contextEntries) persistentContext.set(entry.identifier, hashText(entry.content));
	const requestTransforms = (input.requestTransformChain ?? []).map((identifier) =>
		canonicalizeLogicalPath(identifier),
	);
	const dynamicInstructionGeneration = assertGeneration(
		"dynamicInstructionGeneration",
		input.dynamicInstructionGeneration ?? 0,
	);
	const compactionGeneration = assertGeneration("compactionGeneration", input.compactionGeneration ?? 0);

	const manifest: PrefixManifestV1 = {
		schemaVersion: 1,
		provider: input.provider,
		model: input.model,
		api: input.api,
		transport: input.transport,
		...(input.cacheRetention === undefined ? {} : { cacheRetention: input.cacheRetention }),
		systemPromptHash: hashText(normalizedPrompt),
		systemPromptBytes: Buffer.byteLength(normalizedPrompt),
		toolOrderHash: sha256Canonical(toolOrder),
		toolSchemaHash: sha256Canonical(input.tools.map((tool) => ({ name: tool.name, schema: tool.schema }))),
		toolCount: input.tools.length,
		persistentContextHash: sha256Canonical(contextEntries),
		dynamicInstructionGeneration,
		dynamicInstructionHash: hashText(input.dynamicInstructions ?? ""),
		requestTransformChainHash: sha256Canonical(requestTransforms),
		compactionGeneration,
		...(input.compactionArtifact === undefined
			? {}
			: { compactionArtifactHash: sha256Canonical(input.compactionArtifact) }),
		...(input.cacheKey === undefined ? {} : { cacheKeyHash: hashText(input.cacheKey) }),
		previousResponseMode: input.previousResponseMode,
	};
	SEGMENT_METADATA.set(manifest, { toolOrder, toolSchemas, persistentContext, requestTransforms });
	return Object.freeze(manifest);
}

export function serializePrefixManifest(manifest: PrefixManifestV1): string {
	const keys = Object.keys(manifest).sort(compareCanonicalIdentifiers);
	return `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(manifest[key as keyof PrefixManifestV1])}`).join(",")}}`;
}

function diagnostic(
	previous: PrefixManifestV1,
	current: PrefixManifestV1,
	segment: PrefixManifestSegment,
	reasonCode: PrefixDriftReasonCode,
	expectedMiss: boolean,
	changedIdentifiers: string[] = [],
): PrefixDriftDiagnostic {
	const useDynamicGeneration = segment === "dynamic-instructions";
	return {
		firstDivergentSegment: segment,
		oldGeneration: useDynamicGeneration ? previous.dynamicInstructionGeneration : previous.compactionGeneration,
		newGeneration: useDynamicGeneration ? current.dynamicInstructionGeneration : current.compactionGeneration,
		expectedMiss,
		reasonCode,
		changedIdentifiers,
	};
}

export function comparePrefixManifests(
	previous: PrefixManifestV1,
	current: PrefixManifestV1,
): PrefixDriftDiagnostic | undefined {
	const previousMetadata = SEGMENT_METADATA.get(previous);
	const currentMetadata = SEGMENT_METADATA.get(current);
	if (previous.provider !== current.provider || previous.model !== current.model || previous.api !== current.api) {
		return diagnostic(previous, current, "model", "MODEL_CHANGED", true);
	}
	if (previous.transport !== current.transport || previous.cacheRetention !== current.cacheRetention) {
		return diagnostic(previous, current, "transport", "TRANSPORT_CHANGED", true);
	}
	if (previous.systemPromptHash !== current.systemPromptHash || previous.systemPromptBytes !== current.systemPromptBytes) {
		return diagnostic(previous, current, "system-prompt", "UNKNOWN_PREFIX_DRIFT", false);
	}
	if (previous.toolOrderHash !== current.toolOrderHash || previous.toolCount !== current.toolCount) {
		const changedIdentifiers = symmetricDifference(
			previousMetadata?.toolOrder ?? [],
			currentMetadata?.toolOrder ?? [],
		);
		return diagnostic(
			previous,
			current,
			"tool-order",
			changedIdentifiers.length > 0 ? "TOOL_ACTIVATED" : "UNKNOWN_PREFIX_DRIFT",
			changedIdentifiers.length > 0,
			changedIdentifiers,
		);
	}
	if (previous.toolSchemaHash !== current.toolSchemaHash) {
		return diagnostic(
			previous,
			current,
			"tool-schema",
			"TOOL_SCHEMA_CHANGED",
			true,
			changedMapKeys(previousMetadata?.toolSchemas, currentMetadata?.toolSchemas),
		);
	}
	if (previous.persistentContextHash !== current.persistentContextHash) {
		return diagnostic(
			previous,
			current,
			"persistent-context",
			"PROJECT_CONTEXT_CHANGED",
			true,
			changedMapKeys(previousMetadata?.persistentContext, currentMetadata?.persistentContext),
		);
	}
	if (
		previous.dynamicInstructionGeneration !== current.dynamicInstructionGeneration ||
		previous.dynamicInstructionHash !== current.dynamicInstructionHash
	) {
		return diagnostic(previous, current, "dynamic-instructions", "DYNAMIC_INSTRUCTION_CHANGED", true);
	}
	if (previous.requestTransformChainHash !== current.requestTransformChainHash) {
		return diagnostic(
			previous,
			current,
			"request-transform-chain",
			"UNKNOWN_PREFIX_DRIFT",
			false,
			symmetricDifference(previousMetadata?.requestTransforms ?? [], currentMetadata?.requestTransforms ?? []),
		);
	}
	if (
		previous.compactionGeneration !== current.compactionGeneration ||
		previous.compactionArtifactHash !== current.compactionArtifactHash
	) {
		return diagnostic(previous, current, "compaction", "COMPACTION_BOUNDARY", true);
	}
	if (previous.cacheKeyHash !== current.cacheKeyHash || previous.previousResponseMode !== current.previousResponseMode) {
		return diagnostic(previous, current, "cache-key", "CACHE_KEY_CHANGED", true);
	}
	return undefined;
}

export class PrefixManifestRecorder {
	private previous: PrefixManifestV1 | undefined;
	private latestDiagnostic: PrefixDriftDiagnostic | undefined;

	record(manifest: PrefixManifestV1): PrefixDriftDiagnostic | undefined {
		this.latestDiagnostic = this.previous ? comparePrefixManifests(this.previous, manifest) : undefined;
		this.previous = manifest;
		return this.latestDiagnostic;
	}

	get current(): PrefixManifestV1 | undefined {
		return this.previous;
	}

	get diagnostic(): PrefixDriftDiagnostic | undefined {
		return this.latestDiagnostic;
	}
}
