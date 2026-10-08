import { isPathInside } from "./child-security.ts";
import type { SubagentLimits } from "./limits.ts";

export interface TaskWorkspace {
	readonly canonicalCwd: string;
	readonly allowMutation: boolean;
}

/** One reservation per accepted call; no credentials, prompts or results live here. */
export class TaskReservation {
	readonly workspaces: readonly TaskWorkspace[];
	private remaining: number;
	private released = false;
	private readonly owner: SubagentScheduler;

	constructor(owner: SubagentScheduler, workspaces: readonly TaskWorkspace[]) {
		this.owner = owner;
		this.workspaces = workspaces;
		this.remaining = workspaces.length;
	}

	completed(): void {
		if (this.released || this.remaining === 0) return;
		this.remaining--;
		this.owner.releaseCount(1);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.owner.releaseCount(this.remaining);
		this.remaining = 0;
		this.owner.releaseReservation(this);
	}
}

class SlotWaiter {
	readonly promise: Promise<void>;
	private resolve!: () => void;
	private reject!: (reason: unknown) => void;
	private readonly owner: SubagentScheduler;
	private readonly signal: AbortSignal | undefined;
	private readonly abort = this.onAbort.bind(this);
	settled = false;

	constructor(owner: SubagentScheduler, signal: AbortSignal | undefined) {
		this.owner = owner;
		this.signal = signal;
		this.promise = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
		// Attach only after the owner has enqueued this waiter.
	}

	listen(): void {
		if (this.signal?.aborted) this.onAbort();
		else this.signal?.addEventListener("abort", this.abort, { once: true });
	}

	private onAbort(): void {
		this.owner.removeWaiter(this);
		this.finish(this.signal?.reason ?? new Error("Subagent task cancelled before launch."));
	}

	finish(error?: unknown): void {
		if (this.settled) return;
		this.settled = true;
		this.signal?.removeEventListener("abort", this.abort);
		if (error !== undefined) this.reject(error);
		else this.resolve();
	}
}

/** Session-owned FIFO. All Promises/listeners are per task, never per progress event. */
export class SubagentScheduler {
	readonly limits: SubagentLimits;
	private readonly reservations = new Set<TaskReservation>();
	private readonly waiters: SlotWaiter[] = [];
	private disposed = false;
	active = 0;
	outstanding = 0;
	reserved = 0;
	highWaterMark = 0;
	queueHighWaterMark = 0;

	constructor(limits: SubagentLimits) { this.limits = limits; }
	get queued(): number { return this.waiters.length; }
	get reservationCount(): number { return this.reservations.size; }

	reserve(workspaces: readonly TaskWorkspace[]): TaskReservation {
		if (this.disposed) throw new Error("Subagent scheduler is closed.");
		const count = workspaces.length;
		if (count < 1 || count > this.limits.maxTasks) {
			throw new Error(`Subagent task limit exceeded: requested ${count}, per-call maximum ${this.limits.maxTasks}. Split into batches.`);
		}
		if (this.reserved + count > this.limits.maxTasks) {
			throw new Error(`Subagent capacity exceeded: ${this.reserved} reserved by unfinished calls + ${count} requested; maximum ${this.limits.maxTasks}. Wait for a call to finish or submit fewer.`);
		}
		for (const reservation of this.reservations) {
			for (const current of reservation.workspaces) {
				for (const requested of workspaces) {
					if ((current.allowMutation || requested.allowMutation)
						&& (isPathInside(current.canonicalCwd, requested.canonicalCwd) || isPathInside(requested.canonicalCwd, current.canonicalCwd))) {
						throw new Error("Subagent workspace is already reserved by overlapping work with write access. Wait, use readOnly for both calls, or choose an isolated workspace.");
					}
				}
			}
		}
		const reservation = new TaskReservation(this, workspaces);
		this.reservations.add(reservation);
		this.outstanding += count;
		this.reserved += count;
		return reservation;
	}

	async run<T>(signal: AbortSignal | undefined, execute: () => Promise<T>): Promise<T> {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("Subagent scheduler is closed.");
		if (this.active < this.limits.maxConcurrent && this.waiters.length === 0) this.takeSlot();
		else {
			const waiter = new SlotWaiter(this, signal);
			this.waiters.push(waiter);
			this.queueHighWaterMark = Math.max(this.queueHighWaterMark, this.waiters.length);
			waiter.listen();
			await waiter.promise;
		}
		try {
			signal?.throwIfAborted();
			if (this.disposed) throw new Error("Subagent scheduler is closed.");
			return await execute();
		} finally {
			this.active--;
			this.drain();
		}
	}

	private takeSlot(): void {
		this.active++;
		this.highWaterMark = Math.max(this.highWaterMark, this.active);
	}

	private drain(): void {
		while (!this.disposed && this.active < this.limits.maxConcurrent && this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			if (waiter.settled) continue;
			this.takeSlot();
			waiter.finish();
		}
	}

	removeWaiter(waiter: SlotWaiter): void {
		const index = this.waiters.indexOf(waiter);
		if (index !== -1) this.waiters.splice(index, 1);
	}
	releaseCount(count: number): void { this.outstanding -= count; }
	releaseReservation(reservation: TaskReservation): void {
		if (this.reservations.delete(reservation)) this.reserved -= reservation.workspaces.length;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const waiter of this.waiters) waiter.finish(new Error("Subagent session ended before launch."));
		this.waiters.length = 0;
		for (const reservation of this.reservations) reservation.release();
	}
}
