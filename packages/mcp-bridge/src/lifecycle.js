async function closeRuntime(runtime) {
  if (!runtime) return;
  await runtime.close();
}

function lifecycleCancellation(message) {
  const error = new Error(message);
  error.stack = error.message;
  return error;
}

// Only connection/discovery waits use this boundary. Cancelling one waiter must
// not cancel the shared server connection, and settled waits retain no listener.
export async function waitForMcpReady(pending, signal) {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let abort;
  try {
    return await Promise.race([pending, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export class McpRuntimeLifecycle {
  #generation = 0;
  #controller = null;
  #current = null;
  #starting = null;

  constructor(deactivate) {
    this.deactivate = deactivate;
  }

  get current() {
    return this.#current;
  }

  isCurrent(token) {
    return token?.generation === this.#generation && token.controller === this.#controller;
  }

  owns(runtime) {
    return runtime === this.#current || runtime === this.#starting;
  }

  async suspend() {
    this.#generation++;
    this.#controller?.abort(lifecycleCancellation("MCP execution boundary changed"));
    this.#controller = null;
    // A partially initialized runtime cannot be published after revocation.
    // Only the published catalog is reusable; no replacement catalog is copied.
    const results = await Promise.allSettled([this.#closeStarting(), this.#current?.suspend()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  resume() {
    if (this.#starting) throw new Error("MCP startup cleanup has not completed.");
    this.#current?.resume();
  }

  async begin(parentSignal) {
    const generation = ++this.#generation;
    this.#controller?.abort(lifecycleCancellation("MCP lifecycle replaced"));
    this.#controller = null;
    this.deactivate();
    await this.#drainOwned();
    if (generation !== this.#generation) return null;

    const controller = new AbortController();
    this.#controller = controller;
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    return { generation, controller, signal };
  }

  async attach(token, runtime) {
    if (this.#starting && this.#starting !== runtime) throw new Error("MCP startup still owns a runtime awaiting cleanup.");
    this.#starting = runtime;
    if (!this.isCurrent(token) || token.signal.aborted) {
      await closeRuntime(runtime);
      if (this.#starting === runtime) this.#starting = null;
      return false;
    }
    return true;
  }

  publish(token, runtime) {
    if (!this.isCurrent(token) || this.#starting !== runtime || token.signal.aborted) return false;
    this.#starting = null;
    this.#current = runtime;
    return true;
  }

  fail(token, runtime) {
    if (!this.isCurrent(token)) return false;
    if (runtime && !runtime.cleanupComplete) return true;
    if (this.#starting === runtime) this.#starting = null;
    if (this.#current === runtime) this.#current = null;
    return true;
  }

  async shutdown() {
    this.#generation += 1;
    this.#controller?.abort(lifecycleCancellation("MCP lifecycle stopped"));
    this.#controller = null;
    this.deactivate();
    await this.#drainOwned();
  }

  async #drainOwned() {
    const results = await Promise.allSettled([this.#closeStarting(), this.#closeCurrent()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  async #closeStarting() {
    const runtime = this.#starting;
    await closeRuntime(runtime);
    if (this.#starting === runtime) this.#starting = null;
  }

  async #closeCurrent() {
    const runtime = this.#current;
    await closeRuntime(runtime);
    if (this.#current === runtime) this.#current = null;
  }
}
