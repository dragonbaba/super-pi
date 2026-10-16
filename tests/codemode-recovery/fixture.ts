import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "../../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { alphaSession, ALPHA_MODEL } from "../helpers/alpha-session.ts";

export const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function assistant(ids: string[], reportedTokens = 0, timestamp = 1): AssistantMessage {
  return { role: "assistant", api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id,
    timestamp, usage: { ...usage, input: reportedTokens, totalTokens: reportedTokens }, stopReason: "toolUse",
    content: ids.map(id => ({ type: "toolCall", id, name: "codemode", arguments: { code: 'text("fixture")' } })) };
}

export function toolResult(id: string, content: ToolResultMessage["content"], timestamp = 2): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "codemode", content, isError: false, timestamp };
}

export function body(content: readonly { type: string; text?: string }[]): string {
  return content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

export const longText = Array.from({ length: 400 }, (_, i) => `ROW_${String(i + 1).padStart(3, "0")} ${"text ".repeat(6)}\n`).join("");

export async function sessionFixture(t: TestContext, options: Parameters<typeof alphaSession>[0] = {}) {
  // This fixture never delegates to a real provider, even if a test accidentally changes its stream.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("R0 fixtures must not access the network"); });
  const f = await alphaSession({ ...options, codemode: true,
    settings: { compaction: { enabled: false }, retry: { enabled: false }, ...options.settings } });
  t.after(() => f.release());
  let sequence = 0;
  async function run(code: string | readonly string[]) {
    const start = f.session.messages.length;
    const requests: Message[][] = [];
    const scripts = typeof code === "string" ? [code] : code;
    let sent = 0;
    f.session.agent.streamFunction = (_model, context) => {
      requests.push(context.messages.slice());
      const message = assistant([`r0-${++sequence}`], 0, Date.now());
      const next = scripts[sent++];
      message.content = next === undefined ? [{ type: "text", text: "fixture complete" }]
        : [{ type: "toolCall", id: `r0-${sequence}`, name: "codemode", arguments: { code: next } }];
      message.stopReason = next === undefined ? "stop" : "toolUse";
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    };
    await f.session.prompt("Run the isolated regression fixture.");
    const results = f.session.messages.slice(start).filter(m => m.role === "toolResult") as ToolResultMessage[];
    const result = results[0];
    assert.ok(result, "the real dispatcher must produce a canonical parent result");
    return { result, results, requests };
  }
  return { ...f, run };
}
