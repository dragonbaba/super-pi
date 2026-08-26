import { createHash, type Hash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PreviousResponseMode = "none" | "response-id" | "websocket";
export type PrefixObservationState = "observed" | "unavailable";

export interface PrefixManifestV1 {
	schemaVersion: 1;
	provider: string;
	model: string;
	api: string;
	transport: string;
	cacheRetention?: string;
	cacheRetentionHash: string;
	cachePolicyHash: string;
	cacheBoundaryHash: string;
	systemPromptHash: string;
	systemPromptBytes: number;
	toolOrderHash: string;
	toolIdentifierSetHash: string;
	toolSchemaHash: string;
	toolCount: number;
	persistentContextHash: string;
	dynamicInstructionObservationState: PrefixObservationState;
	dynamicInstructionGeneration?: number;
	dynamicInstructionHash?: string;
	requestTransformChainHash: string;
	requestTransformOutputHash: string;
	effectivePrefixHash: string;
	compactionObservationState: PrefixObservationState;
	compactionGeneration?: number;
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

export interface EffectivePrefixDispatchObservation {
	transport: string;
	previousResponseMode: PreviousResponseMode;
	instructionsHash: string;
	instructionsBytes: number;
	toolOrderHash: string;
	toolIdentifierSetHash: string;
	toolsHash: string;
	toolCount: number;
	cacheKeyHash?: string;
	cacheRetentionHash: string;
	cachePolicyHash: string;
	cacheBoundaryHash: string;
	prefixHash: string;
	requestTransformOutputHash: string;
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
	/** Provider-owned metadata captured from the request that was actually dispatched. */
	effectiveDispatch?: EffectivePrefixDispatchObservation;
}

export type PrefixManifestSegment =
	| "model"
	| "transport"
	| "cache-policy"
	| "cache-retention"
	| "cache-boundary"
	| "system-prompt"
	| "tool-order"
	| "tool-schema"
	| "persistent-context"
	| "dynamic-instructions"
	| "request-transform-chain"
	| "compaction"
	| "cache-key"
	| "previous-response";

export type PrefixDriftReasonCode =
	| "MODEL_CHANGED"
	| "TOOL_ACTIVATED"
	| "TOOL_SCHEMA_CHANGED"
	| "TOOL_ORDER_CHANGED"
	| "PROJECT_CONTEXT_CHANGED"
	| "DYNAMIC_INSTRUCTION_CHANGED"
	| "COMPACTION_BOUNDARY"
	| "TRANSPORT_CHANGED"
	| "CACHE_POLICY_CHANGED"
	| "CACHE_RETENTION_CHANGED"
	| "CACHE_BOUNDARY_CHANGED"
	| "CACHE_KEY_CHANGED"
	| "PREVIOUS_RESPONSE_MODE_CHANGED"
	| "UNKNOWN_PREFIX_DRIFT";

export interface PrefixDriftDiagnostic {
	firstDivergentSegment: PrefixManifestSegment;
	oldGeneration?: number;
	newGeneration?: number;
	expectedMiss: boolean;
	reasonCode: PrefixDriftReasonCode;
	changedIdentifiers: string[];
}

interface SegmentMetadata {
	observationKind: "intent" | "effective";
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
	const canonical = compareCodeUnits(left.normalize("NFC"), right.normalize("NFC"));
	return canonical || compareCodeUnits(left, right);
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

function hashIdentifier(value: string): string {
	return createHash("sha256").update(canonicalizeLogicalPath(value)).digest("hex");
}

function scopedRelativeSuffix(root: string, value: string): string | undefined {
	const relation = relative(resolve(root), resolve(value));
	if (relation === "") return ".";
	if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) return undefined;
	const suffix = canonicalizeLogicalPath(relation);
	if (
		ABSOLUTE_LOGICAL_PATH_PATTERN.test(suffix) ||
		suffix === ".." ||
		suffix.startsWith("../")
	) return undefined;
	return suffix;
}

export function createScopedContextIdentifier(
	value: string,
	options: { workspaceRoot: string; globalRoot?: string },
): string {
	const resolved = resolve(value);
	const workspaceSuffix = scopedRelativeSuffix(options.workspaceRoot, resolved);
	if (workspaceSuffix !== undefined) {
		return `workspace:${workspaceSuffix}`;
	}
	const globalSuffix = options.globalRoot === undefined
		? undefined
		: scopedRelativeSuffix(options.globalRoot, resolved);
	if (globalSuffix !== undefined) {
		return `global-context:${globalSuffix}`;
	}
	if (scopedRelativeSuffix(dirname(resolved), options.workspaceRoot) !== undefined) {
		return `ancestor-context:${hashIdentifier(resolved)}`;
	}
	return `external-context:${hashIdentifier(resolved)}`;
}

export function createScopedExtensionIdentifier(
	extension: {
		path: string;
		resolvedPath: string;
		sourceInfo: { source: string; scope: string; origin: string; baseDir?: string };
	},
	workspaceRoot: string,
): string {
	if (extension.path.startsWith("<")) {
		return `synthetic-extension:${hashIdentifier(extension.path)}`;
	}
	if (extension.sourceInfo.origin === "package") {
		const packageEntry = extension.sourceInfo.baseDir
			? scopedRelativeSuffix(extension.sourceInfo.baseDir, extension.resolvedPath)
			: undefined;
		return `package-extension:${extension.sourceInfo.scope}:${sha256Canonical({
			source: extension.sourceInfo.source,
			entry: packageEntry ?? hashIdentifier(extension.resolvedPath),
		})}`;
	}
	const workspaceSuffix = scopedRelativeSuffix(workspaceRoot, extension.resolvedPath);
	if (workspaceSuffix !== undefined) {
		return `workspace-extension:${workspaceSuffix}`;
	}
	if (extension.sourceInfo.scope === "user") {
		const globalEntry = extension.sourceInfo.baseDir
			? scopedRelativeSuffix(extension.sourceInfo.baseDir, extension.resolvedPath)
			: undefined;
		return `global-extension:${sha256Canonical({
			source: extension.sourceInfo.source,
			entry: globalEntry ?? hashIdentifier(extension.resolvedPath),
		})}`;
	}
	return `external-extension:${hashIdentifier(extension.resolvedPath)}`;
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
			if (!Number.isFinite(value)) throw new TypeError("Unsupported canonical number: expected a finite value");
			hash.update(JSON.stringify(value));
			return;
		case "boolean":
			hash.update(value ? "true" : "false");
			return;
		case "undefined":
			throw new TypeError("Unsupported canonical value type: undefined");
		case "bigint":
		case "function":
		case "symbol":
			throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
	}
	if (seen.has(value)) throw new TypeError("Cannot hash a cyclic canonical value");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				throw new TypeError("Unsupported canonical object: arrays must use Array.prototype");
			}
			const enumerableKeys = Object.keys(value);
			if (
				enumerableKeys.length !== value.length ||
				enumerableKeys.some((key, index) => key !== String(index))
			) {
				throw new TypeError("Unsupported canonical object: arrays must contain only dense indexed data");
			}
			hash.update("[");
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor)) {
					throw new TypeError("Unsupported canonical object: array accessors are not plain data");
				}
				if (index > 0) hash.update(",");
				updateCanonicalHash(hash, descriptor.value, seen);
			}
			hash.update("]");
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Unsupported canonical object: expected JSON-like plain data");
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new TypeError("Unsupported canonical object: symbol keys are not JSON-like plain data");
		}
		const object = value as Record<string, unknown>;
		const keys = Object.keys(object).sort(compareCanonicalIdentifiers);
		hash.update("{");
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index]!;
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (!descriptor || !("value" in descriptor)) {
				throw new TypeError("Unsupported canonical object: accessors are not plain data");
			}
			if (index > 0) hash.update(",");
			hash.update(JSON.stringify(key));
			hash.update(":");
			updateCanonicalHash(hash, descriptor.value, seen);
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

