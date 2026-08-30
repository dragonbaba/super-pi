/**
 * Provider-neutral, metadata-only estimation for the text view of tool results.
 *
 * The fallback deliberately scans each UTF-16 code unit once. It does not join
 * content blocks, materialize sanitized text, split lines, or retain content.
 */

export const TOOL_OUTPUT_ESTIMATOR_VERSION = 1 as const;
export const TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID = "super-pi.conservative-v1";
export const TOOL_OUTPUT_SHADOW_BUDGETS = [1024, 2048, 4096, 8192, 16384] as const;

export type ToolOutputEstimateConfidence = "exact" | "conservative-fallback";

export interface ToolOutputTextContent {
	type: "text";
	text: string;
}

export interface ToolOutputImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type ToolOutputContent = ToolOutputTextContent | ToolOutputImageContent;

export interface ToolOutputTokenEstimate {
	estimatorVersion: typeof TOOL_OUTPUT_ESTIMATOR_VERSION;
	estimatorId: string;
	estimatedTokens: number;
	/** UTF-8 bytes of the supplied text before provider surrogate sanitation. */
	rawUtf8Bytes: number;
	/** UTF-8 bytes of the provider-visible text after unpaired surrogates are omitted. */
	modelVisibleUtf8Bytes: number;
	rawLines: number;
	confidence: ToolOutputEstimateConfidence;
}

/**
 * Optional synchronous provider tokenizer boundary. Implementations must not
 * mutate or retain `content`, and must return a finite non-negative integer.
 */
export interface ToolOutputExactTokenEstimator {
	readonly estimatorId: string;
	estimateToolOutputTokens(content: readonly ToolOutputContent[]): number;
}

export interface ToolOutputEstimatorCounters {
	estimatorCalls: number;
	exactEstimatorCalls: number;
	fallbackEstimatorCalls: number;
	charactersScanned: number;
	utf8BytesObserved: number;
	lineBreaksObserved: number;
	fullStringCopies: number;
	fullStringSerializations: number;
	temporaryLineArrays: number;
	promisesCreated: number;
	closuresCreated: number;
	wrapperObjectsCreated: number;
	telemetryPayloadsCreated: number;
	telemetryPayloadsDropped: number;
	maximumInputCharacters: number;
	finalRetainedReferences: number;
}

export function createToolOutputEstimatorCounters(): ToolOutputEstimatorCounters {
	return {
		estimatorCalls: 0,
		exactEstimatorCalls: 0,
		fallbackEstimatorCalls: 0,
		charactersScanned: 0,
		utf8BytesObserved: 0,
		lineBreaksObserved: 0,
		fullStringCopies: 0,
		fullStringSerializations: 0,
		temporaryLineArrays: 0,
		promisesCreated: 0,
		closuresCreated: 0,
		wrapperObjectsCreated: 0,
		telemetryPayloadsCreated: 0,
		telemetryPayloadsDropped: 0,
		maximumInputCharacters: 0,
		finalRetainedReferences: 0,
	};
}

const AsciiRunKind = {
	None: 0,
	Whitespace: 1,
	LowerAlpha: 2,
	Alpha: 3,
	Digits: 4,
	Hex: 5,
	MixedAlphaNumeric: 6,
	Symbols: 7,
} as const;
type AsciiRunKindValue = (typeof AsciiRunKind)[keyof typeof AsciiRunKind];

interface ScanState {
	rawUtf8Bytes: number;
	modelVisibleUtf8Bytes: number;
	lineBreaks: number;
	characters: number;
	estimatedTokens: number;
	runKind: AsciiRunKindValue;
	runLength: number;
	runHasLower: boolean;
	runHasUpper: boolean;
	runHasDigit: boolean;
	runAllHex: boolean;
	runTransitions: number;
	runLastWordClass: number;
	runAdjacentChanges: number;
	runLastCode: number;
	cjkCharacters: number;
	otherBmpCharacters: number;
	emojiCharacters: number;
	combiningCharacters: number;
	controlCharacters: number;
	hasVisibleText: boolean;
	endsWithLineBreak: boolean;
}

