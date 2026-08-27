import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { DEVICE_ATTRIBUTES_PATTERN, DEVICE_ATTRIBUTES_PREFIX_PATTERN, KITTY_FLAGS_PATTERN } from "./regex.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u\x1b[c`;

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(KITTY_FLAGS_PATTERN);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (DEVICE_ATTRIBUTES_PATTERN.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || DEVICE_ATTRIBUTES_PREFIX_PATTERN.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && data === "\r" && isShiftPressed) return NATIVE_SHIFT_ENTER_SEQUENCE;
	return data;
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);
}

/**
 * Minimal terminal interface for TUI
 */
export type TerminalFrameWriteCompletion = (generation: number, error?: Error) => void;
export type TerminalFrameWriteStarted = (generation: number) => void;

export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/** Permanently release terminal-owned listeners. Unlike stop(), this instance cannot be resumed. */
	dispose?(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	/** Write a terminal control sequence. Every returned Promise must be awaited or observed. */
	write(data: string): void | Promise<void>;

	/** Register the one stable callback used by the terminal frame lane. */
	setFrameWriteCompletionListener(listener: TerminalFrameWriteCompletion | undefined): void;

	/** Register the stable observer for actual Writable frame-write starts. */
	setFrameWriteStartedListener?(listener: TerminalFrameWriteStarted | undefined): void;

	/**
	 * Start one atomic rendered frame. The registered completion listener fires
	 * only after both the Writable callback and any required drain have completed.
	 */
	writeFrame(data: string, generation: number): void;

	/**
	 * Lifecycle-only logical cancellation. OS output cannot be cancelled: the
	 * canceled generation keeps physical writer ownership until callback + drain
	 * settle. One replacement generation may wait in fixed terminal slots, but it
	 * cannot start early or consume the orphan's callback, drain, or close event.
	 */
	cancelFrameWrite(generation: number): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private readonly frameOutput: Pick<NodeJS.WriteStream, "write" | "on" | "once" | "removeListener">;
	private frameOutputFailure: Error | undefined;
	private physicalFrameWriteActive = false;
	private frameWriteReturned = false;
	private frameWriteCallbackComplete = false;
	private frameWriteDrainComplete = false;
	private frameWriteGeneration = 0;
	private frameWriteCanceled = false;
	private pendingFrameData: string | undefined;
	private pendingFrameGeneration = 0;
	private frameWriteCompletionListener: TerminalFrameWriteCompletion | undefined;
	private frameWriteStartedListener: TerminalFrameWriteStarted | undefined;
	private controlWritesOutstanding = 0;
	private disposed = false;
	private disposeFinalizationScheduled = false;
	private readonly finalizeDisposeAfterEvents = (): void => {
		this.disposeFinalizationScheduled = false;
		if (!this.disposed || this.physicalFrameWriteActive || this.controlWritesOutstanding !== 0) return;
		this.frameOutput.removeListener("error", this.onFrameOutputError);
	};
	private readonly onFrameWriteCallback = (error?: Error | null): void => {
		if (!this.physicalFrameWriteActive) return;
		if (error) {
			this.failFrameOutput(error);
			return;
		}
		this.frameWriteCallbackComplete = true;
		this.tryCompleteFrameWrite();
	};
	private readonly onFrameWriteDrain = (): void => {
		if (!this.physicalFrameWriteActive) return;
		this.frameWriteDrainComplete = true;
		this.tryCompleteFrameWrite();
	};
	private readonly onFrameWriteClose = (): void => {
		if (!this.physicalFrameWriteActive) return;
		this.failFrameOutput(new Error("Terminal frame output closed before frame completion"));
	};
	private readonly onFrameOutputError = (error: Error): void => {
		const failure = error instanceof Error ? error : new Error(String(error));
		this.failFrameOutput(failure);
	};
	private started = false;
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = (() => {
		const env = process.env.SP_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	constructor(frameOutput: Pick<NodeJS.WriteStream, "write" | "on" | "once" | "removeListener"> = process.stdout) {
		this.frameOutput = frameOutput;
		// Writable callback failures may be followed by an error event. Keep one
		// process-terminal-owned observer so that late stream errors are contained
		// after the per-write listeners have already been released.
		this.frameOutput.on("error", this.onFrameOutputError);
	}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.disposed) throw new Error("Cannot start a disposed ProcessTerminal");
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer();

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiationSequence === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // Wait briefly for the rest of a split Kitty response.
			}
			if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) {
				return;
			}

			this.forwardInputSequence(sequence);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable it if available.
	 *
	 * Kitty's progressive enhancement detection requires requesting the desired
	 * flags before querying them. The trailing DA query is a sentinel supported by
	 * terminals that do not know Kitty keyboard protocol; receiving DA before a
	 * Kitty response enables modifyOtherKeys fallback without a startup timeout.
	 *
	 * The requested flags are:
	 * - 1 = disambiguate escape codes
	 * - 2 = report event types (press/repeat/release)
	 * - 4 = report alternate keys (shifted key, base layout key)
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.clearKeyboardProtocolNegotiationBuffer();
		process.stdout.write(KITTY_KEYBOARD_PROTOCOL_QUERY);
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence | undefined,
	): boolean {
		if (!negotiationSequence) return false;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): KeyboardProtocolNegotiationSequence | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return negotiationSequence;
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return negotiationSequence;
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter =
			sequence === "\r" && (isAppleTerminalSession() || process.platform === "win32");
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			const arch = process.arch;
			if (arch !== "x64" && arch !== "arm64") return;

			// Dynamic require so non-Windows and bundled/browser paths never load the
			// native helper. In the npm package native/ is next to dist/; in compiled
			// binary archives native/ is copied next to the executable.
			const moduleDir = path.dirname(fileURLToPath(import.meta.url));
			const nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
			const candidates = [
				path.join(moduleDir, "..", nativePath),
				path.join(moduleDir, nativePath),
				path.join(path.dirname(process.execPath), nativePath),
			];
			for (const modulePath of candidates) {
				try {
					const helper = cjsRequire(modulePath) as { enableVirtualTerminalInput?: () => boolean };
					helper.enableVirtualTerminalInput?.();
					return;
				} catch {
					// Try the next possible packaging location.
				}
			}
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (shouldDisableKittyProtocol) {
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		if (this.started) this.stop();
		this.disposed = true;
		this.clearPendingFrameWrite();
		this.frameWriteCompletionListener = undefined;
		this.frameWriteStartedListener = undefined;
		if (this.physicalFrameWriteActive) this.frameWriteCanceled = true;
		this.scheduleDisposeFinalization();
	}

	write(data: string): Promise<void> {
		if (this.disposed) throw new Error("Cannot write with a disposed ProcessTerminal");
		this.controlWritesOutstanding++;
		const completion = new Promise<void>((resolve, reject) => {
			let callbackPending = true;
			try {
				this.frameOutput.write(data, (error) => {
					if (!callbackPending) return;
					callbackPending = false;
					this.controlWritesOutstanding--;
					this.scheduleDisposeFinalization();
					if (error) reject(error);
					else resolve();
				});
			} catch (error) {
				if (callbackPending) {
					callbackPending = false;
					this.controlWritesOutstanding--;
					this.scheduleDisposeFinalization();
				}
				reject(error);
			}
		});
		this.logWrite(data);
		return completion;
	}

	setFrameWriteCompletionListener(listener: TerminalFrameWriteCompletion | undefined): void {
		this.frameWriteCompletionListener = listener;
	}

	setFrameWriteStartedListener(listener: TerminalFrameWriteStarted | undefined): void {
		this.frameWriteStartedListener = listener;
	}

	writeFrame(data: string, generation: number): void {
		if (this.writeLogPath) this.logWrite(data);
		if (this.disposed) {
			this.frameWriteCompletionListener?.(generation, new Error("ProcessTerminal is disposed"));
			return;
		}
		if (this.frameOutputFailure) {
			this.frameWriteCompletionListener?.(generation, this.frameOutputFailure);
			return;
		}
		if (this.physicalFrameWriteActive) {
			if (this.frameWriteCanceled && this.pendingFrameData === undefined) {
				this.pendingFrameData = data;
				this.pendingFrameGeneration = generation;
				return;
			}
			this.frameWriteCompletionListener?.(generation, new Error("Concurrent terminal frame writes are not supported"));
			return;
		}
		this.startFrameWrite(data, generation);
	}

	private startFrameWrite(data: string, generation: number): void {
		this.physicalFrameWriteActive = true;
		this.frameWriteReturned = false;
		this.frameWriteCallbackComplete = false;
		this.frameWriteDrainComplete = false;
		this.frameWriteGeneration = generation;
		this.frameWriteCanceled = false;
		this.frameOutput.once("drain", this.onFrameWriteDrain);
		this.frameOutput.once("close", this.onFrameWriteClose);
		this.frameWriteStartedListener?.(generation);
		try {
			const accepted = this.frameOutput.write(data, this.onFrameWriteCallback);
			if (!this.physicalFrameWriteActive) return;
			this.frameWriteReturned = true;
			if (accepted) {
				this.frameWriteDrainComplete = true;
				this.frameOutput.removeListener("drain", this.onFrameWriteDrain);
			}
			this.tryCompleteFrameWrite();
		} catch (error) {
			this.failFrameOutput(error instanceof Error ? error : new Error(String(error)));
		}
	}

	cancelFrameWrite(generation: number): void {
		if (this.pendingFrameData !== undefined && generation === this.pendingFrameGeneration) {
			this.clearPendingFrameWrite();
			return;
		}
		if (!this.physicalFrameWriteActive || this.frameWriteCanceled || generation !== this.frameWriteGeneration) return;
		// The OS write is not cancellable. Keep physical callback/drain ownership
		// until it settles, but suppress logical completion for this generation.
		this.frameWriteCanceled = true;
	}

	private tryCompleteFrameWrite(): void {
		if (this.frameWriteReturned && this.frameWriteCallbackComplete && this.frameWriteDrainComplete) {
			this.completeFrameWrite();
		}
	}

	private failFrameOutput(error: Error): void {
		this.frameOutputFailure ??= error;
		this.completeFrameWrite(error);
	}

	private completeFrameWrite(error?: Error): void {
		if (!this.physicalFrameWriteActive) return;
		const generation = this.frameWriteGeneration;
		const canceled = this.frameWriteCanceled;
		const listener = this.frameWriteCompletionListener;
		this.clearActiveFrameWriteState();
		if (!canceled) listener?.(generation, error);
		if (this.disposed) {
			this.clearPendingFrameWrite();
			this.scheduleDisposeFinalization();
			return;
		}
		if (error) {
			if (this.pendingFrameData !== undefined) {
				const pendingGeneration = this.pendingFrameGeneration;
				this.clearPendingFrameWrite();
				this.frameWriteCompletionListener?.(pendingGeneration, error);
			}
			return;
		}
		this.startPendingFrameWrite();
	}

	private startPendingFrameWrite(): void {
		const data = this.pendingFrameData;
		if (data === undefined) return;
		const generation = this.pendingFrameGeneration;
		this.clearPendingFrameWrite();
		this.startFrameWrite(data, generation);
	}

	private clearActiveFrameWriteState(): void {
		this.frameOutput.removeListener("drain", this.onFrameWriteDrain);
		this.frameOutput.removeListener("close", this.onFrameWriteClose);
		this.physicalFrameWriteActive = false;
		this.frameWriteReturned = false;
		this.frameWriteCallbackComplete = false;
		this.frameWriteDrainComplete = false;
		this.frameWriteGeneration = 0;
		this.frameWriteCanceled = false;
	}

	private clearPendingFrameWrite(): void {
		this.pendingFrameData = undefined;
		this.pendingFrameGeneration = 0;
	}

	private scheduleDisposeFinalization(): void {
		if (
			!this.disposed ||
			this.physicalFrameWriteActive ||
			this.controlWritesOutstanding !== 0 ||
			this.disposeFinalizationScheduled
		) return;
		this.disposeFinalizationScheduled = true;
		setImmediate(this.finalizeDisposeAfterEvents);
	}

	private logWrite(data: string): void {
		if (!this.writeLogPath) return;
		try {
			fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
		} catch {
			// Ignore logging errors
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
