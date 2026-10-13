import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
      assert.ok(turn <= 10, "Fixture must not retry or start extra model turns");
      assert.equal(results.length, turn);
      for (const [index, result] of results.entries()) {
        assert.equal(result.toolCallId, `native-source-${index}`);
        assert.equal(result.isError, index === 0 || index === 8, JSON.stringify(result));
      }
      // The read-evidence guard runs inside the native tool. Check the actual
      // file before the next request; it is not an Agent pre-execution failure.
      if (turn === 1) assert.equal(readFileSync("中文.txt", "utf8"), "before\n");
      assert.ok(context.tools.some(tool => tool.name === "codemode"));
      assert.ok(!context.tools.some(tool => ["read", "edit", "write"].includes(tool.name)), "ordinary tools use Codemode transport");
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [], api: model.api, provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      let call;
      const path = "中文.txt";
      const nativeTurn = turn - 1;
      if ([0, 2, 4, 6].includes(nativeTurn)) call = { name: "read", arguments: { path } };
      if (nativeTurn === 1) call = { name: "edit", arguments: { path, edits: [{ oldText: "before", newText: "exact" }] } };
      if (nativeTurn === 3) call = { name: "write", arguments: { path, content: "overwrite\n" } };
      if (nativeTurn === 5) {
        const text = results.at(-1).content.filter(block => block.type === "text").map(block => block.text).join("\n");
        const snapshot = text.match(/snapshot=([^;\s]+)/u)?.[1], start = text.split("\n").find(line => line.startsWith("1#"))?.split("|")[0];
        if (!snapshot || !start) throw new Error("Formal source read did not issue snapshot anchors.");
        call = { name: "edit", arguments: { path, snapshot, edits: [{ kind: "replace", start, newLines: ["snapshot"] }] } };
      }
      let code;
      if (turn === 0) code = 'await tools.edit({path:"中文.txt", edits:[{oldText:"before",newText:"forbidden"}]})';
      if (call) {
        code = `if(typeof __sourceLeak !== "undefined") throw Error("VM global leaked");
          const r = await callTool(${JSON.stringify(call.name)}, ${JSON.stringify(call.arguments)}); await show(r.ref);`;
        if (nativeTurn === 0) code += `
          if(!["read","edit","write"].every(name=>ALL_TOOLS.some(tool=>tool.name===name))) throw Error("Missing tool catalog");
          if(!(await describeTools(["read"])).includes("path")) throw Error("Missing read schema");
          globalThis.__sourceLeak=1; store("sourceProbe", 1);`;
        else code += 'if(load("sourceProbe")!==1) throw Error("Committed store was lost");';
      }
      if (turn === 8) code = 'globalThis.__sourceLeak=2; store("sourceProbe",2); throw Error("SOURCE_EXPECTED_FAILURE")';
      if (turn === 9) code = 'if(typeof __sourceLeak!=="undefined" || load("sourceProbe")!==1) throw Error("Failed script state leaked"); return "SOURCE_CODEMODE_RECOVERED"';
      if (code) { message.content.push({ type: "toolCall", id: `native-source-${turn}`, name: "codemode",
        arguments: { code } }); message.stopReason = "toolUse"; }
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
