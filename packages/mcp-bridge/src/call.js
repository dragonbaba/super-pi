const MCP_PROGRESS_SOURCE = Symbol.for("super-pi.mcp-progress-source.v1");

/** Fixed public errors never retain an arbitrary server error as message/cause. */
export class McpCallError extends Error {
  constructor(code) {
    super(code === "aborted" ? "MCP request aborted." : "MCP request failed (protocol-error).");
    this.name = "McpCallError";
    this.code = code;
  }
}

/** One active request; final ToolResult ownership remains with the agent. */
export class McpCall {
  constructor(signal, onUpdate) {
    this.controller = new AbortController();
    this.parentSignal = signal;
    this.onUpdate = onUpdate;
    this.accepting = true;
    this.progress = -1;
    this.notifications = 0;
    this.deliveries = 0;
    this.observerErrors = 0;
    this.notify = this.notify.bind(this);
    this.abort = this.abort.bind(this);
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  notify(value) {
    if (!this.accepting || this.controller.signal.aborted) return;
    this.notifications++;
    if (!Number.isFinite(value?.progress) || value.progress < 0 || value.progress < this.progress) return;
    this.progress = value.progress;
    if (!this.onUpdate) return;
    // Only numeric protocol progress is projected; arbitrary messages never enter
    // logs, telemetry, or the final canonical result. Agent-core owns the latest slot.
    const text = Number.isFinite(value.total) && value.total >= value.progress
      ? `[MCP progress: ${value.progress}/${value.total}]`
      : `[MCP progress: ${value.progress}]`;
    try {
      this.onUpdate({ content: [{ type: "text", text }], details: { mcpProgress: true }, [MCP_PROGRESS_SOURCE]: true });
      this.deliveries++;
    } catch {
      this.observerErrors++;
    }
  }

  abort() {
    this.onUpdate = undefined;
    this.accepting = false;
    this.controller.abort(new McpCallError("aborted"));
  }

  finish() {
    this.accepting = false;
    this.onUpdate = undefined;
    this.parentSignal?.removeEventListener("abort", this.abort);
    this.parentSignal = undefined;
  }
}
