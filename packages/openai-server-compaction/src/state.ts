/**
 * In-memory per-session runtime state.
 *
 * This data is intentionally ephemeral. Persisted remote compaction artifacts
 * live in Pi session entries; this module only caches the currently active
 * continuation and reconstructed replay state for the running process.
 */
import type { ExtensionConfig } from "./config.ts";
import type {
  RemoteCompactionServiceTier,
  RemoteCompactionSessionState,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./remote-compaction.ts";

export type ContinuationState = {
  requestScope?: string;
  responseId: string;
  modelKey: string;
  updatedAt: number;
  contextLength?: number;
};

export type ResponsesRequestShapeState = {
  updatedAt: number;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  serviceTier?: RemoteCompactionServiceTier;
};

export type TransportContextState = {
  requestScope?: string;
  modelKey: string;
  contextLength: number;
};

// One explicit owner; session IDs never select process-global state.
export class CompactionState {
  private disposed = false;
  private readonly continuationBySessionId = new Map<string, ContinuationState>();
  private readonly transportContextBySessionId = new Map<string, TransportContextState>();
  private readonly remoteCompactionBySessionId = new Map<string, RemoteCompactionSessionState>();
  private readonly requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();
  private readonly configBySessionId = new Map<string, Required<ExtensionConfig>>();
  private readonly processedMessagesBySessionId = new Map<string, WeakSet<object>>();
  private readonly claimedCompactionBySessionId = new Map<string, string>();

  private assertMutable(): void {
    if (this.disposed) throw new Error("Responses state owner is disposed");
  }

  get entryCount(): number {
    return this.continuationBySessionId.size + this.transportContextBySessionId.size + this.remoteCompactionBySessionId.size +
      this.requestShapeBySessionId.size + this.configBySessionId.size + this.processedMessagesBySessionId.size + this.claimedCompactionBySessionId.size;
  }

  dispose(): void { this.disposed = true; this.clearAllContinuationState(); }

  getContinuationState(sessionId: string): ContinuationState | undefined {
    return this.continuationBySessionId.get(sessionId);
  }

  setContinuationState(sessionId: string, state: ContinuationState): void {
    this.assertMutable();
    this.continuationBySessionId.set(sessionId, state);
  }

  clearContinuationState(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.continuationBySessionId.delete(sessionId);
    this.transportContextBySessionId.delete(sessionId);
  }

  getTransportContextState(sessionId: string): TransportContextState | undefined {
    return this.transportContextBySessionId.get(sessionId);
  }

  setTransportContextState(sessionId: string, state: TransportContextState): void {
    this.assertMutable();
    this.transportContextBySessionId.set(sessionId, state);
  }

  clearTransportContextState(sessionId: string): void {
    this.transportContextBySessionId.delete(sessionId);
  }

  markMessageProcessed(sessionId: string, message: object): boolean {
    this.assertMutable();
    let processed = this.processedMessagesBySessionId.get(sessionId);
    if (!processed) {
      processed = new WeakSet<object>();
      this.processedMessagesBySessionId.set(sessionId, processed);
    }
    if (processed.has(message)) return false;
    processed.add(message);
    return true;
  }

  claimCompactionContinuation(sessionId: string, compactionEntryId: string): boolean {
    this.assertMutable();
    if (this.claimedCompactionBySessionId.get(sessionId) === compactionEntryId) return false;
    this.claimedCompactionBySessionId.set(sessionId, compactionEntryId);
    return true;
  }

  clearSessionDedupState(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.processedMessagesBySessionId.delete(sessionId);
    this.claimedCompactionBySessionId.delete(sessionId);
  }

  getRemoteCompactionState(
    sessionId: string,
  ): RemoteCompactionSessionState | undefined {
    return this.remoteCompactionBySessionId.get(sessionId);
  }

  setRemoteCompactionState(
    sessionId: string,
    state: RemoteCompactionSessionState,
  ): void {
    this.assertMutable();
    this.remoteCompactionBySessionId.set(sessionId, state);
  }

  clearRemoteCompactionState(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.remoteCompactionBySessionId.delete(sessionId);
  }

  getResponsesRequestShapeState(
    sessionId: string,
  ): ResponsesRequestShapeState | undefined {
    return this.requestShapeBySessionId.get(sessionId);
  }

  setResponsesRequestShapeState(
    sessionId: string,
    state: ResponsesRequestShapeState,
  ): void {
    this.assertMutable();
    this.requestShapeBySessionId.set(sessionId, state);
  }

  clearResponsesRequestShapeState(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.requestShapeBySessionId.delete(sessionId);
  }

  clearRequestShapes(): void { this.requestShapeBySessionId.clear(); }

  getSessionConfig(sessionId: string): Required<ExtensionConfig> | undefined {
    return this.configBySessionId.get(sessionId);
  }

  setSessionConfig(sessionId: string, config: Required<ExtensionConfig>): void {
    this.assertMutable();
    this.configBySessionId.set(sessionId, config);
  }

  clearSessionConfig(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.configBySessionId.delete(sessionId);
  }

  clearAllContinuationState(): void {
    this.continuationBySessionId.clear();
    this.transportContextBySessionId.clear();
    this.remoteCompactionBySessionId.clear();
    this.requestShapeBySessionId.clear();
    this.configBySessionId.clear();
    this.processedMessagesBySessionId.clear();
    this.claimedCompactionBySessionId.clear();
  }

  clearLiveContinuations(): void {
    this.continuationBySessionId.clear();
    this.transportContextBySessionId.clear();
  }
}
