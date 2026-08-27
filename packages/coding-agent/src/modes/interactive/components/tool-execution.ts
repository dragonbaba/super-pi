import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@super-pi/tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { ObjectPool } from "../../../utils/object-pool.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { READ_GROUP_BACKSLASH_PATTERN, READ_GROUP_IMAGE_EXTENSION_PATTERN } from "./tool-execution-regex.ts";

const READ_GROUP_SPECIAL_BASENAMES = new Set(["skill.md", "agents.md", "agents.override.md", "claude.md"]);
const READ_GROUP_MAX_PREVIEW_CHARS = 4000;
const READ_GROUP_MAX_PREVIEW_LINES = 50;
const READ_GROUP_SELECTOR_SET_POOL = new ObjectPool(
	() => new Set<string>(),
	(selectors) => selectors.clear(),
	4,
	(selectors) => selectors.size <= 128,
);

type ToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError: boolean;
	details?: any;
};

type ReadGroupRow = {
	args: any;
	started: boolean;
	argsComplete: boolean;
	result?: ToolResultLike;
	isPartial: boolean;
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
	return result.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
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

	canAccept(args: any): boolean { return !this.finalized && isGroupableReadCall(args); }
	updateArgs(toolCallId: string, args: any): boolean {
		let row = this.rows.get(toolCallId);
		if (!row) {
			if (this.finalized) return false;
			row = { args, started: false, argsComplete: false, result: undefined, isPartial: true };
			this.rows.set(toolCallId, row);
		} else row.args = args;
		this.rebuild();
		return true;
	}
	markExecutionStarted(toolCallId: string): void { const row = this.rows.get(toolCallId); if (row) { row.started = true; this.rebuild(); } }
	setArgsComplete(toolCallId: string): void { const row = this.rows.get(toolCallId); if (row) { row.argsComplete = true; this.rebuild(); } }
	updateResult(toolCallId: string, result: ToolResultLike, isPartial = false): void { const row = this.rows.get(toolCallId); if (row) { row.result = result; row.isPartial = isPartial; this.rebuild(); } }
	finalize(): void { if (!this.finalized) { this.finalized = true; this.rebuild(); } }
	canFreezeRender(): boolean {
		if (!this.finalized || this.rows.size === 0) return false;
		for (const row of this.rows.values()) {
			if (!row.result || row.isPartial) return false;
		}
		return true;
	}
	setExpanded(expanded: boolean): void { if (this.expanded !== expanded) { this.expanded = expanded; this.rebuild(); } }
	override invalidate(): void { super.invalidate(); this.rebuild(); }

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
				const mergeable = filePath && entry.row.argsComplete && entry.row.result && !entry.row.isPartial && !entry.row.result.isError;
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
					if (entry.row.result?.isError) isError = true;
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
				if (!output || (!this.expanded && !entry.row.result?.isError)) continue;
				const preview = boundReadGroupPreview(output, this.expanded ? READ_GROUP_MAX_PREVIEW_LINES : 10);
				this.addChild(new Text(theme.fg(entry.row.result?.isError ? "error" : "toolOutput", preview), callCount > 1 ? 4 : 2, 0));
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
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
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
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

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
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = getBuiltInToolDefinition(cwd, toolName as ToolName);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
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
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
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

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
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
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
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
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
