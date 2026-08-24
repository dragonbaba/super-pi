/**
 * Thin OpenAI Responses WebSocket client.
 *
 * Handles connection lifecycle, message dispatch, reconnect scheduling, and the
 * latest `previous_response_id` learned from completed responses.
 */
import { EventEmitter } from "node:events";
import { unknownText } from "./text.ts";

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  model: string;
  output: OutputItem[];
  usage?: UsageInfo;
  service_tier?: "auto" | "default" | "flex" | "priority";
  error?: { code: string; message: string };
  incomplete_details?: { reason?: string };
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
    cache_write_tokens?: number;
  };
}

export type OpenAIResponsesAssistantPhase = "commentary" | "final_answer";

export type OutputItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      content: Array<{ type: "output_text"; text: string }>;
      phase?: OpenAIResponsesAssistantPhase;
      status?: "in_progress" | "completed";
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status?: "in_progress" | "completed";
    }
  | {
      type: "reasoning";
      id: string;
      content?: string;
      summary?: string;
    };

export function isResponseObject(value: unknown): value is ResponseObject {
  if (!value || typeof value !== "object") return false;
  const response = value as { id?: unknown; output?: unknown };
  return typeof response.id === "string" && Array.isArray(response.output);
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  response: ResponseObject;
}

export interface ResponseFailedEvent {
  type: "response.failed";
  response: ResponseObject;
}

export interface ResponseIncompleteEvent {
  type: "response.incomplete";
  response: ResponseObject;
}

export interface OutputTextDeltaEvent {
  type: "response.output_text.delta";
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
  param?: string;
}

export type OpenAIWebSocketEvent =
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent
  | OutputTextDeltaEvent
  | ErrorEvent
  | { type: string; [key: string]: unknown };

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string };
    };

export type InputItem =
  | {
      type: "message";
      role: "system" | "developer" | "user" | "assistant";
      content: string | ContentPart[];
      phase?: OpenAIResponsesAssistantPhase;
    }
  | { type: "function_call"; id?: string; call_id?: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; content?: string; encrypted_content?: string; summary?: string }
  | { type: "item_reference"; id: string };

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponseCreateEvent {
  type: "response.create";
  model: string;
  store?: boolean;
  stream?: boolean;
  input?: string | InputItem[];
  instructions?: string;
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
  context_management?: unknown;
  previous_response_id?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, string>;
  reasoning?: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    summary?: "auto" | "concise" | "detailed" | null;
  };
  truncation?: "auto" | "disabled";
  [key: string]: unknown;
}

export interface WarmUpEvent extends ResponseCreateEvent {
  generate: false;
}

export type ClientEvent = ResponseCreateEvent | WarmUpEvent;

const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const MAX_RETRIES = 5;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;
const WS_OPEN = 1;

export interface OpenAIWebSocketManagerOptions {
  url?: string;
  maxRetries?: number;
  backoffDelaysMs?: readonly number[];
  handshakeTimeoutMs?: number;
  headers?: Record<string, string>;
  socketFactory?: (url: string, options: { headers: Record<string, string> }) => any | Promise<any>;
}

export class OpenAIWebSocketManager extends EventEmitter {
  private ws: any = null;
  private apiKey: string | null = null;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pendingOpenCancel: ((error: Error) => void) | null = null;
  private connectionGeneration = 0;
  private closed = false;
  private _previousResponseId: string | null = null;
  private readonly wsUrl: string;
  private readonly maxRetries: number;
  private readonly backoffDelaysMs: readonly number[];
  private readonly handshakeTimeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly socketFactory: OpenAIWebSocketManagerOptions["socketFactory"];

  constructor(options: OpenAIWebSocketManagerOptions = {}) {
    super();
    this.wsUrl = options.url ?? OPENAI_WS_URL;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.headers = options.headers ?? {};
    this.socketFactory = options.socketFactory;
  }

  get previousResponseId(): string | null {
    return this._previousResponseId;
  }

  async connect(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
    this.closed = false;
    this.retryCount = 0;
    const generation = ++this.connectionGeneration;
    this.cancelRetryTimer();
    this.cancelPendingOpen(new Error("OpenAI WebSocket connection was superseded."));
    this.disposeSocket(this.ws, false);
    this.ws = null;
    await this.openConnection(generation);
  }

