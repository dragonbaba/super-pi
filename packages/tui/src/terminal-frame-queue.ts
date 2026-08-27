export interface TerminalFrameQueueSnapshot {
	activeWrites: 0 | 1;
	pendingFrames: 0 | 1;
	frameQueueHighWaterMark: number;
	replacedFrames: number;
	failed: boolean;
	idleWaiterActive: 0 | 1;
	activeFrameUtf8Bytes: number;
	pendingFrameUtf8Bytes: number;
}

export interface TerminalFrameQueueOptions {
	onDepthChanged?: (
		activeWrites: 0 | 1,
		pendingFrames: 0 | 1,
		activeFrameUtf8Bytes: number,
		pendingFrameUtf8Bytes: number,
	) => void;
	onWriteStarted?: (metadata: number, utf8Bytes: number) => void;
	onFrameReplaced?: () => void;
	onIdle?: () => void;
	onError?: (error: Error) => void;
}

export interface TerminalFrameSink {
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void;
	writeFrame(data: string, generation: number): void;
	cancelFrameWrite(generation: number): void;
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) bytes++;
		else if (codeUnit <= 0x7ff) bytes += 2;
		else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Bounded latest-value queue for terminal frame strings.
 *
 * At most one write is active and one latest frame is retained. Replacing the
 * pending string immediately releases the prior string reference. The queue
 * never builds a Promise tail: all flush callers share the current idle cycle.
 */
export class TerminalFrameQueue {
	private readonly sink: TerminalFrameSink;
	private readonly options: TerminalFrameQueueOptions;
	private activeWrite = false;
	private pendingFrame: string | undefined;
	private pendingMetadata = 0;
	private activeFrameUtf8Bytes = 0;
	private pendingFrameUtf8Bytes = 0;
	private highWaterMark = 0;
	private replacedFrames = 0;
	private failure: Error | undefined;
	private idlePromise: Promise<void> | undefined;
	private resolveIdle: (() => void) | undefined;
	private activeWriteToken = 0;
	private idleSettlementScheduled = false;
	private readonly settleActiveWrite = (generation: number, error?: Error): void => {
		if (error) this.fail(error, generation);
		else this.finish(generation);
	};
	private readonly settleIdleCycle = (): void => this.finishIdleCycle();
	private readonly captureIdleResolve = (resolve: () => void): void => {
		this.resolveIdle = resolve;
	};

	constructor(sink: TerminalFrameSink, options: TerminalFrameQueueOptions = {}) {
		this.sink = sink;
		this.options = options;
		this.attach();
	}

	/** Attach/detach only at TUI lifecycle boundaries, never per frame. */
	attach(): void { this.sink.setFrameWriteCompletionListener(this.settleActiveWrite); }
	detach(): void { this.sink.setFrameWriteCompletionListener(undefined); }

	get busy(): boolean {
		return this.activeWrite || this.pendingFrame !== undefined;
	}

	submit(data: string, metadata = 0): number {
		if (this.failure) throw this.failure;
		const utf8Bytes = utf8ByteLength(data);
		if (!this.activeWrite) {
			this.start(data, metadata, utf8Bytes);
			return utf8Bytes;
		}
		if (this.pendingFrame !== undefined) {
			this.replacedFrames++;
			this.options.onFrameReplaced?.();
		}
		this.pendingFrame = data;
		this.pendingMetadata = metadata;
		this.pendingFrameUtf8Bytes = utf8Bytes;
		this.recordDepth();
		return utf8Bytes;
	}

	discardPending(): boolean {
		if (this.pendingFrame === undefined) return false;
		this.pendingFrame = undefined;
		this.pendingMetadata = 0;
		this.pendingFrameUtf8Bytes = 0;
		this.recordDepth();
		return true;
	}

