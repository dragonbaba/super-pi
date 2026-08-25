/**
 * Small bounded pool for synchronous scratch objects.
 *
 * The reset callback must clear references before an object is retained. Values
 * beyond maxRetained are reset and released to the garbage collector.
 */
export class ObjectPool<T> {
	private readonly available: T[] = [];
	private readonly create: () => T;
	private readonly reset: (value: T) => void;
	private readonly maxRetained: number;
	private readonly shouldRetain: ((value: T) => boolean) | undefined;

	constructor(
		create: () => T,
		reset: (value: T) => void,
		maxRetained = 8,
		shouldRetain?: (value: T) => boolean,
	) {
		if (!Number.isInteger(maxRetained) || maxRetained < 0) {
			throw new RangeError("ObjectPool maxRetained must be a non-negative integer");
		}
		this.create = create;
		this.reset = reset;
		this.maxRetained = maxRetained;
		this.shouldRetain = shouldRetain;
	}

	acquire(): T {
		return this.available.pop() ?? this.create();
	}

	release(value: T): void {
		const retain =
			this.available.length < this.maxRetained &&
			(this.shouldRetain === undefined || this.shouldRetain(value));
		this.reset(value);
		if (retain) this.available.push(value);
	}
}
