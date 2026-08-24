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
  modelKey: string;
  contextLength: number;
};

const continuationBySessionId = new Map<string, ContinuationState>();
const transportContextBySessionId = new Map<string, TransportContextState>();
const remoteCompactionBySessionId = new Map<string, RemoteCompactionSessionState>();
const requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();
const configBySessionId = new Map<string, Required<ExtensionConfig>>();
const processedMessagesBySessionId = new Map<string, WeakSet<object>>();
const claimedCompactionBySessionId = new Map<string, string>();

export function getContinuationState(sessionId: string): ContinuationState | undefined {
  return continuationBySessionId.get(sessionId);
}

export function setContinuationState(sessionId: string, state: ContinuationState): void {
  continuationBySessionId.set(sessionId, state);
}

export function clearContinuationState(sessionId: string | undefined): void {
  if (!sessionId) return;
  continuationBySessionId.delete(sessionId);
  transportContextBySessionId.delete(sessionId);
}

export function getTransportContextState(sessionId: string): TransportContextState | undefined {
  return transportContextBySessionId.get(sessionId);
}

export function setTransportContextState(sessionId: string, state: TransportContextState): void {
  transportContextBySessionId.set(sessionId, state);
}

export function clearTransportContextState(sessionId: string): void {
  transportContextBySessionId.delete(sessionId);
}

export function markMessageProcessed(sessionId: string, message: object): boolean {
  let processed = processedMessagesBySessionId.get(sessionId);
  if (!processed) {
    processed = new WeakSet<object>();
    processedMessagesBySessionId.set(sessionId, processed);
  }
  if (processed.has(message)) return false;
  processed.add(message);
  return true;
}

export function claimCompactionContinuation(sessionId: string, compactionEntryId: string): boolean {
  if (claimedCompactionBySessionId.get(sessionId) === compactionEntryId) return false;
  claimedCompactionBySessionId.set(sessionId, compactionEntryId);
  return true;
}

export function clearSessionDedupState(sessionId: string | undefined): void {
  if (!sessionId) return;
  processedMessagesBySessionId.delete(sessionId);
  claimedCompactionBySessionId.delete(sessionId);
}

export function getRemoteCompactionState(
  sessionId: string,
): RemoteCompactionSessionState | undefined {
  return remoteCompactionBySessionId.get(sessionId);
}

export function setRemoteCompactionState(
  sessionId: string,
  state: RemoteCompactionSessionState,
): void {
  remoteCompactionBySessionId.set(sessionId, state);
}

export function clearRemoteCompactionState(sessionId: string | undefined): void {
  if (!sessionId) return;
  remoteCompactionBySessionId.delete(sessionId);
}

export function getResponsesRequestShapeState(
  sessionId: string,
): ResponsesRequestShapeState | undefined {
  return requestShapeBySessionId.get(sessionId);
}

export function setResponsesRequestShapeState(
  sessionId: string,
  state: ResponsesRequestShapeState,
): void {
  requestShapeBySessionId.set(sessionId, state);
}

export function clearResponsesRequestShapeState(sessionId: string | undefined): void {
  if (!sessionId) return;
  requestShapeBySessionId.delete(sessionId);
}

export function getSessionConfig(sessionId: string): Required<ExtensionConfig> | undefined {
  return configBySessionId.get(sessionId);
}

export function setSessionConfig(sessionId: string, config: Required<ExtensionConfig>): void {
  configBySessionId.set(sessionId, config);
}

export function clearSessionConfig(sessionId: string | undefined): void {
  if (!sessionId) return;
  configBySessionId.delete(sessionId);
}

export function clearAllContinuationState(): void {
  continuationBySessionId.clear();
  transportContextBySessionId.clear();
  remoteCompactionBySessionId.clear();
  requestShapeBySessionId.clear();
  configBySessionId.clear();
  processedMessagesBySessionId.clear();
  claimedCompactionBySessionId.clear();
}
