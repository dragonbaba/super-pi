import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { AssistantMessageEventStream } = await import(pathToFileURL(join(process.env.N4_PTY_PROJECT, "packages/ai/dist/utils/event-stream.js")).href);

export default function ptyProvider(pi) {
  let requests = 0, executions = 0;
  pi.registerProvider("n4-pty-fixture", { baseUrl: "https://fixture.invalid", apiKey: "offline-fixture", api: "openai-responses",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      const stream = new AssistantMessageEventStream(), first = requests++ === 0;
      const message = { role: "assistant", content: first ? [{ type: "toolCall", id: "pty-read", name: "codemode", arguments: { code: 'const r=await tools.read({path:"ready.txt"}); await show(r.ref)' } }] : [{ type: "text", text: "N4_PTY_TOOL_EXECUTED" }],
        api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
      stream.push({ type: "done", reason: message.stopReason, message }); return stream;
    } });
  pi.on("session_start", async function started(_event, ctx) {
    const model = ctx.modelRegistry.find("n4-pty-fixture", "fixture");
    if (!model || !await pi.setModel(model)) throw new Error("PTY fixture model unavailable.");
  });
  pi.on("tool_result", function completed(event) {
    if (event.toolCallId !== "pty-read:nested:1") return;
    let found = false;
    for (const block of event.content) if (block.type === "text" && block.text.includes("N4_PTY_ACTUAL_READ_中文")) found = true;
    if (event.isError || !found) throw new Error("Actual default read did not return the fixture bytes.");
    executions++;
    appendFileSync(process.env.N4_PTY_REPORT, JSON.stringify({ phase: "tool-ready", timestamp: Date.now(), processMs: performance.now(), requests, executions, cpu: process.cpuUsage(), heap: process.memoryUsage().heapUsed }) + "\n");
    process.stderr.write("N4_PTY_TOOL_READY\n");
  });
  pi.on("session_shutdown", function stopped() { appendFileSync(process.env.N4_PTY_REPORT, JSON.stringify({ phase: "session-shutdown", timestamp: Date.now(), requests, executions }) + "\n"); });
}