  send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error(
        `OpenAIWebSocketManager: cannot send; connection not open (readyState=${this.ws?.readyState ?? "none"})`,
      );
    }
    this.ws.send(JSON.stringify(event));
  }

  onMessage(handler: (event: OpenAIWebSocketEvent) => void): () => void {
    this.on("message", handler);
    return () => this.off("message", handler);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  close(): void {
    this.closed = true;
    this.connectionGeneration += 1;
    this.cancelRetryTimer();
    this.cancelPendingOpen(new Error("OpenAI WebSocket closed."));
    const socket = this.ws;
    this.ws = null;
    this.disposeSocket(socket, true);
  }

  private cancelPendingOpen(error: Error): void {
    const cancel = this.pendingOpenCancel;
    this.pendingOpenCancel = null;
    cancel?.(error);
  }

  private disposeSocket(socket: any, graceful: boolean): void {
    if (!socket) return;
    socket.removeAllListeners?.();
    try {
      if (graceful && socket.readyState === WS_OPEN) socket.close(1000, "Client closed");
      else socket.terminate?.();
    } catch { }
  }

  warmUp(params: { model: string; tools?: FunctionToolDefinition[]; instructions?: string }): void {
    this.send({
      type: "response.create",
      generate: false,
      model: params.model,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.instructions ? { instructions: params.instructions } : {}),
    });
  }

  private async createSocket(): Promise<any> {
    if (!this.apiKey) throw new Error("OpenAIWebSocketManager: apiKey is required.");
    const options = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        ...this.headers,
      },
    };
    if (this.socketFactory) return await this.socketFactory(this.wsUrl, options);
    const wsModule = await import("ws");
    const WebSocketCtor = (wsModule.default ?? wsModule) as any;
    return new WebSocketCtor(this.wsUrl, options);
  }

  private async openConnection(generation = this.connectionGeneration): Promise<void> {
    this.cancelRetryTimer();
    let socket: any;
    try {
      socket = await this.createSocket();
    } catch (error) {
      throw error instanceof Error ? error : new Error(unknownText(error));
    }
    if (this.closed || generation !== this.connectionGeneration) {
      try { socket.terminate?.(); } catch { /* stale socket is already unusable */ }
      throw new Error("OpenAI WebSocket connection was superseded.");
    }
    this.ws = socket;
    await this.waitForOpen(socket, generation);
  }

  private waitForOpen(socket: any, generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let handshakeTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        socket.off?.("open", onOpen);
        socket.off?.("error", onError);
        socket.off?.("close", onClose);
        socket.off?.("message", onMessage);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.pendingOpenCancel === finishReject) this.pendingOpenCancel = null;
        if (this.ws === socket) this.ws = null;
        try { socket.terminate?.(); } catch { /* exact owned socket only */ }
        reject(error);
      };
      const finishResolve = () => {
        if (settled) return;
        if (this.closed || generation !== this.connectionGeneration) {
          finishReject(new Error("OpenAI WebSocket connection was superseded."));
          return;
        }
        settled = true;
        cleanup();
        if (this.pendingOpenCancel === finishReject) this.pendingOpenCancel = null;
        socket.on?.("error", onError);
        socket.on?.("close", onClose);
        socket.on?.("message", onMessage);
        resolve();
      };
      const onOpen = () => {
        this.retryCount = 0;
        this.cancelRetryTimer();
        finishResolve();
        if (!settled || this.closed || generation !== this.connectionGeneration) return;
        this.emit("open");
      };
      const onError = (error: Error) => {
        if (this.listenerCount("error") > 0) this.emit("error", error);
        if (!settled) finishReject(error);
      };
      const onClose = (code: number, reason: Buffer | string) => {
        if (this.ws === socket) this.ws = null;
        const text = typeof reason === "string" ? reason : reason.toString();
        this.emit("close", code, text);
        if (!settled) {
          finishReject(new Error(`OpenAI WebSocket closed before open (${code}).`));
          return;
        }
        if (!this.closed && generation === this.connectionGeneration) this.scheduleReconnect();
      };
      const onMessage = (data: unknown) => this.handleMessage(data);

      this.pendingOpenCancel = finishReject;
      socket.once?.("open", onOpen);
      socket.once?.("error", onError);
      socket.once?.("close", onClose);
      socket.on?.("message", onMessage);
      handshakeTimer = setTimeout(
        finishReject,
        this.handshakeTimeoutMs,
        new Error("OpenAI WebSocket handshake timed out."),
      );
      if (socket.readyState === WS_OPEN) onOpen();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    if (this.retryCount >= this.maxRetries) {
      if (this.listenerCount("error") > 0) {
        this.emit(
          "error",
          new Error(`OpenAIWebSocketManager: max reconnect retries (${this.maxRetries}) exceeded.`),
        );
      }
      return;
    }

    const delayMs =
      this.backoffDelaysMs[Math.min(this.retryCount, this.backoffDelaysMs.length - 1)] ?? 1000;
    this.retryCount++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      this.openConnection().catch((error) => {
        if (this.listenerCount("error") > 0) this.emit("error", error instanceof Error ? error : new Error(unknownText(error)));
        if (!this.closed) this.scheduleReconnect();
      });
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private cancelRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private handleMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else {
      text = unknownText(data);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (this.listenerCount("error") > 0) {
        this.emit("error", new Error(`OpenAIWebSocketManager: failed to parse message: ${text.slice(0, 200)}`));
      }
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      if (this.listenerCount("error") > 0) {
        this.emit(
          "error",
          new Error(`OpenAIWebSocketManager: unexpected message shape: ${text.slice(0, 200)}`),
        );
      }
      return;
    }

    const event = parsed as OpenAIWebSocketEvent;
    const response = (event as { response?: unknown }).response;
    if (
      isResponseObject(response) &&
      (
        event.type === "response.completed" ||
        (
          event.type === "response.incomplete" &&
          response.incomplete_details?.reason === "max_output_tokens"
        )
      )
    ) {
      this._previousResponseId = response.id;
    }
    this.emit("message", event);
  }
}
