// Offline review probes. Reports current behavior; this is not a regression test suite.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { BoundedJson } from "../../packages/codemode/src/bounded-json.ts";
import { CodemodeStore } from "../../packages/coding-agent/src/core/codemode-store.ts";
import { CodemodeController } from "../../packages/coding-agent/src/core/codemode.ts";
import { FileAuthStorageBackend } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { McpOAuth } from "../../packages/mcp-bridge/src/oauth.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";

const root = mkdtempSync(join(tmpdir(), "sp-codemode-review-"));
const report = { node: process.version, root, probes: {} };
const jiti = createJiti(import.meta.url);
const { default: guard } = await jiti.import("../../packages/extensions/tool-loop-guardrails/index.ts");
const MODEL = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let sequence = 0;
async function probe(name, body) {
  try { report.probes[name] = await body(); }
  catch (error) { report.probes[name] = { probeError: error.stack }; process.exitCode = 1; }
  console.log(JSON.stringify({ name, result: report.probes[name] }));
}
async function fixture(kind, evidence = false) {
  const cwd = join(root, `work-${++sequence}`), agentDir = join(root, `agent-${sequence}`);
  mkdirSync(cwd); mkdirSync(agentDir); writeFileSync(join(cwd, "file.txt"), "hello\nworld\n");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, evidenceLedger: { enabled: evidence },
    ...(kind === "bundle" ? { packages: [resolve("packages/extensions")] } : {}) });
  const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: kind !== "bundle",
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: kind === "guard" ? [guard] : [] });
  await resources.reload();
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd),
    toolResultPresentation: evidence ? { enabled: true, budgetTokens: 2048 } : undefined, model: MODEL,
    modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } });
  await session.bindExtensions({});
  let id = 0;
  return { session, resources, async run(scripts, native = false) {
    const wires = []; let index = 0;
    session.agent.streamFunction = (_model, context) => {
      wires.push(context); const code = scripts[index++];
      const message = { role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE,
        content: code === undefined ? [{ type: "text", text: "done" }] : [{ type: "toolCall", id: `script-${++id}`, name: native ? "read" : "codemode", arguments: native ? { path: "file.txt" } : { code } }],
        stopReason: code === undefined ? "stop" : "toolUse", timestamp: id };
      const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
    };
    await session.agent.prompt("offline review");
    return { wires, results: session.agent.state.messages.filter(m => m.role === "toolResult") };
  }, async close() { session.agent.abort(); await session.agent.waitForIdle(); session.dispose(); } };
}
try {
  await probe("boundedJsonAndStore", async () => {
    const value = Array(20000).fill(0), actualChars = JSON.stringify(value).length;
    let serializerError, applyError, restoreError;
    try { new BoundedJson().stringify(value, 256 * 1024); } catch (error) { serializerError = error.message; }
    const store = new CodemodeStore(); store.restore({ previous: 7 });
    try { store.apply({ set: { numbers: value }, delete: [] }); } catch (error) { applyError = error.message; }
    const previousAfterApply = store.snapshot.previous;
    try { store.restore({ previous: 7, numbers: value }); } catch (error) { restoreError = error.message; }
    return { actualChars, cap: 256 * 1024, serializerError, applyError, previousAfterApply, restoreError, keysAfterRestore: Object.keys(store.snapshot) };
  });
  for (const kind of ["none", "guard", "bundle"]) await probe(`session-${kind}`, async () => {
    const f = await fixture(kind);
    try {
      const { wires, results } = await f.run(['await tools.read({path:"file.txt"});await tools.read({path:"file.txt"})']);
      const prompt = wires[0].systemPrompt;
      const available = prompt.slice(prompt.indexOf("Available tools"), prompt.indexOf("Available tools") + 1300);
      const extensions = f.resources.getExtensions();
      return { modelTools: wires[0].tools.map(t => t.name), available, extensionCount: extensions.extensions.length,
        extensionPaths: extensions.extensions.map(e => e.path), extensionErrors: extensions.errors,
        failed: results[0]?.isError, result: results[0]?.content };
    } finally { await f.close(); }
  });
  await probe("exitAndVmStore", async () => {
    const f = await fixture("none");
    try {
      const { results } = await f.run(['text("before");exit();text("after")', 'store("previous",7)', 'store("numbers",Array(20000).fill(0))', 'text(load("previous"));text(load("numbers")===undefined)']);
      return results.map(r => ({ failed: r.isError, content: r.content }));
    } finally { await f.close(); }
  });
  await probe("postMutationSerialization", async () => {
    let sideEffects = 0, savedCalls = 0, savedResults = 0;
    const controller = new CodemodeController(() => {}, () => { savedCalls++; }, () => { savedResults++; });
    const parentToolCallId = "probe-mutation", args = { path: "fixture.txt", content: "fixture" };
    controller.setTools([{ name: "write", description: "offline mutation stand-in", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async () => {} }]);
    const context = { parentToolCallId, async callTool(name, input) {
      controller.recordInvocation(parentToolCallId, "child-1", name, input);
      sideEffects++;
      return { role: "toolResult", toolCallId: "child-1", toolName: name, isError: false, timestamp: 0, content: [], details: { payload: "x".repeat(1024 * 1024 + 1) } };
    }, async finish() { return false; } };
    try {
      const result = await controller.definition.execute(parentToolCallId, { code: `await tools.write(${JSON.stringify(args)})` }, undefined, undefined, undefined, context);
      return { sideEffects, savedCalls, savedResults, failed: result.isError, content: result.content, facts: result.details.codemode.calls };
    } finally { await controller.close(); }
  });
  for (const native of [false, true]) await probe(`evidence-${native ? "native-control" : "codemode"}`, async () => {
    const f = await fixture("none", true);
    try {
      if (native) { for (const tool of f.session.agent.state.tools) tool.modelExposure = undefined; f.session.agent.state.tools = f.session.agent.state.tools; }
      const { results } = await f.run(['const r=await tools.read({path:"file.txt"});await show(r.ref)', 'const r=await tools.read({path:"file.txt"});await show(r.ref)'], native);
      return { platform: process.platform, interpretation: process.platform === "win32" ? "Native and Codemode both use the existing Windows uncertain-identity fallback; this probe cannot measure a Codemode cache regression." : "Compare native-control and Codemode counters.",
        failed: results.map(r => r.isError), counters: { ...f.session._evidenceLedger?.counters }, pendingReceipts: f.session._evidenceCompletedReads?.size };
    } finally { await f.close(); }
  });
  await probe("oauthInteractiveLock", async () => {
    const path = join(root, "fixture-auth.json");
    const config = { id: "offline", source: "fixture", url: "https://fixture.invalid/mcp", oauth: {} };
    const owner = new McpOAuth(config, new FileAuthStorageBackend(path), async () => { throw new Error("No network allowed"); });
    let entered, release; const ready = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
    owner.authorize = async () => { entered(); await gate; return "offline"; };
    const login = owner.login(() => {}); const settled = login.then(() => "completed", error => error.message);
    try {
      await ready;
      const began = performance.now(); let readError;
      try { new McpOAuth(config, new FileAuthStorageBackend(path)).read(); } catch (error) { readError = error.code; }
      const blockedMs = performance.now() - began;
      await delay(11500);
      let secondRead, secondError;
      try { new McpOAuth(config, new FileAuthStorageBackend(path)).read(); secondRead = "succeeded while login still pending"; } catch (error) { secondError = error.code; }
      let concurrentEntryBeforeCommit;
      const other = new McpOAuth({ ...config, id: "other-fixture" }, new FileAuthStorageBackend(path));
      if (secondRead) {
        await other.transact(async entry => { entry.reviewMarker = "concurrent-write"; });
        concurrentEntryBeforeCommit = JSON.parse(readFileSync(path, "utf8"))[other.key]?.reviewMarker;
      }
      release(); const loginOutcome = await settled;
      const concurrentEntryRetained = JSON.parse(readFileSync(path, "utf8"))[other.key]?.reviewMarker === "concurrent-write";
      return { readError, blockedMs, secondRead, secondError, loginOutcome, concurrentEntryBeforeCommit, concurrentEntryRetained };
    } finally { release(); await settled; }
  });
} finally {
  // Only the unique directory created above is owned by this probe.
  rmSync(root, { recursive: true, force: true });
  report.cleaned = !existsSync(root);
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + "\n");
}
