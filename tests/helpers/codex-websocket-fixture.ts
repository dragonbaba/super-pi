export const terminalResponse = {
  type: "response.completed", response: { id: "response-test", status: "completed", output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
};

/** Shared native Codex transport fixture; all replies and credentials are synthetic. */
export class FakeCodexWebSocket {
  static mode: "success" | "fail" = "success";
  static sentBodies: Array<Record<string, any>> = [];
  static replies: ((body: Record<string, any>) => unknown[]) | undefined;
  static connections = 0;
  static closes = 0;
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readyState = 0;
  constructor(_url: string, _options?: unknown) {
    FakeCodexWebSocket.connections++;
    queueMicrotask(() => {
      if (FakeCodexWebSocket.mode === "fail") { this.emit("error", new Error("synthetic websocket failure")); return; }
      this.readyState = 1; this.emit("open", {});
    });
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners); }
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.get(type)?.delete(listener); }
  send(data: string): void {
    const body = JSON.parse(data);
    FakeCodexWebSocket.sentBodies.push(body);
    const events = FakeCodexWebSocket.replies?.(body) ?? [terminalResponse];
    queueMicrotask(() => { for (const event of events) this.emit("message", { data: JSON.stringify(event) }); });
  }
  close(): void { this.readyState = 3; FakeCodexWebSocket.closes++; }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}
