import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { streamSimple as streamResponses } from "../packages/ai/src/api/openai-responses.ts";
import type { AssistantMessage, Context, Model } from "../packages/ai/src/types.ts";

const model: Model<"openai-responses"> = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const operation of ["read", "grep", "files", "count"] as const) for (const output of ["show", "text"] as const) for (const budget of [256, 16384])
test(`MXC ${operation} → ${output} → AgentSession → provider payload; budget=${budget}`, { timeout: 20000 }, async t => {
  const f = mxcFileFixture(t), agentDir = path.join(f.root, "agent"); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(f.input, "long"), "x".repeat(40003));
  fs.writeFileSync(path.join(f.input, "large"), "x".repeat(2 * 1024 * 1024) + "needle");
  fs.writeFileSync(path.join(f.input, "match.txt"), "needle needle\nneedle\n");
  const settings = SettingsManager.inMemory({ permissionMode: "read-only", compaction: { enabled: false }, retry: { enabled: false } });
  const resources = new DefaultResourceLoader({ cwd: f.input, agentDir, settingsManager: settings, noExtensions: true,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resources.reload();
  const { session } = await createAgentSession({ cwd: f.input, agentDir, resourceLoader: resources, settingsManager: settings,
    sessionManager: SessionManager.inMemory(f.input), model, toolResultPresentation: { enabled: true, budgetTokens: budget },
    modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
      getModel: () => undefined, getCredentialGeneration: () => 0, getAuth: async () => undefined } as never });
  const owner = (session as any)._workspaceSandbox; assert.ok(owner, "must use the AgentSession MXC owner");
  f.attach(owner, "read-only");
  f.cleanupWith(async () => {
    session.agent.abort(); await session.agent.waitForIdle(); await owner.close();
    await (session as any)._codemode.close();
    await resources.getExtensions().runtime.nativeFiles?.dispose(); await resources.getExtensions().runtime.nativeTasks?.dispose();
    session.dispose(); await (session as any)._sessionLeaseRelease;
    assert.equal(owner.diagnostics.active, 0); assert.equal(owner.diagnostics.queued, 0); assert.equal(owner.diagnostics.root, undefined);
  });
  await session.bindExtensions({});
  const toolName = operation === "read" ? "read" : "grep";
  const args = operation === "read" ? { path: "long", limit: 1 } : operation === "grep" ? { path: "large", pattern: "needle" }
    : { path: ".", pattern: "needle", outputMode: operation };
  // Direct tool details and content must agree before CodeMode projection.
  const ctx = session.extensionRunner.createContext();
  const direct: any = await owner.definition(toolName).execute("direct", args, ctx.signal, undefined, ctx);
  assert.equal(direct.isError, false);
  assert.equal(operation === "read" ? direct.details.read.lineTruncated : direct.details.search.coverageComplete, operation === "read");
  const marker = operation === "read" ? /Read window incomplete/ : /coverageComplete=false/;
  assert.match(direct.content[0].text, marker);
  if (operation === "files" || operation === "count") assert.equal(direct.details.search.outputMode, operation);
  const code = `// @options: {"max_output_tokens":${budget}}\nconst r=await tools.${toolName}(${JSON.stringify(args)});`
    + (output === "show" ? "await show(r.ref);" : "text(r.content); text(r.details);");
  const wires: Context[] = []; let turn = 0;
  session.agent.streamFunction = (_model, context) => {
    wires.push({ ...context, messages: structuredClone(context.messages) });
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: turn,
      content: turn++ === 0 ? [{ type: "toolCall", id: "mxc-script", name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }],
      stopReason: turn === 1 ? "toolUse" : "stop" };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); return stream;
  };
  await session.agent.prompt("run offline fixture");
  assert.equal(wires.length, 2, JSON.stringify(session.agent.state.messages)); const context = wires[1]!;
  const result = context.messages.find(m => m.role === "toolResult")!; assert.ok(result);
  const text = JSON.stringify(result.content);
  if (budget === 16384) assert.match(text, marker);
  else assert.ok(marker.test(text) || /(?:truncated|display.limited|Output:)/i.test(text), text);
  let payload: any;
  const stopped = await streamResponses(model, context, { apiKey: "fixture-key", env: {},
    onPayload(value) { payload = value; throw new Error("MXC request captured before network"); } }).result();
  assert.match(stopped.errorMessage ?? "", /MXC request captured before network/); assert.ok(payload);
  const sent = JSON.stringify(payload.input.filter((item: any) => item.type === "function_call_output" || item.type === "custom_tool_call_output"));
  if (budget === 16384) assert.match(sent, marker);
  else assert.ok(marker.test(sent) || /(?:truncated|display.limited|Output:)/i.test(sent), sent);
  if (budget === 16384 && (operation === "files" || operation === "count")) assert.ok(sent.includes(operation === "files" ? "match.txt" : "match.txt:2"));
  t.diagnostic(JSON.stringify({ budget, operation, output, providerResultBytes: Buffer.byteLength(sent), schemaBytes: Buffer.byteLength(JSON.stringify(payload.tools)), turns: wires.length }));
});
