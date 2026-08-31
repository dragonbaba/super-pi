import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import {
	getComponentsContentHeight,
	isLineViewportComponent,
	LINE_VIEWPORT_COMPONENT,
	type LineViewportComponent,
	renderComponentsViewport,
} from "./components/viewport-container.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	LayoutFrameScratch,
	type LayoutFrame,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import {
	OSC133_PROMPT_START_PATTERN,
	OSC133_ZONE_PREFIX_PATTERN,
	SGR_MOUSE_PATTERN,
} from "./regex.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	CURSOR_MARKER,
	compositeTuiLine,
	TuiBase,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import {
	getGraphemeCellRange,
	getGraphemeCellEnd,
	getGraphemeCellStart,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	highlightTerminalColumns,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const PAGE_SCROLL_OVERLAP = 4;
const DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES = 3;
const MAX_FULLSCREEN_WHEEL_SCROLL_LINES = 12;
const SCROLLBAR_DRAG_FRAME_INTERVAL_MS = 32;
const configuredWheelScrollLines = Number(process.env.SP_TUI_FULLSCREEN_WHEEL_SCROLL_LINES);
const FULLSCREEN_WHEEL_SCROLL_LINES = Number.isInteger(configuredWheelScrollLines) &&
	configuredWheelScrollLines >= 1 && configuredWheelScrollLines <= MAX_FULLSCREEN_WHEEL_SCROLL_LINES
	? configuredWheelScrollLines
	: DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES;

function flushScrollbarDragFrame(tui: TuiAltScreen): void {
	tui.onScrollbarDragFrame();
}
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
const DOUBLE_CLICK_INTERVAL_MS = 500;
const wordSegmenter = getWordSegmenter();

interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

export interface TuiAltScreenOptions {
	/** Number of logical lines moved for each mouse-wheel event. */
	wheelScrollLines?: number;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
	onRightClickPaste?: () => void;
	/** Bounded frame and terminal-cleanup wait used by stop/error lifecycle tests and hosts. */
	terminalBoundaryTimeoutMs?: number;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private nextScreen: string[] = [];
	private previousRawScreen: string[] = [];
	private readonly lineResetBuffer = [""];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly layoutScratch = new LayoutFrameScratch();
	private readonly implicitDocument: LineViewportComponent;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	private scrollbarDrag?: ScrollbarDrag;
	private scrollbarDragFrameTimer?: NodeJS.Timeout;
	private pendingScrollbarDragScrollTop?: number;
	private readonly layoutRequestRender = () => this.requestRender();
	private scrollbarHover?: ScrollView;
	private pressedUrl?: string;
	private selectionDragged = false;
	private resolvedSelectionStart: SelectionPoint | undefined;
	private resolvedSelectionEnd: SelectionPoint | undefined;
	private resolvedSelectionStartRow = 0;
	private resolvedSelectionStartCol = 0;
	private resolvedSelectionEndRow = 0;
	private resolvedSelectionEndCol = 0;
	private resolvedSelectionEndBoundary = false;
	private resolvedSelectionColumnStart = 0;
	private resolvedSelectionColumnEnd = 0;
	private readonly wheelScrollLines: number;
	private readonly mouseEnabled: boolean;
	private readonly openUrl?: (url: string) => void;
	private readonly onRightClickPaste?: () => void;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory, options.terminalBoundaryTimeoutMs);
		this.implicitDocument = {
			[LINE_VIEWPORT_COMPONENT]: true,
			render: (width) => super.render(width),
			getContentHeight: (width) => getComponentsContentHeight(this.children, width),
			// Main Screen is the only consumer of bounded mutation attribution. The
			// alternate-screen compatibility document stays deliberately conservative.
			observeViewportMutation: () => ({ token: undefined, kind: "unsafe" }),
			renderViewport: (width, startLine, height) =>
				renderComponentsViewport(this.children, width, startLine, height),
			renderViewportTail: (width, height) => {
				const totalHeight = getComponentsContentHeight(this.children, width);
				return renderComponentsViewport(
					this.children,
					width,
					Math.max(0, totalHeight - height),
					height,
					totalHeight,
				);
			},
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? FULLSCREEN_WHEEL_SCROLL_LINES));
		this.mouseEnabled = options.mouse ?? true;
		this.openUrl = options.openUrl;
		this.onRightClickPaste = options.onRightClickPaste;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.writeTerminalControl(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void | Promise<void> {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		const write = this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
		return write;
	}

	protected override afterTerminalStop(options: TuiStopOptions): void | Promise<void> {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		let write: void | Promise<void>;
		if (options.preserveScreen) {
			write = this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.render(width);
			for (let index = 0; index < documentLines.length; index++) {
				documentLines[index] = documentLines[index]
					.replace(OSC133_ZONE_PREFIX_PATTERN, "")
					.replaceAll(CURSOR_MARKER, "");
			}
			this.lastDocument = this.applyLineResets(documentLines);
			for (let index = 0; index < this.lastDocument.length; index++) {
				const line = this.lastDocument[index];
				if (!isImageLine(line) && visibleWidth(line) > width) {
					this.lastDocument[index] = sliceByColumn(line, 0, width, true);
				}
			}
			let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
			for (let row = 0; row < this.lastDocument.length; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
			write = this.terminal.write(buffer);
		}
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
		this.resetRenderState();
		return write;
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	/** Low-frequency lifecycle diagnostics; never called from the frame path. */
	getAltLayoutRetainedReferenceCounts(): {
		components: number;
		lines: number;
		sources: number;
		cachedRows: number;
		sourceCodeUnits: number;
		paintedCodeUnits: number;
		maximumRowCodeUnits: number;
		indexedComponents: number;
		screenRows: number;
		screenCodeUnits: number;
	} {
		return this.layoutScratch.getRetainedReferenceCounts();
	}

	/** Low-frequency composition lifecycle diagnostics; never called from the frame path. */
	getAltCompositionRetainedReferenceCounts(): {
		overlayLineReferences: number;
		selectionPointReferences: number;
	} {
		return {
			overlayLineReferences: this.getOverlayCompositionRetainedLineReferences(),
			selectionPointReferences:
				(this.resolvedSelectionStart === undefined ? 0 : 1) + (this.resolvedSelectionEnd === undefined ? 0 : 1),
		};
	}

	private prepareKittyScreen(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);

			const cachedImage = this.uploadedKittyImages.get(placement.imageId);
			const nextCachedImage = {
				transmissionGeneration: placement.transmissionGeneration,
				transmissionBytes: placement.transmissionBytes,
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			if (cachedImage) this.uploadedKittyImages.delete(placement.imageId);
			this.uploadedKittyImages.set(placement.imageId, nextCachedImage);

			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? placement.replacementLine
				: line;
		});

		let cachedOffscreenImageCount = 0;
		let cachedOffscreenTransmissionBytes = 0;
		let cachedOffscreenDecodedBytes = 0;
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (visibleImageIds.has(imageId)) continue;
			cachedOffscreenImageCount += 1;
			cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
		}

		let evictedImageDeletion = "";
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (
				cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
				cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
				cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
			) {
				break;
			}
			if (visibleImageIds.has(imageId)) continue;
			evictedImageDeletion += deleteKittyImage(imageId);
			this.uploadedKittyImages.delete(imageId);
			cachedOffscreenImageCount -= 1;
			cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
		}
		return { lines, evictedImageDeletion };
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.nextScreen = [];
		this.previousRawScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
		this.layoutScratch.clear();
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box?.scrollContentLines) return;
		const content = box.children[0]?.component;
		const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines.length;
		if (content && isLineViewportComponent(content)) {
			const chunkSize = Math.max(64, scrollView.viewportHeight * 4);
			let cursor = scrollView.scrollTop + direction;
			while (cursor >= 0 && cursor < contentHeight) {
				const chunkStart = direction > 0 ? cursor : Math.max(0, cursor - chunkSize + 1);
				const chunkEnd = direction > 0 ? Math.min(contentHeight, chunkStart + chunkSize) : cursor + 1;
				const rendered = content.renderViewport(box.children[0]?.rect.width ?? box.rect.width, chunkStart, chunkEnd - chunkStart);
				for (let row = cursor; row >= chunkStart && row < chunkEnd; row += direction) {
					const line = rendered.lines[row - rendered.startLine] ?? "";
					if (!OSC133_PROMPT_START_PATTERN.test(line)) continue;
					scrollView.scrollTo(row);
					this.requestRender();
					return;
				}
				cursor = direction > 0 ? chunkEnd : chunkStart - 1;
			}
			return;
		}

		const contentStart = box.scrollContentStart ?? 0;
		for (let row = scrollView.scrollTop + direction; row >= contentStart && row < contentHeight; row += direction) {
			if (!OSC133_PROMPT_START_PATTERN.test(box.scrollContentLines[row - contentStart] ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestRender();
			return;
		}
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			const hadActiveSelection = this.selectionPressActive;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			this.stopScrollbarDrag();
			this.pressedUrl = undefined;
			this.selectionDragged = false;
			if (hadActiveSelection) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				this.selectionGranularity = "character";
				this.selectionInitialRange = undefined;
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			this.lastClick = undefined;
			return { consume: true };
		}
		if (data === FOCUS_IN) return { consume: true };

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			this.routeWheel(wheelEvent);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			if (this.handleRightClickPaste(mouseEvent)) return { consume: true };
			const handled = this.handleScrollbarMouseEvent(mouseEvent);
			if (!this.scrollbarDrag) this.updateScrollbarHover(mouseEvent.x, mouseEvent.y);
			if (!handled) this.handleSelectionMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			if (!isRelease) this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			if (!isRelease) this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineUp")) {
			if (!isRelease) this.scrollBy(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineDown")) {
			if (!isRelease) this.scrollBy(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = SGR_MOUSE_PATTERN.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
			};
		}
		return undefined;
	}

	private routeWheel(event: WheelEvent): void {
		let remaining = event.direction * this.wheelScrollLines;
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		this.requestRender();
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = SGR_MOUSE_PATTERN.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	private handleRightClickPaste(event: SgrMouseEvent): boolean {
		if (!this.onRightClickPaste || process.platform !== "win32" || event.release || event.button !== 2) {
			return false;
		}
		try {
			this.onRightClickPaste();
		} catch {
			// Clipboard paste is best-effort.
		}
		return true;
	}

	private getScrollbarTargetAt(x: number, y: number): ScrollbarTarget | undefined {
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.thumbTop &&
				y < geometry.thumbTop + geometry.thumbHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y)?.scrollView);
	}

	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const box = this.currentLayout
				? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
				const thumbOffset = Math.max(
					0,
					Math.min(maxThumbOffset, event.y - geometry.trackTop - this.scrollbarDrag.grabOffset),
				);
				const scrollTop =
					maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
				this.queueScrollbarDragScroll(scrollTop);
			}
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.setScrollbarHover(target.scrollView);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset: event.y - target.geometry.thumbTop,
		};
		return true;
	}

	private queueScrollbarDragScroll(scrollTop: number): void {
		this.pendingScrollbarDragScrollTop = scrollTop;
		if (this.scrollbarDragFrameTimer) return;
		this.flushPendingScrollbarDragScroll();
		this.scrollbarDragFrameTimer = setTimeout(flushScrollbarDragFrame, SCROLLBAR_DRAG_FRAME_INTERVAL_MS, this);
		this.scrollbarDragFrameTimer.unref();
	}

	private flushPendingScrollbarDragScroll(): void {
		const scrollView = this.scrollbarDrag?.scrollView;
		const scrollTop = this.pendingScrollbarDragScrollTop;
		this.pendingScrollbarDragScrollTop = undefined;
		if (scrollView && scrollTop !== undefined) scrollView.scrollTo(scrollTop);
	}

	onScrollbarDragFrame(): void {
		this.scrollbarDragFrameTimer = undefined;
		if (this.pendingScrollbarDragScrollTop === undefined) return;
		this.flushPendingScrollbarDragScroll();
		this.scrollbarDragFrameTimer = setTimeout(flushScrollbarDragFrame, SCROLLBAR_DRAG_FRAME_INTERVAL_MS, this);
		this.scrollbarDragFrameTimer.unref();
	}

	private stopScrollbarDrag(): void {
		if (this.scrollbarDragFrameTimer) {
			clearTimeout(this.scrollbarDragFrameTimer);
			this.scrollbarDragFrameTimer = undefined;
		}
		this.flushPendingScrollbarDragScroll();
		this.pendingScrollbarDragScrollTop = undefined;
		this.scrollbarDrag = undefined;
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		if (point.scrollView && this.currentLayout) {
			const box = getScrollViewBox(this.currentLayout, point.scrollView);
			const lines = box?.scrollContentLines;
			if (lines) return lines[point.row - (box?.scrollContentStart ?? 0)] ?? "";
		}
		return this.previousScreen[point.row] ?? "";
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			if (point.col >= start && point.col < end) {
				return {
					start: { ...point, col: start },
					end: { ...point, col: end, boundary: true },
				};
			}
			start = end;
		}
		return undefined;
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.requestRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		if ((event.button & 3) !== 0) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const clickedUrl =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col
					? this.pressedUrl
					: undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		this.selectionPressActive = true;
		const scrollView =
			!this.hasOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.requestRender();
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private resolveSelectionBounds(): boolean {
		const anchor = this.selectionAnchor;
		const focus = this.selectionFocus;
		if (!anchor || !focus || anchor.scrollView !== focus.scrollView) return false;
		if (anchor.row === focus.row && anchor.col === focus.col) return false;
		const anchorBeforeFocus = anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col);
		this.resolvedSelectionStart = anchorBeforeFocus ? anchor : focus;
		this.resolvedSelectionEnd = anchorBeforeFocus ? focus : anchor;
		return true;
	}

	private resolveSelectionColumns(
		line: string,
		row: number,
		minColumn: number,
		maxColumn: number,
		lineWidth: number,
	): boolean {
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === this.resolvedSelectionStartRow) {
			start = getGraphemeCellStart(line, this.resolvedSelectionStartCol)
				?? Math.min(this.resolvedSelectionStartCol, lineWidth);
		}
		if (row === this.resolvedSelectionEndRow) {
			end = this.resolvedSelectionEndBoundary
				? Math.min(this.resolvedSelectionEndCol, lineWidth)
				: (getGraphemeCellEnd(line, this.resolvedSelectionEndCol)
					?? Math.min(this.resolvedSelectionEndCol + 1, lineWidth));
		}
		this.resolvedSelectionColumnStart = Math.max(minColumn, start);
		this.resolvedSelectionColumnEnd = Math.min(maxColumn, end);
		return this.resolvedSelectionColumnEnd > this.resolvedSelectionColumnStart;
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn?: number,
		knownLineWidth?: number,
	): { start: number; end: number } {
		const lineWidth = knownLineWidth ?? visibleWidth(line);
		maxColumn ??= lineWidth;
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	private copySelectionToClipboard(): void {
		const selection = this.getSelectionBounds();
		if (!selection) return;
		let sourceLines: readonly string[] = this.previousScreen;
		let sourceStart = 0;
		if (selection.start.scrollView) {
			if (!this.currentLayout) return;
			const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
			if (!box?.scrollContentLines) return;
			const content = box.children[0]?.component;
			if (content && isLineViewportComponent(content)) {
				const rendered = content.renderViewport(
					box.children[0]?.rect.width ?? box.rect.width,
					selection.start.row,
					selection.end.row - selection.start.row + 1,
				);
				sourceLines = rendered.lines;
				sourceStart = rendered.startLine;
			} else {
				sourceLines = box.scrollContentLines;
				sourceStart = box.scrollContentStart ?? 0;
			}
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row - sourceStart] ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		if (text.length === 0) return;
		this.writeTerminalControl(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		if (!this.resolveSelectionBounds()) return screen;
		let rowsVisited = 0;
		let linesComposed = 0;
		try {
			const start = this.resolvedSelectionStart!;
			const end = this.resolvedSelectionEnd!;
			let minRow = 0;
			let maxRow = screen.length - 1;
			let minColumn = 0;
			let maxColumn = this.terminal.columns;
			this.resolvedSelectionStartRow = start.row;
			this.resolvedSelectionStartCol = start.col;
			this.resolvedSelectionEndRow = end.row;
			this.resolvedSelectionEndCol = end.col;
			this.resolvedSelectionEndBoundary = end.boundary === true;
			if (start.scrollView) {
				if (!layout) return screen;
				const box = getScrollViewBox(layout, start.scrollView);
				if (!box) return screen;
				minRow = Math.max(0, box.rect.y, box.clip.y);
				maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
				minColumn = Math.max(0, box.rect.x, box.clip.x);
				maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
				this.resolvedSelectionStartRow = box.rect.y + start.row - start.scrollView.scrollTop;
				this.resolvedSelectionStartCol = box.rect.x + start.col;
				this.resolvedSelectionEndRow = box.rect.y + end.row - start.scrollView.scrollTop;
				this.resolvedSelectionEndCol = box.rect.x + end.col;
			}
			const firstRow = Math.max(minRow, this.resolvedSelectionStartRow);
			const lastRow = Math.min(maxRow, this.resolvedSelectionEndRow);
			for (let row = firstRow; row <= lastRow; row++) {
				rowsVisited++;
				const line = screen[row];
				if (line === undefined || isImageLine(line)) continue;
				const lineWidth = visibleWidth(line);
				if (!this.resolveSelectionColumns(line, row, minColumn, maxColumn, lineWidth)) continue;
				screen[row] = highlightTerminalColumns(
					line,
					this.resolvedSelectionColumnStart,
					this.resolvedSelectionColumnEnd,
					lineWidth,
				);
				linesComposed++;
			}
			return screen;
		} finally {
			this.recordSelectionComposition(rowsVisited, linesComposed);
			this.resolvedSelectionStart = undefined;
			this.resolvedSelectionEnd = undefined;
		}
	}

	private isMouseSequence(data: string): boolean {
		return SGR_MOUSE_PATTERN.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		if (!this.flashes.hasEntries) return screen;
		const flashLines = this.flashes.render(width);
		const flashStart = Math.max(0, flashLines.length - height);
		while (screen.length < height) screen.push("");
		for (let row = 0; row < flashLines.length - flashStart; row++) {
			const line = flashLines[flashStart + row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			screen[row] = compositeTuiLine(screen[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return screen;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		const nextLayout = renderLayoutFrame(root, width, height, this.layoutRequestRender, this.layoutScratch);
		let screen = nextLayout.lines;
		this.recordAltLayoutFrame(
			nextLayout.layoutNodesVisited ?? 0,
			nextLayout.layoutBoxObjects ?? 0,
			nextLayout.layoutRectObjects ?? 0,
			nextLayout.clipObjects ?? 0,
			nextLayout.renderCacheLookupProbes ?? 0,
			nextLayout.renderCacheRecordCount ?? 0,
			nextLayout.renderCacheIndexActivations ?? 0,
			nextLayout.renderCacheWidthVariantBypasses ?? 0,
			nextLayout.screenArraysCreated ?? 0,
			nextLayout.fullViewportArrayCopies ?? 0,
			nextLayout.stringRepeatCalls ?? 0,
			nextLayout.stringRepeatBytes ?? 0,
			nextLayout.paintBoxCalls ?? 0,
			nextLayout.childRenderCalls ?? 0,
			nextLayout.fullWidthRowCacheHits ?? 0,
			nextLayout.cachedSourceCodeUnits ?? 0,
			nextLayout.cachedPaintedCodeUnits ?? 0,
			nextLayout.maximumCachedRowCodeUnits ?? 0,
			nextLayout.rowCacheRejectedBySize ?? 0,
		);
		this.recordRootRender(nextLayout.generatedLineCount, Math.min(screen.length, height));
		for (let row = 0; row < screen.length; row++) {
			const line = screen[row];
			if (line.startsWith("\x1b]133;")) screen[row] = line.replace(OSC133_ZONE_PREFIX_PATTERN, "");
		}
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) {
			const start = screen.length - height;
			for (let row = 0; row < height; row++) screen[row] = screen[start + row]!;
			screen.length = height;
		}
		screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		const rawScreen = screen;
		const nextScreen = this.nextScreen;
		nextScreen.length = screen.length;
		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		let imagesNeedRedraw = false;
		for (let row = 0; row < screen.length; row++) {
			const rawLine = rawScreen[row];
			const previousLine = this.previousScreen[row];
			let line: string;
			let imageLine: boolean;
			if (!fullRedraw && previousLine !== undefined && rawLine === this.previousRawScreen[row]) {
				line = previousLine;
				imageLine = isImageLine(line);
				nextScreen[row] = line;
			} else {
				line = rawLine;
				imageLine = isImageLine(line);
				if (!imageLine) {
					this.lineResetBuffer[0] = line;
					this.applyLineResets(this.lineResetBuffer);
					line = this.lineResetBuffer[0];
					if (visibleWidth(line) > width) line = sliceByColumn(line, 0, width, true);
					nextScreen[row] = line;
				} else {
					nextScreen[row] = line;
				}
			}
			const comparablePreviousLine = previousLine ?? "";
			if (!imagesNeedRedraw && line !== comparablePreviousLine && (imageLine || isImageLine(comparablePreviousLine))) {
				imagesNeedRedraw = true;
			}
		}
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		let preparedLines = nextScreen;
		let evictedImageDeletion = "";
		if (redrawImages && this.imageProtocol === "kitty") {
			const preparedKittyScreen = this.prepareKittyScreen(nextScreen);
			preparedLines = preparedKittyScreen.lines;
			evictedImageDeletion = preparedKittyScreen.evictedImageDeletion;
		}

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			const clearImages =
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? deleteAllKittyPlacements()
					: this.deleteKittyImages();
			buffer += `${clearImages}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += evictedImageDeletion;

		let diffLines = 0;
		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && nextScreen[row] === this.previousScreen[row]) continue;
			diffLines++;
			buffer += `\x1b[${row + 1};1H\x1b[2K${preparedLines[row] ?? ""}`;
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.writeTerminalFrame(buffer, diffLines);

		const reusableScreen = this.previousScreen;
		this.previousScreen = nextScreen;
		this.nextScreen = reusableScreen;
		this.previousRawScreen = rawScreen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		nextLayout.lines = this.previousScreen;
		this.currentLayout = nextLayout;
	}
}