const SCOPED_IDENTIFIER_PATTERN = /^(?:workspace|global-context|ancestor-context|external-context|workspace-extension|global-extension|package-extension|external-extension|synthetic-extension):/;
const ABSOLUTE_LOGICAL_PATH_PATTERN = /^(?:[A-Za-z]:\/|\/)/;
const EMBEDDED_ABSOLUTE_LOGICAL_PATH_PATTERN = /(?:^|:)(?:[A-Za-z]:\/|\/)/;
const EMBEDDED_PARENT_ESCAPE_PATTERN = /(?:^|:)\.\.(?:\/|$)/;

function sanitizeManifestIdentifier(value: string, kind: "context" | "transform"): string {
	const canonical = canonicalizeLogicalPath(value);
	if (
		EMBEDDED_ABSOLUTE_LOGICAL_PATH_PATTERN.test(canonical) ||
		EMBEDDED_PARENT_ESCAPE_PATTERN.test(canonical)
	) {
		return `external-${kind}:${hashIdentifier(canonical)}`;
	}
	if (SCOPED_IDENTIFIER_PATTERN.test(canonical)) return canonical;
	if (ABSOLUTE_LOGICAL_PATH_PATTERN.test(canonical) || canonical === ".." || canonical.startsWith("../")) {
		return `external-${kind}:${hashIdentifier(canonical)}`;
	}
	return canonical;
}

