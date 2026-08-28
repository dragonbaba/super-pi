import type { Terminal } from "../../packages/tui/src/terminal.ts";

export class CounterRegistry {
	private readonly values = new Map<string, number>();

	increment(name: string, amount = 1): void {
		this.values.set(name, (this.values.get(name) ?? 0) + amount);
	}

	get(name: string): number {
		return this.values.get(name) ?? 0;
	}

	snapshot(): Record<string, number> {
		return Object.fromEntries([...this.values].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
	}
}

interface ScheduledTask {
	id: number;
	dueAt: number;
	callback: () => void;
}

export class FakeClock {
	private currentTime = 0;
	private nextId = 1;
	private readonly tasks: ScheduledTask[] = [];

	now(): number {
		return this.currentTime;
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.tasks.push({ id, dueAt: this.currentTime + Math.max(0, delayMs), callback });
		return id;
	}

	clearTimeout(id: number): void {
		const index = this.tasks.findIndex((task) => task.id === id);
		if (index >= 0) this.tasks.splice(index, 1);
	}

	advanceBy(durationMs: number): void {
		const target = this.currentTime + durationMs;
		while (true) {
			this.tasks.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
			const next = this.tasks[0];
			if (!next || next.dueAt > target) break;
			this.tasks.shift();
			this.currentTime = next.dueAt;
			next.callback();
		}
		this.currentTime = target;
	}

	get pendingTimers(): number {
		return this.tasks.length;
	}
}

export class HighWaterMark {
	current = 0;
	maximum = 0;

	set(value: number): void {
		this.current = value;
		this.maximum = Math.max(this.maximum, value);
	}
}

export class FakeScheduler {
	private readonly clock: FakeClock;
	private readonly scheduled = new Set<number>();
	readonly highWaterMark = new HighWaterMark();

	constructor(clock = new FakeClock()) {
		this.clock = clock;
	}

	schedule(callback: () => void, delayMs = 0): number {
		let handle = 0;
		handle = this.clock.setTimeout(() => {
			this.scheduled.delete(handle);
			this.highWaterMark.set(this.scheduled.size);
			callback();
		}, delayMs);
		this.scheduled.add(handle);
		this.highWaterMark.set(this.scheduled.size);
		return handle;
	}

	cancel(handle: number): void {
		this.clock.clearTimeout(handle);
		this.scheduled.delete(handle);
		this.highWaterMark.set(this.scheduled.size);
	}

	advanceBy(durationMs: number): void {
		this.clock.advanceBy(durationMs);
	}

	now(): number {
		return this.clock.now();
	}

	get pendingTasks(): number {
		return this.scheduled.size;
	}
}

export class FakeTerminal implements Terminal {
	readonly writes: string[] = [];
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	started = false;
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;

	constructor(columns = 120, rows = 40) {
		this.columns = columns;
		this.rows = rows;
	}

	start(): void { this.started = true; }
	stop(): void { this.started = false; }
	async drainInput(): Promise<void> {}
	write(data: string): void { this.writes.push(data); }
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameWriteCompletion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.write(data);
		this.frameWriteCompletion?.(generation);
	}
	cancelFrameWrite(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	get bytesWritten(): number {
		let bytes = 0;
		for (const write of this.writes) bytes += Buffer.byteLength(write);
		return bytes;
	}
}

export class FakeObserver<T> {
	readonly events: T[] = [];
	observe(event: T): void { this.events.push(event); }
}

export class FakeProviderStream<T> implements AsyncIterable<T> {
	private readonly events: readonly T[];

	constructor(events: readonly T[]) {
		this.events = events;
	}
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		for (const event of this.events) yield event;
	}
}

export class PrefixManifestRecorder<T> {
	readonly manifests: T[] = [];
	record(manifest: T): void { this.manifests.push(structuredClone(manifest)); }
}
