import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@super-pi/coding-agent";
import { formatContextDisplay } from "./context-usage.js";
import {
	type ExtensionStatusRuntime,
	formatExtensionStatuses,
	wrapExtensionStatusline,
} from "./extension-status.js";
import { formatGitBranchValue, type GitStatusSummary } from "./git-status.js";
import { renderPowerlineStatuslineLines } from "./powerline.js";
import {
	APPROVED_STATUS_PATTERN,
	CHECKS_PASSING_PATTERN,
	CHANGES_REQUESTED_PATTERN,
	CLAUDE_MODEL_PREFIX_PATTERN,
	CLOSED_STATUS_PATTERN,
	DATE_MODEL_SUFFIX_PATTERN,
	DRAFT_STATUS_PATTERN,
	FAILING_CHECKS_PATTERN,
	GPT_MODEL_PREFIX_PATTERN,
	LATEST_MODEL_SUFFIX_PATTERN,
	MERGED_STATUS_PATTERN,
	NO_CHECKS_PATTERN,
	PENDING_CHECKS_PATTERN,
	REVIEW_REQUIRED_PATTERN,
} from "./regex.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { formatTokenSpeed } from "./token-speed.js";
import {
	LINE_BREAK_SEGMENT_NAME,
	type PowerlineBlockName,
	type RenderItem,
	type RenderSegment,
	type SegmentName,
	type StatuslineConfig,
	type TruncationDirection,
} from "./types.js";
import type { FooterUsageSummary } from "./usage.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface RuntimeState extends ExtensionStatusRuntime {
	turnCount: number;
	contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
	compactionPending: boolean;
	activeTools: Map<string, number>;
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	generationStartedAtMs?: number;
	tokenSpeed?: number;
	gitStatus?: GitStatusSummary;
	usageSummary: FooterUsageSummary;
	requestRender?: () => void;
	modelCacheId?: string;
	modelCacheLength?: number;
	modelCacheSymbol?: string;
	modelCacheDirection?: TruncationDirection;
	modelCacheDisplay?: string;
}
const GITHUB_PR_KEY = "github-pr";
const GITHUB_PR_STATUS_KEYS = new Set([GITHUB_PR_KEY]);
export function renderStatuslineLines(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	_theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): string[] {
	if (width <= 0) return [];

	const usageSummary = runtime.usageSummary;
	const rows: Array<{ configuredSegments: number; segments: RenderSegment[] }> = [
		{ configuredSegments: 0, segments: [] },
	];
	for (const name of config.segments) {
		if (name === LINE_BREAK_SEGMENT_NAME) {
			rows.push({ configuredSegments: 0, segments: [] });
			continue;
		}

		const row = rows.at(-1);
		if (!row) continue;
		row.configuredSegments += 1;
		const rendered = buildSegment(name, ctx, footerData, config, runtime, usageSummary);
		if (rendered && rendered.text.length > 0) row.segments.push(rendered);
	}

	const segments: RenderItem[] = [];
	let renderedRowCount = 0;
	for (const row of rows) {
		if (row.configuredSegments !== 0 && row.segments.length === 0) continue;
		if (renderedRowCount > 0) segments.push({ name: LINE_BREAK_SEGMENT_NAME });
		segments.push(...row.segments);
		renderedRowCount += 1;
	}

	return renderPowerlineStatuslineLines(width, segments, config);
}

export function renderStatusline(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
): string {
	return renderStatuslineLines(width, ctx, footerData, theme, config, runtime).join("\n");
}

export function renderExtensionStatusline(
	width: number,
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	config: StatuslineConfig,
	runtime: RuntimeState,
	mainLines: readonly string[],
): string[] {
	const statuses = footerData.getExtensionStatuses();
	const prContext = prContextFromStatuses(statuses);
	let rendersPrInline = false;
	if (prContext !== undefined) {
		for (const line of mainLines) {
			if (!line.includes(prContext)) continue;
			rendersPrInline = true;
			break;
		}
	}
	const status = formatExtensionStatuses(
		statuses,
		theme,
		config,
		runtime,
		rendersPrInline ? GITHUB_PR_STATUS_KEYS : undefined,
	);
	return wrapExtensionStatusline(status, width);
}