export function buildPrefixManifest(input: PrefixManifestBuildInput): PrefixManifestV1 {
	const normalizedPrompt = normalizeText(input.systemPrompt);
	const toolOrder = input.tools.map((tool) => tool.name.normalize("NFC"));
	const toolSchemas = new Map<string, string>();
	for (const tool of input.tools) toolSchemas.set(tool.name, sha256Canonical(tool.schema));
	const contextEntries = [...(input.persistentContext ?? [])]
		.map((entry) => ({
			identifier: sanitizeManifestIdentifier(entry.identifier, "context"),
			content: normalizeText(entry.content),
			precedence: assertGeneration("persistentContext.precedence", entry.precedence),
		}))
		.sort((left, right) => left.precedence - right.precedence || compareCanonicalIdentifiers(left.identifier, right.identifier));
	const persistentContext = new Map<string, string>();
	for (const entry of contextEntries) persistentContext.set(entry.identifier, hashText(entry.content));
	const requestTransforms = (input.requestTransformChain ?? []).map((identifier) =>
		sanitizeManifestIdentifier(identifier, "transform"),
	);
	const dynamicInstructionObserved =
		input.dynamicInstructionGeneration !== undefined || input.dynamicInstructions !== undefined;
	if (dynamicInstructionObserved && (input.dynamicInstructionGeneration === undefined || input.dynamicInstructions === undefined)) {
		throw new TypeError("dynamic instruction observation requires both generation and instructions");
	}
	const compactionObserved = input.compactionGeneration !== undefined || input.compactionArtifact !== undefined;
	if (compactionObserved && input.compactionGeneration === undefined) {
		throw new TypeError("compaction observation requires a generation");
	}
	const effective = input.effectiveDispatch;
	const systemPromptHash = effective?.instructionsHash ?? hashText(normalizedPrompt);
	const systemPromptBytes = effective?.instructionsBytes ?? Buffer.byteLength(normalizedPrompt);
	const toolOrderHash = effective?.toolOrderHash ?? sha256Canonical(toolOrder);
	const toolIdentifierSetHash = effective?.toolIdentifierSetHash ?? sha256Canonical([...toolOrder].sort(compareCanonicalIdentifiers));
	const toolSchemaHash = effective?.toolsHash ?? sha256Canonical(input.tools.map((tool) => ({ name: tool.name, schema: tool.schema })));
	const toolCount = effective?.toolCount ?? input.tools.length;
	const cacheKeyHash = effective?.cacheKeyHash ?? (input.cacheKey === undefined ? undefined : hashText(input.cacheKey));
	const cacheRetentionHash = effective?.cacheRetentionHash ?? sha256Canonical({
		configuredRetention: input.cacheRetention ?? null,
	});
	const cachePolicyHash = effective?.cachePolicyHash ?? sha256Canonical(null);
	const cacheBoundaryHash = effective?.cacheBoundaryHash ?? sha256Canonical(null);
	const requestTransformOutputHash = effective?.requestTransformOutputHash ?? sha256Canonical({
		systemPromptHash,
		toolOrderHash,
		toolIdentifierSetHash,
		toolSchemaHash,
		cacheKeyHash: cacheKeyHash ?? null,
		cacheRetentionHash,
		cachePolicyHash,
		cacheBoundaryHash,
	});
	const effectivePrefixHash = effective?.prefixHash ?? sha256Canonical({
		systemPromptHash,
		toolOrderHash,
		toolSchemaHash,
		persistentContextHash: sha256Canonical(contextEntries),
		cacheKeyHash: cacheKeyHash ?? null,
		cacheRetentionHash,
		cachePolicyHash,
		cacheBoundaryHash,
	});

	const manifest: PrefixManifestV1 = {
		schemaVersion: 1,
		provider: input.provider,
		model: input.model,
		api: input.api,
		transport: effective?.transport ?? input.transport,
		...(input.cacheRetention === undefined ? {} : { cacheRetention: input.cacheRetention }),
		cacheRetentionHash,
		cachePolicyHash,
		cacheBoundaryHash,
		systemPromptHash,
		systemPromptBytes,
		toolOrderHash,
		toolIdentifierSetHash,
		toolSchemaHash,
		toolCount,
		persistentContextHash: sha256Canonical(contextEntries),
		dynamicInstructionObservationState: dynamicInstructionObserved ? "observed" : "unavailable",
		...(dynamicInstructionObserved
			? {
				dynamicInstructionGeneration: assertGeneration(
					"dynamicInstructionGeneration",
					input.dynamicInstructionGeneration!,
				),
				dynamicInstructionHash: hashText(input.dynamicInstructions!),
			}
			: {}),
		requestTransformChainHash: sha256Canonical(requestTransforms),
		requestTransformOutputHash,
		effectivePrefixHash,
		compactionObservationState: compactionObserved ? "observed" : "unavailable",
		...(compactionObserved
			? { compactionGeneration: assertGeneration("compactionGeneration", input.compactionGeneration!) }
			: {}),
		...(input.compactionArtifact === undefined
			? {}
			: { compactionArtifactHash: sha256Canonical(input.compactionArtifact) }),
		...(cacheKeyHash === undefined ? {} : { cacheKeyHash }),
		previousResponseMode: effective?.previousResponseMode ?? input.previousResponseMode,
	};
	SEGMENT_METADATA.set(manifest, {
		observationKind: effective ? "effective" : "intent",
		toolOrder,
		toolSchemas,
		persistentContext,
		requestTransforms,
	});
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
	const result: PrefixDriftDiagnostic = {
		firstDivergentSegment: segment,
		expectedMiss,
		reasonCode,
		changedIdentifiers,
	};
	if (segment === "dynamic-instructions") {
		if (previous.dynamicInstructionGeneration !== undefined) result.oldGeneration = previous.dynamicInstructionGeneration;
		if (current.dynamicInstructionGeneration !== undefined) result.newGeneration = current.dynamicInstructionGeneration;
	} else if (segment === "compaction") {
		if (previous.compactionGeneration !== undefined) result.oldGeneration = previous.compactionGeneration;
		if (current.compactionGeneration !== undefined) result.newGeneration = current.compactionGeneration;
	}
	return result;
}