	/**
	 * Fail an active lifecycle flush and release both frame references. Normal
	 * writes have no absolute deadline; stop/fatal/mode-switch owners call this
	 * only after their independent lifecycle boundary expires.
	 */
	abort(error: unknown): boolean {
		if (this.failure || !this.activeWrite) return false;
		const failure = asError(error);
		const token = this.activeWriteToken;
		this.sink.cancelFrameWrite(token);
		this.fail(failure, token);
		return true;
	}

	async flush(): Promise<void> {
		while (this.busy || this.idleSettlementScheduled) await this.getIdlePromise();
		if (this.failure) throw this.failure;
	}

	snapshot(): Readonly<TerminalFrameQueueSnapshot> {
		return Object.freeze({
			activeWrites: this.activeWrite ? 1 : 0,
			pendingFrames: this.pendingFrame === undefined ? 0 : 1,
			frameQueueHighWaterMark: this.highWaterMark,
			replacedFrames: this.replacedFrames,
			failed: this.failure !== undefined,
			idleWaiterActive: this.idlePromise ? 1 : 0,
			activeFrameUtf8Bytes: this.activeFrameUtf8Bytes,
			pendingFrameUtf8Bytes: this.pendingFrameUtf8Bytes,
		});
	}

	private start(data: string, metadata: number, utf8Bytes: number): void {
		const token = ++this.activeWriteToken;
		this.activeWrite = true;
		this.activeFrameUtf8Bytes = utf8Bytes;
		this.recordDepth();
		this.options.onWriteStarted?.(metadata, utf8Bytes);
		try {
			this.sink.writeFrame(data, token);
		} catch (error) {
			this.fail(error, token);
		}
	}

	private finish(token: number): void {
		if (!this.activeWrite || this.failure || this.activeWriteToken !== token) return;
		this.activeWrite = false;
		this.activeFrameUtf8Bytes = 0;
		const next = this.pendingFrame;
		const nextMetadata = this.pendingMetadata;
		const nextUtf8Bytes = this.pendingFrameUtf8Bytes;
		this.pendingFrame = undefined;
		this.pendingMetadata = 0;
		this.pendingFrameUtf8Bytes = 0;
		this.recordDepth();
		if (next !== undefined) {
			this.start(next, nextMetadata, nextUtf8Bytes);
			return;
		}
		this.scheduleIdleSettlement();
	}

	private fail(error: unknown, token: number): void {
		if (this.failure || this.activeWriteToken !== token) return;
		this.failure = asError(error);
		this.activeWrite = false;
		this.activeFrameUtf8Bytes = 0;
		this.pendingFrame = undefined;
		this.pendingMetadata = 0;
		this.pendingFrameUtf8Bytes = 0;
		this.recordDepth();
		this.idleSettlementScheduled = false;
		this.finishIdleCycle();
		try {
			this.options.onError?.(this.failure);
		} catch {
			// Queue ownership and waiter cleanup must survive diagnostic failures.
		}
	}

	private getIdlePromise(): Promise<void> {
		if (!this.idlePromise) {
			this.idlePromise = new Promise<void>(this.captureIdleResolve);
		}
		return this.idlePromise;
	}

	private scheduleIdleSettlement(): void {
		if (this.idleSettlementScheduled) return;
		this.idleSettlementScheduled = true;
		queueMicrotask(this.settleIdleCycle);
	}

	private finishIdleCycle(): void {
		if (!this.idleSettlementScheduled && !this.failure) return;
		this.idleSettlementScheduled = false;
		if (this.activeWrite || this.pendingFrame !== undefined) return;
		const resolve = this.resolveIdle;
		this.resolveIdle = undefined;
		this.idlePromise = undefined;
		resolve?.();
		this.options.onIdle?.();
	}

	private recordDepth(): void {
		const activeWrites = this.activeWrite ? 1 : 0;
		const pendingFrames = this.pendingFrame === undefined ? 0 : 1;
		this.highWaterMark = Math.max(this.highWaterMark, activeWrites + pendingFrames);
		this.options.onDepthChanged?.(
			activeWrites,
			pendingFrames,
			this.activeFrameUtf8Bytes,
			this.pendingFrameUtf8Bytes,
		);
	}
}
