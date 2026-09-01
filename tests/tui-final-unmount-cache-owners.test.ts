import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	Box as ProductionBox,
	Editor as ProductionEditor,
	Image as ProductionImage,
	Loader as ProductionLoader,
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
import { ArminComponent } from "../packages/coding-agent/src/modes/interactive/components/armin.ts";
import { DaxnutsComponent } from "../packages/coding-agent/src/modes/interactive/components/daxnuts.ts";
import { ExtensionInputComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { RetryStatusIndicator } from "../packages/coding-agent/src/modes/interactive/components/status-indicator.ts";
import type { AutocompleteProvider } from "../packages/tui/src/autocomplete.ts";
import {
	type BashRenderState,
	createBashToolDefinition,
} from "../packages/coding-agent/src/core/tools/bash.ts";
import { createWriteToolDefinition } from "../packages/coding-agent/src/core/tools/write.ts";
import { AssistantMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { SteppedSubmenu } from "../packages/coding-agent/src/modes/interactive/components/settings-submenu.ts";
import { UserMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	GET_COMPONENT_RENDER_CACHE_CHILD,
	GET_COMPONENT_RENDER_CACHE_CHILDREN,
	RELEASE_COMPONENT_RENDER_CACHE,
} from "../packages/tui/src/component-cache.ts";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import { Box } from "../packages/tui/src/components/box.ts";
import { Image } from "../packages/tui/src/components/image.ts";
import { Loader } from "../packages/tui/src/components/loader.ts";
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
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

initTheme("dark");

function identity(value: string): string {
	return value;
}

function noOperation(): void {}
function noInputResult(): undefined { return undefined; }

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

interface SteppedSubmenuRawState {
	activeComponent: Component;
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

interface BashResultRawState {
	state: {
		cachedLines: string[] | undefined;
		preparedContent: unknown[] | undefined;
		preparedStyledOutput: string | undefined;
		expandedOutputComponent: Component | undefined;
		expandedOutputText: string | undefined;
	};
	children: Component[];
	getBashResultRenderCacheReferenceCounts(): {
		cachedLineReferences: number;
		preparedContentReferences: number;
		preparedStyledOutputCodeUnits: number;
		expandedOutputReferences: number;
		derivedChildReferences: number;
	};
}

interface WriteCallRawState extends TextRawCache {
	cache?: {
		rawContent: string;
		normalizedLines: string[];
		highlightedLines: string[];
	};
}

interface LoaderRawState {
	intervalId: (NodeJS.Timeout & { _onTimeout(): void }) | null;
	ui: TuiAltScreen | null;
}

interface EditorAutocompleteRawState {
	autocompleteAbort?: AbortController;
	autocompleteDebounceTimer?: NodeJS.Timeout & { _onTimeout: (() => void) | null };
	autocompleteRequestTask: Promise<void>;
}

interface AnimatedOwnerRawState {
	interval: (NodeJS.Timeout & { _onTimeout: (() => void) | null }) | null;
	ui: ProductionTuiMainScreen | null;
	cachedLines: string[];
}

interface CountdownRawState {
	intervalId?: NodeJS.Timeout & { _onTimeout: (() => void) | null };
	tui?: ProductionTuiMainScreen;
}

interface RetryRawState extends LoaderRawState {
	countdown?: CountdownRawState;
}

interface TuiDisposeRawState {
	inputListeners: Set<unknown>;
	terminalColorSchemeListeners: Set<unknown>;
}

class CountingAltScreen extends TuiAltScreen {
	requestRenderCalls = 0;

	override requestRender(force = false): void {
		this.requestRenderCalls++;
		super.requestRender(force);
	}
}

class CountingProductionMainScreen extends ProductionTuiMainScreen {
	requestRenderCalls = 0;

	override requestRender(force = false): void {
		this.requestRenderCalls++;
		super.requestRender(force);
	}
}

class ThrowingFinalCleanupTerminal extends FakeTerminal {
	frameListenerClearCalls = 0;
	disposeCalls = 0;
	throwOnFinalCleanup = false;

	override setFrameWriteCompletionListener(
		listener: ((generation: number, error?: Error) => void) | undefined,
	): void {
		if (listener === undefined) {
			this.frameListenerClearCalls++;
			if (this.throwOnFinalCleanup) throw new Error("terminal listener cleanup failure");
		}
		super.setFrameWriteCompletionListener(listener);
	}

	dispose(): void {
		this.disposeCalls++;
		if (this.throwOnFinalCleanup) throw new Error("terminal dispose failure");
	}
}

class ThrowingCacheRelease implements Component {
	private readonly terminal: ThrowingFinalCleanupTerminal;

	constructor(terminal: ThrowingFinalCleanupTerminal) {
		this.terminal = terminal;
	}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.terminal.throwOnFinalCleanup = true;
		throw new Error("mounted release first failure");
	}

	invalidate(): void {}
	render(): string[] { return ["throwing-release"]; }
}

class CountingDetachedCacheOwner extends Container {
	releaseCalls = 0;

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.releaseCalls++;
	}
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

class ThrowingRestorationDocument implements Component {
	invalidate(): void {}

	render(): string[] {
		throw new Error("fixture restoration render failure");
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

test("Alt root replacement releases Loader timer and stale TUI callback ownership", async () => {
	const tui = new CountingAltScreen(new FakeTerminal(80, 20), false, undefined, { mouse: false });
	const loader = new Loader(tui, identity, identity, "loading", {
		frames: ["a", "b"],
		intervalMs: 60_000,
	});
	const root = new Container();
	root.addChild(loader);
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();

	const raw = loader as unknown as LoaderRawState;
	const staleTimer = raw.intervalId;
	assert.ok(staleTimer);
	const staleCallback = staleTimer._onTimeout;
	assert.equal(raw.ui, tui);

	const replacement = new StaticLine("replacement");
	tui.setLayoutRoot(replacement);
	assert.equal(raw.intervalId, null);
	assert.equal(raw.ui, null);
	const callsAfterDetach = tui.requestRenderCalls;
	staleCallback.call(staleTimer);
	assert.equal(tui.requestRenderCalls, callsAfterDetach);
	tui.renderNow();
	assert.deepEqual(replacement.render(), ["replacement"]);

	await tui.dispose({ preserveScreen: true });

	const nextTui = new CountingAltScreen(new FakeTerminal(80, 20), false, undefined, { mouse: false });
	loader.setTui(nextTui);
	loader.start();
	const nextRoot = new Container();
	nextRoot.addChild(loader);
	nextTui.setLayoutRoot(nextRoot);
	nextTui.start();
	nextTui.renderNow();
	assert.equal(raw.ui, nextTui);
	assert.ok(raw.intervalId);
	assert.ok(loader.render(80).length > 0);
	await nextTui.dispose({ preserveScreen: true });
	assert.equal(raw.intervalId, null);
	assert.equal(raw.ui, null);
});

test("Alt root replacement preserves shared Loader and Editor descendants under different wrappers", async () => {
	const tui = new CountingAltScreen(new FakeTerminal(100, 30), false, undefined, { mouse: false });
	const loader = new Loader(tui, identity, identity, "shared", { frames: ["a", "b"], intervalMs: 60_000 });
	const loaderRaw = loader as unknown as LoaderRawState;
	const editor = new Editor(tui, EDITOR_THEME);
	const provider: AutocompleteProvider = {
		triggerCharacters: ["@"],
		async getSuggestions() { return null; },
		applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
	};
	editor.setAutocompleteProvider(provider);
	editor.focused = true;
	editor.setText("shared editor ");
	const oldLoaderBox = new Box(0, 0);
	oldLoaderBox.addChild(loader);
	const oldEditorWrapper = new Container();
	oldEditorWrapper.addChild(editor);
	const detachedOwner = new CountingDetachedCacheOwner();
	const rootA = new VStack([oldLoaderBox, oldEditorWrapper, detachedOwner]);
	const newLoaderBox = new Box(0, 0);
	newLoaderBox.addChild(loader);
	const newEditorWrapper = new Container();
	newEditorWrapper.addChild(editor);
	const rootB = new VStack([newLoaderBox, newEditorWrapper, new CountingDetachedCacheOwner()]);
	tui.setLayoutRoot(rootA);
	tui.start();
	const editorRaw = editor as unknown as EditorAutocompleteRawState;
	try {
		tui.renderNow(true);
		editor.handleInput("@");
		const autocompleteTimer = editorRaw.autocompleteDebounceTimer;
		assert.ok(loaderRaw.intervalId);
		assert.ok(autocompleteTimer);
		assert.equal(loaderRaw.ui, tui);

		tui.setLayoutRoot(rootB);
		assert.equal(detachedOwner.releaseCalls, 1);
		assert.equal((oldLoaderBox as unknown as BoxRawCache).cache, undefined);
		assert.ok(loaderRaw.intervalId, "shared Loader animation remains owned by the incoming root");
		assert.equal(loaderRaw.ui, tui);
		assert.equal(editorRaw.autocompleteDebounceTimer, autocompleteTimer);
		assert.equal(editor.getText(), "shared editor @");
		tui.renderNow(true);
		assert.ok(loader.render(80).length > 0);
	} finally {
		await tui.dispose({ preserveScreen: true });
	}
	assert.equal(loaderRaw.intervalId, null);
	assert.equal(loaderRaw.ui, null);
	assert.equal(editorRaw.autocompleteDebounceTimer, undefined);
});

test("Editor final release cancels debounced and active autocomplete work", async () => {
	let debounceProviderCalls = 0;
	const debounceProvider: AutocompleteProvider = {
		triggerCharacters: ["@"],
		async getSuggestions() {
			debounceProviderCalls++;
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	};
	const debounceTui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const debounceEditor = new Editor(debounceTui, EDITOR_THEME);
	debounceEditor.setAutocompleteProvider(debounceProvider);
	debounceTui.addChild(debounceEditor);
	debounceTui.start();
	debounceEditor.handleInput("@");
	const debounceRaw = debounceEditor as unknown as EditorAutocompleteRawState;
	const staleTimer = debounceRaw.autocompleteDebounceTimer;
	assert.ok(staleTimer);
	const staleDebounceCallback = staleTimer._onTimeout;
	assert.ok(staleDebounceCallback);
	await debounceTui.dispose({ preserveScreen: true });
	assert.equal(debounceRaw.autocompleteDebounceTimer, undefined);
	staleDebounceCallback.call(staleTimer);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(debounceProviderCalls, 0);

	let activeSignal: AbortSignal | undefined;
	let resolveActive: ((value: null) => void) | undefined;
	const activeProvider: AutocompleteProvider = {
		getSuggestions(_lines, _cursorLine, _cursorCol, options) {
			activeSignal = options.signal;
			return new Promise((resolve) => { resolveActive = resolve; });
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion() { return true; },
	};
	const activeTui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const activeEditor = new Editor(activeTui, EDITOR_THEME);
	activeEditor.setAutocompleteProvider(activeProvider);
	activeTui.addChild(activeEditor);
	activeTui.start();
	activeEditor.handleInput("\t");
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(activeSignal);
	const activeRaw = activeEditor as unknown as EditorAutocompleteRawState;
	assert.ok(activeRaw.autocompleteAbort);
	await activeTui.dispose({ preserveScreen: true });
	assert.equal(activeSignal.aborted, true);
	assert.equal(activeRaw.autocompleteAbort, undefined);
	resolveActive?.(null);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(activeEditor.isShowingAutocomplete(), false);
});

test("extension countdown natural expiry invokes its callback before releasing owners", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	let cancelCalls = 0;
	const selector = new ExtensionSelectorComponent("Timed selector", ["one"], noOperation, () => {
		cancelCalls++;
	}, { tui, timeout: 1_000 });
	tui.addChild(selector);
	tui.start();
	const raw = selector as unknown as { countdown?: CountdownRawState };
	const timer = raw.countdown?.intervalId;
	assert.ok(timer);
	const callback = timer._onTimeout;
	assert.ok(callback);
	callback.call(timer);
	assert.equal(cancelCalls, 1);
	assert.equal(raw.countdown?.intervalId, undefined);
	selector.dispose();
	await tui.dispose({ preserveScreen: true });
});

test("final disposal releases timed extension dialog countdown owners", async () => {
	const tui = new CountingProductionMainScreen(new FakeTerminal(80, 20), false);
	const selector = new ExtensionSelectorComponent("Timed selector", ["one"], noOperation, noOperation, {
		tui,
		timeout: 60_000,
	});
	const input = new ExtensionInputComponent("Timed input", undefined, noOperation, noOperation, {
		tui,
		timeout: 60_000,
	});
	const selectorRaw = selector as unknown as { countdown?: CountdownRawState };
	const inputRaw = input as unknown as { countdown?: CountdownRawState };
	tui.addChild(selector);
	tui.addChild(input);
	tui.start();
	assert.ok(selectorRaw.countdown?.intervalId);
	assert.ok(inputRaw.countdown?.intervalId);
	try {
		await tui.stop({ preserveScreen: true });
		assert.ok(selectorRaw.countdown?.intervalId);
		assert.ok(inputRaw.countdown?.intervalId);
		tui.start();
		await tui.dispose({ preserveScreen: true });
		assert.equal(selectorRaw.countdown?.intervalId, undefined);
		assert.equal(inputRaw.countdown?.intervalId, undefined);
		assert.equal(selectorRaw.countdown?.tui, undefined);
		assert.equal(inputRaw.countdown?.tui, undefined);
	} finally {
		selector.dispose();
		input.dispose();
	}
});

test("final release stops coding-agent animation owners and retry countdown", async () => {
	const tui = new CountingProductionMainScreen(new FakeTerminal(120, 40), false);
	const armin = new ArminComponent(tui);
	const daxnuts = new DaxnutsComponent(tui);
	const retry = new RetryStatusIndicator(tui, 1, 3, 60_000);
	tui.addChild(armin);
	tui.addChild(daxnuts);
	tui.addChild(retry);
	tui.start();
	tui.renderNow();

	const arminRaw = armin as unknown as AnimatedOwnerRawState;
	const daxRaw = daxnuts as unknown as AnimatedOwnerRawState;
	const retryRaw = retry as unknown as RetryRawState;
	assert.ok(arminRaw.interval);
	assert.ok(daxRaw.interval);
	assert.ok(retryRaw.intervalId);
	assert.ok(retryRaw.countdown?.intervalId);
	assert.ok(arminRaw.cachedLines.length > 0);
	assert.ok(daxRaw.cachedLines.length > 0);
	const staleArminTimer = arminRaw.interval;
	const staleDaxTimer = daxRaw.interval;
	const staleRetryLoaderTimer = retryRaw.intervalId;
	const staleRetryCountdownTimer = retryRaw.countdown.intervalId;
	const staleArminCallback = staleArminTimer._onTimeout;
	const staleDaxCallback = staleDaxTimer._onTimeout;
	const staleRetryLoaderCallback = staleRetryLoaderTimer._onTimeout;
	const staleRetryCountdownCallback = staleRetryCountdownTimer._onTimeout;

	await tui.dispose({ preserveScreen: true });
	assert.equal(arminRaw.interval, null);
	assert.equal(arminRaw.ui, null);
	assert.equal(arminRaw.cachedLines.length, 0);
	assert.equal(daxRaw.interval, null);
	assert.equal(daxRaw.ui, null);
	assert.equal(daxRaw.cachedLines.length, 0);
	assert.equal(retryRaw.intervalId, null);
	assert.equal(retryRaw.ui, null);
	assert.equal(retryRaw.countdown, undefined);
	const renderCallsAfterDispose = tui.requestRenderCalls;
	staleArminCallback?.call(staleArminTimer);
	staleDaxCallback?.call(staleDaxTimer);
	staleRetryLoaderCallback?.call(staleRetryLoaderTimer);
	staleRetryCountdownCallback?.call(staleRetryCountdownTimer);
	assert.equal(tui.requestRenderCalls, renderCallsAfterDispose);

	const replacementTui = new CountingProductionMainScreen(new FakeTerminal(120, 40), false);
	armin.setTui(replacementTui);
	daxnuts.setTui(replacementTui);
	replacementTui.addChild(armin);
	replacementTui.addChild(daxnuts);
	replacementTui.start();
	replacementTui.renderNow();
	assert.equal(arminRaw.ui, replacementTui);
	assert.equal(daxRaw.ui, replacementTui);
	assert.ok(arminRaw.interval);
	assert.ok(daxRaw.interval);
	assert.ok(arminRaw.cachedLines.length > 0);
	assert.ok(daxRaw.cachedLines.length > 0);
	await replacementTui.dispose({ preserveScreen: true });
	assert.equal(arminRaw.interval, null);
	assert.equal(arminRaw.ui, null);
	assert.equal(arminRaw.cachedLines.length, 0);
	assert.equal(daxRaw.interval, null);
	assert.equal(daxRaw.ui, null);
	assert.equal(daxRaw.cachedLines.length, 0);
});

test("final disposal preserves the first release error and continues terminal cleanup", async () => {
	const terminal = new ThrowingFinalCleanupTerminal(80, 20);
	const tui = new TuiMainScreen(terminal, false);
	const release = new ThrowingCacheRelease(terminal);
	const cachedText = new Text("cached-after-error", 0, 0);
	tui.addChild(release);
	tui.addChild(cachedText);
	tui.addInputListener(noInputResult);
	tui.onTerminalColorSchemeChange(noOperation);
	tui.start();
	tui.renderNow();
	assert.ok((cachedText as unknown as TextRawCache).cachedLines);

	await assert.rejects(tui.dispose({ preserveScreen: true }), /mounted release first failure/);
	assert.equal(terminal.frameListenerClearCalls, 3);
	assert.equal(terminal.disposeCalls, 1);
	assert.equal((cachedText as unknown as TextRawCache).cachedLines, undefined);
	const raw = tui as unknown as TuiDisposeRawState;
	assert.equal(raw.inputListeners.size, 0);
	assert.equal(raw.terminalColorSchemeListeners.size, 0);
});

test("final disposal releases built-in Bash result sidecar caches", async () => {
	const definition = createBashToolDefinition(process.cwd());
	assert.ok(definition.renderResult);
	const renderState: BashRenderState = { startedAt: undefined, endedAt: undefined, interval: undefined };
	const output = new Array<string>(4_096);
	for (let index = 0; index < output.length; index++) output[index] = `bash-output-${index}-中文-😀-e\u0301`;
	const outputText = output.join("\n");
	const component = definition.renderResult(
		{ content: [{ type: "text", text: outputText }], details: undefined },
		{ expanded: false, isPartial: false },
		undefined as never,
		{
			args: { command: "fixture" },
			toolCallId: "bash-final-unmount",
			invalidate: noOperation,
			lastComponent: undefined,
			state: renderState,
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		},
	);
	const tui = new ProductionTuiMainScreen(new FakeTerminal(120, 40), false);
	tui.addChild(component);
	tui.start();
	tui.renderNow();
	const raw = component as unknown as BashResultRawState;
	assert.ok((raw.state.cachedLines?.length ?? 0) > 0);
	assert.ok((raw.state.preparedContent?.length ?? 0) > 0);
	assert.ok((raw.state.preparedStyledOutput?.length ?? 0) > 0);
	assert.ok(raw.children.length > 0);
	const beforeRelease = raw.getBashResultRenderCacheReferenceCounts();
	assert.ok(beforeRelease.cachedLineReferences > 0);
	assert.equal(beforeRelease.preparedContentReferences, 1);
	assert.ok(beforeRelease.preparedStyledOutputCodeUnits > 0);
	assert.ok(beforeRelease.derivedChildReferences > 0);

	await tui.dispose({ preserveScreen: true });
	assert.equal(raw.state.cachedLines, undefined);
	assert.equal(raw.state.preparedContent, undefined);
	assert.equal(raw.state.preparedStyledOutput, undefined);
	assert.equal(raw.state.expandedOutputComponent, undefined);
	assert.equal(raw.state.expandedOutputText, undefined);
	assert.equal(raw.children.length, 0);
	assert.deepEqual(raw.getBashResultRenderCacheReferenceCounts(), {
		cachedLineReferences: 0,
		preparedContentReferences: 0,
		preparedStyledOutputCodeUnits: 0,
		expandedOutputReferences: 0,
		derivedChildReferences: 0,
	});

	const rebuilt = definition.renderResult(
		{ content: [{ type: "text", text: outputText }], details: undefined },
		{ expanded: false, isPartial: false },
		undefined as never,
		{
			args: { command: "fixture" },
			toolCallId: "bash-final-unmount",
			invalidate: noOperation,
			lastComponent: component,
			state: renderState,
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		},
	);
	assert.equal(rebuilt, component);
	assert.ok(rebuilt.render(120).length > 0);
	assert.ok(raw.getBashResultRenderCacheReferenceCounts().cachedLineReferences > 0);
});

test("final disposal releases write-call highlight sidecars", async () => {
	const definition = createWriteToolDefinition(process.cwd());
	assert.ok(definition.renderCall);
	const sourceLines = new Array<string>(4_096);
	for (let index = 0; index < sourceLines.length; index++) {
		sourceLines[index] = `const value${index} = "中文-😀-e\u0301";`;
	}
	const source = sourceLines.join("\n");
	const component = definition.renderCall(
		{ path: "large-fixture.ts", content: source },
		theme,
		{
			args: { path: "large-fixture.ts", content: source },
			toolCallId: "write-final-unmount",
			invalidate: noOperation,
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		},
	);
	const raw = component as unknown as WriteCallRawState;
	assert.equal(raw.cache?.rawContent, source);
	assert.equal(raw.cache?.normalizedLines.length, sourceLines.length);
	assert.equal(raw.cache?.highlightedLines.length, sourceLines.length);
	const tui = new ProductionTuiMainScreen(new FakeTerminal(120, 40), false);
	tui.addChild(component);
	tui.start();
	tui.renderNow();
	await tui.dispose({ preserveScreen: true });
	assert.equal(raw.cache, undefined);
	assert.equal(raw.cachedLines, undefined);
	const rebuilt = definition.renderCall(
		{ path: "large-fixture.ts", content: source },
		theme,
		{
			args: { path: "large-fixture.ts", content: source },
			toolCallId: "write-final-unmount",
			invalidate: noOperation,
			lastComponent: component,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		},
	);
	assert.equal(rebuilt, component);
	const rebuiltRaw = rebuilt as unknown as WriteCallRawState;
	assert.equal(rebuiltRaw.cache?.rawContent, source);
	assert.ok(rebuilt.render(120).length > 0);
});

test("permanently removed overlays release animation owners", async () => {
	for (const useHandle of [true, false]) {
		const tui = new CountingProductionMainScreen(new FakeTerminal(80, 20), false);
		const loader = new ProductionLoader(tui, identity, identity, useHandle ? "handle" : "stack");
		const raw = loader as unknown as LoaderRawState;
		const handle = tui.showOverlay(loader);
		tui.start();
		assert.ok(raw.intervalId);
		try {
			handle.setHidden(true);
			assert.ok(raw.intervalId);
			handle.setHidden(false);
			if (useHandle) handle.hide();
			else tui.hideOverlay();
			assert.equal(raw.intervalId, null);
			assert.equal(raw.ui, null);
		} finally {
			loader.dispose();
			await tui.dispose({ preserveScreen: true });
		}
	}

	const mountedTui = new CountingProductionMainScreen(new FakeTerminal(80, 20), false);
	const mountedLoader = new ProductionLoader(mountedTui, identity, identity, "mounted-overlay");
	const mountedRaw = mountedLoader as unknown as LoaderRawState;
	mountedTui.addChild(mountedLoader);
	const mountedHandle = mountedTui.showOverlay(mountedLoader);
	mountedTui.start();
	mountedHandle.hide();
	assert.ok(mountedRaw.intervalId);
	assert.equal(mountedRaw.ui, mountedTui);
	await mountedTui.dispose({ preserveScreen: true });
	assert.equal(mountedRaw.intervalId, null);
	assert.equal(mountedRaw.ui, null);

	const wrappedTui = new CountingProductionMainScreen(new FakeTerminal(80, 20), false);
	const wrappedLoader = new ProductionLoader(wrappedTui, identity, identity, "wrapped-overlay");
	const wrappedRaw = wrappedLoader as unknown as LoaderRawState;
	const retainedLoader = new ProductionRetainedItem(wrappedLoader, {
		id: "wrapped-overlay-loader",
		version: 1,
		completed: false,
	});
	wrappedTui.addChild(retainedLoader);
	const wrappedHandle = wrappedTui.showOverlay(wrappedLoader);
	wrappedTui.start();
	wrappedHandle.hide();
	assert.ok(wrappedRaw.intervalId);
	assert.equal(wrappedRaw.ui, wrappedTui);
	await wrappedTui.dispose({ preserveScreen: true });
	assert.equal(wrappedRaw.intervalId, null);
	assert.equal(wrappedRaw.ui, null);
});

test("overlay removal preserves descendants still owned through nested and partially shared overlays", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const loader = new Loader(tui, identity, identity, "shared-overlay", {
		frames: ["a", "b"],
		intervalMs: 60_000,
	});
	const raw = loader as unknown as LoaderRawState;
	const nestedWrapper = new CountingDetachedCacheOwner();
	nestedWrapper.addChild(loader);
	const direct = tui.showOverlay(loader);
	const nested = tui.showOverlay(nestedWrapper);
	tui.start();
	try {
		assert.ok(raw.intervalId);

		direct.hide();
		assert.ok(raw.intervalId, "nested structural owner keeps the Loader active");
		assert.equal(raw.ui, tui);
		assert.equal(nestedWrapper.releaseCalls, 0);

		nested.hide();
		assert.equal(raw.intervalId, null);
		assert.equal(raw.ui, null);
		assert.equal(nestedWrapper.releaseCalls, 1);
	} finally {
		loader.dispose();
		await tui.dispose({ preserveScreen: true });
	}

	const partialTui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const partialLoader = new Loader(partialTui, identity, identity, "partial-shared", {
		frames: ["a", "b"],
		intervalMs: 60_000,
	});
	const partialRaw = partialLoader as unknown as LoaderRawState;
	const oldWrapper = new CountingDetachedCacheOwner();
	oldWrapper.addChild(partialLoader);
	const remainingWrapper = new CountingDetachedCacheOwner();
	remainingWrapper.addChild(partialLoader);
	const oldHandle = partialTui.showOverlay(oldWrapper);
	const remainingHandle = partialTui.showOverlay(remainingWrapper);
	partialTui.start();
	try {
		oldHandle.hide();
		assert.equal(oldWrapper.releaseCalls, 1);
		assert.equal(remainingWrapper.releaseCalls, 0);
		assert.ok(partialRaw.intervalId);
		assert.equal(partialRaw.ui, partialTui);
		remainingHandle.hide();
		assert.equal(remainingWrapper.releaseCalls, 1);
		assert.equal(partialRaw.intervalId, null);
		assert.equal(partialRaw.ui, null);
	} finally {
		partialLoader.dispose();
		await partialTui.dispose({ preserveScreen: true });
	}

	const sameRootTui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const sameRootLoader = new Loader(sameRootTui, identity, identity, "same-root", {
		frames: ["a", "b"],
		intervalMs: 60_000,
	});
	const sameRootRaw = sameRootLoader as unknown as LoaderRawState;
	const sameRootFirst = sameRootTui.showOverlay(sameRootLoader);
	const sameRootSecond = sameRootTui.showOverlay(sameRootLoader);
	sameRootTui.start();
	try {
		sameRootFirst.hide();
		assert.ok(sameRootRaw.intervalId);
		assert.equal(sameRootRaw.ui, sameRootTui);
		sameRootSecond.hide();
		assert.equal(sameRootRaw.intervalId, null);
		assert.equal(sameRootRaw.ui, null);
	} finally {
		sameRootLoader.dispose();
		await sameRootTui.dispose({ preserveScreen: true });
	}

	const hiddenTui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const hiddenLoader = new Loader(hiddenTui, identity, identity, "hidden-owner", {
		frames: ["a", "b"],
		intervalMs: 60_000,
	});
	const hiddenRaw = hiddenLoader as unknown as LoaderRawState;
	const removedWrapper = new CountingDetachedCacheOwner();
	removedWrapper.addChild(hiddenLoader);
	const hiddenWrapper = new CountingDetachedCacheOwner();
	hiddenWrapper.addChild(hiddenLoader);
	const removedHandle = hiddenTui.showOverlay(removedWrapper);
	const hiddenHandle = hiddenTui.showOverlay(hiddenWrapper);
	hiddenHandle.setHidden(true);
	hiddenTui.start();
	try {
		removedHandle.hide();
		assert.ok(hiddenRaw.intervalId, "hidden overlays retain structural ownership");
		assert.equal(hiddenRaw.ui, hiddenTui);
		hiddenHandle.hide();
		assert.equal(hiddenRaw.intervalId, null);
		assert.equal(hiddenRaw.ui, null);
	} finally {
		hiddenLoader.dispose();
		await hiddenTui.dispose({ preserveScreen: true });
	}

	const mountedTui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	const mountedLoader = new Loader(mountedTui, identity, identity, "mounted-shared", {
		frames: ["a", "b"],
		intervalMs: 60_000,
	});
	const mountedRaw = mountedLoader as unknown as LoaderRawState;
	const mountedWrapper = new Container();
	mountedWrapper.addChild(mountedLoader);
	mountedTui.addChild(mountedWrapper);
	const overlayWrapper = new CountingDetachedCacheOwner();
	overlayWrapper.addChild(mountedLoader);
	const mountedOverlay = mountedTui.showOverlay(overlayWrapper);
	mountedTui.start();
	try {
		mountedOverlay.hide();
		assert.equal(overlayWrapper.releaseCalls, 1);
		assert.ok(mountedRaw.intervalId);
		assert.equal(mountedRaw.ui, mountedTui);
	} finally {
		await mountedTui.dispose({ preserveScreen: true });
	}
	assert.equal(mountedRaw.intervalId, null);
	assert.equal(mountedRaw.ui, null);
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

test("final disposal traverses the active production SteppedSubmenu component", async () => {
	const stepped = new SteppedSubmenu(
		[
			{
				key: "model",
				title: "Model",
				description: "Default thinking level per model",
				options: () => [{ value: "high", label: "High" }],
			},
		],
		() => {},
		() => {},
	);
	const activeComponent = (stepped as unknown as SteppedSubmenuRawState).activeComponent;
	const nestedText = findComponent(activeComponent, ProductionText);
	assert.ok(nestedText);
	assert.ok(stepped.render(80).length > 0);
	const raw = nestedText as unknown as TextRawCache;
	assert.ok((raw.cachedLines?.length ?? 0) > 0);

	const tui = new ProductionTuiMainScreen(new FakeTerminal(120, 40), false);
	tui.addChild(stepped);
	tui.start();
	tui.renderNow();
	await tui.dispose({ preserveScreen: true });

	assert.equal(raw.cachedLines, undefined);
	assert.equal((stepped as unknown as SteppedSubmenuRawState).activeComponent, activeComponent);
	assert.ok(stepped.render(80).length > 0);
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
		savedCapabilitiesReferences: 0,
		selectionPointReferences: 0,
		layoutRenderOwnerReferences: 0,
		pendingLayoutReleaseReferences: 0,
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

test("Alt final disposal restores global image capabilities after restoration render failure", async () => {
	const previousCapabilities = getCapabilities();
	const expectedCapabilities = { images: "iterm2" as const, trueColor: true, hyperlinks: true };
	setCapabilities(expectedCapabilities);
	try {
		const tui = new TuiAltScreen(new FakeTerminal(80, 20), false, undefined, { mouse: false });
		tui.setLayoutRoot(new ThrowingRestorationDocument());
		tui.start();
		assert.equal(getCapabilities().images, null);
		await tui.dispose({ preserveScreen: false });
		assert.deepEqual(getCapabilities(), expectedCapabilities);
	} finally {
		setCapabilities(previousCapabilities);
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
		["ScrollView", "packages/tui/src/components/scroll-view.ts"],
		["Loader", "packages/tui/src/components/loader.ts"],
		["ArminComponent", "packages/coding-agent/src/modes/interactive/components/armin.ts"],
		["DaxnutsComponent", "packages/coding-agent/src/modes/interactive/components/daxnuts.ts"],
		["RetryStatusIndicator", "packages/coding-agent/src/modes/interactive/components/status-indicator.ts"],
		["BashResultRenderComponent", "packages/coding-agent/src/core/tools/bash.ts"],
		["WriteCallRenderComponent", "packages/coding-agent/src/core/tools/write.ts"],
		["ToolExecutionComponent", "packages/coding-agent/src/modes/interactive/components/tool-execution.ts"],
		["ExtensionSelectorComponent", "packages/coding-agent/src/modes/interactive/components/extension-selector.ts"],
		["ExtensionInputComponent", "packages/coding-agent/src/modes/interactive/components/extension-input.ts"],
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
		assert.doesNotMatch(releaseText, /\.invalidate\(|\.render\(|new (?:Set|Promise|AbortController)|=>|function\s*\(/);
		if (className === "ToolExecutionComponent") {
			assert.equal(releaseText.match(/new Map\(/g)?.length ?? 0, 1);
		} else {
			assert.doesNotMatch(releaseText, /new Map\(/);
		}
	}
	const settingsText = await readFile("packages/tui/src/components/settings-list.ts", "utf8");
	assert.match(
		settingsText,
		/\[GET_COMPONENT_RENDER_CACHE_CHILD\]\(\): Component \| undefined \{\s*return this\.submenuComponent \?\? undefined;\s*\}/,
	);
	const steppedText = await readFile(
		"packages/coding-agent/src/modes/interactive/components/settings-submenu.ts",
		"utf8",
	);
	assert.match(steppedText, /this\.children\.push\(this\.activeComponent\)/);
	assert.match(
		steppedText,
		/private setActiveComponent\(component: Component\): void \{\s*this\.activeComponent = component;\s*this\.children\[0\] = component;/,
	);
	const countdownText = await readFile(
		"packages/coding-agent/src/modes/interactive/components/countdown-timer.ts",
		"utf8",
	);
	assert.match(
		countdownText,
		/const onExpire = this\.onExpire;\s*this\.dispose\(\);\s*onExpire\(\);/,
	);

	const tuiPath = "packages/tui/src/tui.ts";
	const tuiText = await readFile(tuiPath, "utf8");
	const overlayHandleHide = tuiText.match(/hide: \(\) => \{[\s\S]*?\n\t\t\t},/)?.[0] ?? "";
	const hideOverlay = tuiText.match(/hideOverlay\(\): void \{[\s\S]*?\n\t}/)?.[0] ?? "";
	assert.match(overlayHandleHide, /this\.releaseDetachedOverlayComponent\(component\)/);
	assert.match(hideOverlay, /this\.releaseDetachedOverlayComponent\(overlay\.component\)/);
	assert.match(tuiText, /export function releaseDetachedComponentRenderCaches/);
	assert.match(tuiText, /const identities = new Map<Component, number>\(\)/);
	assert.match(tuiText, /identities\.clear\(\)/);
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
	for (const cleanup of [
		"this.terminalFrameQueue.detach()",
		"this.terminal.setFrameWriteReadyListener?.(undefined)",
		"this.terminal.setFrameWriteCompletionListener(undefined)",
		"this.terminal.setFrameWriteStartedListener?.(undefined)",
		"this.terminal.dispose?.()",
		"this.inputListeners.clear()",
		"this.terminalColorSchemeListeners.clear()",
	]) {
		assert.ok(disposeMethod.indexOf(cleanup) > release, `${cleanup} must run after mounted release admission closes`);
	}
	assert.match(disposeMethod, /if \(disposeFailed\) throw disposeError;/);
});