function addAsciiRunTokens(state: ScanState): void {
	const length = state.runLength;
	if (length === 0) return;
	switch (state.runKind) {
		case AsciiRunKind.Whitespace:
			state.estimatedTokens += Math.ceil(Math.max(0, length - 1) / 6);
			break;
		case AsciiRunKind.Digits:
			state.estimatedTokens += Math.ceil(length / 3);
			break;
		case AsciiRunKind.Hex:
			state.estimatedTokens += length > 12 ? Math.ceil(length / 2) : Math.ceil(length / 4);
			break;
		case AsciiRunKind.MixedAlphaNumeric:
			state.estimatedTokens +=
				length > 12
					? state.runTransitions * 2 >= length
						? Math.ceil((length * 7) / 8)
						: Math.ceil(length / 2)
					: Math.ceil(length / 3);
			break;
		case AsciiRunKind.Symbols:
			state.estimatedTokens += Math.ceil(length / 2);
			break;
		case AsciiRunKind.LowerAlpha:
		case AsciiRunKind.Alpha:
			state.estimatedTokens += Math.max(
				1,
				Math.ceil(length / (length > 16 ? (state.runAdjacentChanges === 0 ? 8 : 4) : 6)),
			);
			break;
	}
	state.runKind = AsciiRunKind.None;
	state.runLength = 0;
	state.runHasLower = false;
	state.runHasUpper = false;
	state.runHasDigit = false;
	state.runAllHex = true;
	state.runTransitions = 0;
	state.runLastWordClass = 0;
	state.runAdjacentChanges = 0;
	state.runLastCode = -1;
}

function isAsciiHex(code: number): boolean {
	return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function beginOrExtendAsciiRun(state: ScanState, code: number): void {
	let kind: AsciiRunKindValue;
	const lower = code >= 0x61 && code <= 0x7a;
	const upper = code >= 0x41 && code <= 0x5a;
	const digit = code >= 0x30 && code <= 0x39;
	const wordClass = lower ? 1 : upper ? 2 : digit ? 3 : 0;
	if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
		kind = AsciiRunKind.Whitespace;
	} else if (lower || upper || digit) {
		kind = digit ? AsciiRunKind.Digits : lower ? AsciiRunKind.LowerAlpha : AsciiRunKind.Alpha;
	} else {
		kind = AsciiRunKind.Symbols;
	}

	const currentIsWord =
		state.runKind === AsciiRunKind.LowerAlpha ||
		state.runKind === AsciiRunKind.Alpha ||
		state.runKind === AsciiRunKind.Digits ||
		state.runKind === AsciiRunKind.Hex ||
		state.runKind === AsciiRunKind.MixedAlphaNumeric;
	const nextIsWord = kind === AsciiRunKind.LowerAlpha || kind === AsciiRunKind.Alpha || kind === AsciiRunKind.Digits;
	if (state.runKind !== AsciiRunKind.None && state.runKind !== kind && !(currentIsWord && nextIsWord)) {
		addAsciiRunTokens(state);
	}

	if (state.runLength === 0) {
		state.runKind = kind;
		state.runAllHex = true;
		state.runLastWordClass = wordClass;
		state.runLastCode = code;
	} else if (wordClass !== 0 && state.runLastWordClass !== 0 && wordClass !== state.runLastWordClass) {
		state.runTransitions++;
	}
	if (state.runLength > 0 && state.runLastCode !== code) state.runAdjacentChanges++;
	state.runLength++;
	state.runHasLower = state.runHasLower || lower;
	state.runHasUpper = state.runHasUpper || upper;
	state.runHasDigit = state.runHasDigit || digit;
	state.runAllHex = state.runAllHex && isAsciiHex(code);
	if (wordClass !== 0) state.runLastWordClass = wordClass;
	state.runLastCode = code;
	if (nextIsWord) {
		if (state.runHasDigit && (state.runHasLower || state.runHasUpper)) {
			state.runKind = state.runAllHex ? AsciiRunKind.Hex : AsciiRunKind.MixedAlphaNumeric;
		} else if (state.runHasDigit) {
			state.runKind = AsciiRunKind.Digits;
		} else if (state.runHasUpper) {
			state.runKind = AsciiRunKind.Alpha;
		} else {
			state.runKind = AsciiRunKind.LowerAlpha;
		}
	}
}

