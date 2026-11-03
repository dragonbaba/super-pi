/** One tool invocation, never one progress event. The session keeps execution ownership. */
export class ForegroundTask<T> {
	private controller: AbortController | undefined = new AbortController();
	private parent: AbortSignal | undefined;
	private update: ((value: T) => void) | undefined;
	private resolve: ((value: T) => void) | undefined;
	private reject: ((error: unknown) => void) | undefined;
	private waiting: Promise<T> | undefined;
	private settled = false;
	background = false;
	private readonly abort = (): void => { this.controller?.abort(this.parent?.reason); };
	readonly publish = (value: T): void => { this.update?.(value); };
	get signal(): AbortSignal {
		if (!this.controller) throw new Error("Foreground execution already settled.");
		return this.controller.signal;
	}

	constructor(parent: AbortSignal | undefined, update: ((value: T) => void) | undefined) {
		this.parent = parent;
		this.update = update;
		this.waiting = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
		if (parent?.aborted) this.abort();
		else parent?.addEventListener("abort", this.abort, { once: true });
	}

	/** Take once; no pending Promise.race branch retains the foreground continuation. */
	takeWait(): Promise<T> {
		const waiting = this.waiting;
		if (!waiting) throw new Error("Foreground wait was already taken.");
		this.waiting = undefined;
		return waiting;
	}

	detach(accepted: T): void {
		if (this.settled || this.background) throw new Error("Task is no longer waiting in the foreground.");
		this.parent?.throwIfAborted();
		this.signal.throwIfAborted();
		this.background = true;
		this.release();
		this.resolve?.(accepted);
		this.resolve = undefined; this.reject = undefined;
	}

	complete(value: T): void { this.finish(value, undefined, false); }
	fail(error: unknown): void { this.finish(undefined, error, true); }
	private finish(value: T | undefined, error: unknown, failed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.release();
		this.controller = undefined;
		if (failed) this.reject?.(error);
		else this.resolve?.(value!);
		this.resolve = undefined; this.reject = undefined;
	}
	private release(): void {
		this.parent?.removeEventListener("abort", this.abort);
		this.parent = undefined;
		this.update = undefined;
	}
}
