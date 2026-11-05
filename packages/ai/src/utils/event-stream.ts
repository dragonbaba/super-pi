import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/** Synchronous, observational terminal notification; never invoked for deltas. */
export interface StreamResultObserver<R> {
	onResult(result: R | undefined): void | Promise<void>;
}

function ignoreResultObserverRejection(): void {}

function notifyResultObserver<R>(observer: StreamResultObserver<R>, result: R | undefined): void {
	try {
		const returned = observer.onResult(result);
		if (returned && typeof returned.then === "function") void Promise.resolve(returned).catch(ignoreResultObserverRejection);
	} catch { /* Observers cannot affect provider delivery. */ }
}

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	private done = false;
	// Capture at creation for plain SDK streams as well as the assistant subclass.
	private readonly startedAt = Date.now();
	private readonly startedMonotonic = performance.now();
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;
	private resultObserver: StreamResultObserver<R> | undefined;
	private settledResult: R | undefined;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			const original = this.extractResult(event);
			const result = finalizeAssistantTiming(original, this.startedAt, this.startedMonotonic);
			event = replaceAssistantTerminal(event, original, result);
			this.notifyResult(result);
			this.resolveFinalResult(result);
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		const wasDone = this.done;
		if (!this.done && result !== undefined) {
			result = finalizeAssistantTiming(result, this.startedAt, this.startedMonotonic);
		}
		this.done = true;
		if (!wasDone) this.notifyResult(result);
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}

	/** One logical owner; late registration observes the exact result returned by result(). */
	observeResult(observer: StreamResultObserver<R>): void {
		if (this.resultObserver) throw new Error("A result observer is already registered");
		if (this.done) {
			notifyResultObserver(observer, this.settledResult);
		} else {
			this.resultObserver = observer;
		}
	}

	private notifyResult(result: R | undefined): void {
		this.settledResult = result;
		const observer = this.resultObserver;
		this.resultObserver = undefined;
		if (observer) notifyResultObserver(observer, result);
	}
}

// Completion-only envelope copies support immutable provider messages/events.
// Content and usage retain their existing ownership; deltas never enter here.
function finalizeAssistantTiming<R>(result: R, wall: number, monotonic: number): R {
	if (typeof result !== "object" || result === null) return result;
	const message = result as Partial<AssistantMessage>;
	if (message.role !== "assistant" || message.durationMs !== undefined ||
		typeof message.timestamp !== "number" || message.timestamp < wall) return result;
	return { ...result, durationMs: Math.max(0, Math.round(performance.now() - monotonic)) };
}

function replaceAssistantTerminal<T, R>(event: T, original: R, result: R): T {
	if (result === original || typeof event !== "object" || event === null) return event;
	const terminal = event as unknown as AssistantMessageEvent;
	if (terminal.type === "done" && terminal.message === original) return { ...event, message: result };
	if (terminal.type === "error" && terminal.error === original) return { ...event, error: result };
	return event;
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