function isCjk(codePoint: number): boolean {
	return (
		(codePoint >= 0x3400 && codePoint <= 0x9fff) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0x3040 && codePoint <= 0x30ff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0x20000 && codePoint <= 0x3134f)
	);
}

function isCombiningOrJoiner(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		codePoint === 0x200d
	);
}

function scanText(state: ScanState, text: string): void {
	state.characters += text.length;
	if (text.length > 0) state.hasVisibleText = true;
	for (let index = 0; index < text.length; index++) {
		const first = text.charCodeAt(index);
		if (first <= 0x7f) {
			state.rawUtf8Bytes++;
			state.modelVisibleUtf8Bytes++;
			if (first === 0x0a) state.lineBreaks++;
			if (first < 0x20 && first !== 0x09 && first !== 0x0a && first !== 0x0d) state.controlCharacters++;
			state.endsWithLineBreak = first === 0x0a;
			beginOrExtendAsciiRun(state, first);
			continue;
		}

		addAsciiRunTokens(state);
		state.endsWithLineBreak = false;
		if (first >= 0xd800 && first <= 0xdbff) {
			const second = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (second >= 0xdc00 && second <= 0xdfff) {
				const codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
				state.rawUtf8Bytes += 4;
				state.modelVisibleUtf8Bytes += 4;
				if (isCjk(codePoint)) state.cjkCharacters++;
				else if (isCombiningOrJoiner(codePoint)) state.combiningCharacters++;
				else state.emojiCharacters++;
				index++;
				continue;
			}
			// Provider serializers omit unpaired surrogates; Node UTF-8 encoding observes U+FFFD.
			state.rawUtf8Bytes += 3;
			continue;
		}
		if (first >= 0xdc00 && first <= 0xdfff) {
			state.rawUtf8Bytes += 3;
			continue;
		}

		const bytes = first <= 0x7ff ? 2 : 3;
		state.rawUtf8Bytes += bytes;
		state.modelVisibleUtf8Bytes += bytes;
		if (isCjk(first)) state.cjkCharacters++;
		else if (isCombiningOrJoiner(first)) state.combiningCharacters++;
		else state.otherBmpCharacters++;
	}
}

function createScanState(): ScanState {
	return {
		rawUtf8Bytes: 0,
		modelVisibleUtf8Bytes: 0,
		lineBreaks: 0,
		characters: 0,
		estimatedTokens: 0,
		runKind: AsciiRunKind.None,
		runLength: 0,
		runHasLower: false,
		runHasUpper: false,
		runHasDigit: false,
		runAllHex: true,
		runTransitions: 0,
		runLastWordClass: 0,
		runAdjacentChanges: 0,
		runLastCode: -1,
		cjkCharacters: 0,
		otherBmpCharacters: 0,
		emojiCharacters: 0,
		combiningCharacters: 0,
		controlCharacters: 0,
		hasVisibleText: false,
		endsWithLineBreak: false,
	};
}

const IMAGE_ONLY_PLACEHOLDER = "(see attached image)";

