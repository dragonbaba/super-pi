import { AssistantMessageEventStream } from "../../packages/ai/dist/utils/event-stream.js";

// Offline provider only; all tools, permissions, receipts and filesystem work
// come from the formal source launcher's default bundled resources.
export default function (pi) {
  const provider = "native-source-fixture";
  let turn = 0;
  pi.registerProvider(provider, {
    baseUrl: "https://fixture.invalid", apiKey: "offline-fixture", api: "openai-responses",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const results = context.messages.filter(message => message.role === "toolResult");
      if (results.some(result => result.isError)) throw new Error(`Source-entry tool failed: ${JSON.stringify(results.at(-1))}`);
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [], api: model.api, provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      let call;
      const path = "中文.txt";
      if ([0, 2, 4, 6].includes(turn)) call = { name: "read", arguments: { path } };
      if (turn === 1) call = { name: "edit", arguments: { path, edits: [{ oldText: "before", newText: "exact" }] } };
      if (turn === 3) call = { name: "write", arguments: { path, content: "overwrite\n" } };
      if (turn === 5) {
        const text = results.at(-1).content.filter(block => block.type === "text").map(block => block.text).join("\n");
        const snapshot = text.match(/snapshot=([^;\s]+)/u)?.[1], start = text.split("\n").find(line => line.startsWith("1#"))?.split("|")[0];
        if (!snapshot || !start) throw new Error("Formal source read did not issue snapshot anchors.");
        call = { name: "edit", arguments: { path, snapshot, edits: [{ kind: "replace", start, newLines: ["snapshot"] }] } };
      }
      if (call) { message.content.push({ type: "toolCall", id: `native-source-${turn}`, ...call }); message.stopReason = "toolUse"; }
      else message.content.push({ type: "text", text: "NATIVE_SOURCE_COMPLETE" });
      turn++;
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find(provider, "fixture");
    if (!model || !await pi.setModel(model)) throw new Error("Source fixture model unavailable.");
    pi.setActiveTools(["read", "edit", "write"]);
  });
}
