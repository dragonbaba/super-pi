import { Worker } from "node:worker_threads";

interface LeaseOwner { readonly completed: boolean }

/** One sandbox owns one slot. No queue, VM, result, or catalog is pooled. */
export class WorkerPool {
	private worker: Worker | undefined;
	private owner: LeaseOwner | undefined;
	private uses = 0;
	private closed = false;
	private timer: NodeJS.Timeout | undefined;
	private retiring: Promise<void> | undefined;
	private readonly url: string | URL;
	private readonly lifecycle: { workersStarted: number; workersStopped: number };

	constructor(url: string | URL, lifecycle: { workersStarted: number; workersStopped: number }) {
		this.url = url;
		this.lifecycle = lifecycle;
	}

	async acquire(owner: LeaseOwner): Promise<Worker> {
		await this.retiring;
		if (owner.completed) throw new Error("Worker lease cancelled");
		if (this.closed) throw new Error("Worker pool is closed");
		if (this.owner) throw new Error("Worker pool already leased");
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.worker) {
			const source = typeof this.url === "string" ? this.url.endsWith(".ts") : this.url.pathname.endsWith(".ts");
			this.worker = new Worker(this.url, { workerData: { pooled: true },
				execArgv: source ? ["--experimental-strip-types"] : [], env: Object.freeze({}) });
			this.lifecycle.workersStarted++;
			this.uses = 0;
			this.worker.on("error", this.onError);
			this.worker.on("exit", this.onExit);
		}
		this.owner = owner;
		this.uses++;
		this.worker.ref();
		return this.worker;
	}

	/** Only a completion sent after VM disposal may return a healthy slot. */
	release(worker: Worker, owner: LeaseOwner, reusable: boolean): Promise<void> | undefined {
		if (worker !== this.worker || owner !== this.owner) return this.retiring;
		this.owner = undefined;
		if (!reusable || this.closed || this.uses >= 64) return this.retire();
		worker.unref();
		this.timer = setTimeout(this.onIdle, 30_000);
		this.timer.unref();
		return undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.retire();
	}

	private readonly onIdle = (): void => { void this.retire(); };
	private readonly onError = (): void => { void this.retire(); };
	private readonly onExit = (): void => {
		this.lifecycle.workersStopped++;
		this.worker?.removeListener("error", this.onError);
		this.worker = undefined;
		this.owner = undefined;
		clearTimeout(this.timer);
		this.timer = undefined;
	};

	private retire(): Promise<void> | undefined {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.retiring) return this.retiring;
		const worker = this.worker;
		if (!worker) return undefined;
		this.owner = undefined;
		// Keep ownership until physical exit, including an idle deadline racing acquire().
		this.retiring = worker.terminate().then(this.onRetired, this.onRetired);
		return this.retiring;
	}
	private readonly onRetired = (): void => { this.retiring = undefined; };
}
