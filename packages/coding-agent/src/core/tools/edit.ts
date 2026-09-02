import type { AgentTool } from "@super-pi/agent-core";
import { Container, Spacer, Text } from "@super-pi/tui";
import { TextDecoder } from "node:util";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getDiffRenderThemeSignature, renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { splitBom } from "../../utils/text.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import {
	RELEASE_TOOL_RENDER_DERIVED_STATE,
	TOOL_RENDER_LIFECYCLE_GENERATION,
	type ToolRenderLifecycleState,
} from "./tool-render-lifecycle.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = ToolRenderLifecycleState & {
	callComponent?: EditCallRenderComponent;
	previewTasksScheduled?: number;
	previewTasksAccepted?: number;
	previewTasksDropped?: number;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	let args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args = { ...args, edits: parsed };
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditDiffRenderCache = {
	renderedDiffSource?: string;
	renderedDiffExpanded?: boolean;
	renderedDiffThemeSignature?: string;
	renderedDiffBody?: string;
};

type EditCallRenderComponent = Container & EditDiffRenderCache & {
	editCallRenderComponent: true;
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Container(), {
		editCallRenderComponent: true as const,
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
		renderedDiffSource: undefined as string | undefined,
		renderedDiffExpanded: undefined as boolean | undefined,
		renderedDiffThemeSignature: undefined as string | undefined,
		renderedDiffBody: undefined as string | undefined,
	});
}

function releaseEditRenderDerivedState(state: unknown): void {
	const component = (state as EditRenderState).callComponent;
	if (!component) return;
	component.preview = undefined;
	component.previewArgsKey = undefined;
	component.previewPending = false;
	component.settledError = false;
	component.renderedDiffSource = undefined;
	component.renderedDiffExpanded = undefined;
	component.renderedDiffThemeSignature = undefined;
	component.renderedDiffBody = undefined;
	component.clear();
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	state[RELEASE_TOOL_RENDER_DERIVED_STATE] = releaseEditRenderDerivedState;
	if ((lastComponent as EditCallRenderComponent | undefined)?.editCallRenderComponent === true) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

const MAX_COLLAPSED_EDIT_DIFF_LINES = 20;

function getCollapsedEditDiff(diff: string): { diff: string; hiddenChanges: number } {
	const changes: Array<{ line: string; group: number; index: number }> = [];
	let group = 0;
	let pendingBoundary = false;
	for (const line of diff.split("\n")) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		if (!isChange) {
			if (changes.length > 0) pendingBoundary = true;
			continue;
		}
		if (pendingBoundary) group++;
		pendingBoundary = false;
		changes.push({ line, group, index: changes.length });
	}
	const half = MAX_COLLAPSED_EDIT_DIFF_LINES / 2;
	const selected = changes.length <= MAX_COLLAPSED_EDIT_DIFF_LINES
		? changes
		: [...changes.slice(0, half), ...changes.slice(-half)];
	const output: string[] = [];
	let previous: (typeof changes)[number] | undefined;
	for (const change of selected) {
		if (previous && (change.group !== previous.group || change.index !== previous.index + 1)) output.push("  ...");
		output.push(change.line);
		previous = change;
	}
	return { diff: output.join("\n"), hiddenChanges: changes.length - selected.length };
}

function getRenderedEditDiff(component: EditDiffRenderCache, diff: string, expanded: boolean, theme: Theme): string {
	const themeSignature = getDiffRenderThemeSignature();
	if (
		component.renderedDiffSource !== diff ||
		component.renderedDiffExpanded !== expanded ||
		component.renderedDiffThemeSignature !== themeSignature
	) {
		const display = expanded ? { diff, hiddenChanges: 0 } : getCollapsedEditDiff(diff);
		component.renderedDiffSource = diff;
		component.renderedDiffExpanded = expanded;
		component.renderedDiffThemeSignature = themeSignature;
		component.renderedDiffBody = renderDiff(display.diff);
		if (display.hiddenChanges > 0) {
			component.renderedDiffBody += theme.fg("muted", `\n… ${display.hiddenChanges} more diff lines · Ctrl+O`);
		}
	}
	return component.renderedDiffBody ?? "";
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	expanded = false,
): EditCallRenderComponent {
	const header = getEditHeaderBg(component.preview, component.settledError, theme)(formatEditCall(args, theme, cwd));
	component.clear();
	component.addChild(new Text(header, 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview
			? theme.fg("error", component.preview.error)
			: getRenderedEditDiff(component, component.preview.diff, expanded, theme);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				let rawContent: string;
				try {
					rawContent = strictUtf8Decoder.decode(buffer);
				} catch {
					throw new Error(`Could not edit file: ${path}. The file is not valid UTF-8; refusing a lossy rewrite.`);
				}
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const state = context.state as EditRenderState;
			const component = getEditCallRenderComponent(state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				state.previewTasksScheduled = (state.previewTasksScheduled ?? 0) + 1;
				const requestKey = argsKey;
				const requestGeneration = state[TOOL_RENDER_LIFECYCLE_GENERATION];
				const invalidate = context.invalidate;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (
						state[TOOL_RENDER_LIFECYCLE_GENERATION] !== requestGeneration ||
						component.previewArgsKey !== requestKey
					) {
						state.previewTasksDropped = (state.previewTasksDropped ?? 0) + 1;
						return;
					}
					state.previewTasksAccepted = (state.previewTasksAccepted ?? 0) + 1;
					setEditPreview(component, preview, requestKey);
					invalidate();
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd, context.expanded);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			const errorText = context.isError
				? typedResult.content.filter((c) => c.type === "text").map((c) => c.text || "").join("\n")
				: "";
			let changed = false;
			if (callComponent) {
				if (errorText) {
					changed = setEditPreview(callComponent, { error: errorText }, argsKey) || changed;
				} else if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
						context.expanded,
					);
				}
			}

			const component = Object.assign((context.lastComponent as Container | undefined) ?? new Container(), {}) as Container & EditDiffRenderCache;
			component.clear();
			if (callComponent) return component;
			const output = context.isError
				? (errorText ? theme.fg("error", errorText) : undefined)
				: typeof resultDiff === "string" && resultDiff
					? getRenderedEditDiff(component, resultDiff, context.expanded, theme)
					: undefined;
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