export function estimateToolOutputTokens(
	content: readonly ToolOutputContent[],
	exactEstimator?: ToolOutputExactTokenEstimator,
	counters?: ToolOutputEstimatorCounters,
): ToolOutputTokenEstimate {
	if (counters) counters.estimatorCalls++;
	const state = createScanState();
	if (counters) counters.wrapperObjectsCreated++;
	let textBlocks = 0;
	let hasImage = false;
	for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
		const block = content[blockIndex]!;
		if (block.type === "image") {
			hasImage = true;
			continue;
		}
		if (textBlocks > 0) scanText(state, "\n");
		scanText(state, block.text);
		textBlocks++;
	}
	if (!state.hasVisibleText && hasImage) scanText(state, IMAGE_ONLY_PLACEHOLDER);
	addAsciiRunTokens(state);
	state.estimatedTokens += Math.ceil((state.cjkCharacters * 5) / 4);
	state.estimatedTokens += state.otherBmpCharacters * 2;
	state.estimatedTokens += state.emojiCharacters * 3;
	state.estimatedTokens += state.combiningCharacters * 2;
	state.estimatedTokens += Math.ceil(state.controlCharacters / 2);
	state.estimatedTokens += state.lineBreaks;
	if (state.modelVisibleUtf8Bytes > 0 && state.estimatedTokens === 0) state.estimatedTokens = 1;

	let estimatedTokens = state.estimatedTokens;
	let estimatorId = TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID;
	let confidence: ToolOutputEstimateConfidence = "conservative-fallback";
	if (exactEstimator) {
		if (counters) counters.exactEstimatorCalls++;
		try {
			const exactTokens = exactEstimator.estimateToolOutputTokens(content);
			if (Number.isSafeInteger(exactTokens) && exactTokens >= 0) {
				estimatedTokens = exactTokens;
				estimatorId = exactEstimator.estimatorId;
				confidence = "exact";
			}
		} catch {
			// Exact estimation is observational. Fall back without changing tool delivery.
		}
	}
	if (confidence === "conservative-fallback" && counters) counters.fallbackEstimatorCalls++;

	if (counters) {
		counters.charactersScanned += state.characters;
		counters.utf8BytesObserved += state.rawUtf8Bytes;
		counters.lineBreaksObserved += state.lineBreaks;
		counters.maximumInputCharacters = Math.max(counters.maximumInputCharacters, state.characters);
		counters.wrapperObjectsCreated++;
	}
	return {
		estimatorVersion: TOOL_OUTPUT_ESTIMATOR_VERSION,
		estimatorId,
		estimatedTokens,
		rawUtf8Bytes: state.rawUtf8Bytes,
		modelVisibleUtf8Bytes: state.modelVisibleUtf8Bytes,
		rawLines: state.characters === 0 ? 0 : state.endsWithLineBreak ? state.lineBreaks : state.lineBreaks + 1,
		confidence,
	};
}

export type ToolOutputCategory = "read" | "shell" | "search" | "mutation" | "mcp" | "extension";
export type ToolOutputShadowReason = "none" | "candidate-token-budget";

export interface ToolOutputShadowTelemetry {
	rawUtf8Bytes: number;
	rawLines: number;
	estimatedTokens: number;
	currentModelVisibleBytes: number;
	currentModelVisibleTokens: number;
	proposedModelViewTokens1k: number;
	proposedModelViewTokens2k: number;
	proposedModelViewTokens4k: number;
	proposedModelViewTokens8k: number;
	proposedModelViewTokens16k: number;
	wouldTruncate1k: boolean;
	wouldTruncate2k: boolean;
	wouldTruncate4k: boolean;
	wouldTruncate8k: boolean;
	wouldTruncate16k: boolean;
	wouldTruncate: boolean;
	proposedTruncationReason: ToolOutputShadowReason;
	toolCategory: ToolOutputCategory;
	estimatorId: string;
	estimatorVersion: typeof TOOL_OUTPUT_ESTIMATOR_VERSION;
	estimatorConfidence: ToolOutputEstimateConfidence;
}

export interface ToolOutputShadowTelemetrySink {
	recordToolOutputShadow(record: ToolOutputShadowTelemetry): void;
}

export interface ToolOutputShadowOptions {
	enabled?: boolean;
	exactEstimator?: ToolOutputExactTokenEstimator;
	telemetry?: ToolOutputShadowTelemetrySink;
	counters?: ToolOutputEstimatorCounters;
}

