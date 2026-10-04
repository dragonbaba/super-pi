async function closeRuntime(runtime) {
  if (!runtime) return;
  try { await runtime.close(); } catch { /* lifecycle cleanup is best effort */ }
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

  async begin(parentSignal) {
    const generation = ++this.#generation;
    this.#controller?.abort(new Error("MCP lifecycle replaced"));
    const current = this.#current;
    const starting = this.#starting;
    this.#controller = null;
    this.#current = null;
    this.#starting = null;
    this.deactivate();
    await closeRuntime(starting);
    if (current !== starting) await closeRuntime(current);
    if (generation !== this.#generation) return null;

    const controller = new AbortController();
    this.#controller = controller;
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    return { generation, controller, signal };
  }

  async attach(token, runtime) {
    if (!this.isCurrent(token) || token.signal.aborted) {
      await closeRuntime(runtime);
      return false;
    }
    this.#starting = runtime;
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
    if (this.#starting === runtime) this.#starting = null;
    if (this.#current === runtime) this.#current = null;
    return true;
  }

  async shutdown() {
    this.#generation += 1;
    this.#controller?.abort(new Error("MCP lifecycle stopped"));
    const current = this.#current;
    const starting = this.#starting;
    this.#controller = null;
    this.#current = null;
    this.#starting = null;
    this.deactivate();
    await closeRuntime(starting);
    if (current !== starting) await closeRuntime(current);
  }
}
