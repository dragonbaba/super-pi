import { randomUUID } from "node:crypto";

export type TaskState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export interface ManagedSubagentTask {
	readonly id: string;
	readonly agent: string;
	state: TaskState;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	controller?: AbortController;
	readonly waiters: Set<TaskWaiter>;
}

function isTerminal(task: ManagedSubagentTask): boolean { return task.completedAt !== undefined; }

class TaskWaiter {
	readonly promise: Promise<void>;
	private resolve!: () => void;
	private reject!: (error: unknown) => void;
	private task: ManagedSubagentTask | undefined;
	private readonly signal: AbortSignal | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly abort = this.onAbort.bind(this);
	private readonly owner: SubagentTasks;

	constructor(owner: SubagentTasks, task: ManagedSubagentTask, timeoutMs: number, signal?: AbortSignal) {
		this.owner = owner;
		this.task = task;
		this.signal = signal;
		this.promise = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
		task.waiters.add(this);
		this.timer = setTimeout(TaskWaiter.onTimeout, timeoutMs, this);
		if (signal?.aborted) this.onAbort();
		else signal?.addEventListener("abort", this.abort, { once: true });
	}

	private static onTimeout(waiter: TaskWaiter): void { waiter.finish(); }
	private onAbort(): void { this.finish(this.signal?.reason ?? new Error("Task wait cancelled.")); }

	finish(error?: unknown): void {
		if (!this.task) return;
		this.task.waiters.delete(this);
		this.task = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.signal?.removeEventListener("abort", this.abort);
		this.owner.waiterCount--;
		if (error !== undefined) this.reject(error);
		else this.resolve();
	}
}

/** Bounded session history. Finished records retain text only, never child processes or credentials. */
export class SubagentTasks {
	private readonly records = new Map<string, ManagedSubagentTask>();
	private readonly prefix = randomUUID();
	private nextId = 1;
	private completed = 0;
	private readonly capacity: number;
	private closed = false;
	waiterCount = 0;

	constructor(capacity: number) { this.capacity = capacity; }
	get size(): number { return this.records.size; }
	get retainedResults(): number { return this.completed; }
	values(): IterableIterator<ManagedSubagentTask> { return this.records.values(); }

	create(agent: string): ManagedSubagentTask {
		if (this.closed) throw new Error("Subagent task history is closed.");
		if (this.records.size - this.completed >= this.capacity) throw new Error(`Subagent task capacity reached: ${this.capacity}. Wait for active tasks.`);
		const task: ManagedSubagentTask = {
			id: `${this.prefix}-${this.nextId++}`, agent, state: "queued", controller: new AbortController(), waiters: new Set(),
		};
		this.records.set(task.id, task);
		return task;
	}

	get(id: string): ManagedSubagentTask {
		const task = this.records.get(id);
		if (!task) throw new Error("Unknown or expired subagent task ID. List current tasks.");
		return task;
	}

	start(task: ManagedSubagentTask): void {
		task.controller?.signal.throwIfAborted();
		task.state = "running";
		task.startedAt = Date.now();
	}

	finish(task: ManagedSubagentTask, result: string, failed: boolean): void {
		if (isTerminal(task)) return;
		task.state = task.controller?.signal.aborted ? "cancelled" : failed ? "failed" : "completed";
		task.completedAt = Date.now();
		// 50 KiB UTF-8 worst case (4 bytes/code point), without materializing the whole output.
		let end = 12_000;
		if (result.length > end && result.charCodeAt(end - 1) >= 0xD800 && result.charCodeAt(end - 1) <= 0xDBFF && result.charCodeAt(end) >= 0xDC00 && result.charCodeAt(end) <= 0xDFFF) end--;
		task.result = this.closed ? undefined : result.length > 12_000 ? `${result.slice(0, end)}\n[truncated; retained task result limit: 12000 characters]` : result;
		task.controller = undefined;
		for (const waiter of task.waiters) waiter.finish();
		if (this.closed) return;
		// Completion order, rather than launch order, determines history eviction.
		this.records.delete(task.id);
		this.records.set(task.id, task);
		this.completed++;
		this.prune();
	}

	cancel(id: string): ManagedSubagentTask {
		const task = this.get(id);
		if (!isTerminal(task)) {
			task.state = "cancelling";
			task.controller?.abort(new Error("Subagent task cancelled."));
		}
		return task;
	}

	cancelAll(): void {
		for (const task of this.records.values()) if (!isTerminal(task)) this.cancel(task.id);
	}

	async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ManagedSubagentTask> {
		const task = this.get(id);
		signal?.throwIfAborted();
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error("Task wait timeout must be 0–60000 ms; a timeout leaves the task running.");
		if (!isTerminal(task) && timeoutMs > 0) {
			if (this.waiterCount >= 64) throw new Error("Subagent wait capacity reached: 64. Finish an existing wait first.");
			this.waiterCount++;
			await new TaskWaiter(this, task, timeoutMs, signal).promise;
		}
		return task;
	}

	private prune(): void {
		if (this.completed <= this.capacity) return;
		for (const [id, task] of this.records) {
			if (!isTerminal(task)) continue;
			task.result = undefined;
			this.records.delete(id);
			if (--this.completed <= this.capacity) break;
		}
	}

	dispose(): void {
		this.closed = true;
		this.cancelAll();
		for (const task of this.records.values()) {
			for (const waiter of task.waiters) waiter.finish(new Error("Subagent session ended."));
			task.result = undefined;
		}
		this.records.clear();
		this.completed = 0;
	}
}