export function comparePrefixManifests(
	previous: PrefixManifestV1,
	current: PrefixManifestV1,
): PrefixDriftDiagnostic | undefined {
	const previousMetadata = SEGMENT_METADATA.get(previous);
	const currentMetadata = SEGMENT_METADATA.get(current);
	const comparingEffective =
		previousMetadata?.observationKind === "effective" && currentMetadata?.observationKind === "effective";
	const toolOrderChanged = previous.toolOrderHash !== current.toolOrderHash || previous.toolCount !== current.toolCount;
	const toolSetChanged =
		previous.toolIdentifierSetHash !== current.toolIdentifierSetHash || previous.toolCount !== current.toolCount;
	const changedTools = toolOrderChanged
		? symmetricDifference(previousMetadata?.toolOrder ?? [], currentMetadata?.toolOrder ?? [])
		: [];
	const toolSchemaChanged = previous.toolSchemaHash !== current.toolSchemaHash;
	const changedToolSchemas = toolSchemaChanged
		? changedMapKeys(previousMetadata?.toolSchemas, currentMetadata?.toolSchemas)
		: [];
	const contextChanged = previous.persistentContextHash !== current.persistentContextHash;
	const changedContext = contextChanged
		? changedMapKeys(previousMetadata?.persistentContext, currentMetadata?.persistentContext)
		: [];
	const dynamicChanged =
		previous.dynamicInstructionObservationState !== current.dynamicInstructionObservationState ||
		previous.dynamicInstructionGeneration !== current.dynamicInstructionGeneration ||
		previous.dynamicInstructionHash !== current.dynamicInstructionHash;
	const systemPromptChanged =
		previous.systemPromptHash !== current.systemPromptHash ||
		previous.systemPromptBytes !== current.systemPromptBytes;
	const effectivePrefixChanged = previous.effectivePrefixHash !== current.effectivePrefixHash;
	const cacheRetentionChanged = previous.cacheRetentionHash !== current.cacheRetentionHash;
	const cachePolicyChanged = previous.cachePolicyHash !== current.cachePolicyHash;
	const cacheBoundaryChanged = previous.cacheBoundaryHash !== current.cacheBoundaryHash;
	if (previous.provider !== current.provider || previous.model !== current.model || previous.api !== current.api) {
		return diagnostic(previous, current, "model", "MODEL_CHANGED", true);
	}
	if (previous.transport !== current.transport) {
		return diagnostic(previous, current, "transport", "TRANSPORT_CHANGED", true);
	}
	if (
		comparingEffective &&
		!systemPromptChanged &&
		!toolOrderChanged &&
		!toolSchemaChanged &&
		!effectivePrefixChanged &&
		previous.cacheKeyHash === current.cacheKeyHash &&
		!cacheRetentionChanged &&
		!cachePolicyChanged &&
		!cacheBoundaryChanged &&
		previous.previousResponseMode === current.previousResponseMode
	) {
		// Intent metadata is explanatory only. A transform may hold the provider prefix
		// constant even while configured context, tools, or dynamic instructions change.
		return undefined;
	}
	if (systemPromptChanged) {
		if (toolSetChanged) {
			return diagnostic(previous, current, "system-prompt", "TOOL_ACTIVATED", true, changedTools);
		}
		if (toolOrderChanged) {
			return diagnostic(previous, current, "system-prompt", "TOOL_ORDER_CHANGED", true);
		}
		if (toolSchemaChanged) {
			return diagnostic(previous, current, "system-prompt", "TOOL_SCHEMA_CHANGED", true, changedToolSchemas);
		}
		if (contextChanged) {
			return diagnostic(previous, current, "system-prompt", "PROJECT_CONTEXT_CHANGED", true, changedContext);
		}
		if (dynamicChanged) {
			return diagnostic(previous, current, "system-prompt", "DYNAMIC_INSTRUCTION_CHANGED", true);
		}
		return diagnostic(previous, current, "system-prompt", "UNKNOWN_PREFIX_DRIFT", false);
	}
	if (
		effectivePrefixChanged &&
		!toolOrderChanged &&
		!toolSchemaChanged &&
		!contextChanged &&
		!dynamicChanged &&
		previous.cacheKeyHash === current.cacheKeyHash &&
		!cacheRetentionChanged &&
		!cachePolicyChanged &&
		!cacheBoundaryChanged
	) {
		return diagnostic(previous, current, "system-prompt", "UNKNOWN_PREFIX_DRIFT", false);
	}
	if (toolOrderChanged) {
		return diagnostic(
			previous,
			current,
			"tool-order",
			toolSetChanged ? "TOOL_ACTIVATED" : "TOOL_ORDER_CHANGED",
			true,
			changedTools,
		);
	}
	if (toolSchemaChanged) {
		return diagnostic(
			previous,
			current,
			"tool-schema",
			"TOOL_SCHEMA_CHANGED",
			true,
			changedToolSchemas,
		);
	}
	if (
		(comparingEffective && cacheRetentionChanged) ||
		(!comparingEffective && previous.cacheRetention !== current.cacheRetention)
	) {
		return diagnostic(previous, current, "cache-retention", "CACHE_RETENTION_CHANGED", true);
	}
	if (comparingEffective && cachePolicyChanged) {
		return diagnostic(previous, current, "cache-policy", "CACHE_POLICY_CHANGED", true);
	}
	if (comparingEffective && previous.cacheKeyHash !== current.cacheKeyHash) {
		return diagnostic(previous, current, "cache-key", "CACHE_KEY_CHANGED", true);
	}
	if (comparingEffective && cacheBoundaryChanged) {
		return diagnostic(previous, current, "cache-boundary", "CACHE_BOUNDARY_CHANGED", true);
	}
	if (comparingEffective && effectivePrefixChanged) {
		if (contextChanged) {
			return diagnostic(previous, current, "system-prompt", "PROJECT_CONTEXT_CHANGED", true, changedContext);
		}
		if (dynamicChanged) {
			return diagnostic(previous, current, "system-prompt", "DYNAMIC_INSTRUCTION_CHANGED", true);
		}
		return diagnostic(previous, current, "system-prompt", "UNKNOWN_PREFIX_DRIFT", false);
	}
	if (!comparingEffective && contextChanged) {
		return diagnostic(
			previous,
			current,
			"persistent-context",
			"PROJECT_CONTEXT_CHANGED",
			true,
			changedContext,
		);
	}
	if (!comparingEffective && dynamicChanged) {
		return diagnostic(previous, current, "dynamic-instructions", "DYNAMIC_INSTRUCTION_CHANGED", true);
	}
	if (!comparingEffective && previous.requestTransformChainHash !== current.requestTransformChainHash) {
		return diagnostic(
			previous,
			current,
			"request-transform-chain",
			"UNKNOWN_PREFIX_DRIFT",
			false,
			symmetricDifference(previousMetadata?.requestTransforms ?? [], currentMetadata?.requestTransforms ?? []),
		);
	}
	const compactionChanged =
		previous.compactionObservationState !== current.compactionObservationState ||
		previous.compactionGeneration !== current.compactionGeneration ||
		previous.compactionArtifactHash !== current.compactionArtifactHash;
	if (!comparingEffective && compactionChanged) {
		return diagnostic(previous, current, "compaction", "COMPACTION_BOUNDARY", true);
	}
	if (previous.cacheKeyHash !== current.cacheKeyHash) {
		return diagnostic(previous, current, "cache-key", "CACHE_KEY_CHANGED", true);
	}
	if (previous.previousResponseMode !== current.previousResponseMode) {
		return diagnostic(previous, current, "previous-response", "PREVIOUS_RESPONSE_MODE_CHANGED", true);
	}
	return undefined;
}

export class PrefixManifestRecorder {
	private previous: PrefixManifestV1 | undefined;
	private latestIntent: PrefixManifestV1 | undefined;
	private latestDiagnostic: PrefixDriftDiagnostic | undefined;

	recordIntent(manifest: PrefixManifestV1): void {
		this.latestIntent = manifest;
	}

	record(manifest: PrefixManifestV1): PrefixDriftDiagnostic | undefined {
		this.latestDiagnostic = this.previous ? comparePrefixManifests(this.previous, manifest) : undefined;
		this.previous = manifest;
		return this.latestDiagnostic;
	}

	get current(): PrefixManifestV1 | undefined {
		return this.previous;
	}

	get intent(): PrefixManifestV1 | undefined {
		return this.latestIntent;
	}

	get diagnostic(): PrefixDriftDiagnostic | undefined {
		return this.latestDiagnostic;
	}
}