function buildSegment(
	name: SegmentName,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	config: StatuslineConfig,
	runtime: RuntimeState,
	usageSummary: FooterUsageSummary,
): RenderSegment | undefined {
	switch (name) {
		case "brand":
			return segment(name, "π", config, "accent", "header", true);
		case "provider":
			return segment(name, ctx.model?.provider ?? "no-provider", config, "accent", "header");
		case "model": {
			const presentation = config.segmentText.model;
			const model = formatModelDisplay(ctx.model?.id ?? "no-model", presentation, runtime);
			return segment(name, model, config, "accent", "header");
		}
		case "thinking":
			return segment(
				name,
				runtime.thinkingLevel,
				config,
				thinkingColor(runtime.thinkingLevel),
				"header",
			);
		case "branch": {
			const branch = footerData.getGitBranch();
			const pr = branch ? prContextFromStatuses(footerData.getExtensionStatuses()) : undefined;
			return segment(
				name,
				formatGitBranchValue(branch, runtime.gitStatus, pr),
				config,
				"accent",
				"git",
			);
		}
		case "cwd":
			return segment(name, basename(ctx.cwd) || ctx.cwd, config, "accent", "directory");
		case "tools": {
			const activity = formatToolActivity(runtime);
			return activity ? segment(name, activity, config, "accent", "runtime") : undefined;
		}
		case "context": {
			const usage = runtime.contextUsage;
			const percentage =
				usage?.percent === null || usage?.percent === undefined
					? "?"
					: `${usage.percent.toFixed(1)}%`;
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const value = formatContextDisplay(
				percentage,
				formatCount(contextWindow),
				runtime.compactionPending,
			);
			return segment(
				name,
				value,
				config,
				contextColor(usage?.percent),
				"runtime",
			);
		}
		case "tokens": {
			const value =
				usageSummary.input === 0 && usageSummary.output === 0
					? "tok 0"
					: `↑${formatCount(usageSummary.input)} ↓${formatCount(usageSummary.output)}`;
			return segment(name, value, config, "accent", "runtime");
		}
		case "cache": {
			if (usageSummary.cacheRead === 0 && usageSummary.cacheWrite === 0) return undefined;
			let value = "";
			if (usageSummary.cacheRead > 0) value = `R${formatCount(usageSummary.cacheRead)}`;
			if (usageSummary.cacheWrite > 0) {
				const write = `W${formatCount(usageSummary.cacheWrite)}`;
				value = value.length === 0 ? write : `${value} ${write}`;
			}
			if (usageSummary.latestCacheHitRate !== undefined) {
				const hitRate = `CH${usageSummary.latestCacheHitRate.toFixed(1)}%`;
				value = value.length === 0 ? hitRate : `${value} ${hitRate}`;
			}
			return segment(name, value, config, "accent", "runtime");
		}
		case "cost": {
			const subscription = isSubscriptionBacked(ctx) ? " (sub)" : "";
			return segment(
				name,
				`${usageSummary.cost.toFixed(usageSummary.cost >= 1 ? 2 : 3)}${subscription}`,
				config,
				"accent",
				"meter",
			);
		}
		case "speed":
			return runtime.tokenSpeed === undefined
				? undefined
				: segment(name, formatTokenSpeed(runtime.tokenSpeed), config, "accent", "meter");
		case "time":
			return segment(name, formatTime(), config, "accent", "meter");
		case "turn":
			return segment(name, `${runtime.turnCount}`, config, "accent", "meter");
	}
}

function segment(
	name: SegmentName,
	value: string,
	config: StatuslineConfig,
	color: RenderSegment["color"],
	block: PowerlineBlockName,
	emphasis = false,
): RenderSegment {
	return { name, text: formatConfiguredSegment(name, value, config), color, block, emphasis };
}

export function formatConfiguredSegment(
	name: SegmentName,
	value: string,
	config: Pick<StatuslineConfig, "segmentText">,
): string {
	const presentation = config.segmentText[name];
	const prefix = sanitizeTerminalText(presentation.prefix, 64);
	const safeValue = sanitizeTerminalText(value, 160);
	const suffix = sanitizeTerminalText(presentation.suffix, 64);
	return `${prefix}${safeValue}${suffix}`;
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
	switch (level as string) {
		case "off":
			return "dim";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax" as ThemeColor;
		default:
			return "dim";
	}
}

export function contextColor(percent: number | null | undefined): ThemeColor {
	if (percent === null || percent === undefined) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

export function formatToolActivity(runtime: RuntimeState): string | undefined {
	const first = runtime.activeTools.entries().next();
	if (!first.done) {
		const [name, count] = first.value;
		const activeCount = runtime.activeTools.size;
		const suffix = count > 1 ? `×${count}` : activeCount > 1 ? `+${activeCount - 1}` : "";
		return `${sanitizeTerminalText(name, 80)}${suffix}`;
	}

	return runtime.isStreaming ? "thinking" : undefined;
}

export function prLinkFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get(GITHUB_PR_KEY);
	if (!value) return undefined;
	// Extract the OSC 8 hyperlink span (the clickable "#123"); skip non-PR states
	// like "PR gh missing" that carry no link. github-pr emits exactly one link, so the
	// first OSC 8 span is the PR number.
	const open = value.indexOf("\x1b]8;;");
	if (open === -1) return undefined;
	const closeMarker = "\x1b]8;;\x07";
	const close = value.indexOf(closeMarker, open + 1);
	return close === -1 ? undefined : value.slice(open, close + closeMarker.length);
}

