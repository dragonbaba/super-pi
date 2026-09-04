import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	RELEASE_COMPONENT_RENDER_CACHE,
	Spacer,
	Text,
	type TUI,
} from "@super-pi/tui";
import type { StreamedToolArgumentOwnership } from "@super-pi/ai";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import type { ToolResultPresentation } from "../../../core/tool-result-presentation.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import {
	RELEASE_TOOL_RENDER_DERIVED_STATE,
	TOOL_RENDER_LIFECYCLE_GENERATION,
	type ToolRenderLifecycleState,
} from "../../../core/tools/tool-render-lifecycle.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { ObjectPool } from "../../../utils/object-pool.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { READ_GROUP_BACKSLASH_PATTERN, READ_GROUP_IMAGE_EXTENSION_PATTERN } from "./tool-execution-regex.ts";

const READ_GROUP_SPECIAL_BASENAMES = new Set(["skill.md", "agents.md", "agents.override.md", "claude.md"]);
const READ_GROUP_MAX_PREVIEW_CHARS = 4000;
const READ_GROUP_MAX_PREVIEW_LINES = 50;
const toolPendingBackground = (text: string): string => theme.bg("toolPendingBg", text);
const toolErrorBackground = (text: string): string => theme.bg("toolErrorBg", text);
const toolSuccessBackground = (text: string): string => theme.bg("toolSuccessBg", text);
const toolImageFallbackColor = (text: string): string => theme.fg("toolOutput", text);
type ToolArgsGeneration = string | number | undefined;
const READ_GROUP_SELECTOR_SET_POOL = new ObjectPool(
	() => new Set<string>(),
	(selectors) => selectors.clear(),
	4,
	(selectors) => selectors.size <= 128,
);

type ToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
	details?: any;
};

export interface ToolResultPresentationDiscoveryState {
	readonly identity: string;
	readonly cursor: string;
	readonly artifactId?: string;
	readonly originalEstimatedTokens: number;
	readonly modelEstimatedTokens: number;
}

function createToolResultDiscovery(
	presentation: ToolResultPresentation,
): ToolResultPresentationDiscoveryState | undefined {
	if (presentation.version !== 2) return undefined;
	return {
		identity: presentation.artifact?.id ?? presentation.continuation.cursor,
		cursor: presentation.continuation.cursor,
		artifactId: presentation.artifact?.id,
		originalEstimatedTokens: presentation.truncation.originalEstimatedTokens,
		modelEstimatedTokens: presentation.truncation.modelEstimatedTokens,
	};
}

function formatToolResultDiscovery(
	discovery: ToolResultPresentationDiscoveryState,
	expanded: boolean,
): string {
	const budget = `${discovery.modelEstimatedTokens}/${discovery.originalEstimatedTokens} estimated tokens`;
	const availability = `Continuation: available · Session artifact: ${discovery.artifactId ? "available" : "unavailable"}.`;
	if (expanded) {
		return theme.fg(
			"muted",
			`Model received a bounded view (${budget}). Full canonical result is shown. ${availability}`,
		);
	}
	return (
		theme.fg("muted", `Model received a bounded view (${budget}); full result remains available (`) +
		keyHint("app.tools.expand", "to show full result") +
		theme.fg("muted", `). ${availability}`)
	);
}

type ReadGroupRow = {
	args: any;
	started: boolean;
	argsComplete: boolean;
	result?: ToolResultLike;
	resultIsError: boolean;
	isPartial: boolean;
	toolResultDiscovery?: ToolResultPresentationDiscoveryState;
};
type ReadGroupEntry = { toolCallId: string; row: ReadGroupRow };
type ReadGroupDisplayRow = { entries: ReadGroupEntry[] };

const READ_GROUP_PATH_MAP_POOL = new ObjectPool(
	() => new Map<string, ReadGroupDisplayRow>(),
	(groups) => groups.clear(),
	4,
	(groups) => groups.size <= 128,
);

function getReadGroupPath(args: any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
	return value && value.trim() ? value : undefined;
}

