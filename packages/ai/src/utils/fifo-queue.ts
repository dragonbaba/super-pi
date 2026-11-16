/** Caller-owned lossless FIFO. No per-item wrappers; clear releases both backing stores. */
export class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number { return this.incoming.length + this.outgoing.length; }
	enqueue(value: T): void { this.incoming.push(value); }
	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) this.outgoing.push(this.incoming.pop()!);
		}
		return this.outgoing.pop();
	}
	clear(): void { this.incoming = []; this.outgoing = []; }
}
