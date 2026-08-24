async function closeRuntime(runtime) {
  if (!runtime) return;
  try { await runtime.close(); } catch { /* lifecycle cleanup is best effort */ }
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
    if (!this.isCurrent(token)) {
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
