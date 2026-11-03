/** Service owners only; individual tasks remain in their existing registries. */
export interface ExecutionBoundaryParticipant {
  revoke(): void;
  drain(): Promise<void>;
  /** Synchronous, side-effect-free selection metadata. Reads the owner's state; grants no authority. */
  toolSelectionMode?(): "plan" | undefined;
}

const MAX_PARTICIPANTS = 16;
const STALE = "[EXECUTION_BOUNDARY_CHANGED] Execution is paused or belongs to a previous boundary.";

/** One session/runtime owner. This coordinates lifecycle; it makes no allow/ask/deny decision. */
export class SessionExecutionBoundary {
  private readonly participants = new Map<string, ExecutionBoundaryParticipant>();
  private cancellation = new AbortController();
  private epoch = 0;
  private accepting = true;
  private disposed = false;
  private operation: Promise<void> | undefined;
  private draining: Promise<PromiseSettledResult<void>[]> | undefined;
  private revocationFailed = false;
  private deadline: NodeJS.Timeout | undefined;
  private rejectDeadline: ((error: Error) => void) | undefined;
  private readonly deadlineMs: number;
  private preparations = 0;
  private preparationIdle: Promise<void> | undefined;
  private finishPreparations: (() => void) | undefined;

  constructor(deadlineMs = 10_000) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw new Error("Invalid execution transition deadline.");
    this.deadlineMs = deadlineMs;
  }

  get generation(): number { return this.epoch; }
  get isDisposed(): boolean { return this.disposed; }
  get signal(): AbortSignal { return this.cancellation.signal; }
  get participantCount(): number { return this.participants.size; }
  get isDraining(): boolean { return this.draining !== undefined; }
  get hasDeadline(): boolean { return this.deadline !== undefined; }
  get preparationCount(): number { return this.preparations; }

  /** Catalog reads and registration selection. Admission and final authorization remain separate. */
  getToolSelectionMode(): "default" | "plan" {
    if (this.disposed) return "default";
    let mode: "default" | "plan" = "default";
    for (const owner of this.participants.values()) {
      const declared = owner.toolSelectionMode?.();
      if (declared === "plan") mode = "plan";
      else if (declared !== undefined) throw new Error("Invalid tool selection mode declaration.");
    }
    return mode;
  }

  assertCurrent(generation = this.epoch): void {
    if (!this.accepting || this.disposed || generation !== this.epoch) throw new Error(STALE);
  }

  /** Prompt/preflight boundary only, never a per-event or per-progress operation. */
  beginPreparation(): number {
    this.assertCurrent();
    if (this.preparations >= 128) throw new Error("Too many admitted session preparations.");
    if (this.preparations++ === 0) this.preparationIdle = new Promise(resolve => { this.finishPreparations = resolve; });
    return this.epoch;
  }

  endPreparation(): void {
    if (this.preparations === 0) throw new Error("Session preparation ownership is already released.");
    if (--this.preparations !== 0) return;
    const finish = this.finishPreparations;
    this.finishPreparations = undefined;
    this.preparationIdle = undefined;
    finish?.();
  }

  async waitForPreparations(): Promise<void> { await this.preparationIdle; }

  register(name: string, participant: ExecutionBoundaryParticipant): () => void {
    this.assertCurrent();
    if (!name || this.participants.has(name) || this.participants.size >= MAX_PARTICIPANTS) throw new Error("Execution boundary participant is duplicate or exceeds capacity.");
    this.participants.set(name, participant);
    let registered = true;
    return () => {
      if (!registered) return;
      if (this.operation || this.draining) throw new Error("Cannot detach an execution owner during transition cleanup.");
      registered = false;
      if (this.participants.get(name) === participant) this.participants.delete(name);
    };
  }

  /** Publish is synchronous; never wait for a containing tool/agent hook from this callback. */
  transition(publish: () => undefined): Promise<void> {
    if (this.disposed || this.operation || this.draining) return Promise.reject(new Error("Execution boundary is closed or still draining; no transition was queued."));
    return this.start(publish);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    if (this.operation) return this.operation;
    if (this.participants.size === 0 && !this.draining && this.preparations === 0) { this.accepting = false; this.cancellation.abort(); return Promise.resolve(); }
    return this.start();
  }

  private start(publish?: () => undefined): Promise<void> {
    this.accepting = false;
    this.epoch++;
    // Establish ownership before abort observers can reenter disposal.
    this.operation = Promise.resolve().then(() => this.run(publish));
    if (!this.cancellation.signal.aborted) {
      const reason = new Error(STALE); reason.stack = reason.message; this.cancellation.abort(reason);
    }
    return this.operation;
  }

  private readonly onDrained = (results: PromiseSettledResult<void>[]): PromiseSettledResult<void>[] => {
    this.draining = undefined;
    if (this.disposed) {
      let clean = !this.revocationFailed;
      for (const result of results) if (result.status === "rejected") clean = false;
      if (clean) this.participants.clear();
    }
    return results;
  };

  private readonly onDeadline = (): void => {
    this.rejectDeadline?.(new Error("[EXECUTION_DRAIN_TIMEOUT] Previous execution has not stopped. Admission remains closed; no new boundary was published."));
  };

  private async run(publish?: () => undefined): Promise<void> {
    if (!this.draining) {
      this.revocationFailed = false;
      // Revoke every owner before starting any asynchronous wait, even when one fails.
      for (const owner of this.participants.values()) {
        try { owner.revoke(); } catch { this.revocationFailed = true; }
      }
      const pending: Promise<void>[] = [];
      if (this.preparationIdle) pending.push(this.preparationIdle);
      for (const owner of this.participants.values()) {
        try { pending.push(Promise.resolve(owner.drain())); }
        catch (error) { pending.push(Promise.reject(error)); }
      }
      this.draining = Promise.allSettled(pending).then(this.onDrained);
    }
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        this.rejectDeadline = reject;
        this.deadline = setTimeout(this.onDeadline, this.deadlineMs);
      });
      const results = await Promise.race([this.draining, timeout]);
      if (this.revocationFailed) throw new Error("Execution owner revocation failed; cleanup remains unconfirmed.");
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (this.disposed) { this.participants.clear(); return; }
      const returned = publish?.();
      if (returned !== undefined) throw new Error("Execution boundary publication must be synchronous and return undefined.");
      if (this.disposed) { this.participants.clear(); return; }
      this.cancellation = new AbortController();
      this.accepting = true;
    } finally {
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = undefined;
      this.rejectDeadline = undefined;
      this.operation = undefined;
      // Timed-out or failed cleanup retains exact owners; successful disposal releases them.
    }
  }
}
