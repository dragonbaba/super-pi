/**
 * Minimal TUI implementation with differential rendering
 */

import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
	GET_COMPONENT_RENDER_CACHE_CHILD,
	GET_COMPONENT_RENDER_CACHE_CHILDREN,
	RELEASE_COMPONENT_RENDER_CACHE,
} from "./component-cache.ts";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { TuiRenderInstrumentation } from "./render-instrumentation.ts";
import type { Terminal } from "./terminal.ts";
import { TerminalFrameQueue, type TerminalFrameQueueSnapshot } from "./terminal-frame-queue.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import {
	extractSegments,
	extractSegmentsInto,
	type ExtractedSegmentsResult,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	sliceWithWidthInto,
	type SliceWithWidthResult,
	visibleWidth,
} from "./utils.ts";

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

const OSC11_BACKGROUND_UNSUPPORTED = Promise.resolve<RgbColor | undefined>(undefined);

/** Default deadline for lifecycle flush/restore boundaries, never for ordinary frame writes. */
export const DEFAULT_TERMINAL_LIFECYCLE_TIMEOUT_MS = 5_000;

class RecoverableTerminalLifecycleTimeoutError extends Error {
	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs}ms`);
		this.name = "RecoverableTerminalLifecycleTimeoutError";
	}
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns An array of strings, each representing a line. Ownership is defined
	 * by the concrete component; ordinary callers must treat the array as read-only
	 * unless a narrower API explicitly grants mutation rights.
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;

	/** Internal child ownership for cache-only lifecycle traversal. */
	[GET_COMPONENT_RENDER_CACHE_CHILDREN]?(): readonly Component[];

	/** Internal single-child ownership for wrappers without a temporary child array. */
	[GET_COMPONENT_RENDER_CACHE_CHILD]?(): Component | undefined;

	/** Internal final-unmount cache release. Must not perform semantic rerendering. */
	[RELEASE_COMPONENT_RENDER_CACHE]?(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const percentage = parsePercentage(value);
	return percentage === undefined ? undefined : Math.floor((referenceSize * percentage) / 100);
}

/** Parse a non-negative percentage without regex match arrays or substring copies. */
function parsePercentage(value: string): number | undefined {
	if (value.length < 2 || value.charCodeAt(value.length - 1) !== 37) return undefined;
	let whole = 0;
	let fraction = 0;
	let fractionScale = 1;
	let wholeDigits = 0;
	let fractionDigits = 0;
	let afterDecimal = false;
	for (let index = 0; index < value.length - 1; index++) {
		const code = value.charCodeAt(index);
		if (code === 46 && !afterDecimal && wholeDigits > 0) {
			afterDecimal = true;
			continue;
		}
		if (code < 48 || code > 57) return undefined;
		if (afterDecimal) {
			fraction = fraction * 10 + code - 48;
			fractionScale *= 10;
			fractionDigits++;
		} else {
			whole = whole * 10 + code - 48;
			wholeDigits++;
		}
	}
	if (wholeDigits === 0 || (afterDecimal && fractionDigits === 0)) return undefined;
	return whole + fraction / fractionScale;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
};

type OverlayFocusRestoreStatus = "inactive" | "eligible" | "blocked";
type OverlayFocusResumeStatus = "restore-overlay" | "focus-target";
type OverlayFocusRestoreState = {
	status: OverlayFocusRestoreStatus;
	overlay: OverlayStackEntry | undefined;
	blockedBy: Component | null;
	resumeStatus: OverlayFocusResumeStatus;
	resumeTarget: Component | null;
};
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	[GET_COMPONENT_RENDER_CACHE_CHILDREN](): readonly Component[] {
		return this.children;
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * Return a fresh caller-owned outer array. Mutating it never mutates a child
	 * component's cached render array.
	 */
	render(width: number): string[] {
		const lines: string[] = [];
		renderContainerInto(this, width, lines);
		return lines;
	}
}

function renderContainerInto(container: Container, width: number, target: string[]): void {
	for (let childIndex = 0; childIndex < container.children.length; childIndex++) {
		const child = container.children[childIndex]!;
		if (child instanceof Container && child.render === Container.prototype.render) {
			renderContainerInto(child, width, target);
			continue;
		}
		const childLines = child.render(width);
		for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
			target.push(childLines[lineIndex]!);
		}
	}
}

function collectComponentReleaseOrder(
	component: Component | undefined,
	identities: Set<Component>,
	releaseOrder: Component[],
): void {
	if (component === undefined || identities.has(component)) return;
	identities.add(component);
	const child = component[GET_COMPONENT_RENDER_CACHE_CHILD]?.();
	if (child !== undefined) collectComponentReleaseOrder(child, identities, releaseOrder);
	const children = component[GET_COMPONENT_RENDER_CACHE_CHILDREN]?.();
	if (children !== undefined) {
		for (let index = 0; index < children.length; index++) {
			collectComponentReleaseOrder(children[index], identities, releaseOrder);
		}
	}
	releaseOrder.push(component);
}

function releaseCollectedComponentRenderCaches(
	releaseOrder: readonly Component[],
	metrics: DetachedComponentReleaseMetrics | undefined,
): void {
	let releaseError: unknown;
	let releaseFailed = false;
	for (let index = 0; index < releaseOrder.length; index++) {
		const component = releaseOrder[index]!;
		const release = component[RELEASE_COMPONENT_RENDER_CACHE];
		if (release === undefined) continue;
		try {
			release.call(component);
			if (metrics) metrics.releasedNodes++;
		} catch (error) {
			if (!releaseFailed) {
				releaseFailed = true;
				releaseError = error;
			}
		}
	}
	if (releaseFailed) throw releaseError;
}

export function releaseComponentRenderCaches(component: Component | undefined): void {
	const identities = new Set<Component>();
	const releaseOrder: Component[] = [];
	try {
		collectComponentReleaseOrder(component, identities, releaseOrder);
		releaseCollectedComponentRenderCaches(releaseOrder, undefined);
	} finally {
		releaseOrder.length = 0;
		identities.clear();
	}
}

function releaseMountedComponentRenderCaches(
	roots: readonly Component[],
	overlays: readonly OverlayStackEntry[],
): void {
	const identities = new Set<Component>();
	const releaseOrder: Component[] = [];
	try {
		for (let index = 0; index < roots.length; index++) {
			collectComponentReleaseOrder(roots[index], identities, releaseOrder);
		}
		for (let index = 0; index < overlays.length; index++) {
			collectComponentReleaseOrder(overlays[index]?.component, identities, releaseOrder);
		}
		releaseCollectedComponentRenderCaches(releaseOrder, undefined);
	} finally {
		releaseOrder.length = 0;
		identities.clear();
	}
}

const COMPONENT_RELEASE_LIVE = 1;
const COMPONENT_RELEASE_VISITED = 2;

export interface DetachedComponentReleaseMetrics {
	liveNodesScanned: number;
	detachedNodesScanned: number;
	releasedNodes: number;
	identityTableHighWaterMark: number;
	retainedIdentityEntries: number;
}

function recordComponentReleaseIdentityHighWaterMark(
	identities: Map<Component, number>,
	metrics: DetachedComponentReleaseMetrics | undefined,
): void {
	if (metrics && identities.size > metrics.identityTableHighWaterMark) {
		metrics.identityTableHighWaterMark = identities.size;
	}
}

function collectLiveComponentIdentity(
	component: Component | undefined,
	identities: Map<Component, number>,
	metrics: DetachedComponentReleaseMetrics | undefined,
): void {
	if (component === undefined) return;
	const state = identities.get(component) ?? 0;
	if ((state & COMPONENT_RELEASE_LIVE) !== 0) return;
	identities.set(component, state | COMPONENT_RELEASE_LIVE);
	if (metrics) metrics.liveNodesScanned++;
	recordComponentReleaseIdentityHighWaterMark(identities, metrics);
	collectLiveComponentIdentity(component[GET_COMPONENT_RENDER_CACHE_CHILD]?.(), identities, metrics);
	const children = component[GET_COMPONENT_RENDER_CACHE_CHILDREN]?.();
	if (children === undefined) return;
	for (let index = 0; index < children.length; index++) {
		collectLiveComponentIdentity(children[index], identities, metrics);
	}
}

function collectDetachedComponentReleaseOrder(
	component: Component | undefined,
	identities: Map<Component, number>,
	releaseOrder: Component[],
	metrics: DetachedComponentReleaseMetrics | undefined,
): void {
	if (component === undefined) return;
	const state = identities.get(component) ?? 0;
	if ((state & (COMPONENT_RELEASE_LIVE | COMPONENT_RELEASE_VISITED)) !== 0) return;
	identities.set(component, state | COMPONENT_RELEASE_VISITED);
	if (metrics) metrics.detachedNodesScanned++;
	recordComponentReleaseIdentityHighWaterMark(identities, metrics);
	const child = component[GET_COMPONENT_RENDER_CACHE_CHILD]?.();
	if (child !== undefined) {
		collectDetachedComponentReleaseOrder(child, identities, releaseOrder, metrics);
	}
	const children = component[GET_COMPONENT_RENDER_CACHE_CHILDREN]?.();
	if (children !== undefined) {
		for (let index = 0; index < children.length; index++) {
			collectDetachedComponentReleaseOrder(children[index], identities, releaseOrder, metrics);
		}
	}
	releaseOrder.push(component);
}

/**
 * Release only detached component sidecars while preserving identities still
 * reachable from a live ownership graph. This lifecycle-only traversal owns a
 * call-local identity table and releases it before returning.
 */
export function releaseDetachedComponentRenderCaches(
	component: Component | undefined,
	liveRoots: readonly Component[],
	metrics?: DetachedComponentReleaseMetrics,
): void {
	const identities = new Map<Component, number>();
	const releaseOrder: Component[] = [];
	try {
		for (let index = 0; index < liveRoots.length; index++) {
			collectLiveComponentIdentity(liveRoots[index], identities, metrics);
		}
		collectDetachedComponentReleaseOrder(component, identities, releaseOrder, metrics);
		releaseCollectedComponentRenderCaches(releaseOrder, metrics);
	} finally {
		releaseOrder.length = 0;
		identities.clear();
		if (metrics) metrics.retainedIdentityEntries = 0;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setRenderInstrumentation(instrumentation: TuiRenderInstrumentation | undefined): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): Promise<void>;
	dispose(options?: TuiStopOptions): Promise<void>;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	flushTerminalFrames(): Promise<void>;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
	queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
}

export const VIEWPORT_TUI = Symbol.for("@super-pi/tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = process.env.SP_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.SP_CLEAR_ON_SHRINK === "1";
	protected fullRedrawCount = 0;
	protected stopped = false;
	/** Concurrent callers share one query; one tombstone owns a timed-out physical reply. */
	private osc11BackgroundQueryPromise: Promise<RgbColor | undefined> | undefined;
	private osc11BackgroundQueryResolve: ((rgb: RgbColor | undefined) => void) | undefined;
	private osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
	private osc11BackgroundPhysicalOutstanding = false;
	private osc11BackgroundTombstone = false;
	private osc11BackgroundUnsupported = false;
	private osc11BackgroundWaveGeneration = 0;
	private osc11BackgroundActiveGeneration = 0;
	private capturedOsc11BackgroundResolve: ((rgb: RgbColor | undefined) => void) | undefined;
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	protected readonly logDirectory: string;
	private renderInstrumentation: TuiRenderInstrumentation | undefined;
	private readonly terminalFrameQueue: TerminalFrameQueue;
	private terminalFrameError: Error | undefined;
	private recoverableTerminalControlError: RecoverableTerminalLifecycleTimeoutError | undefined;
	private stopping = false;
	private stopPromise: Promise<void> | undefined;
	private disposePromise: Promise<void> | undefined;
	private disposed = false;
	private readonly terminalBoundaryTimeoutMs: number;
	private composingTerminalFrame = false;
	private composedTerminalFrame = "";
	private composedTerminalDiffLines = 0;
	private readonly overlayLinesScratch: string[][] = [];
	private readonly overlayRowsScratch: number[] = [];
	private readonly overlayColsScratch: number[] = [];
	private readonly overlayWidthsScratch: number[] = [];
	private readonly overlayLineCountsScratch: number[] = [];
	private readonly overlaySegmentsScratch: ExtractedSegmentsResult = {
		before: "",
		beforeWidth: 0,
		after: "",
		afterWidth: 0,
	};
	private readonly overlaySliceScratch: SliceWithWidthResult = { text: "", width: 0 };
	private resolvedOverlayWidth = 0;
	private resolvedOverlayRow = 0;
	private resolvedOverlayCol = 0;
	private resolvedOverlayMaxHeight: number | undefined;
	private readonly recordTerminalFrameQueueDepth = (
		activeWrites: 0 | 1,
		pendingFrames: 0 | 1,
		activeFrameUtf8Bytes: number,
		pendingFrameUtf8Bytes: number,
	): void =>
		this.renderInstrumentation?.recordTerminalFrameQueueDepth(
			activeWrites,
			pendingFrames,
			activeFrameUtf8Bytes,
			pendingFrameUtf8Bytes,
		);
	private readonly recordTerminalFrameWrite = (diffLines: number, utf8Bytes: number): void =>
		this.renderInstrumentation?.recordTerminalFrame(utf8Bytes, diffLines);
	private readonly recordTerminalFrameReplacement = (): void =>
		this.renderInstrumentation?.recordTerminalFrameReplaced();
	private readonly handleTerminalFrameQueueIdle = (): void => this.onTerminalFrameQueueIdle();
	private readonly handleTerminalFrameQueueError = (error: Error): void => this.onTerminalFrameWriteError(error);
	private readonly ignoreTerminalLifecycleRejection = (): void => {};
	private readonly onTerminalInput = (data: string): void => this.handleTerminalInput(data);
	private readonly onTerminalResize = (): void => this.requestRender();
	private readonly scheduleRequestedRender = (): void => this.scheduleRender();
	private readonly runImmediateRender = (): void => {
		this.immediateRenderScheduled = false;
		if (this.stopped || this.stopping || !this.renderRequested || !this.terminalFrameQueue.canSubmitImmediately) return;
		this.cancelRenderTimer();
		this.performRender();
	};
	private readonly runScheduledRender = (): void => {
		this.renderTimer = undefined;
		if (this.stopped || this.stopping || !this.terminalFrameQueue.canSubmitImmediately || !this.renderRequested) return;
		this.performRender();
		if (this.renderRequested) this.scheduleRender();
	};
	private readonly captureOsc11BackgroundResolve = (resolve: (rgb: RgbColor | undefined) => void): void => {
		this.capturedOsc11BackgroundResolve = resolve;
	};
	private readonly handleOsc11BackgroundTimeout = (generation: number): void => {
		if (generation !== this.osc11BackgroundActiveGeneration) return;
		this.osc11BackgroundQueryTimer = undefined;
		const resolve = this.osc11BackgroundQueryResolve;
		if (!resolve) return;
		this.osc11BackgroundQueryResolve = undefined;
		this.osc11BackgroundQueryPromise = undefined;
		if (this.osc11BackgroundPhysicalOutstanding) {
			this.osc11BackgroundPhysicalOutstanding = false;
			this.osc11BackgroundTombstone = true;
		} else if (this.osc11BackgroundTombstone) {
			// One follower wave already waited for the unidentifiable stale reply.
			// Cache unsupported until a late OSC 11 response proves otherwise.
			this.osc11BackgroundTombstone = false;
			this.osc11BackgroundUnsupported = true;
		}
		this.osc11BackgroundActiveGeneration = 0;
		resolve(undefined);
	};
	private startOsc11BackgroundPhysicalQuery(): void {
		if (this.osc11BackgroundPhysicalOutstanding || this.osc11BackgroundTombstone) return;
		this.osc11BackgroundPhysicalOutstanding = true;
		this.writeTerminalControl("\x1b]11;?\x07");
	}

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private readonly overlayFocusRestore: OverlayFocusRestoreState = {
		status: "inactive",
		overlay: undefined,
		blockedBy: null,
		resumeStatus: "restore-overlay",
		resumeTarget: null,
	};

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		terminalBoundaryTimeoutMs = DEFAULT_TERMINAL_LIFECYCLE_TIMEOUT_MS,
	) {
		super();
		this.terminal = terminal;
		if (!Number.isFinite(terminalBoundaryTimeoutMs) || terminalBoundaryTimeoutMs <= 0) {
			throw new RangeError("terminalBoundaryTimeoutMs must be a positive finite number");
		}
		this.terminalBoundaryTimeoutMs = terminalBoundaryTimeoutMs;
		this.terminalFrameQueue = new TerminalFrameQueue(this.terminal, {
			onDepthChanged: this.recordTerminalFrameQueueDepth,
			onWriteStarted: this.recordTerminalFrameWrite,
			onFrameReplaced: this.recordTerminalFrameReplacement,
			onIdle: this.handleTerminalFrameQueueIdle,
			onError: this.handleTerminalFrameQueueError,
		});
		this.logDirectory = logDirectory ?? process.env.SP_CODING_AGENT_DIR ?? path.join(os.homedir(), ".sp", "agent");
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	protected observeTerminalLifecycle(promise: Promise<void>): void {
		void promise.then(undefined, this.ignoreTerminalLifecycleRejection);
	}

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void | Promise<void> {}

	protected afterTerminalStop(_options: TuiStopOptions): void | Promise<void> {}

	/** Final unmount boundary. Ordinary stop/restart deliberately does not call this hook. */
	protected releaseMountedComponentsAfterDispose(): void {
		const roots = this.getMountedRoots();
		releaseMountedComponentRenderCaches(roots, this.overlayStack);
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	setRenderInstrumentation(instrumentation: TuiRenderInstrumentation | undefined): void {
		this.renderInstrumentation = instrumentation;
	}

	protected recordRootRender(generatedLines: number, visibleLines: number): void {
		this.renderInstrumentation?.recordRootRender(generatedLines, visibleLines);
	}

	protected recordAltLayoutFrame(
		nodesVisited: number,
		boxObjects: number,
		rectObjects: number,
		clipObjects: number,
		renderCacheLookupProbes: number,
		renderCacheRecordCount: number,
		renderCacheIndexActivations: number,
		renderCacheWidthVariantBypasses: number,
		screenArraysCreated: number,
		fullViewportArrayCopies: number,
		stringRepeatCalls: number,
		stringRepeatBytes: number,
		paintBoxCalls: number,
		childRenderCalls: number,
		fullWidthRowCacheHits: number,
		cachedSourceCodeUnits: number,
		cachedPaintedCodeUnits: number,
		maximumCachedRowCodeUnits: number,
		rowCacheRejectedBySize: number,
	): void {
		this.renderInstrumentation?.recordAltLayoutFrame(
			nodesVisited,
			boxObjects,
			rectObjects,
			clipObjects,
			renderCacheLookupProbes,
			renderCacheRecordCount,
			renderCacheIndexActivations,
			renderCacheWidthVariantBypasses,
			screenArraysCreated,
			fullViewportArrayCopies,
			stringRepeatCalls,
			stringRepeatBytes,
			paintBoxCalls,
			childRenderCalls,
			fullWidthRowCacheHits,
			cachedSourceCodeUnits,
			cachedPaintedCodeUnits,
			maximumCachedRowCodeUnits,
			rowCacheRejectedBySize,
		);
	}

	protected recordSelectionComposition(rowsVisited: number, linesComposed: number): void {
		this.renderInstrumentation?.recordSelectionComposition(rowsVisited, linesComposed);
	}

	/** Low-frequency lifecycle diagnostic; never called from the frame path. */
	protected getOverlayCompositionRetainedLineReferences(): number {
		let references = this.overlayLinesScratch.length;
		if (this.overlaySegmentsScratch.before.length !== 0) references++;
		if (this.overlaySegmentsScratch.after.length !== 0) references++;
		if (this.overlaySliceScratch.text.length !== 0) references++;
		return references;
	}

	protected writeTerminalFrame(data: string, diffLines: number): void {
		if (this.composingTerminalFrame) {
			this.composedTerminalFrame += data;
			this.composedTerminalDiffLines += diffLines;
			return;
		}
		const utf8Bytes = this.terminalFrameQueue.submit(data, diffLines);
		this.renderInstrumentation?.recordTerminalFrameGenerated(utf8Bytes);
	}

	/** Send a non-frame terminal control and contain asynchronous write failure. */
	protected writeTerminalControl(data: string): void {
		try {
			const write = this.terminal.write(data);
			if (write && typeof write.then === "function") {
				void this.awaitTerminalBoundary(write).catch((error) => this.onTerminalFrameWriteError(asError(error)));
			}
		} catch (error) {
			this.onTerminalFrameWriteError(asError(error));
		}
	}

	protected recordFullHistoryFallback(): void {
		this.renderInstrumentation?.recordFullHistoryFallback();
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal(component, "clear");
	}

	private setFocusInternal(component: Component | null, overlayFocusRestore: OverlayFocusRestorePolicy): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		let previousFocusedOverlay: OverlayStackEntry | undefined;
		let nextFocusIsOverlay = false;
		for (let index = 0; index < this.overlayStack.length; index++) {
			const entry = this.overlayStack[index]!;
			if (!previousFocusedOverlay && previousFocus && entry.component === previousFocus && this.isOverlayVisible(entry)) {
				previousFocusedOverlay = entry;
			}
			if (nextFocus && entry.component === nextFocus) nextFocusIsOverlay = true;
		}
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState?.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (
					restoreState.resumeStatus === "focus-target"
					|| !restoreState.blockedBy
					|| !this.isComponentMounted(restoreState.blockedBy)
				) {
					nextFocus = this.resolveBlockedOverlayFocusResume();
				} else {
					restoreState.blockedBy = nextFocus;
				}
			} else if (
				previousFocusedOverlay &&
				restoreState &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.setBlockedOverlayFocusRestore(previousFocusedOverlay, nextFocus, "restore-overlay", null);
			}
		} else if (nextFocus === null) {
			if (restoreState?.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume();
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		let focusedOverlay: OverlayStackEntry | undefined;
		if (nextFocus) {
			for (let index = 0; index < this.overlayStack.length; index++) {
				const entry = this.overlayStack[index]!;
				if (entry.component === nextFocus && this.isOverlayVisible(entry)) {
					focusedOverlay = entry;
					break;
				}
			}
		}
		if (focusedOverlay) {
			this.setEligibleOverlayFocusRestore(focusedOverlay);
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore.status = "inactive";
		this.overlayFocusRestore.overlay = undefined;
		this.overlayFocusRestore.blockedBy = null;
		this.overlayFocusRestore.resumeStatus = "restore-overlay";
		this.overlayFocusRestore.resumeTarget = null;
	}

	private setEligibleOverlayFocusRestore(overlay: OverlayStackEntry): void {
		this.overlayFocusRestore.status = "eligible";
		this.overlayFocusRestore.overlay = overlay;
		this.overlayFocusRestore.blockedBy = null;
		this.overlayFocusRestore.resumeStatus = "restore-overlay";
		this.overlayFocusRestore.resumeTarget = null;
	}

	private setBlockedOverlayFocusRestore(
		overlay: OverlayStackEntry,
		blockedBy: Component,
		resumeStatus: OverlayFocusResumeStatus,
		resumeTarget: Component | null,
	): void {
		this.overlayFocusRestore.status = "blocked";
		this.overlayFocusRestore.overlay = overlay;
		this.overlayFocusRestore.blockedBy = blockedBy;
		this.overlayFocusRestore.resumeStatus = resumeStatus;
		this.overlayFocusRestore.resumeTarget = resumeTarget;
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(): Component | null {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.resumeStatus === "restore-overlay") return restoreState.overlay?.component ?? null;
		const target = restoreState.resumeTarget;
		this.clearOverlayFocusRestore();
		return target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState | undefined {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive" || !restoreState.overlay) return undefined;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) return undefined;
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		let current = entry.preFocus;
		let remaining = this.overlayStack.length + 1;
		while (current && remaining > 0) {
			if (current === component) return true;
			let parent: Component | null = null;
			for (let index = 0; index < this.overlayStack.length; index++) {
				const overlay = this.overlayStack[index]!;
				if (overlay.component === current) {
					parent = overlay.preFocus;
					break;
				}
			}
			current = parent;
			remaining--;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	protected appendActiveComponentOwnershipRoots(_target: Component[]): void {}

	protected appendOverlayComponentOwnershipRoots(target: Component[]): void {
		for (let index = 0; index < this.overlayStack.length; index++) {
			target.push(this.overlayStack[index]!.component);
		}
	}

	private isComponentMounted(component: Component): boolean {
		const roots = this.getMountedRoots();
		for (let index = 0; index < roots.length; index++) {
			if (this.containsComponent(roots[index]!, component)) return true;
		}
		return false;
	}

	private releaseDetachedOverlayComponent(component: Component): void {
		const liveRoots: Component[] = [];
		try {
			const mountedRoots = this.getMountedRoots();
			for (let index = 0; index < mountedRoots.length; index++) {
				liveRoots.push(mountedRoots[index]!);
			}
			this.appendOverlayComponentOwnershipRoots(liveRoots);
			this.appendActiveComponentOwnershipRoots(liveRoots);
			releaseDetachedComponentRenderCaches(component, liveRoots);
		} finally {
			liveRoots.length = 0;
		}
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		const child = root[GET_COMPONENT_RENDER_CACHE_CHILD]?.();
		if (child !== undefined && this.containsComponent(child, target)) return true;
		const children = root[GET_COMPONENT_RENDER_CACHE_CHILDREN]?.();
		if (children === undefined) return false;
		for (let index = 0; index < children.length; index++) {
			if (this.containsComponent(children[index]!, target)) return true;
		}
		return false;
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
					this.releaseDetachedOverlayComponent(component);
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions && restoreState.blockedBy) {
						this.setBlockedOverlayFocusRestore(entry, restoreState.blockedBy, "focus-target", unfocusOptions.target);
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
		this.releaseDetachedOverlayComponent(overlay.component);
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		for (let index = 0; index < this.overlayStack.length; index++) {
			if (this.isOverlayVisible(this.overlayStack[index]!)) return true;
		}
		return false;
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		if (this.disposed) throw new Error("Cannot start a disposed TUI");
		if (this.stopping) return;
		const recoveredFailure = this.terminalFrameQueue.restartAfterLifecycleAbort();
		if (recoveredFailure && this.terminalFrameError === recoveredFailure) this.terminalFrameError = undefined;
		const recoveredControlFailure = this.recoverableTerminalControlError;
		if (recoveredControlFailure && this.terminalFrameError === recoveredControlFailure) {
			this.terminalFrameError = undefined;
		}
		this.recoverableTerminalControlError = undefined;
		this.terminalFrameQueue.attach();
		this.stopped = false;
		this.stopPromise = undefined;
		this.beforeTerminalStart();
		this.terminal.start(this.onTerminalInput, this.onTerminalResize);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.writeTerminalControl("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.writeTerminalControl(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.writeTerminalControl("\x1b[16t");
	}

	stop(options: TuiStopOptions = {}): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.stopped) return Promise.resolve();
		this.stopping = true;
		this.cancelRenderTimer();
		if (this.renderRequested) this.terminalFrameQueue.discardPending();
		if (this.terminalFrameQueue.canSubmitImmediately && this.renderRequested) {
			try {
				this.performRender();
			} catch (error) {
				this.recordTerminalControlError(error);
			}
		}
		this.stopPromise = this.terminalFrameQueue.busy || (this.renderRequested && !this.terminalFrameQueue.canSubmitImmediately)
			? this.finishStopAfterFrames(options)
			: this.finishTerminalStop(options);
		return this.stopPromise;
	}

	dispose(options: TuiStopOptions = {}): Promise<void> {
		if (!this.disposePromise) this.disposePromise = this.finishDispose(options);
		return this.disposePromise;
	}

	private async finishDispose(options: TuiStopOptions): Promise<void> {
		try {
			await this.stop(options);
		} finally {
			let disposeError: unknown;
			let disposeFailed = false;
			this.disposed = true;
			try {
				this.releaseMountedComponentsAfterDispose();
			} catch (error) {
				disposeFailed = true;
				disposeError = error;
			}
			try {
				this.terminalFrameQueue.detach();
			} catch (error) {
				if (!disposeFailed) {
					disposeFailed = true;
					disposeError = error;
				}
			}
			try {
				this.terminal.setFrameWriteReadyListener?.(undefined);
			} catch (error) {
				if (!disposeFailed) {
					disposeFailed = true;
					disposeError = error;
				}
			}
			try {
				this.terminal.setFrameWriteCompletionListener(undefined);
			} catch (error) {
				if (!disposeFailed) {
					disposeFailed = true;
					disposeError = error;
				}
			}
			try {
				this.terminal.setFrameWriteStartedListener?.(undefined);
			} catch (error) {
				if (!disposeFailed) {
					disposeFailed = true;
					disposeError = error;
				}
			}
			try {
				this.terminal.dispose?.();
			} catch (error) {
				if (!disposeFailed) {
					disposeFailed = true;
					disposeError = error;
				}
			}
			this.focusedComponent = null;
			this.inputListeners.clear();
			this.terminalColorSchemeListeners.clear();
			if (this.osc11BackgroundQueryTimer) clearTimeout(this.osc11BackgroundQueryTimer);
			this.osc11BackgroundQueryTimer = undefined;
			const resolve = this.osc11BackgroundQueryResolve;
			this.osc11BackgroundQueryResolve = undefined;
			this.osc11BackgroundQueryPromise = undefined;
			this.osc11BackgroundPhysicalOutstanding = false;
			this.osc11BackgroundTombstone = false;
			this.osc11BackgroundUnsupported = false;
			this.osc11BackgroundActiveGeneration = 0;
			resolve?.(undefined);
			if (disposeFailed) throw disposeError;
		}
	}

	private async finishStopAfterFrames(options: TuiStopOptions): Promise<void> {
		try {
			await this.awaitTerminalBoundary(
				this.drainStopFrames(),
				(error) => this.terminalFrameQueue.abort(error),
				"Terminal lifecycle flush",
			);
		} catch (error) {
			this.terminalFrameError ??= error instanceof Error ? error : new Error(String(error));
		}
		await this.finishTerminalStop(options);
	}

	private async drainStopFrames(): Promise<void> {
		while (!this.terminalFrameError) {
			await this.terminalFrameQueue.flush();
			if (!this.renderRequested) break;
			this.performRender();
		}
	}

	private async finishTerminalStop(options: TuiStopOptions): Promise<void> {
		if (this.terminalColorSchemeNotificationsEnabled) {
			try {
				await this.awaitTerminalBoundary(this.terminal.write("\x1b[?2031l"));
			} catch (error) {
				this.recordTerminalControlError(error);
			}
		}
		try {
			await this.awaitTerminalBoundary(this.beforeTerminalStop(options));
		} catch (error) {
			this.recordTerminalControlError(error);
		}
		try {
			this.terminal.showCursor();
		} catch (error) {
			this.recordTerminalControlError(error);
		}
		try {
			this.terminal.stop();
		} catch (error) {
			this.recordTerminalControlError(error);
		}
		try {
			await this.awaitTerminalBoundary(this.afterTerminalStop(options));
		} catch (error) {
			this.recordTerminalControlError(error);
		}
		this.markTerminalStopped();
	}

	private async awaitTerminalBoundary(
		boundary: void | Promise<void>,
		onTimeout?: (error: Error) => void,
		label = "Terminal cleanup",
	): Promise<void> {
		if (!boundary || typeof boundary.then !== "function") return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				boundary,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						const error = new RecoverableTerminalLifecycleTimeoutError(label, this.terminalBoundaryTimeoutMs);
						onTimeout?.(error);
						reject(error);
					}, this.terminalBoundaryTimeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private markTerminalStopped(): void {
		this.terminalFrameQueue.detach();
		this.stopped = true;
		this.stopping = false;
		this.renderRequested = false;
		this.immediateRenderScheduled = false;
	}

	async flushTerminalFrames(): Promise<void> {
		while (true) {
			await this.terminalFrameQueue.flush();
			if (this.terminalFrameError) throw this.terminalFrameError;
			if (this.stopped || this.stopping || !this.renderRequested) return;
			this.performRender();
		}
	}

	/** Numeric/reference-only queue state for lifecycle and benchmark diagnostics. */
	getTerminalFrameQueueSnapshot(): Readonly<TerminalFrameQueueSnapshot & { pendingRenderIntents: 0 | 1 }> {
		return Object.freeze({
			...this.terminalFrameQueue.snapshot(),
			pendingRenderIntents: this.renderRequested ? 1 : 0,
		});
	}

	renderNow(force = false): void {
		if (this.stopped || this.stopping) return;
		if (force) {
			this.resetRenderState();
			this.terminalFrameQueue.discardPending();
		}
		if (!this.terminalFrameQueue.canSubmitImmediately) {
			if (!this.renderRequested) this.renderInstrumentation?.recordPendingRenderRequest();
			this.renderRequested = true;
			return;
		}
		this.performRender();
	}

	requestRender(force = false): void {
		if (this.stopped || this.stopping) return;
		if (force) {
			this.resetRenderState();
			this.terminalFrameQueue.discardPending();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		this.renderInstrumentation?.recordPendingRenderRequest();
		process.nextTick(this.scheduleRequestedRender);
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		const wasRequested = this.renderRequested;
		this.renderRequested = true;
		if (!wasRequested) this.renderInstrumentation?.recordPendingRenderRequest();
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(this.runImmediateRender);
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (
			this.stopped ||
			this.stopping ||
			!this.terminalFrameQueue.canSubmitImmediately ||
			this.renderTimer ||
			!this.renderRequested
		) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(this.runScheduledRender, delay);
	}

	private performRender(): void {
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.composingTerminalFrame = true;
		this.composedTerminalFrame = "";
		this.composedTerminalDiffLines = 0;
		try {
			this.doRender();
			if (this.composedTerminalFrame.length > 0) {
				const utf8Bytes = this.terminalFrameQueue.submit(
					this.composedTerminalFrame,
					this.composedTerminalDiffLines,
				);
				this.renderInstrumentation?.recordTerminalFrameGenerated(utf8Bytes);
			}
		} finally {
			this.composingTerminalFrame = false;
			this.composedTerminalFrame = "";
			this.composedTerminalDiffLines = 0;
		}
	}

	private onTerminalFrameQueueIdle(): void {
		if (this.stopped || this.stopping || !this.renderRequested) return;
		this.requestImmediateRender();
	}

	private onTerminalFrameWriteError(error: Error): void {
		this.terminalFrameError = error;
		this.recoverableTerminalControlError = undefined;
		this.renderInstrumentation?.recordTerminalFrameWriteError();
		this.renderRequested = false;
		this.cancelRenderTimer();
		if (!this.stopping && !this.stopped) this.observeTerminalLifecycle(this.stop());
	}

	private recordTerminalControlError(error: unknown): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (failure instanceof RecoverableTerminalLifecycleTimeoutError) {
			if (!this.terminalFrameError) {
				this.terminalFrameError = failure;
				this.recoverableTerminalControlError = failure;
			}
		} else {
			if (!this.terminalFrameError || this.terminalFrameError === this.recoverableTerminalControlError) {
				this.terminalFrameError = failure;
			}
			this.recoverableTerminalControlError = undefined;
		}
		this.renderInstrumentation?.recordTerminalFrameWriteError();
	}

	private handleTerminalInput(data: string): void {
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}
		if (this.stopping || this.stopped) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (this.stopping || this.stopped) {
					return;
				}
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}
		if (this.stopping || this.stopped) {
			return;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		let focusedOverlay: OverlayStackEntry | undefined;
		for (let index = 0; index < this.overlayStack.length; index++) {
			const entry = this.overlayStack[index]!;
			if (entry.component === this.focusedComponent) {
				focusedOverlay = entry;
				break;
			}
		}
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal(focusedOverlay.preFocus, "preserve");
			}
		}

		let focusIsOverlay = false;
		for (let index = 0; index < this.overlayStack.length; index++) {
			if (this.overlayStack[index]!.component === this.focusedComponent) {
				focusIsOverlay = true;
				break;
			}
		}
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState?.status === "eligible" && restoreState.overlay) {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState?.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resumeStatus === "restore-overlay" && restoreState.overlay) {
					this.setFocus(restoreState.overlay.component);
				} else {
					const target = restoreState.resumeTarget;
					this.clearOverlayFocusRestore();
					this.setFocus(target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			if (this.stopping || this.stopped) {
				return;
			}
			// Keyboard input is latency-sensitive. Avoid the throttled timer path,
			// where even setTimeout(0) can take a full 16 ms tick on Windows.
			this.requestImmediateRender();
		}
	}

	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		if (this.osc11BackgroundUnsupported) {
			// A reply after the unsupported cache can only belong to the last timed-out
			// physical request. Consume it and permit a future fresh query.
			this.osc11BackgroundUnsupported = false;
			return true;
		}
		if (this.osc11BackgroundTombstone) {
			this.osc11BackgroundTombstone = false;
			if (this.osc11BackgroundQueryResolve) this.startOsc11BackgroundPhysicalQuery();
			return true;
		}
		if (!this.osc11BackgroundPhysicalOutstanding) return false;
		this.osc11BackgroundPhysicalOutstanding = false;
		if (this.osc11BackgroundQueryTimer) clearTimeout(this.osc11BackgroundQueryTimer);
		this.osc11BackgroundQueryTimer = undefined;
		const resolve = this.osc11BackgroundQueryResolve;
		this.osc11BackgroundQueryResolve = undefined;
		this.osc11BackgroundQueryPromise = undefined;
		this.osc11BackgroundActiveGeneration = 0;
		resolve?.(rgb);
		return true;
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout into fixed instance slots used only by the current
	 * synchronous compositeOverlays call.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): void {

		// Parse margin (clamp to non-negative)
		const margin = options?.margin;
		const marginTop = Math.max(0, typeof margin === "number" ? margin : (margin?.top ?? 0));
		const marginRight = Math.max(0, typeof margin === "number" ? margin : (margin?.right ?? 0));
		const marginBottom = Math.max(0, typeof margin === "number" ? margin : (margin?.bottom ?? 0));
		const marginLeft = Math.max(0, typeof margin === "number" ? margin : (margin?.left ?? 0));

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(options?.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (options?.minWidth !== undefined) {
			width = Math.max(width, options.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(options?.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (options?.row !== undefined) {
			if (typeof options.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const percentage = parsePercentage(options.row);
				if (percentage !== undefined) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					row = marginTop + Math.floor((maxRow * percentage) / 100);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = options.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = options?.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (options?.col !== undefined) {
			if (typeof options.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const percentage = parsePercentage(options.col);
				if (percentage !== undefined) {
					const maxCol = Math.max(0, availWidth - width);
					col = marginLeft + Math.floor((maxCol * percentage) / 100);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = options.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = options?.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (options?.offsetY !== undefined) row += options.offsetY;
		if (options?.offsetX !== undefined) col += options.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		this.resolvedOverlayWidth = width;
		this.resolvedOverlayRow = row;
		this.resolvedOverlayCol = col;
		this.resolvedOverlayMaxHeight = maxHeight;
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}


	/**
	 * Composite overlays into the caller-owned frame array. The input is consumed
	 * in place; per-instance scratch retains no line references after this call.
	 */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		let renderedCount = 0;
		let previousFocusOrder = -1;
		let minLinesNeeded = lines.length;
		try {
			while (true) {
				let entry: OverlayStackEntry | undefined;
				let nextFocusOrder = Number.POSITIVE_INFINITY;
				for (let index = 0; index < this.overlayStack.length; index++) {
					const candidate = this.overlayStack[index]!;
					if (
						candidate.focusOrder > previousFocusOrder &&
						candidate.focusOrder < nextFocusOrder &&
						this.isOverlayVisible(candidate)
					) {
						entry = candidate;
						nextFocusOrder = candidate.focusOrder;
					}
				}
				if (!entry) break;
				previousFocusOrder = nextFocusOrder;

				this.resolveOverlayLayout(entry.options, 0, termWidth, termHeight);
				const width = this.resolvedOverlayWidth;
				const maxHeight = this.resolvedOverlayMaxHeight;
				const overlayLines = entry.component.render(width);
				this.renderInstrumentation?.recordOverlayRender();
				const lineCount = maxHeight === undefined ? overlayLines.length : Math.min(overlayLines.length, maxHeight);
				this.resolveOverlayLayout(entry.options, lineCount, termWidth, termHeight);

				this.overlayLinesScratch[renderedCount] = overlayLines;
				this.overlayRowsScratch[renderedCount] = this.resolvedOverlayRow;
				this.overlayColsScratch[renderedCount] = this.resolvedOverlayCol;
				this.overlayWidthsScratch[renderedCount] = width;
				this.overlayLineCountsScratch[renderedCount] = lineCount;
				minLinesNeeded = Math.max(minLinesNeeded, this.resolvedOverlayRow + lineCount);
				renderedCount++;
			}

			const workingHeight = Math.max(lines.length, termHeight, minLinesNeeded);
			while (lines.length < workingHeight) lines.push("");
			const viewportStart = Math.max(0, workingHeight - termHeight);
			for (let overlayIndex = 0; overlayIndex < renderedCount; overlayIndex++) {
				const overlayLines = this.overlayLinesScratch[overlayIndex]!;
				const row = this.overlayRowsScratch[overlayIndex]!;
				const col = this.overlayColsScratch[overlayIndex]!;
				const width = this.overlayWidthsScratch[overlayIndex]!;
				const lineCount = this.overlayLineCountsScratch[overlayIndex]!;
				for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
					const targetIndex = viewportStart + row + lineIndex;
					if (targetIndex < 0 || targetIndex >= lines.length) continue;
					const overlayLine = overlayLines[lineIndex]!;
					const clippedLine =
						visibleWidth(overlayLine) > width ? sliceByColumn(overlayLine, 0, width, true) : overlayLine;
					lines[targetIndex] = this.compositeLineAt(lines[targetIndex]!, clippedLine, col, width, termWidth);
				}
			}
			return lines;
		} finally {
			this.overlayLinesScratch.length = 0;
			this.overlayRowsScratch.length = 0;
			this.overlayColsScratch.length = 0;
			this.overlayWidthsScratch.length = 0;
			this.overlayLineCountsScratch.length = 0;
			this.overlaySegmentsScratch.before = "";
			this.overlaySegmentsScratch.after = "";
			this.overlaySliceScratch.text = "";
		}
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		const afterStart = startCol + overlayWidth;
		const base = this.overlaySegmentsScratch;
		extractSegmentsInto(baseLine, startCol, afterStart, totalWidth - afterStart, true, base);
		const overlay = this.overlaySliceScratch;
		sliceWithWidthInto(overlayLine, 0, overlayWidth, true, overlay);
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);
		let repeatCalls = 0;
		let repeatBytes = 0;
		let beforeSpaces = "";
		let overlaySpaces = "";
		let afterSpaces = "";
		if (beforePad !== 0) {
			beforeSpaces = " ".repeat(beforePad);
			repeatCalls++;
			repeatBytes += beforePad;
		}
		if (overlayPad !== 0) {
			overlaySpaces = " ".repeat(overlayPad);
			repeatCalls++;
			repeatBytes += overlayPad;
		}
		if (afterPad !== 0) {
			afterSpaces = " ".repeat(afterPad);
			repeatCalls++;
			repeatBytes += afterPad;
		}
		const result =
			base.before
			+ beforeSpaces
			+ SEGMENT_RESET
			+ overlay.text
			+ overlaySpaces
			+ SEGMENT_RESET
			+ base.after
			+ afterSpaces;
		this.renderInstrumentation?.recordOverlayComposition(1, repeatCalls, repeatBytes);
		return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		let scannedLines = 0;
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			scannedLines++;
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
				this.renderInstrumentation?.recordCursorScan(scannedLines);

				return { row, col };
			}
		}
		this.renderInstrumentation?.recordCursorScan(scannedLines);
		return null;
	}

	/**
	 * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
	 * Concurrent callers join one logical query wave and share the first caller's
	 * deadline. A later caller's timeout does not extend that wave. OSC 11 has no
	 * request identifier, so a timed-out physical request retains one tombstone;
	 * a later logical wave waits for that stale reply before sending its own
	 * physical query. If that follower also reaches its deadline, this TUI caches
	 * OSC 11 as unsupported and later calls reuse one resolved result without a
	 * timer or physical write. A late valid reply is still consumed and clears the
	 * unsupported cache, allowing a future wave to retry safely. This prevents a
	 * late reply from completing the wrong wave without causing permanent waits.
	 * @param timeoutMs First-caller deadline for a newly created query wave.
	 * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		if (this.osc11BackgroundQueryPromise) return this.osc11BackgroundQueryPromise;
		if (this.osc11BackgroundUnsupported) return OSC11_BACKGROUND_UNSUPPORTED;
		this.osc11BackgroundActiveGeneration = ++this.osc11BackgroundWaveGeneration;
		this.capturedOsc11BackgroundResolve = undefined;
		const result = new Promise<RgbColor | undefined>(this.captureOsc11BackgroundResolve);
		this.osc11BackgroundQueryPromise = result;
		this.osc11BackgroundQueryResolve = this.capturedOsc11BackgroundResolve;
		this.capturedOsc11BackgroundResolve = undefined;
		this.osc11BackgroundQueryTimer = setTimeout(this.handleOsc11BackgroundTimeout, timeoutMs, this.osc11BackgroundActiveGeneration);
		this.startOsc11BackgroundPhysicalQuery();
		return result;
	}

	/**
	 * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
	 * Terminals that support the color palette notification protocol reply with
	 * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.writeTerminalControl("\x1b[?996n");
		});
	}
}