function getReadGroupBasename(filePath: string): string {
	const normalized = filePath.replace(READ_GROUP_BACKSLASH_PATTERN, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function getReadGroupSelector(args: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = args.offset ?? 1;
	const end = args.limit === undefined ? "" : start + args.limit - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}

function normalizeReadGroupPath(filePath: string): string {
	let normalized = filePath.replace(READ_GROUP_BACKSLASH_PATTERN, "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	return normalized;
}

function getReadGroupResultText(result: ToolResultLike | undefined): string {
	if (!Array.isArray(result?.content)) return "";
	let text = "";
	for (let index = 0; index < result.content.length; index++) {
		const block = result.content[index];
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		if (text) text += "\n";
		text += block.text;
	}
	return text;
}

function boundReadGroupPreview(text: string, maxLines: number): string {
	const bounded = text.length > READ_GROUP_MAX_PREVIEW_CHARS ? `${text.slice(0, READ_GROUP_MAX_PREVIEW_CHARS)}\n[… truncated]` : text;
	const lines = bounded.split("\n");
	return lines.length <= maxLines ? bounded : `${lines.slice(0, maxLines).join("\n")}\n[… ${lines.length - maxLines} more lines]`;
}

export function isGroupableReadCall(args: any): boolean {
	const filePath = getReadGroupPath(args);
	if (!filePath) return false;
	const basename = getReadGroupBasename(filePath);
	return !READ_GROUP_SPECIAL_BASENAMES.has(basename) && !READ_GROUP_IMAGE_EXTENSION_PATTERN.test(basename);
}

export function getReadGroupingDisposition(content: any, executedEarly = false): "boundary" | "ignore" | "group-read" {
	if ((content?.type === "text" && content.text.trim()) || (content?.type === "thinking" && content.thinking.trim())) return "boundary";
	if (content?.type !== "toolCall") return "ignore";
	if (content.name !== "read" || executedEarly || !isGroupableReadCall(content.arguments)) return "boundary";
	return "group-read";
}

export function replaceToolPlaceholder(children: Component[], placeholder: Component, component: Component): boolean {
	let placeholderIndex = children.indexOf(placeholder);
	if (placeholderIndex < 0) return false;
	const componentIndex = children.indexOf(component);
	if (componentIndex >= 0 && componentIndex !== placeholderIndex) {
		children.splice(componentIndex, 1);
		if (componentIndex < placeholderIndex) placeholderIndex--;
	}
	children.splice(placeholderIndex, 1, component);
	return true;
}

export class ReadToolGroupComponent extends Container {
	private readonly rows = new Map<string, ReadGroupRow>();
	private expanded = false;
	private finalized = false;
	private showImages: boolean;
	private imageWidthCells: number;

	constructor(showImages = true, imageWidthCells = 60) {
		super();
		this.showImages = showImages;
		this.imageWidthCells = Math.max(1, Math.floor(imageWidthCells));
	}

	canAccept(args: any): boolean { return !this.finalized && isGroupableReadCall(args); }
	updateArgs(toolCallId: string, args: any): boolean {
		let row = this.rows.get(toolCallId);
		if (!row) {
			if (this.finalized) return false;
			row = { args, started: false, argsComplete: false, result: undefined, resultIsError: false, isPartial: true };
			this.rows.set(toolCallId, row);
		} else row.args = args;
		this.rebuild();
		return true;
	}
	markExecutionStarted(toolCallId: string): void { const row = this.rows.get(toolCallId); if (row) { row.started = true; this.rebuild(); } }
	setArgsComplete(toolCallId: string): void { const row = this.rows.get(toolCallId); if (row) { row.argsComplete = true; this.rebuild(); } }
	updateResult(toolCallId: string, result: ToolResultLike, isPartial = false, isError = result.isError === true): void { const row = this.rows.get(toolCallId); if (row) { row.result = result; row.resultIsError = isError; row.isPartial = isPartial; this.rebuild(); } }
	finalize(): void { if (!this.finalized) { this.finalized = true; this.rebuild(); } }
	canFreezeRender(): boolean {
		if (!this.finalized || this.rows.size === 0) return false;
		for (const row of this.rows.values()) {
			if (!row.result || row.isPartial) return false;
		}
		return true;
	}
	setExpanded(expanded: boolean): void { if (this.expanded !== expanded) { this.expanded = expanded; this.rebuild(); } }
	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		this.rebuild();
	}
	setImageWidthCells(width: number): void {
		const nextWidth = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === nextWidth) return;
		this.imageWidthCells = nextWidth;
		this.rebuild();
	}
	override invalidate(): void { super.invalidate(); this.rebuild(); }
	setToolResultPresentation(toolCallId: string, presentation: ToolResultPresentation): string | undefined {
		const row = this.rows.get(toolCallId);
		if (!row) return undefined;
		row.toolResultDiscovery = createToolResultDiscovery(presentation);
		this.rebuild();
		return row.toolResultDiscovery?.identity;
	}
	clearToolResultPresentation(toolCallId: string, identity?: string): void {
		if (!this.detachToolResultPresentation(toolCallId, identity)) return;
		this.rebuild();
	}
	detachToolResultPresentation(toolCallId: string, identity?: string): boolean {
		const row = this.rows.get(toolCallId);
		if (!row?.toolResultDiscovery || (identity !== undefined && row.toolResultDiscovery.identity !== identity)) return false;
		row.toolResultDiscovery = undefined;
		return true;
	}
	getToolResultPresentationDiscovery(toolCallId: string): ToolResultPresentationDiscoveryState | undefined {
		return this.rows.get(toolCallId)?.toolResultDiscovery;
	}

	private getDisplayRows(): ReadGroupDisplayRow[] {
		const displayRows: ReadGroupDisplayRow[] = [];
		if (!this.finalized) {
			for (const [toolCallId, row] of this.rows) displayRows.push({ entries: [{ toolCallId, row }] });
			return displayRows;
		}

		const byPath = READ_GROUP_PATH_MAP_POOL.acquire();
		try {
			for (const [toolCallId, row] of this.rows) {
				const entry = { toolCallId, row };
				const filePath = getReadGroupPath(entry.row.args);
				const mergeable = filePath && entry.row.argsComplete && entry.row.result && !entry.row.isPartial && !entry.row.resultIsError;
				if (!mergeable) { displayRows.push({ entries: [entry] }); continue; }
				const key = normalizeReadGroupPath(filePath);
				const existing = byPath.get(key);
				if (existing) existing.entries.push(entry);
				else { const group = { entries: [entry] }; byPath.set(key, group); displayRows.push(group); }
			}
			return displayRows;
		} finally {
			READ_GROUP_PATH_MAP_POOL.release(byPath);
		}
	}

	private rebuild(): void {
		this.clear();
		const callCount = this.rows.size;
		if (callCount === 0) return;
		this.addChild(new Spacer(1));
		const displayRows = this.getDisplayRows();
		if (callCount > 1) this.addChild(new Text(theme.fg("toolTitle", theme.bold(`• Read (${callCount})`)), 1, 0));
		for (let index = 0; index < displayRows.length; index++) {
			const group = displayRows[index];
			const first = group.entries[0].row;
			const filePath = getReadGroupPath(first.args) ?? "";
			const selectors = READ_GROUP_SELECTOR_SET_POOL.acquire();
			let selectorText = "";
			let isError = false;
			let isPending = false;
			try {
				for (const entry of group.entries) {
					const selector = getReadGroupSelector(entry.row.args);
					if (selector && !selectors.has(selector)) {
						selectors.add(selector);
						selectorText += selectorText ? `,${selector}` : selector;
					}
					if (entry.row.resultIsError) isError = true;
					if (!entry.row.result || entry.row.isPartial) isPending = true;
				}
			} finally {
				READ_GROUP_SELECTOR_SET_POOL.release(selectors);
			}
			const icon = isError ? theme.fg("error", "✗") : isPending ? theme.fg("muted", "○") : theme.fg("muted", "•");
			const branch = callCount > 1 ? (index === displayRows.length - 1 ? "└─ " : "├─ ") : "";
			const label = branch + icon + " " + (callCount === 1 ? theme.fg("toolTitle", theme.bold("Read")) + " " : "") + theme.fg("accent", filePath) + theme.fg("warning", selectorText);
			this.addChild(new Text(label, callCount > 1 ? 2 : 1, 0));
			for (const entry of group.entries) {
				const output = getReadGroupResultText(entry.row.result);
				if (!output || (!this.expanded && !entry.row.resultIsError)) continue;
				const preview = this.expanded ? output : boundReadGroupPreview(output, 10);
				this.addChild(new Text(theme.fg(entry.row.resultIsError ? "error" : "toolOutput", preview), callCount > 1 ? 4 : 2, 0));
				if (
					this.expanded &&
					entry.row.toolResultDiscovery &&
					entry.row.result &&
					this.showImages &&
					getCapabilities().images !== null
				) {
					for (let blockIndex = 0; blockIndex < entry.row.result.content.length; blockIndex++) {
						const block = entry.row.result.content[blockIndex];
						if (block?.type !== "image" || !block.data || !block.mimeType) continue;
						this.addChild(new Image(
							block.data,
							block.mimeType,
							{ fallbackColor: toolImageFallbackColor },
							{ maxWidthCells: this.imageWidthCells },
						));
					}
				}
			}
			for (const entry of group.entries) {
				const discovery = entry.row.toolResultDiscovery;
				if (!discovery) continue;
				this.addChild(new Text(formatToolResultDiscovery(discovery, this.expanded), callCount > 1 ? 4 : 2, 0));
			}
		}
	}
}

let cachedBuiltInToolDefinitions: ReturnType<typeof createAllToolDefinitions> | undefined;
let cachedBuiltInToolDefinitionsCwd: string | undefined;
function getBuiltInToolDefinition(cwd: string, toolName: ToolName): ToolDefinition<any, any> | undefined {
	if (cachedBuiltInToolDefinitionsCwd !== cwd || !cachedBuiltInToolDefinitions) {
		cachedBuiltInToolDefinitionsCwd = cwd;
		cachedBuiltInToolDefinitions = createAllToolDefinitions(cwd);
	}
	return cachedBuiltInToolDefinitions[toolName];
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	/** Clears this component's retained sidecar after a late visual update. */
	onVisualInvalidate?: (component: ToolExecutionComponent) => void;
	/** Optional benchmark counters. The component only mutates primitive fields. */
	allocationMetrics?: ToolExecutionAllocationMetrics;
}

export interface ToolExecutionAllocationMetrics {
	updateDisplayCalls: number;
	callRendererCalls: number;
	resultRendererCalls: number;
	componentCreations: number;
	renderContextObjects: number;
	internalWrapperObjects: number;
	imageScans: number;
	argsSerializations: number;
	toolArgsGenerationUpdates: number;
	toolArgsReplacementUpdates: number;
	toolArgsSemanticFallbackComparisons: number;
	/** Compatibility-boundary deliveries missing adapter ownership/generation metadata. */
	toolArgsMissingGenerationUpdates: number;
	/** Per-tool stream finalization boundaries accepted by this component. */
	toolArgsFinalizations: number;
	imageConversionsScheduled?: number;
	imageConversionsAccepted?: number;
	imageConversionsDropped?: number;
	imageConversionRejections?: number;
}

type ConvertedTerminalImage = { data: string; mimeType: string };

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private renderLifecycleGeneration = 1;
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private imageSourceData: string[] = [];
	private imageSourceMimeTypes: string[] = [];
	private pendingImageSourceData: Array<string | undefined> = [];
	private pendingImageSourceMimeTypes: Array<string | undefined> = [];
	private pendingImageTaskGenerations: number[] = [];
	private nextImageTaskGeneration = 0;
	private activeImageConversions = 0;
	private activeImageConversionsHighWaterMark = 0;
	private imageConversionsScheduled = 0;
	private imageConversionsAccepted = 0;
	private imageConversionsDropped = 0;
	private imageConversionRejections = 0;
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private argsGeneration: ToolArgsGeneration;
	private argsSemanticJson: string | undefined;
	private argsStreamFinalized = false;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};
	private resultIsError = false;
	private toolResultDiscovery: ToolResultPresentationDiscoveryState | undefined;
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private callRendererDirty = true;
	private argsDisplayDirty = true;
	private argsDisplayJson = "";
	private imageTreeShowImages = false;
	private imageTreeWidthCells = 0;
	private imageTreeProtocol: ReturnType<typeof getCapabilities>["images"] = null;
	private imageConversionGeneration = 0;
	private imageTreeConversionGeneration = -1;
	private hideComponent = false;
	private readonly allocationMetrics: ToolExecutionAllocationMetrics | undefined;
	private readonly onVisualInvalidate: ((component: ToolExecutionComponent) => void) | undefined;
	private readonly renderContextInvalidate = (): void => {
		this.invalidate();
		this.notifyVisualInvalidation();
	};

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.argsGeneration = undefined;
		this.argsSemanticJson = undefined;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = getBuiltInToolDefinition(cwd, toolName as ToolName);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.onVisualInvalidate = options.onVisualInvalidate;
		this.allocationMetrics = options.allocationMetrics;
		this.ui = ui;
		this.cwd = cwd;
		(this.rendererState as ToolRenderLifecycleState)[TOOL_RENDER_LIFECYCLE_GENERATION] =
			this.renderLifecycleGeneration;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, toolPendingBackground);
		this.contentText = new Text("", 1, 1, toolPendingBackground);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private isCallRendererArgsOnly(): boolean {
		if (!this.toolDefinition?.renderCall) return true;
		return this.toolDefinition.renderCallStability === "args-only";
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		if (this.allocationMetrics) this.allocationMetrics.renderContextObjects++;
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: this.renderContextInvalidate,
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.resultIsError,
		};
	}

	private createCallFallback(): Component {
		if (this.allocationMetrics) this.allocationMetrics.componentCreations++;
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		if (this.allocationMetrics) this.allocationMetrics.componentCreations++;
		if (this.expanded) return new Text(theme.fg("toolOutput", output), 0, 0);
		let previewEnd = -1;
		for (let line = 0; line < 10; line++) {
			previewEnd = output.indexOf("\n", previewEnd + 1);
			if (previewEnd === -1) return new Text(theme.fg("toolOutput", output), 0, 0);
		}
		let remaining = 1;
		for (let cursor = output.indexOf("\n", previewEnd + 1); cursor !== -1; cursor = output.indexOf("\n", cursor + 1)) remaining++;
		const preview = theme.fg("toolOutput", output.slice(0, previewEnd));
		const suffix = theme.fg("muted", `\n... (${remaining} more lines,`) + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return new Text(preview + suffix, 0, 0);
	}

	/**
	 * `generation` is the provider's transient partial-JSON buffer identity.
	 * It makes same-object streaming mutations observable without serializing
	 * unchanged arguments. New object identities are compared semantically so a
	 * replacement with identical JSON does not rebuild the call renderer.
	 */
	updateArgs(
		args: any,
		generation?: ToolArgsGeneration,
		ownership?: StreamedToolArgumentOwnership,
		finalized = false,
	): boolean {
		if (this.argsStreamFinalized) return false;
		if (finalized) {
			this.argsStreamFinalized = true;
			if (this.allocationMetrics) this.allocationMetrics.toolArgsFinalizations++;
			this.args = args;
			this.argsGeneration = undefined;
			this.argsSemanticJson = undefined;
			this.callRendererDirty = true;
			this.argsDisplayDirty = true;
			this.updateDisplay();
			return true;
		}
		if (ownership === "mutation-with-generation") {
			if (generation === undefined) {
				if (this.allocationMetrics) this.allocationMetrics.toolArgsMissingGenerationUpdates++;
				this.args = args;
				this.argsGeneration = undefined;
				this.argsSemanticJson = undefined;
				this.callRendererDirty = true;
				this.argsDisplayDirty = true;
				this.updateDisplay();
				return true;
			}
			if (Object.is(this.argsGeneration, generation)) {
				this.args = args;
				return false;
			}
			if (this.allocationMetrics) this.allocationMetrics.toolArgsGenerationUpdates++;
			this.args = args;
			this.argsGeneration = generation;
			this.argsSemanticJson = undefined;
			this.callRendererDirty = true;
			this.argsDisplayDirty = true;
			this.updateDisplay();
			return true;
		}
		if (ownership === "replacement-object") {
			if (this.args === args) return false;
			if (this.allocationMetrics) this.allocationMetrics.toolArgsReplacementUpdates++;
		} else {
			if (this.allocationMetrics) this.allocationMetrics.toolArgsMissingGenerationUpdates++;
			if (generation !== undefined && Object.is(this.argsGeneration, generation)) {
				this.args = args;
				return false;
			}
			if (generation !== undefined) {
				this.args = args;
				this.argsGeneration = generation;
				this.argsSemanticJson = undefined;
				this.callRendererDirty = true;
				this.argsDisplayDirty = true;
				this.updateDisplay();
				return true;
			}
			if (this.args === args) {
				this.argsGeneration = undefined;
				this.argsSemanticJson = undefined;
				this.callRendererDirty = true;
				this.argsDisplayDirty = true;
				this.updateDisplay();
				return true;
			}
			if (this.allocationMetrics) this.allocationMetrics.toolArgsSemanticFallbackComparisons++;
		}
		if (this.args !== args) {
			const previousJson = this.argsSemanticJson ?? this.serializeArgs(this.args);
			const nextJson = this.serializeArgs(args);
			this.args = args;
			this.argsGeneration = generation;
			this.argsSemanticJson = nextJson;
			if (previousJson !== undefined && previousJson === nextJson) {
				this.argsDisplayJson = nextJson;
				this.argsDisplayDirty = false;
				return false;
			}
			if (nextJson !== undefined) {
				this.argsDisplayJson = nextJson;
				this.argsDisplayDirty = false;
			} else {
				this.argsDisplayDirty = true;
			}
		} else {
			this.argsGeneration = generation;
			this.argsSemanticJson = undefined;
			this.argsDisplayDirty = true;
		}
		this.callRendererDirty = true;
		this.updateDisplay();
		return true;
	}

	private serializeArgs(args: any): string | undefined {
		try {
			if (this.allocationMetrics) this.allocationMetrics.argsSerializations++;
			return JSON.stringify(args, null, 2) ?? "";
		} catch {
			return undefined;
		}
	}

	markExecutionStarted(): void {
		if (this.executionStarted) return;
		this.executionStarted = true;
		this.callRendererDirty = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		if (this.argsComplete) return;
		this.argsComplete = true;
		this.callRendererDirty = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial = false,
		isError = result.isError === true,
	): void {
		this.result = result;
		this.resultIsError = isError;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		let imageIndex = 0;
		for (let blockIndex = 0; blockIndex < this.result.content.length; blockIndex++) {
			const img = this.result.content[blockIndex];
			if (img.type !== "image") continue;
			if (!img.data || !img.mimeType) continue;
			const index = imageIndex++;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(index)) continue;
			if (
				this.pendingImageSourceData[index] === img.data &&
				this.pendingImageSourceMimeTypes[index] === img.mimeType
			) continue;

			this.cancelPendingImageConversion(index);
			const generation = ++this.nextImageTaskGeneration;
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			this.pendingImageSourceData[index] = sourceData;
			this.pendingImageSourceMimeTypes[index] = sourceMimeType;
			this.pendingImageTaskGenerations[index] = generation;
			this.activeImageConversions++;
			if (this.activeImageConversions > this.activeImageConversionsHighWaterMark) {
				this.activeImageConversionsHighWaterMark = this.activeImageConversions;
			}
			this.imageConversionsScheduled++;
			if (this.allocationMetrics) {
				this.allocationMetrics.imageConversionsScheduled =
					(this.allocationMetrics.imageConversionsScheduled ?? 0) + 1;
			}
			void this.convertImageForTerminal(sourceData, sourceMimeType).then(
				(converted) => this.completeImageConversion(index, generation, converted),
				() => this.rejectImageConversion(index, generation),
			);
		}
	}

	private cancelPendingImageConversion(index: number): void {
		if ((this.pendingImageTaskGenerations[index] ?? 0) === 0) return;
		this.pendingImageTaskGenerations[index] = 0;
		this.pendingImageSourceData[index] = undefined;
		this.pendingImageSourceMimeTypes[index] = undefined;
		this.activeImageConversions--;
	}

	/** Deterministic conversion seam for lifecycle tests; production uses Photon. */
	protected convertImageForTerminal(data: string, mimeType: string): Promise<ConvertedTerminalImage | null> {
		return convertToPng(data, mimeType);
	}

	private completeImageConversion(
		index: number,
		generation: number,
		converted: ConvertedTerminalImage | null,
	): void {
		if (this.pendingImageTaskGenerations[index] !== generation) {
			this.recordDroppedImageConversion();
			return;
		}
		const sourceData = this.pendingImageSourceData[index];
		const sourceMimeType = this.pendingImageSourceMimeTypes[index];
		this.finishImageConversion(index);
		if (
			this.imageSourceData[index] !== sourceData ||
			this.imageSourceMimeTypes[index] !== sourceMimeType
		) {
			this.recordDroppedImageConversion();
			return;
		}
		if (converted === null) return;
		this.convertedImages.set(index, converted);
		this.imageConversionsAccepted++;
		if (this.allocationMetrics) {
			this.allocationMetrics.imageConversionsAccepted =
				(this.allocationMetrics.imageConversionsAccepted ?? 0) + 1;
		}
		this.imageConversionGeneration++;
		this.updateDisplay();
		this.notifyVisualInvalidation();
	}

	private rejectImageConversion(index: number, generation: number): void {
		if (this.pendingImageTaskGenerations[index] !== generation) {
			this.recordDroppedImageConversion();
			return;
		}
		this.finishImageConversion(index);
		this.imageConversionRejections++;
		if (this.allocationMetrics) {
			this.allocationMetrics.imageConversionRejections =
				(this.allocationMetrics.imageConversionRejections ?? 0) + 1;
		}
	}

	private recordDroppedImageConversion(): void {
		this.imageConversionsDropped++;
		if (this.allocationMetrics) {
			this.allocationMetrics.imageConversionsDropped =
				(this.allocationMetrics.imageConversionsDropped ?? 0) + 1;
		}
	}

	private finishImageConversion(index: number): void {
		this.pendingImageTaskGenerations[index] = 0;
		this.pendingImageSourceData[index] = undefined;
		this.pendingImageSourceMimeTypes[index] = undefined;
		this.activeImageConversions--;
	}

	private notifyVisualInvalidation(): void {
		this.onVisualInvalidate?.(this);
		this.ui.requestRender();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.callRendererDirty = true;
		this.updateDisplay();
	}

	setToolResultPresentation(toolCallId: string, presentation: ToolResultPresentation): string | undefined {
		if (toolCallId !== this.toolCallId) return undefined;
		this.toolResultDiscovery = createToolResultDiscovery(presentation);
		this.updateDisplay();
		return this.toolResultDiscovery?.identity;
	}

	clearToolResultPresentation(toolCallId: string, identity?: string): void {
		if (!this.detachToolResultPresentation(toolCallId, identity)) return;
		this.updateDisplay();
	}

	detachToolResultPresentation(toolCallId: string, identity?: string): boolean {
		if (
			toolCallId !== this.toolCallId ||
			!this.toolResultDiscovery ||
			(identity !== undefined && this.toolResultDiscovery.identity !== identity)
		) return false;
		this.toolResultDiscovery = undefined;
		return true;
	}

	getToolResultPresentationDiscovery(toolCallId: string): ToolResultPresentationDiscoveryState | undefined {
		return toolCallId === this.toolCallId ? this.toolResultDiscovery : undefined;
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		this.callRendererDirty = true;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		const nextWidth = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === nextWidth) return;
		this.imageWidthCells = nextWidth;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.callRendererDirty = true;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.renderLifecycleGeneration++;
		const lifecycleState = this.rendererState as ToolRenderLifecycleState;
		lifecycleState[TOOL_RENDER_LIFECYCLE_GENERATION] = this.renderLifecycleGeneration;
		let releaseError: unknown;
		let releaseFailed = false;
		try {
			lifecycleState[RELEASE_TOOL_RENDER_DERIVED_STATE]?.(lifecycleState);
		} catch (error) {
			releaseError = error;
			releaseFailed = true;
		}
		for (let index = 0; index < this.imageComponents.length; index++) {
			this.removeChild(this.imageComponents[index]!);
		}
		for (let index = 0; index < this.imageSpacers.length; index++) {
			this.removeChild(this.imageSpacers[index]!);
		}
		this.activeImageConversions = 0;
		this.convertedImages = new Map();
		this.imageComponents = [];
		this.imageSpacers = [];
		this.imageSourceData = [];
		this.imageSourceMimeTypes = [];
		this.pendingImageSourceData = [];
		this.pendingImageSourceMimeTypes = [];
		this.pendingImageTaskGenerations = [];
		this.imageTreeProtocol = null;
		this.imageTreeWidthCells = 0;
		this.imageTreeConversionGeneration = -1;
		this.toolResultDiscovery = undefined;
		if (releaseFailed) throw releaseError;
	}

	/** Low-frequency lifecycle diagnostics; never called from update/render. */
	getImageConversionLifecycleCounts(): {
		activePending: number;
		activePendingHighWaterMark: number;
		scheduled: number;
		accepted: number;
		dropped: number;
		rejected: number;
		convertedImages: number;
		imageComponents: number;
		imageSpacers: number;
		sourceReferences: number;
		pendingSourceReferences: number;
		pendingGenerationReferences: number;
	} {
		let pendingSourceReferences = 0;
		let pendingGenerationReferences = 0;
		for (let index = 0; index < this.pendingImageSourceData.length; index++) {
			if (this.pendingImageSourceData[index] !== undefined) pendingSourceReferences++;
			if (this.pendingImageSourceMimeTypes[index] !== undefined) pendingSourceReferences++;
			if ((this.pendingImageTaskGenerations[index] ?? 0) !== 0) pendingGenerationReferences++;
		}
		return {
			activePending: this.activeImageConversions,
			activePendingHighWaterMark: this.activeImageConversionsHighWaterMark,
			scheduled: this.imageConversionsScheduled,
			accepted: this.imageConversionsAccepted,
			dropped: this.imageConversionsDropped,
			rejected: this.imageConversionRejections,
			convertedImages: this.convertedImages.size,
			imageComponents: this.imageComponents.length,
			imageSpacers: this.imageSpacers.length,
			sourceReferences: this.imageSourceData.length + this.imageSourceMimeTypes.length,
			pendingSourceReferences,
			pendingGenerationReferences,
		};
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		if (this.allocationMetrics) this.allocationMetrics.updateDisplayCalls++;
		const bgFn = this.isPartial ? toolPendingBackground : this.resultIsError ? toolErrorBackground : toolSuccessBackground;

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.children.length = 0;

			const callRenderer = this.getCallRenderer();
			if (!this.isCallRendererArgsOnly() || this.callRendererDirty || !this.callRendererComponent) {
				if (!callRenderer) {
					this.callRendererComponent = this.createCallFallback();
				} else {
					try {
						if (this.allocationMetrics) this.allocationMetrics.callRendererCalls++;
						this.callRendererComponent = callRenderer(
							this.args,
							theme,
							this.getRenderContext(this.callRendererComponent),
						);
					} catch {
						this.callRendererComponent = this.createCallFallback();
					}
				}
				this.callRendererDirty = false;
			}
			if (this.callRendererComponent) {
				renderContainer.addChild(this.callRendererComponent);
				hasContent = true;
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						if (this.allocationMetrics) {
							this.allocationMetrics.resultRendererCalls++;
							this.allocationMetrics.internalWrapperObjects += 2;
						}
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
			if (this.toolResultDiscovery) {
				renderContainer.addChild(new Text(formatToolResultDiscovery(this.toolResultDiscovery, this.expanded), 0, 0));
				hasContent = true;
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}
		this.refreshImageTree();

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		if (this.argsDisplayDirty) {
			this.argsDisplayJson = this.serializeArgs(this.args) ?? "";
			this.argsSemanticJson = this.argsDisplayJson;
			this.argsDisplayDirty = false;
		}
		const content = this.argsDisplayJson;
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		if (this.toolResultDiscovery) {
			text += `\n${formatToolResultDiscovery(this.toolResultDiscovery, this.expanded)}`;
		}
		return text;
	}

	private refreshImageTree(): void {
		const result = this.result;
		const capabilities = getCapabilities();
		let imageCount = 0;
		let changed =
			this.imageTreeShowImages !== this.showImages ||
			this.imageTreeWidthCells !== this.imageWidthCells ||
			this.imageTreeProtocol !== capabilities.images ||
			this.imageTreeConversionGeneration !== this.imageConversionGeneration;
		if (result) {
			if (this.allocationMetrics) this.allocationMetrics.imageScans++;
			for (let index = 0; index < result.content.length; index++) {
				const block = result.content[index];
				if (block.type !== "image" || !block.data || !block.mimeType) continue;
				if (this.imageSourceData[imageCount] !== block.data || this.imageSourceMimeTypes[imageCount] !== block.mimeType) {
					changed = true;
					this.convertedImages.delete(imageCount);
				}
				imageCount++;
			}
		}
		if (imageCount !== this.imageSourceData.length) changed = true;
		if (!changed) return;
		for (const index of this.convertedImages.keys()) {
			if (index >= imageCount) this.convertedImages.delete(index);
		}
		for (let index = imageCount; index < this.pendingImageTaskGenerations.length; index++) {
			this.cancelPendingImageConversion(index);
		}

		for (let index = 0; index < this.imageComponents.length; index++) this.removeChild(this.imageComponents[index]);
		for (let index = 0; index < this.imageSpacers.length; index++) this.removeChild(this.imageSpacers[index]);
		this.imageComponents.length = 0;
		this.imageSpacers.length = 0;
		this.imageSourceData.length = 0;
		this.imageSourceMimeTypes.length = 0;
		this.pendingImageSourceData.length = imageCount;
		this.pendingImageSourceMimeTypes.length = imageCount;
		this.pendingImageTaskGenerations.length = imageCount;
		this.imageTreeShowImages = this.showImages;
		this.imageTreeWidthCells = this.imageWidthCells;
		this.imageTreeProtocol = capabilities.images;
		this.imageTreeConversionGeneration = this.imageConversionGeneration;
		if (!result) return;

		let imageIndex = 0;
		for (let index = 0; index < result.content.length; index++) {
			const block = result.content[index];
			if (block.type !== "image" || !block.data || !block.mimeType) continue;
			this.imageSourceData.push(block.data);
			this.imageSourceMimeTypes.push(block.mimeType);
			if (capabilities.images && this.showImages) {
				const converted = this.convertedImages.get(imageIndex);
				const imageData = converted?.data ?? block.data;
				const imageMimeType = converted?.mimeType ?? block.mimeType;
				if (capabilities.images !== "kitty" || imageMimeType === "image/png") {
					const spacer = new Spacer(1);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: toolImageFallbackColor },
						{ maxWidthCells: this.imageWidthCells },
					);
					if (this.allocationMetrics) this.allocationMetrics.componentCreations += 2;
					this.imageSpacers.push(spacer);
					this.imageComponents.push(imageComponent);
					this.addChild(spacer);
					this.addChild(imageComponent);
				}
			}
			imageIndex++;
		}
	}
}
