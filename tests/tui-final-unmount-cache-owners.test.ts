import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	Box as ProductionBox,
	Editor as ProductionEditor,
	Image as ProductionImage,
	Markdown as ProductionMarkdown,
	RetainedContainer as ProductionRetainedContainer,
	RetainedItem as ProductionRetainedItem,
	Text as ProductionText,
	TuiAltScreen as ProductionTuiAltScreen,
	TuiMainScreen as ProductionTuiMainScreen,
	ViewportContainer as ProductionViewportContainer,
} from "@super-pi/tui";
import ts from "typescript";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { AssistantMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	GET_COMPONENT_RENDER_CACHE_CHILD,
	GET_COMPONENT_RENDER_CACHE_CHILDREN,
	RELEASE_COMPONENT_RENDER_CACHE,
} from "../packages/tui/src/component-cache.ts";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import { Image } from "../packages/tui/src/components/image.ts";
import {
	Markdown,
	type MarkdownIncrementalMetrics,
	type MarkdownTheme,
} from "../packages/tui/src/components/markdown.ts";
import { RetainedItem } from "../packages/tui/src/components/retained-item.ts";
import { SettingsList, type SettingsListTheme } from "../packages/tui/src/components/settings-list.ts";
import { Text } from "../packages/tui/src/components/text.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { getCapabilities, setCapabilities } from "../packages/tui/src/terminal-image.ts";
import { Container, type Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

initTheme("dark");

function identity(value: string): string {
	return value;
}

const MARKDOWN_THEME: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

const EDITOR_THEME: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

const SETTINGS_THEME: SettingsListTheme = {
	label: identitySelection,
	value: identitySelection,
	description: identity,
	cursor: "> ",
	hint: identity,
};

function identitySelection(value: string, _selected: boolean): string {
	return value;
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "final-unmount-fixture",
		model: "final-unmount-fixture",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function findComponent<T extends Component>(root: Component, constructor: abstract new (...args: never[]) => T): T | undefined {
	if (root instanceof constructor) return root;
	const child = root[GET_COMPONENT_RENDER_CACHE_CHILD]?.();
	if (child !== undefined) {
		const match = findComponent(child, constructor);
		if (match !== undefined) return match;
	}
	const children = root[GET_COMPONENT_RENDER_CACHE_CHILDREN]?.() ??
		(root as unknown as { children?: readonly Component[] }).children;
	if (children === undefined) return undefined;
	for (let index = 0; index < children.length; index++) {
		const match = findComponent(children[index]!, constructor);
		if (match !== undefined) return match;
	}
	return undefined;
}

function createMarkdownMetrics(): MarkdownIncrementalMetrics {
	return {
		incrementalEligibleUpdates: 0,
		incrementalUpdates: 0,
		fullFallbacks: 0,
		sourceCharactersReparsed: 0,
		sourceCharactersRewrapped: 0,
		parserTokensReused: 0,
		parserTokensRebuilt: 0,
		renderedPrefixLinesReused: 0,
		tailLinesRebuilt: 0,
		cachedTokenCount: 0,
		cachedRenderedLines: 0,
		cachedSourceCharacters: 0,
		lastFallbackReason: "none",
	};
}

interface MarkdownRawCache {
	cachedLines?: string[];
	incrementalNormalizedText?: string;
	incrementalTokenSignatures?: Array<string | undefined>;
	incrementalTokenContentLines?: string[][];
	incrementalPlainContentLines?: string[];
}

interface TextRawCache {
	cachedLines?: string[];
}

interface ImageRawCache {
	cachedLines?: string[];
	base64Data: string;
	imageId?: number;
}

interface ViewportRawScratch {
	childMutationTokens: unknown[];
	childHeights: number[];
	tailChildLines: Array<readonly string[] | undefined>;
	tailChildStarts: number[];
	tailChildLeadingKittyImages: unknown[];
	childMutationScratch: {
		token: unknown;
		kind: string;
		earliestChangedLine?: number;
		latestChangedLine?: number;
		heightChanged?: boolean;
	};
}

interface EditorRawCache {
	layoutCacheSourceLines: string[];
}

interface AltRawDocument {
	lastDocument: string[];
}

interface MainRawScratch {
	previousLines: string[];
	viewportMutationTokens: unknown[];
	frameRootHeights: number[];
	frameRootLines: unknown[];
	frameRootLineStarts: number[];
	frameRootLeadingKittyImages: unknown[];
	boundedFrameLinesA: string[];
	boundedFrameLinesB: string[];
}

interface BoxRawCache {
	cache?: unknown;
}

interface RetainedItemRawState {
	logicalVersion: number;
}

class StaticLine implements Component {
	value: string;

	constructor(value: string) {
		this.value = value;
	}

	invalidate(): void {}
	setValue(value: string): void {
		this.value = value;
	}

	render(): string[] {
		return [this.value];
	}
}

class GatedRestorationTerminal extends FakeTerminal {
	private restorationResolve: (() => void) | undefined;
	private readonly restorationPromise: Promise<void>;

	constructor(columns: number, rows: number) {
		super(columns, rows);
		this.restorationPromise = new Promise<void>((resolve) => {
			this.restorationResolve = resolve;
		});
	}

	override write(data: string): void | Promise<void> {
		this.writes.push(data);
		return data.includes("\x1b[?1049l") ? this.restorationPromise : undefined;
	}

	completeRestoration(): void {
		this.restorationResolve?.();
		this.restorationResolve = undefined;
	}
}

class RejectingControlTerminal extends FakeTerminal {
	override write(data: string): void | Promise<void> {
		this.writes.push(data);
		return data.includes("\x1b[?1049l")
			? Promise.reject(new Error("fixture terminal restoration failure"))
			: undefined;
	}
}

class NeverSettlingControlTerminal extends FakeTerminal {
	override write(data: string): void | Promise<void> {
		this.writes.push(data);
		return data.includes("\x1b[?1049l") ? new Promise<void>(() => {}) : undefined;
	}
}

class StaticDocument implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

test("final disposal releases Markdown Text and Image derived caches while preserving logical sources", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiMainScreen(terminal, false);
	const root = new Container();
	const metrics = createMarkdownMetrics();
	const markdown = new Markdown("stream 中文 😀 e\u0301", 0, 0, MARKDOWN_THEME, undefined, {
		incrementalRenderCache: true,
	}, metrics);
	const text = new Text("direct \x1b[31mANSI\x1b[0m 中文 😀 e\u0301", 0, 0);
	const imageSource = "AA==";
	const image = new Image(imageSource, "image/png", { fallbackColor: identity }, {}, { widthPx: 10, heightPx: 10 });
	root.addChild(markdown);
	root.addChild(text);
	root.addChild(image);
	tui.addChild(root);
	tui.start();
	tui.renderNow();
	markdown.setText("stream 中文 😀 e\u0301 append");
	tui.renderNow();

	const markdownRaw = markdown as unknown as MarkdownRawCache;
	const textRaw = text as unknown as TextRawCache;
	const imageRaw = image as unknown as ImageRawCache;
	assert.ok((markdownRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((markdownRaw.incrementalNormalizedText?.length ?? 0) > 0);
	assert.ok(metrics.cachedSourceCharacters > 0);
	assert.ok((textRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((imageRaw.cachedLines?.length ?? 0) > 0);
	const imageId = imageRaw.imageId;

	await tui.dispose({ preserveScreen: true });
	assert.equal(markdownRaw.cachedLines, undefined);
	assert.equal(markdownRaw.incrementalNormalizedText, undefined);
	assert.equal(markdownRaw.incrementalTokenSignatures, undefined);
	assert.equal(markdownRaw.incrementalTokenContentLines, undefined);
	assert.equal(markdownRaw.incrementalPlainContentLines, undefined);
	assert.equal(metrics.cachedTokenCount, 0);
	assert.equal(metrics.cachedRenderedLines, 0);
	assert.equal(metrics.cachedSourceCharacters, 0);
	assert.equal(textRaw.cachedLines, undefined);
	assert.equal(imageRaw.cachedLines, undefined);
	assert.equal(imageRaw.base64Data, imageSource);
	assert.equal(imageRaw.imageId, imageId);

	const referenceMarkdown = new Markdown("stream 中文 😀 e\u0301 append", 0, 0, MARKDOWN_THEME, undefined, {
		incrementalRenderCache: true,
	});
	assert.deepEqual(markdown.render(80), referenceMarkdown.render(80));
	assert.deepEqual(text.render(80), new Text("direct \x1b[31mANSI\x1b[0m 中文 😀 e\u0301", 0, 0).render(80));
	assert.deepEqual(
		image.render(80),
		new Image(imageSource, "image/png", { fallbackColor: identity }, {}, { widthPx: 10, heightPx: 10 }).render(80),
	);
});

test("production Assistant and User message trees release nested Markdown and Text caches", async () => {
	const tui = new ProductionTuiMainScreen(new FakeTerminal(120, 40), false);
	const assistant = new AssistantMessageComponent(undefined, true, MARKDOWN_THEME, "Thinking...", 1, []);
	assistant.updateContent(
		assistantMessage([
			{ type: "thinking", thinking: "hidden thought 中文 😀 e\u0301" },
			{ type: "text", text: "stream **Markdown** 中文 😀 e\u0301" },
		]),
		true,
	);
	const user = new UserMessageComponent("user `ANSI` 中文 😀 e\u0301", MARKDOWN_THEME, 1, []);
	tui.addChild(assistant);
	tui.addChild(user);
	tui.start();
	tui.renderNow();
	assistant.updateContent(
		assistantMessage([
			{ type: "thinking", thinking: "hidden thought 中文 😀 e\u0301" },
			{ type: "text", text: "stream **Markdown** 中文 😀 e\u0301 append" },
		]),
		true,
	);
	tui.renderNow();

	const assistantMarkdown = findComponent(assistant, ProductionMarkdown);
	const assistantText = findComponent(assistant, ProductionText);
	const userMarkdown = findComponent(user, ProductionMarkdown);
	assert.ok(assistantMarkdown);
	assert.ok(assistantText);
	assert.ok(userMarkdown);
	const assistantMarkdownRaw = assistantMarkdown as unknown as MarkdownRawCache;
	const assistantTextRaw = assistantText as unknown as TextRawCache;
	const userMarkdownRaw = userMarkdown as unknown as MarkdownRawCache;
	assert.ok((assistantMarkdownRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((assistantMarkdownRaw.incrementalNormalizedText?.length ?? 0) > 0);
	assert.ok((assistantTextRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((userMarkdownRaw.cachedLines?.length ?? 0) > 0);

	await tui.dispose({ preserveScreen: true });
	assert.equal(assistantMarkdownRaw.cachedLines, undefined);
	assert.equal(assistantMarkdownRaw.incrementalNormalizedText, undefined);
	assert.equal(assistantTextRaw.cachedLines, undefined);
	assert.equal(userMarkdownRaw.cachedLines, undefined);
	assert.ok(assistant.render(80).length > 0);
	assert.ok(user.render(80).length > 0);
});

test("final disposal traverses an active SettingsList submenu without closing it", async () => {
	const submenuText = new Text("submenu cached text 中文 😀 e\u0301", 0, 0);
	const submenu = new Container();
	submenu.addChild(submenuText);
	const settings = new SettingsList(
		[
			{
				id: "theme",
				label: "Theme",
				currentValue: "dark",
				submenu: () => submenu,
			},
		],
		5,
		SETTINGS_THEME,
		() => {},
		() => {},
	);
	settings.handleInput("\r");
	assert.ok(settings.render(80).length > 0);
	const raw = submenuText as unknown as TextRawCache;
	assert.ok((raw.cachedLines?.length ?? 0) > 0);

	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	tui.addChild(settings);
	tui.start();
	tui.renderNow();
	await tui.dispose({ preserveScreen: true });

	assert.equal(raw.cachedLines, undefined);
	assert.deepEqual(settings.render(80), submenu.render(80));
});

test("Kitty Image release clears the cached sequence without changing image identity or source", () => {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const source = "AA==";
		const image = new Image(source, "image/png", { fallbackColor: identity }, { maxWidthCells: 10 }, {
			widthPx: 10,
			heightPx: 10,
		});
		assert.ok(image.render(80).length > 0);
		const raw = image as unknown as ImageRawCache;
		const imageId = raw.imageId;
		assert.ok(imageId !== undefined);
		assert.ok((raw.cachedLines?.length ?? 0) > 0);
		image[RELEASE_COMPONENT_RENDER_CACHE]?.();
		assert.equal(raw.cachedLines, undefined);
		assert.equal(raw.base64Data, source);
		assert.equal(raw.imageId, imageId);
		assert.ok(image.render(80).length > 0);
		assert.equal(raw.imageId, imageId);
	} finally {
		setCapabilities(previousCapabilities);
	}
});

function verifyViewportRelease(itemCount: number): void {
	const candidate = new ViewportContainer();
	const reference = new ViewportContainer();
	for (let index = 0; index < itemCount; index++) {
		candidate.addChild(new StaticLine(`line-${index} 中文 😀 e\u0301`));
		reference.addChild(new StaticLine(`line-${index} 中文 😀 e\u0301`));
	}
	const candidateCompleted = new RetainedItem(new Text("completed \x1b[31mANSI\x1b[0m", 0, 0), {
		id: `completed-${itemCount}`,
		version: 1,
		completed: true,
	});
	const referenceCompleted = new RetainedItem(new Text("completed \x1b[31mANSI\x1b[0m", 0, 0), {
		id: `completed-${itemCount}`,
		version: 1,
		completed: true,
	});
	const candidateActive = new StaticLine("active-before");
	const referenceActive = new StaticLine("active-before");
	candidate.addChild(candidateCompleted);
	candidate.addChild(candidateActive);
	reference.addChild(referenceCompleted);
	reference.addChild(referenceActive);
	assert.deepEqual(candidate.renderViewportTail(120, 40), reference.renderViewportTail(120, 40));
	const observation = candidate.observeViewportMutation(120);
	const raw = candidate as unknown as ViewportRawScratch;
	const childrenIdentity = candidate.children;
	const oldTokens = raw.childMutationTokens;
	const oldHeights = raw.childHeights;
	const oldLines = raw.tailChildLines;
	const oldStarts = raw.tailChildStarts;
	const oldKitty = raw.tailChildLeadingKittyImages;
	assert.equal(oldHeights.length, itemCount + 2);
	assert.equal(oldLines.length, itemCount + 2);
	assert.ok(candidateCompleted.cachedLineCount > 0);

	candidate[RELEASE_COMPONENT_RENDER_CACHE]?.();
	assert.equal(candidate.children, childrenIdentity);
	assert.equal(candidate.children.length, itemCount + 2);
	assert.equal(candidateCompleted.completed, true);
	assert.equal(candidateCompleted.completedVersion, 1);
	assert.notEqual(raw.childMutationTokens, oldTokens);
	assert.notEqual(raw.childHeights, oldHeights);
	assert.notEqual(raw.tailChildLines, oldLines);
	assert.notEqual(raw.tailChildStarts, oldStarts);
	assert.notEqual(raw.tailChildLeadingKittyImages, oldKitty);
	assert.equal(raw.childMutationTokens.length, 0);
	assert.equal(raw.childHeights.length, 0);
	assert.equal(raw.tailChildLines.length, 0);
	assert.equal(raw.tailChildStarts.length, 0);
	assert.equal(raw.tailChildLeadingKittyImages.length, 0);
	assert.equal(raw.childMutationScratch.token, undefined);
	assert.equal(candidate.observeViewportMutation(80, observation.token).kind, "unsafe");
	candidateActive.setValue("active-after 中文 😀 e\u0301");
	referenceActive.setValue("active-after 中文 😀 e\u0301");
	assert.deepEqual(candidate.renderViewportTail(80, 40), reference.renderViewportTail(80, 40));
	candidate[RELEASE_COMPONENT_RENDER_CACHE]?.();
	assert.equal(raw.childHeights.length, 0);
	assert.deepEqual(candidate.getViewportLifecycleReferenceCounts(), {
		children: itemCount + 2,
		childMutationTokens: 0,
		childHeights: 0,
		tailChildLines: 0,
		tailChildStarts: 0,
		tailChildLeadingKittyImages: 0,
		childMutationScratchToken: 0,
		childHeightWidth: 0,
	});
}

test("ViewportContainer final release discards 5k and 50k child scratch backing and rebuilds golden", () => {
	verifyViewportRelease(5_000);
	verifyViewportRelease(50_000);
});

test("Editor final release replaces the 4096-line source backing without clearing text", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const editor = new Editor(tui, EDITOR_THEME);
	const text = new Array<string>(4_096).fill("x").join("\n");
	editor.setText(text);
	tui.addChild(editor);
	tui.start();
	tui.renderNow();
	const raw = editor as unknown as EditorRawCache;
	const initialBacking = raw.layoutCacheSourceLines;
	assert.equal(initialBacking.length, 4_096);
	editor.invalidate();
	assert.equal(raw.layoutCacheSourceLines, initialBacking);
	tui.renderNow();
	assert.equal(raw.layoutCacheSourceLines.length, 4_096);

	await tui.dispose({ preserveScreen: true });
	assert.notEqual(raw.layoutCacheSourceLines, initialBacking);
	assert.equal(raw.layoutCacheSourceLines.length, 0);
	assert.equal(editor.getText(), text);
});

test("Main final disposal drops frame scratch backing while preserving mounted children", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const viewport = new ViewportContainer();
	for (let index = 0; index < 100; index++) viewport.addChild(new StaticLine(`main-${index}`));
	const childrenIdentity = tui.children;
	tui.addChild(viewport);
	tui.start();
	tui.renderNow();
	tui.renderNow();
	const raw = tui as unknown as MainRawScratch;
	const previousLines = raw.previousLines;
	const viewportMutationTokens = raw.viewportMutationTokens;
	const frameRootHeights = raw.frameRootHeights;
	assert.ok(previousLines.length > 0);
	assert.ok(frameRootHeights.length > 0);

	await tui.dispose({ preserveScreen: true });
	assert.equal(tui.children, childrenIdentity);
	assert.equal(tui.children[0], viewport);
	assert.notEqual(raw.previousLines, previousLines);
	assert.notEqual(raw.viewportMutationTokens, viewportMutationTokens);
	assert.notEqual(raw.frameRootHeights, frameRootHeights);
	assert.deepEqual(tui.getMainFinalUnmountRetainedReferenceCounts(), {
		previousLines: 0,
		previousKittyImageIds: 0,
		viewportMutationTokens: 0,
		frameRootRecords: 0,
		boundedFrameLines: 0,
		rootFrameLines: 0,
	});
});

test("ordinary stop retains leaf caches and restart remains golden", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const text = new Text("restart 中文 😀 e\u0301", 0, 0);
	tui.addChild(text);
	tui.start();
	tui.renderNow();
	const raw = text as unknown as TextRawCache;
	const cachedLines = raw.cachedLines;
	assert.ok(cachedLines);
	await tui.stop({ preserveScreen: true });
	assert.equal(raw.cachedLines, cachedLines);
	tui.start();
	tui.renderNow();
	assert.deepEqual(text.render(80), new Text("restart 中文 😀 e\u0301", 0, 0).render(80));
	await tui.dispose({ preserveScreen: true });
});

test("Alt final disposal drops lastDocument only after full restoration output completes", async () => {
	const terminal = new GatedRestorationTerminal(80, 20);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const documentLines = new Array<string>(200);
	for (let index = 0; index < documentLines.length; index++) documentLines[index] = `document-${index}`;
	tui.setLayoutRoot(new StaticDocument(documentLines));
	tui.start();
	tui.renderNow();
	const stopping = tui.stop({ preserveScreen: false });
	await Promise.resolve();
	await Promise.resolve();
	const raw = tui as unknown as AltRawDocument;
	const restoredDocument = raw.lastDocument;
	assert.equal(restoredDocument.length, documentLines.length);
	assert.ok(terminal.writes.join("").includes("document-199"));
	const beforeFinalRelease = tui.getAltFinalUnmountRetainedReferenceCounts();
	assert.equal(beforeFinalRelease.lastDocumentRows, documentLines.length);
	assert.equal(beforeFinalRelease.lastDocumentCodeUnits, restoredDocument.reduce((total, line) => total + line.length, 0));
	assert.equal(beforeFinalRelease.lastDocumentReference, 1);
	terminal.completeRestoration();
	await stopping;

	await tui.dispose({ preserveScreen: false });
	assert.notEqual(raw.lastDocument, restoredDocument);
	assert.equal(raw.lastDocument.length, 0);
	assert.deepEqual(tui.getAltFinalUnmountRetainedReferenceCounts(), {
		lastDocumentRows: 0,
		lastDocumentCodeUnits: 0,
		lastDocumentReference: 0,
		lineResetCodeUnits: 0,
		uploadedKittyImages: 0,
		selectionPointReferences: 0,
	});
});

test("Alt final release runs after rejected and timed-out terminal restoration boundaries", async () => {
	for (const terminal of [new RejectingControlTerminal(80, 20), new NeverSettlingControlTerminal(80, 20)]) {
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false, terminalBoundaryTimeoutMs: 2 });
		const lines = ["first", "last"];
		tui.setLayoutRoot(new StaticDocument(lines));
		tui.start();
		tui.renderNow();
		const firstDispose = tui.dispose({ preserveScreen: false });
		const secondDispose = tui.dispose({ preserveScreen: false });
		assert.equal(firstDispose, secondDispose);
		await firstDispose;
		assert.equal((tui as unknown as AltRawDocument).lastDocument.length, 0);
		assert.equal(tui.getAltFinalUnmountRetainedReferenceCounts().lastDocumentReference, 0);
		await tui.dispose({ preserveScreen: false });
	}
});

test("production-shaped final unmount releases all built-in derived owners and preserves reusable state", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new ProductionTuiMainScreen(terminal, false);
	const transcript = new ProductionRetainedContainer();
	for (let index = 0; index < 5_000; index++) {
		transcript.addRetainedChild(new ProductionText(`history-${index}`, 0, 0), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const assistant = new AssistantMessageComponent(undefined, false, MARKDOWN_THEME, "Thinking...", 1, []);
	assistant.updateContent(assistantMessage([{ type: "text", text: "active stream 中文 😀 e\u0301" }]), true);
	const activeRetained = transcript.addRetainedChild(assistant, { id: "active-assistant", version: 1 });
	const directText = new ProductionText("direct text 中文 😀 e\u0301", 0, 0);
	const imageSource = "AA==";
	const image = new ProductionImage(imageSource, "image/png", { fallbackColor: identity }, {}, {
		widthPx: 10,
		heightPx: 10,
	});
	const editor = new ProductionEditor(tui, EDITOR_THEME);
	const editorText = new Array<string>(4_096).fill("editor-state").join("\n");
	editor.setText(editorText);
	const retainedEditor = new ProductionRetainedItem(editor, {
		id: "direct-retained-editor",
		version: 1,
		completed: true,
	});
	const viewport = new ProductionViewportContainer();
	viewport.addChild(transcript);
	viewport.addChild(directText);
	viewport.addChild(image);
	viewport.addChild(retainedEditor);
	const box = new ProductionBox(0, 0);
	box.addChild(viewport);
	const overlayText = new ProductionText("overlay", 0, 0);
	tui.addChild(box);
	tui.showOverlay(overlayText, { nonCapturing: true });
	tui.start();
	tui.renderNow();
	assistant.updateContent(assistantMessage([{ type: "text", text: "active stream 中文 😀 e\u0301 append" }]), true);
	activeRetained.updateVersion(2);
	tui.renderNow();

	const markdown = findComponent(assistant, ProductionMarkdown);
	assert.ok(markdown);
	const markdownRaw = markdown as unknown as MarkdownRawCache;
	const textRaw = directText as unknown as TextRawCache;
	const imageRaw = image as unknown as ImageRawCache;
	const editorRaw = editor as unknown as EditorRawCache;
	const overlayRaw = overlayText as unknown as TextRawCache;
	const editorSourceBacking = editorRaw.layoutCacheSourceLines;
	const childrenIdentity = viewport.children;
	const retainedItems = transcript.getRetainedStats().retainedItems;
	const beforeReleaseOutput = box.render(80).slice();
	assert.ok((markdownRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((markdownRaw.incrementalNormalizedText?.length ?? 0) > 0);
	assert.ok((textRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((imageRaw.cachedLines?.length ?? 0) > 0);
	assert.equal(editorRaw.layoutCacheSourceLines.length, 4_096);
	assert.ok((overlayRaw.cachedLines?.length ?? 0) > 0);
	assert.ok((box as unknown as BoxRawCache).cache !== undefined);

	await tui.dispose({ preserveScreen: true });
	assert.equal(transcript.getRetainedStats().cachedItems, 0);
	assert.equal(transcript.getRetainedStats().cachedLines, 0);
	assert.equal(transcript.getRetainedStats().estimatedCachedBytes, 0);
	const retainedReferences = transcript.getRetainedLifecycleReferenceCounts();
	assert.equal(retainedReferences.viewportRecords, 0);
	assert.equal(retainedReferences.viewportRecordComponentReferences, 0);
	assert.equal(retainedReferences.dirtyViewportRecords, 0);
	assert.equal(retainedReferences.preparedViewportRecords, 0);
	assert.equal(retainedReferences.viewportBlockHeights, 0);
	assert.deepEqual(viewport.getViewportLifecycleReferenceCounts(), {
		children: 4,
		childMutationTokens: 0,
		childHeights: 0,
		tailChildLines: 0,
		tailChildStarts: 0,
		tailChildLeadingKittyImages: 0,
		childMutationScratchToken: 0,
		childHeightWidth: 0,
	});
	assert.equal(markdownRaw.cachedLines, undefined);
	assert.equal(markdownRaw.incrementalNormalizedText, undefined);
	assert.equal(textRaw.cachedLines, undefined);
	assert.equal(imageRaw.cachedLines, undefined);
	assert.notEqual(editorRaw.layoutCacheSourceLines, editorSourceBacking);
	assert.equal(editorRaw.layoutCacheSourceLines.length, 0);
	assert.equal(overlayRaw.cachedLines, undefined);
	assert.equal((box as unknown as BoxRawCache).cache, undefined);
	assert.equal(viewport.children, childrenIdentity);
	assert.equal(transcript.getRetainedStats().retainedItems, retainedItems);
	assert.equal(activeRetained.component, assistant);
	assert.equal((activeRetained as unknown as RetainedItemRawState).logicalVersion, 2);
	assert.equal(imageRaw.base64Data, imageSource);
	assert.equal(editor.getText(), editorText);

	const alt = new ProductionTuiAltScreen(new FakeTerminal(80, 20), false, undefined, { mouse: false });
	alt.setLayoutRoot(box);
	alt.start();
	alt.renderNow();
	assert.deepEqual(box.render(80), beforeReleaseOutput);
	assert.ok(markdown.render(80).length > 0);
	assert.ok(editor.render(80).length > 0);
	await alt.dispose({ preserveScreen: false });
	assert.equal(alt.getAltFinalUnmountRetainedReferenceCounts().lastDocumentRows, 0);
	assert.equal(transcript.getRetainedLifecycleReferenceCounts().viewportRecords, 0);
	assert.equal(editor.getText(), editorText);
});

test("built-in cache owner contract stays lifecycle-only and complete", async () => {
	const ownerFiles = [
		["Markdown", "packages/tui/src/components/markdown.ts"],
		["Text", "packages/tui/src/components/text.ts"],
		["Image", "packages/tui/src/components/image.ts"],
		["Editor", "packages/tui/src/components/editor.ts"],
		["Box", "packages/tui/src/components/box.ts"],
		["RetainedItem", "packages/tui/src/components/retained-item.ts"],
		["RetainedContainer", "packages/tui/src/components/retained-item.ts"],
		["ViewportContainer", "packages/tui/src/components/viewport-container.ts"],
	] as const;
	for (const [className, filePath] of ownerFiles) {
		const sourceText = await readFile(filePath, "utf8");
		const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		let releaseMethod: ts.MethodDeclaration | undefined;
		for (const statement of source.statements) {
			if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
			for (const member of statement.members) {
				if (ts.isMethodDeclaration(member) && member.name.getText(source) === "[RELEASE_COMPONENT_RENDER_CACHE]") {
					releaseMethod = member;
				}
			}
		}
		assert.ok(releaseMethod, `${className} must own an explicit cache-only final-unmount hook`);
		const releaseText = releaseMethod.getText(source);
		assert.doesNotMatch(releaseText, /\.invalidate\(|\.render\(|new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/);
	}
	const settingsText = await readFile("packages/tui/src/components/settings-list.ts", "utf8");
	assert.match(
		settingsText,
		/\[GET_COMPONENT_RENDER_CACHE_CHILD\]\(\): Component \| undefined \{\s*return this\.submenuComponent \?\? undefined;\s*\}/,
	);

	const tuiPath = "packages/tui/src/tui.ts";
	const tuiText = await readFile(tuiPath, "utf8");
	const traversal = tuiText.match(/export function releaseComponentRenderCaches[\s\S]*?\n}\n/)?.[0] ?? "";
	assert.notEqual(traversal, "");
	assert.doesNotMatch(traversal, /new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/);
	const stopMethod = tuiText.match(/private async finishTerminalStop[\s\S]*?\n\t}\n/)?.[0] ?? "";
	assert.doesNotMatch(stopMethod, /releaseMountedComponentsAfterDispose|releaseComponentRenderCaches/);
	const disposeMethod = tuiText.match(/private async finishDispose[\s\S]*?\n\t}\n/)?.[0] ?? "";
	const stopped = disposeMethod.indexOf("await this.stop(options)");
	const admission = disposeMethod.indexOf("this.disposed = true");
	const release = disposeMethod.indexOf("this.releaseMountedComponentsAfterDispose()");
	assert.ok(stopped >= 0 && admission > stopped && release > admission);
});
