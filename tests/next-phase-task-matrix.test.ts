import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { getEncoding } from "js-tiktoken";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/next-phase-model.ts";
import { FIXTURE_SNAPSHOT_ID_PATTERN, FIXTURE_SECOND_LINE_ANCHOR_PATTERN } from "./helpers/next-phase-fixture-regex.ts";

// The same harness can run an untouched parent checkout for interleaved comparisons.
// Only application module paths change; task data, scheduling and counters do not.
const project = resolve(process.env.SP_COST_PROJECT_ROOT ?? ".");
const { createAgentSession } = await import(pathToFileURL(join(project, "packages/coding-agent/src/core/sdk.ts")).href);
const { DefaultResourceLoader } = await import(pathToFileURL(join(project, "packages/coding-agent/src/core/resource-loader.ts")).href);
const { SettingsManager } = await import(pathToFileURL(join(project, "packages/coding-agent/src/core/settings-manager.ts")).href);
const { SessionManager } = await import(pathToFileURL(join(project, "packages/coding-agent/src/core/session-manager.ts")).href);
const { streamSimple } = await import(pathToFileURL(join(project, "packages/ai/dist/api/openai-completions.js")).href);
const { estimateToolOutputTokens } = await import(pathToFileURL(join(project, "packages/coding-agent/src/core/tool-output-budget.ts")).href);
const encoding = process.env.SP_COST_TOKENIZER === "o200k_base" ? getEncoding("o200k_base") : undefined;
const estimator = encoding ? "o200k_base" : "super-pi.conservative-v1";
function tokens(text: string): number { return encoding ? encoding.encode(text).length : estimateToolOutputTokens([{ type: "text", text }]).estimatedTokens; }
type Strategy = "T1" | "T2" | "T3";
type Kind = "create" | "exact" | "snapshot" | "mixed";

function call(id: string, name: string, args: any) { return { id, type: "function", function: { name, arguments: JSON.stringify(args) } }; }
function contents(index: number): string {
  const eol = index % 2 ? "\r\n" : "\n";
  return (index % 3 === 0 ? "\ufeff" : "") + `FIRST-${index}${eol}SECOND-${index}${eol}` + (index % 4 === 3 ? "long-single-line=" + "x".repeat(8192) : "English 中文 data") + eol;
}

