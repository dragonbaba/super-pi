export type EventDelivery = "critical" | "latest";

export interface EventDeliveryScheduler {
	now(): number;
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export interface EventSubscriptionOptions<E> {
	delivery?: EventDelivery;
	minIntervalMs?: number;
	filter?: (event: E) => boolean;
}

export type EventDeliveryDiagnostic =
	| { type: "observer-error"; error: unknown }
	| { type: "observer-slow"; durationMs: number };

export interface EventDeliveryStats {
	received: number;
	coalesced: number;
	delivered: number;
	pendingKeys: number;
	maxPendingKeys: number;
	observerErrors: number;
	slowObservers: number;
}

export interface EventDeliveryDispatcherOptions<E> {
	scheduler?: EventDeliveryScheduler;
	defaultMinIntervalMs?: number;
	slowObserverMs?: number;
	snapshotLatest?: (event: E) => E;
	onDiagnostic?: (diagnostic: EventDeliveryDiagnostic) => void;
}

type EventListener<E> = (event: E) => Promise<void> | void;

interface CriticalListener<E> {
	listener: EventListener<E>;
	filter?: (event: E) => boolean;
}

interface ObserverListener<E, K> extends CriticalListener<E> {
	minIntervalMs: number;
	lastDeliveredAt: number;
	seenVersions: Map<K, number>;
}

interface PendingLatest<E> {
	event: E;
	version: number;
	snapshot: E | undefined;
}

const DEFAULT_SCHEDULER: EventDeliveryScheduler = {
	now: () => performance.now(),
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Delivers compatibility listeners synchronously while keeping display-only
 * observers on a bounded latest-value lane.
 */
export class EventDeliveryDispatcher<E, K> {
	private readonly criticalListeners = new Set<CriticalListener<E>>();
	private readonly observers = new Set<ObserverListener<E, K>>();
	private readonly pendingLatest = new Map<K, PendingLatest<E>>();
	private readonly scheduler: EventDeliveryScheduler;
	private readonly defaultMinIntervalMs: number;
	private readonly slowObserverMs: number;
	private readonly snapshotLatest: (event: E) => E;
	private readonly onDiagnostic?: (diagnostic: EventDeliveryDiagnostic) => void;
	private scheduledHandle: unknown;
	private flushPromise: Promise<void> | undefined;
	private nextVersion = 1;
	private disposed = false;
	private received = 0;
	private coalesced = 0;
	private delivered = 0;
	private maxPendingKeys = 0;
	private observerErrors = 0;
	private slowObservers = 0;
	private readonly scheduledFlush = (): void => {
		this.scheduledHandle = undefined;
		void this.flushAvailable(false);
	};

	constructor(options: EventDeliveryDispatcherOptions<E> = {}) {
		this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
		this.defaultMinIntervalMs = Math.max(0, options.defaultMinIntervalMs ?? 16);
		this.slowObserverMs = Math.max(0, options.slowObserverMs ?? 100);
		this.snapshotLatest = options.snapshotLatest ?? ((event) => event);
		this.onDiagnostic = options.onDiagnostic;
	}

	subscribe(listener: EventListener<E>, options: EventSubscriptionOptions<E> = {}): () => void {
		if (this.disposed) throw new Error("Event delivery dispatcher is disposed");
		if (options.delivery === "latest") {
			const observer: ObserverListener<E, K> = {
				listener,
				filter: options.filter,
				minIntervalMs: Math.max(0, options.minIntervalMs ?? this.defaultMinIntervalMs),
				lastDeliveredAt: this.scheduler.now(),
				seenVersions: new Map(),
			};
			this.observers.add(observer);
			return () => {
				this.observers.delete(observer);
				observer.seenVersions.clear();
				this.removeFullyDelivered();
			};
		}

		const critical = { listener, filter: options.filter };
		this.criticalListeners.add(critical);
		return () => this.criticalListeners.delete(critical);
	}

	hasAwaitedListeners(event: E): boolean {
		for (const registration of this.criticalListeners) {
			if (!registration.filter || registration.filter(event)) return true;
		}
		return false;
	}

	async publishAwaited(event: E): Promise<void> {
		if (this.disposed) return;
		for (const registration of this.criticalListeners) {
			if (registration.filter && !registration.filter(event)) continue;
			await registration.listener(event);
			this.delivered++;
		}
	}

	publishLatest(key: K, event: E): void {
		if (this.disposed || this.observers.size === 0) return;
		this.received++;
		const current = this.pendingLatest.get(key);
		if (current) {
			current.event = event;
			current.version = this.nextVersion++;
			current.snapshot = undefined;
			this.coalesced++;
		} else {
			this.pendingLatest.set(key, { event, version: this.nextVersion++, snapshot: undefined });
			this.maxPendingKeys = Math.max(this.maxPendingKeys, this.pendingLatest.size);
		}
		this.scheduleFlush();
	}

	async publishCritical(event: E): Promise<void> {
		if (this.disposed) return;
		await this.flushAllLatest();
		await this.publishAwaited(event);
		for (const observer of this.observers) {
			if (observer.filter && !observer.filter(event)) continue;
			await this.deliverObserver(observer, event);
			observer.lastDeliveredAt = this.scheduler.now();
		}
	}

	async flushLatest(key: K): Promise<void> {
		await this.flushAvailable(true, key);
	}

	async flushAllLatest(): Promise<void> {
		await this.flushAvailable(true);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelScheduledFlush();
		this.pendingLatest.clear();
		await this.flushPromise;
		this.criticalListeners.clear();
		for (const observer of this.observers) observer.seenVersions.clear();
		this.observers.clear();
	}

	get stats(): EventDeliveryStats {
		return {
			received: this.received,
			coalesced: this.coalesced,
			delivered: this.delivered,
			pendingKeys: this.pendingLatest.size,
			maxPendingKeys: this.maxPendingKeys,
			observerErrors: this.observerErrors,
			slowObservers: this.slowObservers,
		};
	}

	private scheduleFlush(): void {
		if (this.scheduledHandle !== undefined || this.flushPromise || this.pendingLatest.size === 0) return;
		let delayMs = Number.POSITIVE_INFINITY;
		const now = this.scheduler.now();
		for (const observer of this.observers) {
			let hasPending = false;
			for (const [key, pending] of this.pendingLatest) {
				if ((observer.seenVersions.get(key) ?? 0) < pending.version) {
					hasPending = true;
					break;
				}
			}
			if (hasPending) {
				delayMs = Math.min(delayMs, Math.max(0, observer.lastDeliveredAt + observer.minIntervalMs - now));
			}
		}
		if (!Number.isFinite(delayMs)) return;
		this.scheduledHandle = this.scheduler.schedule(this.scheduledFlush, delayMs);
	}

	private cancelScheduledFlush(): void {
		if (this.scheduledHandle === undefined) return;
		this.scheduler.cancel(this.scheduledHandle);
		this.scheduledHandle = undefined;
	}

	private async flushAvailable(force: boolean, onlyKey?: K): Promise<void> {
		if (this.disposed || !this.hasPending(onlyKey)) return;
		this.cancelScheduledFlush();
		if (this.flushPromise) {
			await this.flushPromise;
			if (!this.disposed && this.hasPending(onlyKey)) await this.flushAvailable(force, onlyKey);
			return;
		}

		const flush = this.runFlush(force, onlyKey);
		this.flushPromise = flush;
		try {
			await flush;
		} finally {
			if (this.flushPromise === flush) this.flushPromise = undefined;
		}
		if (!this.disposed) {
			if (force && this.hasPending(onlyKey)) await this.flushAvailable(true, onlyKey);
			if (this.pendingLatest.size > 0) this.scheduleFlush();
		}
	}

	private hasPending(onlyKey?: K): boolean {
		return onlyKey === undefined ? this.pendingLatest.size > 0 : this.pendingLatest.has(onlyKey);
	}

	private async runFlush(force: boolean, onlyKey?: K): Promise<void> {
		const now = this.scheduler.now();
		for (const observer of this.observers) {
			if (!force && now < observer.lastDeliveredAt + observer.minIntervalMs) continue;
			let deliveredAny = false;
			for (const [key, pending] of this.pendingLatest) {
				if (onlyKey !== undefined && key !== onlyKey) continue;
				if ((observer.seenVersions.get(key) ?? 0) >= pending.version) continue;
				const deliveredVersion = pending.version;
				const event = pending.snapshot ?? (pending.snapshot = this.snapshotLatest(pending.event));
				if (!observer.filter || observer.filter(event)) await this.deliverObserver(observer, event);
				observer.seenVersions.set(key, deliveredVersion);
				deliveredAny = true;
			}
			if (deliveredAny) observer.lastDeliveredAt = this.scheduler.now();
		}
		this.removeFullyDelivered(onlyKey);
	}

	private removeFullyDelivered(onlyKey?: K): void {
		for (const [key, pending] of this.pendingLatest) {
			if (onlyKey !== undefined && key !== onlyKey) continue;
			let deliveredToAll = true;
			for (const observer of this.observers) {
				if ((observer.seenVersions.get(key) ?? 0) < pending.version) {
					deliveredToAll = false;
					break;
				}
			}
			if (!deliveredToAll) continue;
			this.pendingLatest.delete(key);
			for (const observer of this.observers) observer.seenVersions.delete(key);
		}
	}

	private async deliverObserver(observer: ObserverListener<E, K>, event: E): Promise<void> {
		const startedAt = this.scheduler.now();
		try {
			await observer.listener(event);
			this.delivered++;
		} catch (error) {
			this.observerErrors++;
			this.onDiagnostic?.({ type: "observer-error", error });
		}
		const durationMs = this.scheduler.now() - startedAt;
		if (durationMs >= this.slowObserverMs) {
			this.slowObservers++;
			this.onDiagnostic?.({ type: "observer-slow", durationMs });
		}
	}
}