export function prContextFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get(GITHUB_PR_KEY);
	const link = prLinkFromStatuses(statuses);
	if (!value || !link) return undefined;

	const state = compactPrState(value.replace(link, ""));
	return state ? sanitizeTerminalText(`${link} · ${state}`, 80) : undefined;
}

function compactPrState(value: string): string | undefined {
	if (MERGED_STATUS_PATTERN.test(value)) return "merged";
	if (CLOSED_STATUS_PATTERN.test(value)) return "closed";
	if (DRAFT_STATUS_PATTERN.test(value)) return "draft";

	const failing = FAILING_CHECKS_PATTERN.exec(value);
	if (failing) return `${failing[1]} failing`;
	if (CHANGES_REQUESTED_PATTERN.test(value)) return "changes requested";

	const pending = PENDING_CHECKS_PATTERN.exec(value);
	if (pending) return `${pending[1]} pending`;
	if (APPROVED_STATUS_PATTERN.test(value)) return "approved";
	if (REVIEW_REQUIRED_PATTERN.test(value)) return "review required";
	if (CHECKS_PASSING_PATTERN.test(value)) return "checks passing";
	if (NO_CHECKS_PATTERN.test(value)) return "no checks";
	return undefined;
}

function isSubscriptionBacked(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return (
		model !== undefined &&
		(model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model))
	);
}

export function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

let cachedTimeMinute = -1;
let cachedTime = "";

function formatTime(): string {
	const nowMs = Date.now();
	const minute = Math.floor(nowMs / 60_000);
	if (minute === cachedTimeMinute) return cachedTime;

	const now = new Date(nowMs);
	const hours = now.getHours().toString().padStart(2, "0");
	const minutes = now.getMinutes().toString().padStart(2, "0");
	cachedTimeMinute = minute;
	cachedTime = `${hours}:${minutes}`;
	return cachedTime;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateModel(
	model: string,
	length: number,
	symbol: string,
	direction: TruncationDirection,
): string {
	const safeModel = sanitizeTerminalText(model, 512);
	if (length === 0 || safeModel.length <= length) return safeModel;
	const graphemes: string[] = [];
	for (const item of graphemeSegmenter.segment(safeModel)) graphemes.push(item.segment);
	if (graphemes.length <= length) return safeModel;
	const safeSymbol = sanitizeTerminalText(symbol, 16);

	switch (direction) {
		case "start":
			return `${safeSymbol}${graphemes.slice(-length).join("")}`;
		case "middle": {
			const headLength = Math.ceil(length / 2);
			const tailLength = Math.floor(length / 2);
			const tail = tailLength > 0 ? graphemes.slice(-tailLength).join("") : "";
			return `${graphemes.slice(0, headLength).join("")}${safeSymbol}${tail}`;
		}
		case "end":
			return `${graphemes.slice(0, length).join("")}${safeSymbol}`;
	}
}

function formatModelDisplay(
	modelId: string,
	presentation: StatuslineConfig["segmentText"]["model"],
	runtime: RuntimeState,
): string {
	const length = presentation.truncationLength;
	const symbol = presentation.truncationSymbol;
	const direction = presentation.truncationDirection;
	if (
		runtime.modelCacheId === modelId &&
		runtime.modelCacheLength === length &&
		runtime.modelCacheSymbol === symbol &&
		runtime.modelCacheDirection === direction &&
		runtime.modelCacheDisplay !== undefined
	) {
		return runtime.modelCacheDisplay;
	}

	const display = truncateModel(shortenModel(modelId), length, symbol, direction);
	runtime.modelCacheId = modelId;
	runtime.modelCacheLength = length;
	runtime.modelCacheSymbol = symbol;
	runtime.modelCacheDirection = direction;
	runtime.modelCacheDisplay = display;
	return display;
}

export function shortenModel(model: string): string {
	return model
		.replace(CLAUDE_MODEL_PREFIX_PATTERN, "")
		.replace(GPT_MODEL_PREFIX_PATTERN, "gpt ")
		.replace(DATE_MODEL_SUFFIX_PATTERN, "")
		.replace(LATEST_MODEL_SUFFIX_PATTERN, "");
}