async function measure(t: test.TestContext, strategy: Strategy, count: number, kind: Kind) {
  const root = mkdtempSync(join(tmpdir(), "sp-n4-matrix-")), cwd = join(root, "work"), agentDir = join(root, "agent");
  let session: any;
  try {
  process.stdout.write(`# owned matrix fixture ${JSON.stringify({ root, strategy, count, kind })}\n`);
  mkdirSync(cwd); mkdirSync(agentDir);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true,
    noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [join(project, "packages/extensions"), join(project, "packages/tool-classification/src/index.ts")] });
  await resourceLoader.reload();
  const model = { ...ALPHA_MODEL, api: "openai-completions", compat: { maxTokensField: "max_tokens" } };
  // The existing mutation budget counts both move paths. A 16-path successful
  // mixed task therefore has 12 operations, including four moves; do not relax it.
  const operationCount = kind === "mixed" ? count === 16 ? 12 : count === 4 ? 3 : 1 : count;
  const files = Array.from({ length: operationCount }, (_, index) => {
    const before = contents(index), path = `file-${index}.txt`;
    const operation = kind === "create" ? "write" : kind === "mixed" ? ["write", "delete", "move"][index % 3] : "edit";
    if (operation !== "write") writeFileSync(join(cwd, path), before);
    return { path, before, operation, after: kind === "exact" ? before.replace(`FIRST-${index}`, `CHANGED-${index}`).replace(`SECOND-${index}`, `二次-${index}`)
      : kind === "snapshot" ? before.replace(`SECOND-${index}`, `SNAPSHOT-${index}`) : before, destination: `moved-${index}.txt` };
  });
  const queue: any[][] = [];
  const discovered: string[] = strategy === "T3" ? ["file_batch"] : kind === "mixed" && count > 1 ? ["delete", "move"] : [];
  if (discovered.length) queue.push(discovered.map((name, index) => call(`discover-${index}`, "tool_search", { query: name, limit: name === "move" ? 3 : 1 })));
  const reads = files.filter(file => file.operation !== "write").map((file, index) => call(`read-${index}`, "read", { path: file.path }));
  if (strategy === "T1") for (const read of reads) queue.push([read]);
  else if (reads.length) queue.push(reads);
  let mutationsPlanned = false, requests = 0, approvals = 0, schemaTokens = 0, inputTokens = 0, toolTokens = 0, historyTokens = 0, outputTokens = 0, wireBytes = 0;
  let peakHeap = process.memoryUsage().heapUsed;
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.equal(typeof init?.body, "string");
    const wire = init!.body as string, payload = JSON.parse(wire); requests++;
    inputTokens += tokens(wire); wireBytes += Buffer.byteLength(wire);
    schemaTokens += tokens(JSON.stringify(payload.tools));
    for (const message of payload.messages) {
      const estimate = tokens(JSON.stringify(message));
      if (message.role === "tool") toolTokens += estimate; else historyTokens += estimate;
    }
    if (!queue.length && !mutationsPlanned) {
      mutationsPlanned = true;
      const operations = files.map((file, index) => {
        if (file.operation === "write") return { operation: "write", mode: "create", path: file.path, content: file.after };
        if (file.operation === "delete") return { operation: "delete", path: file.path };
        if (file.operation === "move") return { operation: "move", path: file.path, destination: file.destination };
        if (kind === "exact") return { operation: "edit", path: file.path, edits: [{ oldText: `FIRST-${index}`, newText: `CHANGED-${index}` }, { oldText: `SECOND-${index}`, newText: `二次-${index}` }] };
        const read = session.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === `read-${index}`);
        assert.ok(read && !read.isError, JSON.stringify(read));
        const body = read.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
        const snapshot = FIXTURE_SNAPSHOT_ID_PATTERN.exec(body)?.[1], anchor = FIXTURE_SECOND_LINE_ANCHOR_PATTERN.exec(body)?.[0];
        assert.ok(snapshot && anchor, body.slice(0, 500));
        return { operation: "edit", path: file.path, snapshot, edits: [{ kind: "replace", start: anchor, newLines: [`SNAPSHOT-${index}`] }] };
      });
      if (strategy === "T3") queue.push([call("batch", "file_batch", { operations })]);
      else {
        const calls = operations.map(({ operation, mode: _mode, ...input }: any, index) => call(`mutation-${index}`, operation, input));
        if (strategy === "T1") for (const item of calls) queue.push([item]); else queue.push(calls);
      }
    }
    const calls = queue.shift();
    if (calls) for (const item of calls) assert.ok(payload.tools.some((tool: any) => tool.function.name === item.function.name), `actual discovery must expose ${item.function.name}`);
    const delta = calls ? { tool_calls: calls.map((item, index) => ({ ...item, index })) } : { content: "Task results recorded." };
    outputTokens += tokens(JSON.stringify(delta));
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const runtime = alphaModelRuntime((m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "offline-fixture", fetch: fakeFetch, maxRetries: 0 }));
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  ({ session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader, sessionManager: manager, model, modelRuntime: runtime, noTools: "builtin" }));
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), select: async () => { approvals++; return "仅允许本次"; } } });
    global.gc?.(); const heapBefore = process.memoryUsage().heapUsed; peakHeap = heapBefore;
    const cpu = process.cpuUsage(), start = performance.now();
    await session.prompt("Perform the deterministic fixture task using its recorded operations."); await session.agent.waitForIdle();
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    const results = session.messages.filter((message: any) => message.role === "toolResult");
    for (const message of session.messages) if (message.role === "assistant") assert.notEqual(message.stopReason, "error", JSON.stringify({ strategy, count, kind, error: message.errorMessage, discovery: results.filter((item: any) => item.toolName === "tool_search") }));
    for (const result of results) assert.equal(result.isError, false, JSON.stringify({ strategy, count, kind, result }));
    for (const file of files) {
      if (file.operation === "delete") assert.equal(existsSync(join(cwd, file.path)), false);
      else if (file.operation === "move") { assert.equal(existsSync(join(cwd, file.path)), false); assert.equal(readFileSync(join(cwd, file.destination), "utf8"), file.before); }
      else assert.equal(readFileSync(join(cwd, file.path), "utf8"), file.after);
    }
    assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal(session.extensionRunner.finalAuthorizations?.size ?? 0, 0);
    session.dispose(); global.gc?.();
    t.diagnostic(JSON.stringify({ matrix: "N4-success", implementation: process.env.SP_COST_LABEL ?? "candidate", count, kind, strategy,
      fileOperations: files.length, addressedPaths: files.length + files.filter(file => file.operation === "move").length,
      requests, toolCalls: results.length, approvals, discoveryCalls: discovered.length, priorReads: reads.length, supplementalReads: 0, retries: 0, compactions: 0,
      actualSerializer: true, estimator, inputTokens, schemaTokens, toolTokens, historyTokens, outputTokens, wireBytes,
      providerUsage: null, cacheHits: null, actualCost: null, quality: "all filesystem assertions passed", elapsedMs, cpuUs: used.user + used.system,
      heapBefore, sampledPeakHeap: peakHeap, heapAfterDispose: process.memoryUsage().heapUsed, pendingCalls: 0 }));
  } finally { session?.dispose(); session = undefined; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
}

test("N4 actual serializer task matrix: equal data, real prior reads/discovery, independent same-reply T2", { timeout: 1800000 }, async t => {
  for (const kind of ["create", "exact", "snapshot", "mixed"] as const) for (const count of [1, 4, 16]) for (const strategy of ["T1", "T2", "T3"] as const) {
    t.signal.throwIfAborted(); await measure(t, strategy, count, kind);
  }
});
