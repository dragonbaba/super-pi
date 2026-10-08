import { randomUUID } from "node:crypto";
import { TaskHistory, TASK_RESULT_CHARS, type TaskHistorySession, type TaskKind, type TaskObservation } from "../task-history.ts";
import type { ShellExecutionFacts } from "@super-pi/coding-agent";

export type { TaskState } from "../task-history.ts";
export interface ManagedSubagentTask extends TaskObservation {
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
	private readonly label: string;
	private closed = false;
	private history: TaskHistory | undefined;
	private historySession: TaskHistorySession | undefined;
	historyError: string | undefined;
	waiterCount = 0;

	constructor(capacity: number, label = "Subagent") { this.capacity = capacity; this.label = label; }
	get size(): number { return this.records.size; }
	get retainedResults(): number { return this.completed; }
	values(): IterableIterator<ManagedSubagentTask> { return this.records.values(); }
	find(id: string): ManagedSubagentTask | undefined { return this.records.get(id); }
	get historyStatus(): string {
		return this.historyError ? `Task history unavailable: ${this.historyError} New work is blocked; live results remain inspectable.`
			: this.historySession?.file ? `History: latest ${this.capacity} terminal records survive restart; unfinished work is marked interrupted and never replayed.`
			: "History: memory only; this session has no persistent storage.";
	}
	configureHistory(session: TaskHistorySession, kind: TaskKind): void {
		if (this.closed) throw new Error(`${this.label} task history is closed.`);
		if (this.historySession?.file === session.file && this.historySession?.id === session.id && this.historySession?.cwd === session.cwd) return;
		if (this.records.size !== this.completed) throw new Error("Drain active tasks before changing their history session.");
		this.closeHistory(); this.records.clear(); this.completed = 0;
		this.historySession = session; this.historyError = undefined;
		try {
			const history = this.history = new TaskHistory(session, kind, this.capacity);
			for (const record of history.load()) {
				this.records.set(record.id, { ...record, waiters: new Set(), controller: undefined });
				this.completed++;
			}
		} catch (error) { this.recordHistoryError(error); this.closeHistory(); }
	}
	assertHistoryAvailable(): void {
		if (this.historyError) throw new Error(this.historyStatus);
	}
	private recordHistoryError(error: unknown): void {
		this.historyError ??= (error instanceof Error ? error.message : String(error)).slice(0, 1000);
	}
	private persist(task: ManagedSubagentTask, beforeExecution: boolean): void {
		try { this.assertHistoryAvailable(); this.history?.save(task); }
		catch (error) { this.recordHistoryError(error); if (beforeExecution) throw new Error(this.historyStatus); }
	}
	private closeHistory(): void {
		try { this.history?.close(); } catch (error) { this.recordHistoryError(error); }
		this.history = undefined;
	}

	create(agent: string, cwd?: string, branchId?: string | null): ManagedSubagentTask {
		if (this.closed) throw new Error(`${this.label} task history is closed.`);
		this.assertHistoryAvailable();
		if (this.records.size - this.completed >= this.capacity) throw new Error(`${this.label} task capacity reached: ${this.capacity}. Wait for active tasks.`);
		const task: ManagedSubagentTask = {
			id: `${this.prefix}-${this.nextId++}`, agent, state: "queued", createdAt: Date.now(), cwd, branchId,
			controller: new AbortController(), waiters: new Set(),
		};
		this.persist(task, true);
		this.records.set(task.id, task);
		return task;
	}

	get(id: string): ManagedSubagentTask {
		const task = this.records.get(id);
		if (!task) {
			this.assertHistoryAvailable();
			throw new Error(`Unknown or expired ${this.label.toLowerCase()} task ID. List current tasks.`);
		}
		return task;
	}

	start(task: ManagedSubagentTask): void {
		if (isTerminal(task)) throw new Error("Historical/terminal tasks cannot restart; submit a fresh authorized request.");
		task.controller?.signal.throwIfAborted();
		task.state = "running";
		task.startedAt = Date.now();
		this.persist(task, true);
	}

	finish(task: ManagedSubagentTask, result: string, failed: boolean, shellExecution?: ShellExecutionFacts): void {
		if (isTerminal(task)) return;
		task.state = task.controller?.signal.aborted ? "cancelled" : failed ? "failed" : "completed";
		task.completedAt = Date.now();
		// 50 KiB UTF-8 worst case (4 bytes/code point), without materializing the whole output.
		const suffix = "\n[truncated; retained task result limit: 12000 characters]";
		let end = TASK_RESULT_CHARS - suffix.length;
		if (result.length > end && result.charCodeAt(end - 1) >= 0xD800 && result.charCodeAt(end - 1) <= 0xDBFF && result.charCodeAt(end) >= 0xDC00 && result.charCodeAt(end) <= 0xDFFF) end--;
		task.result = this.closed ? undefined : result.length > TASK_RESULT_CHARS ? `${result.slice(0, end)}${suffix}` : result;
		task.shellExecution = this.closed ? undefined : shellExecution;
		task.controller = undefined;
		if (!this.closed) this.persist(task, false);
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
			task.controller?.abort(new Error(`${this.label} task cancelled.`));
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
			if (this.waiterCount >= 64) throw new Error(`${this.label} wait capacity reached: 64. Finish an existing wait first.`);
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
			task.shellExecution = undefined;
			this.records.delete(id);
			if (--this.completed <= this.capacity) break;
		}
	}

	dispose(): void {
		this.closed = true;
		this.cancelAll();
		for (const task of this.records.values()) {
			for (const waiter of task.waiters) waiter.finish(new Error(`${this.label} session ended.`));
			task.result = undefined;
			task.shellExecution = undefined;
		}
		this.closeHistory();
		this.historySession = undefined;
		this.records.clear();
		this.completed = 0;
	}
}
