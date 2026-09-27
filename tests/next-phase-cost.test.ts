import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getEncoding } from "js-tiktoken";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { alphaModelRuntime, ALPHA_MODEL } from "./helpers/alpha-session.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";

test("next phase: three strategies capture actual offline provider request bodies including discovery", { timeout: 120000 }, async t => {
  const encoding = getEncoding("o200k_base");
  for (const count of [1, 4, 16]) for (const strategy of ["T1", "T2", "T3"] as const) {
    const root = mkdtempSync(join(tmpdir(), "sp-next-cost-"));
    const cwd = join(root, "work"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true,
      noSkills: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [resolve("packages/extensions"), resolve("packages/tool-classification/src/index.ts")] });
    await resourceLoader.reload();
    const model: any = { ...ALPHA_MODEL, api: "openai-completions", compat: { maxTokensField: "max_tokens" } };
    const operations = Array.from({ length: count }, (_, i) => ({ operation: "write", mode: "create", path: `files/${i}.txt`, content: `内容 ${i}\r\n` }));
    const calls = operations.map((op, i) => ({ id: `write-${i}`, type: "function", function: { name: "write", arguments: JSON.stringify({ path: op.path, content: op.content }) } }));
    const turns = strategy === "T1" ? calls.map(call => [call]) : strategy === "T2" ? [calls] : [
      [{ id: "discover", type: "function", function: { name: "tool_search", arguments: JSON.stringify({ query: "file_batch", limit: 1 }) } }],
      [{ id: "batch", type: "function", function: { name: "file_batch", arguments: JSON.stringify({ operations }) } }],
    ];
    let requests = 0, inputTokens = 0, outputTokens = 0, schemaTokens = 0, approvals = 0, wireBytes = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      assert.equal(typeof init?.body, "string");
      const body = init!.body as string, payload = JSON.parse(body);
      inputTokens += encoding.encode(body).length; wireBytes += Buffer.byteLength(body);
      schemaTokens += encoding.encode(JSON.stringify(payload.tools)).length;
      const toolCalls = turns[requests++];
      if (strategy === "T3" && requests === 2) assert.ok(payload.tools.some((tool: any) => tool.function.name === "file_batch"));
      const delta = toolCalls ? { tool_calls: toolCalls.map((call, index) => ({ ...call, index })) } : { content: "Completed requested files." };
      outputTokens += encoding.encode(JSON.stringify(delta)).length;
      const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: null }] };
      const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }] };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    };
    const runtime = alphaModelRuntime((m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "offline-fixture", fetch: fakeFetch, maxRetries: 0 }));
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, model, modelRuntime: runtime, noTools: "builtin" });
    try {
      await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), select: async () => { approvals++; return "仅允许本次"; } } });
      const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = performance.now();
      await session.prompt("Create the specified synthetic UTF-8 text files.");
      await session.agent.waitForIdle();
      const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
      for (const op of operations) assert.equal(readFileSync(join(cwd, op.path), "utf8"), op.content);
      const results = session.messages.filter((m: any) => m.role === "toolResult");
      for (const result of results) assert.equal((result as any).isError, false, JSON.stringify(result));
      assert.equal(requests, turns.length + 1);
      assert.equal(session.agent.state.pendingToolCalls.size, 0);
      t.diagnostic(JSON.stringify({ count, strategy, requests, toolCalls: results.length, approvals, wireBytes,
        estimator: "o200k_base", actualSerializer: true, actualBilling: false, usage: null, cacheHits: null,
        inputTokens, outputTokens, schemaTokens, discoveryCalls: strategy === "T3" ? 1 : 0,
        retries: 0, supplementalReads: 0, elapsedMs, cpuUs: used.user + used.system,
        heapDelta: process.memoryUsage().heapUsed - heapBefore }));
    } finally { session.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); rmSync(root, { recursive: true, force: true }); }
  }
});
