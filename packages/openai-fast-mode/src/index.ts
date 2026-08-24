import { parseFastCommand, resolveFastEnabled } from "./command.ts";
import { loadFastModeConfig, saveFastModeConfig } from "./config.ts";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.ts";
import { discoverActivePiVersion } from "./runtime-version.ts";
import {
  clearFastRuntimeState,
  publishFastRuntimeState,
  updateFastRuntimeState,
} from "./runtime-state.ts";

const STATUS_KEY = "openai-fast";

interface FastModel {
  provider?: string;
  api?: string;
}

interface FastContext {
  model?: FastModel;
  sessionManager: { getSessionId(): string };
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
  };
}

interface FastExtensionAPI {
  on(event: string, handler: (event: any, ctx: FastContext) => unknown): void;
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: FastContext): Promise<void>;
  }): void;
}

function isOpenAICodexModel(model: FastModel | undefined): boolean {
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function updateFastStatus(ctx: FastContext, enabled: boolean): void {
  ctx.ui.setStatus(STATUS_KEY, enabled && isOpenAICodexModel(ctx.model) ? "FAST" : undefined);
}

export default function openAIFastModeExtension(
  pi: FastExtensionAPI,
  runtimeVersion = discoverActivePiVersion(),
): void {
  if (!runtimeVersion || !SUPPORTED_SP_VERSION_PATTERN.test(runtimeVersion)) {
    console.warn(`@super-pi/openai-fast-mode disabled: Pi ${runtimeVersion ?? "unknown"} is unsupported (requires 0.84.x).`);
    return;
  }

  let enabled = false;
  let configLoadError: string | undefined;
  try {
    enabled = loadFastModeConfig().enabled;
  } catch (error) {
    configLoadError = error instanceof Error ? error.message : "unknown read error";
    console.warn(`@super-pi/openai-fast-mode: ${configLoadError}`);
  }
  const ownedStates = new Map<string, ReturnType<typeof publishFastRuntimeState>>();
  const stateFor = (ctx: FastContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const owned = ownedStates.get(sessionId);
    if (owned) return owned;
    const state = publishFastRuntimeState(sessionId, enabled);
    ownedStates.set(sessionId, state);
    return state;
  };

  pi.on("before_provider_request", (event, ctx) => {
    const runtimeState = stateFor(ctx);
    if (!runtimeState.enabled || !isOpenAICodexModel(ctx.model) || !isRecord(event.payload)) return undefined;
    return { ...event.payload, service_tier: "priority" };
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Codex Fast (Priority) mode; accepts on or off",
    handler: async (args, ctx) => {
      const runtimeState = stateFor(ctx);
      const action = parseFastCommand(args);
      if (action === "invalid") {
        ctx.ui.notify("Usage: /fast [on|off]", "warning");
        return;
      }

      const nextEnabled = resolveFastEnabled(runtimeState.enabled, action);
      try {
        saveFastModeConfig({ enabled: nextEnabled });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown write error";
        ctx.ui.notify(`Could not save Fast mode: ${message}`, "error");
        return;
      }

      updateFastRuntimeState(runtimeState, nextEnabled);
      updateFastStatus(ctx, runtimeState.enabled);
      if (!runtimeState.enabled) {
        ctx.ui.notify("OpenAI Fast mode disabled.", "info");
      } else if (isOpenAICodexModel(ctx.model)) {
        ctx.ui.notify("OpenAI Fast mode enabled (Priority; GPT-5.6 uses 2.5x ChatGPT credits).", "info");
      } else {
        ctx.ui.notify("OpenAI Fast mode enabled; it will apply when an OpenAI Codex model is selected.", "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const runtimeState = stateFor(ctx);
    updateFastStatus(ctx, runtimeState.enabled);
    if (configLoadError) {
      ctx.ui.notify(`${configLoadError} Run /fast on or /fast off to replace it explicitly.`, "warning");
    }
  });
  pi.on("model_select", (event, ctx) => {
    const runtimeState = stateFor(ctx);
    ctx.ui.setStatus(
      STATUS_KEY,
      runtimeState.enabled && isOpenAICodexModel(event.model) ? "FAST" : undefined,
    );
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtimeState = ownedStates.get(sessionId);
    if (runtimeState) {
      clearFastRuntimeState(runtimeState);
      ownedStates.delete(sessionId);
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
