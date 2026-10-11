import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

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
		if (!this.done && result !== undefined) {
			result = finalizeAssistantTiming(result, this.startedAt, this.startedMonotonic);
		}
		this.done = true;
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
