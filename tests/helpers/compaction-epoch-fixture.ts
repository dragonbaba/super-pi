import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { ALPHA_MODEL, alphaSession } from "./alpha-session.ts";

export const EPOCH_MODEL = { ...ALPHA_MODEL, contextWindow: 500000, maxTokens: 128000 };

export function epochAssistant(tokens: number, timestamp = 1): AssistantMessage {
  return { role: "assistant", api: EPOCH_MODEL.api, provider: EPOCH_MODEL.provider, model: EPOCH_MODEL.id,
    timestamp, stopReason: "stop", content: [{ type: "text", text: "historical text ".repeat(128) }],
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export async function compactionEpochFixture(options: Parameters<typeof alphaSession>[0] = {}) {
  const f = await alphaSession({ g2: false, codemode: true, ...options,
    settings: { compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 128 },
      retry: { enabled: false }, ...options.settings } });
  f.session.agent.state.model = EPOCH_MODEL;
  f.sessionManager.appendMessage({ role: "user", content: "earlier task", timestamp: 0 });
  const retained = epochAssistant(490965);
  const kept = f.sessionManager.appendMessage(retained);
  f.sessionManager.appendCompaction("previous checkpoint", kept, 490965, {
    contextAccounting: { schemaVersion: 1, owner: { provider: EPOCH_MODEL.provider, model: EPOCH_MODEL.id },
      providerUsageState: "unverified", estimateSource: "materialized", materializedTokensAfter: 19708,
      contextWindow: 500000, thresholdTokens: 483616, reason: "manual" },
  }, true, undefined, [retained]);
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  return f;
}
