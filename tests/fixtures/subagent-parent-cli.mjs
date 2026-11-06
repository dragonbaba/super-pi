// Real production CLI, with an offline provider and a task-owned configuration only.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
register({ tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)) });
const fixture = JSON.parse(readFileSync(join(process.cwd(), "child-request.json"), "utf8"));
assert.equal(realpathSync.native(tmpdir()), realpathSync.native(fixture.temp));
for (const key of ["TMP", "TEMP", "TMPDIR"]) assert.equal(realpathSync.native(process.env[key]), realpathSync.native(fixture.temp));
const report = value => appendFileSync(join(process.cwd(), "child-observation.jsonl"), JSON.stringify(value) + "\n");
report({ event: "start", pid: process.pid, temp: tmpdir() });
const { AssistantMessageEventStream } = await import("../../packages/ai/src/utils/event-stream.ts");
const { SubagentParentClient } = await import("../../packages/coding-agent/src/core/files/subagent-execution.ts");
const initialize = SubagentParentClient.prototype.initialize;
SubagentParentClient.prototype.initialize = async function () { await initialize.call(this); report({ event: "profile", profile: this.profile }); };
const { DefaultResourceLoader } = await import("../../packages/coding-agent/src/core/resource-loader.ts");
const createRuntime = DefaultResourceLoader.prototype.createSessionRuntime;
DefaultResourceLoader.prototype.createSessionRuntime = function () {
  const runtime = createRuntime.call(this);
  report({ event: "runtime", parent: !!runtime.parentExecution, files: !!runtime.nativeFiles, tasks: !!runtime.nativeTasks, permissions: !!runtime.nativePermissions });
  return runtime;
};
const { main } = await import("../../packages/coding-agent/src/main.ts");
function provider(pi) {
  let requests = 0;
  pi.registerProvider("delegated-fixture", { baseUrl: "https://fixture.invalid", apiKey: "offline-fixture", api: "openai-responses",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      report({ event: "request", number: ++requests });
      if (requests > 2) throw new Error("Unexpected additional fixture provider request");
      const content = requests === 1 ? [{ type: "toolCall", id: "child-code", name: "codemode", arguments: { code: fixture.code } }]
        : [{ type: "text", text: "Child fixture complete" }];
      const stopReason = requests === 1 ? "toolUse" : "stop";
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
      const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: stopReason, message }); return stream;
    } });
  pi.on("tool_result", event => { report({ event: "result", name: event.toolName, content: event.content, isError: event.isError }); });
}
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--provider") args[++index] = "delegated-fixture";
  else if (args[index] === "--model") args[++index] = "fixture";
}
await main([...args, "--offline"], { extensionFactories: [provider] });
report({ event: "exit", code: process.exitCode ?? 0 });