export interface ToolResultMessageLike {
	toolName: string;
	content: readonly ToolOutputContent[];
	details?: unknown;
}

function classifyTool(toolName: string): ToolOutputCategory {
	switch (toolName) {
		case "read":
			return "read";
		case "bash":
		case "powershell":
			return "shell";
		case "grep":
		case "find":
		case "ls":
			return "search";
		case "edit":
		case "write":
			return "mutation";
		default:
			return toolName.startsWith("mcp_") || toolName.startsWith("mcp.") ? "mcp" : "extension";
	}
}

function originalOutputMetric(details: unknown, key: "totalBytes" | "totalLines", fallback: number): number {
	try {
		if (!details || typeof details !== "object") return fallback;
		const truncation = (details as { truncation?: unknown }).truncation;
		if (!truncation || typeof truncation !== "object") return fallback;
		const value = (truncation as Record<string, unknown>)[key];
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

export class ToolOutputShadowObserver {
	private exactEstimator: ToolOutputExactTokenEstimator | undefined;
	private telemetry: ToolOutputShadowTelemetrySink | undefined;
	private active = true;
	readonly counters: ToolOutputEstimatorCounters;

	constructor(options: ToolOutputShadowOptions) {
		this.exactEstimator = options.exactEstimator;
		this.telemetry = options.telemetry;
		this.counters = options.counters ?? createToolOutputEstimatorCounters();
	}

	observe(message: ToolResultMessageLike): void {
		if (!this.active) return;
		try {
			const estimate = estimateToolOutputTokens(message.content, this.exactEstimator, this.counters);
			const rawUtf8Bytes = originalOutputMetric(message.details, "totalBytes", estimate.rawUtf8Bytes);
			const rawLines = originalOutputMetric(message.details, "totalLines", estimate.rawLines);
			const tokens = estimate.estimatedTokens;
			const payload: ToolOutputShadowTelemetry = {
				rawUtf8Bytes,
				rawLines,
				estimatedTokens: tokens,
				currentModelVisibleBytes: estimate.modelVisibleUtf8Bytes,
				currentModelVisibleTokens: tokens,
				proposedModelViewTokens1k: Math.min(tokens, 1024),
				proposedModelViewTokens2k: Math.min(tokens, 2048),
				proposedModelViewTokens4k: Math.min(tokens, 4096),
				proposedModelViewTokens8k: Math.min(tokens, 8192),
				proposedModelViewTokens16k: Math.min(tokens, 16384),
				wouldTruncate1k: tokens > 1024,
				wouldTruncate2k: tokens > 2048,
				wouldTruncate4k: tokens > 4096,
				wouldTruncate8k: tokens > 8192,
				wouldTruncate16k: tokens > 16384,
				wouldTruncate: tokens > 1024,
				proposedTruncationReason: tokens > 1024 ? "candidate-token-budget" : "none",
				toolCategory: classifyTool(message.toolName),
				estimatorId: estimate.estimatorId,
				estimatorVersion: estimate.estimatorVersion,
				estimatorConfidence: estimate.confidence,
			};
			this.counters.wrapperObjectsCreated++;
			this.counters.telemetryPayloadsCreated++;
			const telemetry = this.telemetry;
			if (!telemetry) {
				this.counters.telemetryPayloadsDropped++;
				return;
			}
			try {
				telemetry.recordToolOutputShadow(payload);
			} catch {
				this.counters.telemetryPayloadsDropped++;
			}
		} catch {
			// Shadow mode is observational and cannot alter result delivery or errors.
			this.counters.telemetryPayloadsDropped++;
		}
	}

	dispose(): void {
		this.active = false;
		this.exactEstimator = undefined;
		this.telemetry = undefined;
		this.counters.finalRetainedReferences = 0;
	}
}

export function createToolOutputShadowObserver(options?: ToolOutputShadowOptions): ToolOutputShadowObserver | undefined {
	return options?.enabled === true ? new ToolOutputShadowObserver(options) : undefined;
}
