/**
 * Provider override entrypoint.
 *
 * Chooses between Pi's normal HTTP Responses streaming path and this package's
 * custom WebSocket-backed continuation path for direct OpenAI Responses models.
 */
import type {
  SimpleStreamOptions,
  Context,
  Model,
  StreamFunction,
} from "@super-pi/ai";
import { streamSimpleOpenAIResponses } from "@super-pi/ai/compat";
import { createOpenAIWebSocketStreamFn } from "./openai-ws-stream.ts";
import { loadConfig } from "./config.ts";
import { getSessionConfig } from "./state.ts";
import { isDirectOpenAIResponsesModel } from "./openai.ts";

const websocketStream = createOpenAIWebSocketStreamFn();

export const streamOpenAIResponsesWithPhase2B: StreamFunction = (
  model,
  context,
  options,
) => {
  // Provider registration is process-wide and the stream API has no project
  // context. Delegate transparently unless session_start captured an enabled,
  // trusted ctx.cwd config (global/env-only fallback for sessionless calls).
  const cfg = options?.sessionId
    ? getSessionConfig(options.sessionId) ?? loadConfig()
    : loadConfig();
  if (!cfg.enabled || !isDirectOpenAIResponsesModel(model)) {
    return streamSimpleOpenAIResponses(
      model as Model<"openai-responses">,
      context as Context,
      options as SimpleStreamOptions | undefined,
    );
  }
  return websocketStream(model, context, options);
};
