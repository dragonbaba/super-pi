import * as fs from "node:fs";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.ts";
import { enableNativeWindowsVirtualTerminalInput, isNativeModifierPressed } from "./native-modifiers.ts";
import { DEVICE_ATTRIBUTES_PATTERN, DEVICE_ATTRIBUTES_PREFIX_PATTERN, KITTY_FLAGS_PATTERN } from "./regex.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

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

function asTerminalError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function resolveTerminalWriteLogPath(): string {
	const env = process.env.SP_TUI_WRITE_LOG || "";
	if (!env) return "";
	try {
		if (fs.statSync(env).isDirectory()) {
			const now = new Date();
			const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
			return path.join(env, `tui-${ts}-${process.pid}.log`);
		}
	} catch {
		// Not an existing directory - use as-is (file path).
	}
	return env;
}

function readMonotonicTime(): number {
	return performance.now();
}

function validateDrainDuration(name: string, value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
	return value;
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
	 * The first caller starts a cycle and defines both its absolute maximum and
	 * idle deadline. Concurrent callers share that cycle's Promise and cannot
	 * extend, shorten, or reschedule it. At most one timer is concurrently active,
	 * but input near an idle boundary may require a new timer handle for the same
	 * cycle. Durations must be finite and non-negative;
	 * zero is valid, and the absolute maximum always wins when idleMs is larger.
	 * @param maxMs - Absolute maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	/** Write a terminal control sequence. Every returned Promise must be awaited or observed. */
	write(data: string): void | Promise<void>;

	/** Register the one stable callback used by the terminal frame lane. */
	setFrameWriteCompletionListener(listener: TerminalFrameWriteCompletion | undefined): void;

	/** Register the stable observer for actual Writable frame-write starts. */
	setFrameWriteStartedListener?(listener: TerminalFrameWriteStarted | undefined): void;
	/** Register the stable notification used when an orphan physical write releases the writer. */
	setFrameWriteReadyListener?(listener: ((error?: Error) => void) | undefined): void;
	/** True when a rendered frame can enter Writable immediately. */
	isFrameWriteAvailable?(): boolean;

	/**
	 * Start one atomic rendered frame. The registered completion listener fires
	 * only after both the Writable callback and any required drain have completed.
	 */
	writeFrame(data: string, generation: number): void | boolean;

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
	private frameWriteCompletionListener: TerminalFrameWriteCompletion | undefined;
	private frameWriteStartedListener: TerminalFrameWriteStarted | undefined;
	private frameWriteReadyListener: ((error?: Error) => void) | undefined;
	private controlWritesOutstanding = 0;
	private progressDesiredActive = false;
	private progressWriteActive = false;
	private progressWriteIsActive = false;
	private progressClearPending = false;
	private disposed = false;
	private disposeFinalizationScheduled = false;
	private readonly onUnawaitedControlWriteCallback = (error?: Error | null): void => {
		this.controlWritesOutstanding--;
		if (error) this.failFrameOutput(error);
		this.scheduleDisposeFinalization();
	};
	private readonly writeProgressKeepalive = (): void => {
		if (!this.progressDesiredActive || this.progressWriteActive) return;
		try {
			this.startProgressWrite(true);
		} catch {
			this.clearProgressInterval();
		}
	};
	private readonly onProgressWriteCallback = (error?: Error | null): void => {
		if (!this.progressWriteActive) return;
		const completedActive = this.progressWriteIsActive;
		this.progressWriteActive = false;
		this.progressWriteIsActive = false;
		this.controlWritesOutstanding--;
		if (error) {
			this.progressDesiredActive = false;
			this.progressClearPending = false;
			this.clearProgressInterval();
			this.failFrameOutput(error);
			this.scheduleDisposeFinalization();
			return;
		}
		this.scheduleDisposeFinalization();
		if (this.disposed || this.progressDesiredActive === completedActive) {
			this.progressClearPending = false;
			return;
		}
		this.progressClearPending = !this.progressDesiredActive;
		try {
			this.startProgressWrite(this.progressDesiredActive);
		} catch {
			this.progressClearPending = false;
			this.clearProgressInterval();
		}
	};
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
	private readonly onStdinBufferData = (sequence: string): void => {
		const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence === "pending") {
			this.scheduleKeyboardProtocolNegotiationBufferFlush();
			return;
		}
		if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) return;
		this.forwardInputSequence(sequence);
	};
	private readonly onStdinBufferPaste = (content: string): void => {
		this.inputHandler?.(`\x1b[200~${content}\x1b[201~`);
	};
	private readonly onStdinData = (data: string): void => {
		this.stdinBuffer?.process(data);
	};
	private readonly onKeyboardProtocolNegotiationBufferFlush = (): void => {
		this.keyboardProtocolBufferFlushTimer = undefined;
		this.flushKeyboardProtocolNegotiationBufferAsInput();
	};
	private drainInputActive = false;
	private drainInputDeadline = 0;
	private drainInputIdleMs = 0;
	private drainInputLastDataTime = 0;
	private drainGeneration = 0;
	private drainActiveGeneration = 0;
	private drainInputPromise?: Promise<void>;
	private drainInputResolve?: () => void;
	private drainInputReject?: (error: Error) => void;
	private drainInputTimer?: ReturnType<typeof setTimeout>;
	private drainInputTimerHandlesCreated = 0;
	private drainInputTimerReschedules = 0;
	private drainInputPreviousHandler?: (data: string) => void;
	private readonly readDrainTime = readMonotonicTime;
	private drainInputSource: Pick<NodeJS.ReadStream, "on" | "removeListener"> = process.stdin;
	private readonly captureDrainInputResolve = (resolve: () => void, reject: (error: Error) => void): void => {
		this.drainInputResolve = resolve;
		this.drainInputReject = reject;
	};
	private readonly onDrainInputData = (): void => {
		if (!this.drainInputActive) return;
		this.drainInputLastDataTime = this.readDrainTime();
	};
	private readonly onDrainInputTimer = (generation: number): void => {
		if (!this.drainInputActive || generation !== this.drainActiveGeneration) return;
		this.drainInputTimer = undefined;
		this.scheduleDrainInputTimer(generation);
	};
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = resolveTerminalWriteLogPath();

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
		if (this.started) return;
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		try {
			// Save previous state and enable raw mode
			this.wasRaw = process.stdin.isRaw || false;
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(true);
			}
			process.stdin.setEncoding("utf8");
			process.stdin.resume();

			// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
			this.writeUnawaitedControl("\x1b[?2004h");

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
		} catch (error) {
			const failure = asTerminalError(error);
			try {
				this.stop();
			} catch {
				// Startup reports its first failure after transactional cleanup.
			}
			throw failure;
		}
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
		this.stdinBuffer.on("data", this.onStdinBufferData);

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", this.onStdinBufferPaste);
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
		process.stdin.on("data", this.onStdinData);
		this.keyboardProtocolPushed = true;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.writeUnawaitedControl(KITTY_KEYBOARD_PROTOCOL_QUERY);
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
		this.keyboardProtocolBufferFlushTimer = setTimeout(
			this.onKeyboardProtocolNegotiationBufferFlush,
			KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS,
		);
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
		this.writeUnawaitedControl("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		this.writeUnawaitedControl("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		enableNativeWindowsVirtualTerminalInput();
	}

	drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.drainInputPromise) return this.drainInputPromise;
		const boundedMaxMs = validateDrainDuration("maxMs", maxMs);
		const boundedIdleMs = validateDrainDuration("idleMs", idleMs);
		const generation = ++this.drainGeneration;
		this.drainActiveGeneration = generation;
		this.drainInputPreviousHandler = this.inputHandler;
		this.inputHandler = undefined;
		this.drainInputActive = true;
		this.drainInputIdleMs = boundedIdleMs;
		this.drainInputLastDataTime = this.readDrainTime();
		this.drainInputDeadline = this.drainInputLastDataTime + boundedMaxMs;
		this.drainInputTimerHandlesCreated = 0;
		this.drainInputTimerReschedules = 0;
		const result = new Promise<void>(this.captureDrainInputResolve);
		this.drainInputPromise = result;
		try {
			const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
			this.clearKeyboardProtocolNegotiationBuffer();
			if (shouldDisableKittyProtocol) {
				// Disable Kitty keyboard protocol first so any late key releases
				// do not generate new Kitty escape sequences.
				this.writeUnawaitedControl("\x1b[<u");
				this.keyboardProtocolPushed = false;
				this._kittyProtocolActive = false;
				setKittyProtocolActive(false);
			}
			this.disableModifyOtherKeys();
			this.drainInputSource.on("data", this.onDrainInputData);
			this.scheduleDrainInputTimer(generation);
		} catch (error) {
			this.finishDrainInput(generation, asTerminalError(error));
		}
		return result;
	}

	private scheduleDrainInputTimer(generation: number): void {
		if (!this.drainInputActive || generation !== this.drainActiveGeneration) return;
		if (this.drainInputTimer) return;
		const now = this.readDrainTime();
		const deadlineRemaining = this.drainInputDeadline - now;
		const idleRemaining = this.drainInputIdleMs - (now - this.drainInputLastDataTime);
		const delay = Math.min(Math.max(0, deadlineRemaining), Math.max(0, idleRemaining));
		if (delay <= 0) {
			this.drainInputTimer = undefined;
			this.finishDrainInput(generation);
			return;
		}
		if (this.drainInputTimerHandlesCreated > 0) this.drainInputTimerReschedules++;
		this.drainInputTimerHandlesCreated++;
		this.drainInputTimer = setTimeout(this.onDrainInputTimer, delay, generation);
	}

	private finishDrainInput(generation: number, error?: Error): void {
		if (!this.drainInputActive || generation !== this.drainActiveGeneration) return;
		this.drainInputActive = false;
		if (this.drainInputTimer) clearTimeout(this.drainInputTimer);
		this.drainInputTimer = undefined;
		this.drainInputSource.removeListener("data", this.onDrainInputData);
		this.inputHandler = this.drainInputPreviousHandler;
		this.drainInputPreviousHandler = undefined;
		this.drainActiveGeneration = 0;
		this.drainInputDeadline = 0;
		this.drainInputIdleMs = 0;
		this.drainInputLastDataTime = 0;
		const resolve = this.drainInputResolve;
		const reject = this.drainInputReject;
		this.drainInputResolve = undefined;
		this.drainInputReject = undefined;
		this.drainInputPromise = undefined;
		if (error) reject?.(error);
		else resolve?.();
	}

	private cancelDrainInput(): void {
		if (this.drainInputActive) this.finishDrainInput(this.drainActiveGeneration);
	}

	stop(): void {
		this.cancelDrainInput();
		if (!this.started) return;
		this.started = false;
		let failure: Error | undefined;
		if (this.clearProgressInterval()) {
			this.progressDesiredActive = false;
			if (this.progressWriteActive) this.progressClearPending = this.progressWriteIsActive;
			else {
				try {
					this.startProgressWrite(false);
				} catch (error) {
					failure = asTerminalError(error);
				}
			}
		}

		// Disable bracketed paste mode
		failure = this.writeLifecycleControl("\x1b[?2004l", failure);

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (shouldDisableKittyProtocol) {
			failure = this.writeLifecycleControl("\x1b[<u", failure);
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			failure = this.writeLifecycleControl("\x1b[>4;0m", failure);
			this._modifyOtherKeysActive = false;
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			try {
				this.stdinBuffer.destroy();
			} catch (error) {
				failure ??= asTerminalError(error);
			}
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		process.stdin.removeListener("data", this.onStdinData);
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		try {
			process.stdin.pause();
		} catch (error) {
			failure ??= asTerminalError(error);
		}

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			try {
				process.stdin.setRawMode(this.wasRaw);
			} catch (error) {
				failure ??= asTerminalError(error);
			}
		}
		if (failure) throw failure;
	}

	dispose(): void {
		if (this.disposed) return;
		this.cancelDrainInput();
		let failure: Error | undefined;
		if (this.started) {
			try {
				this.stop();
			} catch (error) {
				failure = asTerminalError(error);
			}
		}
		this.disposed = true;
		this.clearProgressInterval();
		this.progressDesiredActive = false;
		this.progressClearPending = false;
		this.frameWriteCompletionListener = undefined;
		this.frameWriteStartedListener = undefined;
		this.frameWriteReadyListener = undefined;
		if (this.physicalFrameWriteActive) this.frameWriteCanceled = true;
		this.scheduleDisposeFinalization();
		if (failure) throw failure;
	}

	private writeLifecycleControl(data: string, failure: Error | undefined): Error | undefined {
		try {
			this.writeUnawaitedControl(data);
		} catch (error) {
			return failure ?? asTerminalError(error);
		}
		return failure;
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
					if (error) {
						this.failFrameOutput(error);
						reject(error);
					}
					else resolve();
				});
			} catch (error) {
				if (callbackPending) {
					callbackPending = false;
					this.controlWritesOutstanding--;
					this.scheduleDisposeFinalization();
				}
				this.failFrameOutput(error instanceof Error ? error : new Error(String(error)));
				reject(error);
			}
		});
		this.logWrite(data);
		return completion;
	}

	private writeUnawaitedControl(data: string): void {
		if (this.disposed) throw new Error("Cannot write with a disposed ProcessTerminal");
		this.controlWritesOutstanding++;
		try {
			this.frameOutput.write(data, this.onUnawaitedControlWriteCallback);
		} catch (error) {
			this.controlWritesOutstanding--;
			this.failFrameOutput(error instanceof Error ? error : new Error(String(error)));
			this.scheduleDisposeFinalization();
			throw error;
		}
		this.logWrite(data);
	}

	setFrameWriteCompletionListener(listener: TerminalFrameWriteCompletion | undefined): void {
		this.frameWriteCompletionListener = listener;
	}

	setFrameWriteStartedListener(listener: TerminalFrameWriteStarted | undefined): void {
		this.frameWriteStartedListener = listener;
	}

	setFrameWriteReadyListener(listener: ((error?: Error) => void) | undefined): void {
		this.frameWriteReadyListener = listener;
	}

	isFrameWriteAvailable(): boolean {
		return !this.physicalFrameWriteActive;
	}

	writeFrame(data: string, generation: number): boolean {
		if (this.writeLogPath) this.logWrite(data);
		if (this.disposed) {
			this.frameWriteCompletionListener?.(generation, new Error("ProcessTerminal is disposed"));
			return true;
		}
		if (this.frameOutputFailure) {
			this.frameWriteCompletionListener?.(generation, this.frameOutputFailure);
			return true;
		}
		if (this.physicalFrameWriteActive) {
			return false;
		}
		this.startFrameWrite(data, generation);
		return true;
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
		try {
			const accepted = this.frameOutput.write(data, this.onFrameWriteCallback);
			this.frameWriteStartedListener?.(generation);
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
			this.scheduleDisposeFinalization();
			return;
		}
		if (canceled) this.frameWriteReadyListener?.(error);
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
			this.writeUnawaitedControl(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.writeUnawaitedControl(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.writeUnawaitedControl("\x1b[?25l");
	}

	showCursor(): void {
		this.writeUnawaitedControl("\x1b[?25h");
	}

	clearLine(): void {
		this.writeUnawaitedControl("\x1b[K");
	}

	clearFromCursor(): void {
		this.writeUnawaitedControl("\x1b[J");
	}

	clearScreen(): void {
		this.writeUnawaitedControl("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.writeUnawaitedControl(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.progressDesiredActive = active;
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			this.progressClearPending = false;
			if (!this.progressWriteActive) this.startProgressWrite(true);
			if (!this.progressDesiredActive) return;
			if (!this.progressInterval) {
				this.progressInterval = setInterval(this.writeProgressKeepalive, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			if (this.progressWriteActive) {
				this.progressClearPending = this.progressWriteIsActive;
			} else {
				this.startProgressWrite(false);
			}
		}
	}

	private startProgressWrite(active: boolean): void {
		if (this.disposed) throw new Error("Cannot write with a disposed ProcessTerminal");
		if (this.progressWriteActive) return;
		this.progressWriteActive = true;
		this.progressWriteIsActive = active;
		this.progressClearPending = false;
		this.controlWritesOutstanding++;
		const data = active ? TERMINAL_PROGRESS_ACTIVE_SEQUENCE : TERMINAL_PROGRESS_CLEAR_SEQUENCE;
		try {
			this.frameOutput.write(data, this.onProgressWriteCallback);
		} catch (error) {
			this.progressWriteActive = false;
			this.progressWriteIsActive = false;
			this.controlWritesOutstanding--;
			this.failFrameOutput(error instanceof Error ? error : new Error(String(error)));
			this.scheduleDisposeFinalization();
			throw error;
		}
		this.logWrite(data);
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
