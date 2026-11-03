/**
 * Explicit host-runtime dispatch entrypoint.
 *
 * Chooses between Pi's normal HTTP Responses streaming path and this package's
 * custom WebSocket-backed continuation path for direct OpenAI Responses models.
 */
import { createOpenAIWebSocketStreamOwner } from "./openai-ws-stream.ts";
import type { OpenAIWebSocketManagerOptions } from "./openai-ws-connection.ts";
import { CompactionState } from "./state.ts";

/** One state/connection/queue owner per extension runtime, never a module singleton. */
export function createOpenAIResponsesOwner(options?: OpenAIWebSocketManagerOptions) {
  return createOpenAIWebSocketStreamOwner(new CompactionState(), options);
}
