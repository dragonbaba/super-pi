import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { CODEMODE_DESCRIPTION } from "../../packages/coding-agent/src/core/codemode-constants.ts";
import toolClassification from "../../packages/tool-classification/src/index.ts";
import { createJiti } from "jiti";

const chromeSelector = process.argv.includes("--chrome-selection")
  ? await createJiti(import.meta.url).import<typeof import("../../packages/chrome-devtools/src/tool-selector.ts")>("../../packages/chrome-devtools/src/tool-selector.ts") : undefined;

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
const root = mkdtempSync(join(tmpdir(), "sp-codemode-session-bench-"));
if (process.argv.includes("--registration-plan")) console.error(`ownedFixture=${root}`);
writeFileSync(join(root, "read.txt"), "evidence\n".repeat(200));
const model: any = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const refs: WeakRef<object>[] = [], startupMs: number[] = [], firstMs: number[] = [], warmMs: number[] = [];
let workersStarted = 0, workersStopped = 0, childCalls = 0, progress = 0, ledgerPending = 0;
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const browserRouting = process.argv.includes("--browser-routing");
let registrationApi: any;
let loader: DefaultResourceLoader | undefined = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true,
  noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: browserRouting ? [toolClassification]
    : process.argv.includes("--registration-plan") ? [value => { registrationApi = value; }] : undefined });
await loader.reload();
async function cycle() {
  const start = performance.now();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root),
    tools: ["read"], model, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
      getModel: () => undefined, getAuth: async () => undefined } as never });
  startupMs.push(performance.now() - start);
  const owner = (session as any)._codemode;
  assert.equal(owner.sandbox, undefined, "default startup creates no sandbox/Worker");
  const initialDescriptors = owner.descriptors;
  owner.setTools(owner.tools);
  assert.equal(owner.descriptors, initialDescriptors, "unchanged catalog reuses descriptor identity");
  let request = 0;
  session.agent.streamFunction = () => {
    const code = request++ === 0 ? 'for(let i=0;i<10;i++) await tools.read({path:"read.txt"}); await show((await tools.read({path:"read.txt"})).ref);store("n",1)' : undefined;
    const result: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: request,
      content: code ? [{ type: "toolCall", id: `script-${request}`, name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }], stopReason: code ? "toolUse" : "stop" };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: result.stopReason, message: result }); return stream;
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_end" && event.parentToolCallId) childCalls++;
    if (event.type === "tool_execution_update" && event.parentToolCallId) progress++;
  });
  try {
    let begin = performance.now(); await session.prompt("Read bounded fixture"); firstMs.push(performance.now() - begin);
    request = 0; begin = performance.now(); await session.prompt("Read again"); warmMs.push(performance.now() - begin);
    for (const result of session.messages) if (result.role === "toolResult") assert.equal(result.isError, false);
    assert.equal(owner.current, undefined); assert.equal(owner.pendingStore, undefined);
    ledgerPending += (session as any)._evidenceCompletedReads?.size ?? 0;
    assert.equal(session.agent.state.pendingToolCalls.size, 0);
    const sandbox = owner.sandbox;
    await owner.close();
    const stats = sandbox.stats; assert.equal(stats.activeExecutions, 0);
    workersStarted += stats.workersStarted; workersStopped += stats.workersStopped;
    assert.equal(owner.displayedReads.size, 0); assert.equal(owner.visibleReads.length, 0);
    assert.equal(owner.descriptors.length, 0); assert.equal(Object.keys(owner.store.snapshot).length, 0);
    refs.push(new WeakRef(session), new WeakRef(session.agent), new WeakRef(owner), new WeakRef(sandbox), new WeakRef(initialDescriptors));
  } finally {
    unsubscribe(); session.dispose(); await session.waitForSessionLeaseRelease();
    // A disposed session owns a revoked runtime. Every measured lifecycle must
    // acquire a fresh loader runtime before constructing its replacement.
    await loader?.reload();
  }
}
function compare(a: number, b: number) { return a - b; }
/** Real SDK dynamic registration, with its existing mode owner held in Plan. */
async function registrationCycle() {
  const names = Array.from({ length: 8 }, (_, i) => `registration_${i}`);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), tools: ["read", ...names], toolSelection: { tools: ["*"] },
    model, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
      getModel: () => undefined, getAuth: async () => undefined } as never });
  const owner = (session as any)._codemode, boundary = loader.getExtensions().runtime.executionBoundary;
  const state = { plan: true };
  let modeReads = 0, promptBuilds = 0, schemaReads = 0, broadenedSelections = 0;
  const modeReader = (): "plan" | undefined => { modeReads++; return state.plan ? "plan" : undefined; };
  const participant = { revoke() {}, async drain() {}, toolSelectionMode: modeReader };
  boundary.register("registration-mode-fixture", participant);
  const rebuild = (session as any)._rebuildSystemPrompt.bind(session);
  (session as any)._rebuildSystemPrompt = (...args: unknown[]) => { promptBuilds++; return rebuild(...args); };
  const retired: WeakRef<object>[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      session.setActiveToolsByName(["read"]);
      retired.push(new WeakRef((session as any)._toolRegistry), new WeakRef((session as any)._baseSystemPromptComposition));
      registrationApi.registerTool({ name: names[i % names.length], label: "registration", description: `revision ${i}`,
        parameters: { type: "object", get properties() { schemaReads++; return {}; } }, execute: async () => ({ content: [], details: {} }) });
      if (session.getActiveToolNames().length !== 2) broadenedSelections++;
    }
    assert.equal(owner.sandbox, undefined, "registration never starts a Worker");
    for (let i = 0; i < 4; i++) { await nextTask(); gc!(); }
    for (const ref of retired) assert.equal(ref.deref(), undefined, "live session releases old registries and compositions");
    refs.push(...retired, new WeakRef(session), new WeakRef(owner), new WeakRef(boundary), new WeakRef(participant), new WeakRef(modeReader), new WeakRef(state));
    return { registrations: 32, modeReads, promptBuilds, schemaReads, broadenedSelections, workersStarted: 0,
      retiredReferencesReleasedWithLiveSession: retired.length };
  } finally { session.dispose(); registrationApi = undefined; assert.equal((session as any)._baseSystemPromptComposition, undefined); }
}
/** On-demand catalog audit; uses the real SDK, controller and compiled Worker. */
async function catalogCycle(count: number, pagedJson = false) {
  // Each session disposes its execution boundary; the next case needs a fresh runtime.
  await loader!.reload();
  let localReads = 0, remoteReads = 0;
  const localCount = pagedJson ? 0 : Math.min(64, Math.ceil(count / 4));
  const names: string[] = [];
  const customTools = Array.from({ length: count }, (_, index) => {
    const remote = index >= localCount;
    const name = remote ? `mcp__catalog__tool_${index}` : `catalog_local_${index}`;
    names.push(name);
    const properties = pagedJson ? { value: { type: "string", description: "x".repeat(60_000) } }
      : { value: { type: "string", enum: Array.from({ length: 70 }, (_, n) => `literal_${n}`) } };
    const parameters = { type: "object", get properties() { if (remote) remoteReads++; else localReads++; return properties; } };
    return { name, label: name, description: `Catalog fixture ${index}`, parameters,
      execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }) };
  });
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), noTools: "builtin", customTools,
    model, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
      getModel: () => undefined, getAuth: async () => undefined } as never });
  const owner = (session as any)._codemode;
  let sequence = 0;
  async function run(code: string) {
    let sent = false;
    session.agent.streamFunction = () => {
      const script = !sent; sent = true;
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: ++sequence,
        content: script ? [{ type: "toolCall", id: `catalog-${sequence}`, name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }], stopReason: script ? "toolUse" : "stop" };
      const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
    };
    await session.prompt("Offline catalog audit");
    const result = session.messages.findLast(message => message.role === "toolResult");
    assert.ok(result?.role === "toolResult" && !result.isError, JSON.stringify(result));
    const block = result.content.find(block => block.type === "text" && block.text.startsWith("CATALOG:"));
    assert.ok(block?.type === "text");
    return JSON.parse(block.text.slice("CATALOG:".length));
  }
  try {
    localReads = 0; remoteReads = 0;
    const definitions = (session as any)._toolDefinitions;
    let catalogReads = 0, promptBuilds = 0;
    const selectionState = { enabled: false };
    let selectionModeReads = 0, selectionModeSupported = false;
    const selectionReader = (): "plan" | undefined => { selectionModeReads++; return selectionState.enabled ? "plan" : undefined; };
    const selectionOwner = { revoke() {}, async drain() {}, toolSelectionMode: selectionReader };
    const boundary = session.resourceLoader.getExtensions().runtime.executionBoundary;
    boundary.register("catalog-mode-fixture", selectionOwner);
    refs.push(new WeakRef(selectionOwner), new WeakRef(selectionReader), new WeakRef(selectionState));
    const getAllTools = session.getAllTools.bind(session);
    session.getAllTools = () => { catalogReads++; return getAllTools(); };
    const rebuildPrompt = (session as any)._rebuildSystemPrompt.bind(session);
    (session as any)._rebuildSystemPrompt = (...args: unknown[]) => { promptBuilds++; return rebuildPrompt(...args); };
    session.setActiveToolsByName(names);
    assert.equal((session as any)._toolDefinitions, definitions, "activation does not rebuild registered definitions");
    const activation = { localSchemaPropertyReads: localReads, remoteSchemaPropertyReads: remoteReads,
      inlineChars: owner.definition.description.length, inlineUtf8Bytes: Buffer.byteLength(owner.definition.description) };
    assert.equal(remoteReads, 0); assert.ok(activation.inlineChars < 32768);
    // Paired baseline supports the older public API; no cache or remote schema serialization.
    let configuredCount = 0;
    function readDirectory() {
      for (let index = 0; index < 32; index++) {
        selectionState.enabled = index >= 16;
        const snapshot = (session as any).getToolCatalog?.() ?? { tools: session.getAllTools(), activeTools: session.getActiveToolNames() };
        selectionModeSupported = snapshot.selectionMode !== undefined;
        if (selectionModeSupported) assert.equal(snapshot.selectionMode, selectionState.enabled ? "plan" : "default");
        configuredCount = snapshot.tools.length;
        for (const name of names) assert.ok(snapshot.tools.some((tool: { name: string }) => tool.name === name));
        assert.deepEqual(snapshot.activeTools, [...names, "codemode"]);
        if (index === 31) return [new WeakRef(snapshot), new WeakRef(snapshot.tools), new WeakRef(snapshot.activeTools)];
      }
      throw new Error("missing directory sample");
    }
    const beforeDirectoryReads = localReads + remoteReads, beforeDirectoryPrompts = promptBuilds;
    const directoryRefs = readDirectory();
    selectionState.enabled = false;
    assert.equal(selectionModeReads, selectionModeSupported ? 32 : 0);
    assert.equal(localReads + remoteReads, beforeDirectoryReads);
    assert.equal(promptBuilds, beforeDirectoryPrompts);
    for (let i = 0; i < 3; i++) { await nextTask(); gc!(); }
    for (const ref of directoryRefs) assert.equal(ref.deref(), undefined, "live session must not retain caller snapshots");
    refs.push(...directoryRefs);
    const directory = { configuredCount, reads: catalogReads, selectionModeSupported, selectionModeReads,
      schemaPropertyReads: 0, promptBuilds: 0, retainedSnapshotsWithLiveSession: 0 };
    let chromeSelection;
    if (chromeSelector) {
      selectionState.enabled = true;
      const beforeReads = catalogReads, beforeBuilds = promptBuilds, beforeSchemaReads = localReads + remoteReads;
      const snapshots: WeakRef<object>[] = [];
      const api = {
        getToolCatalog: () => {
          const snapshot = session.getToolCatalog();
          snapshots.push(new WeakRef(snapshot), new WeakRef(snapshot.tools), new WeakRef(snapshot.activeTools));
          return snapshot;
        },
        getActiveTools: () => session.getActiveToolNames(),
        setActiveTools: (names: string[]) => session.setActiveToolsByName(names),
      } as never;
      // The two automatic applications bracket settings I/O in the real startup path.
      chromeSelector.applyChromeDevtoolsTools(api, [], { preservePlanModeSelection: true });
      await nextTask();
      chromeSelector.applyChromeDevtoolsTools(api, [], { preservePlanModeSelection: true });
      const automaticReads = catalogReads - beforeReads, automaticPromptBuilds = promptBuilds - beforeBuilds;
      const automaticSchemaReads = localReads + remoteReads - beforeSchemaReads;
      chromeSelector.applyChromeDevtoolsTools(api, []); // Explicit command still uses the existing path.
      assert.equal(catalogReads - beforeReads, automaticReads);
      for (let i = 0; i < 3; i++) { await nextTask(); gc!(); }
      for (const ref of snapshots) assert.equal(ref.deref(), undefined, "Chrome restoration must not retain catalog snapshots");
      refs.push(...snapshots);
      chromeSelection = { automaticReads, automaticPromptBuilds, automaticSchemaReads, explicitAdditionalReads: 0,
        releasedSnapshotsWithLiveSession: snapshots.length };
      selectionState.enabled = false;
    }
    const beforeScripts = { catalogReads, promptBuilds, selectionModeReads };
    const descriptors = owner.descriptors;
    const target = names.at(-1)!;
    localReads = 0; remoteReads = 0;
    const first = await run(pagedJson ? `let offset=0,revision,pages=0,total;
while(true) { const page=await describeTools(${JSON.stringify(names)},{format:"json",offset,revision});
const h=/chars (\\d+)\\.\\.(\\d+) of (\\d+); format:json; revision:([^\\]]+)\\]/.exec(page);
if(!h || Number(h[1])!==offset || Number(h[2])<=offset) throw new Error("invalid page");
offset=Number(h[2]);total=Number(h[3]);revision=h[4];pages++;if(offset===total) break; }
text("CATALOG:"+JSON.stringify({count:ALL_TOOLS.length,name:${JSON.stringify(target)},declarationChars:total,pages}));`
      : `const found=ALL_TOOLS.find(t=>t.name===${JSON.stringify(target)}); const declaration=await describeTools([found.name]);text("CATALOG:"+JSON.stringify({count:ALL_TOOLS.length,name:found.name,declarationChars:declaration.length}));`);
    assert.equal(first.count, count); assert.equal(first.name, target);
    const discoveryReads = { local: localReads, remote: remoteReads };
    if (pagedJson) assert.equal(remoteReads, count, "one schema serialization per selected tool across all pages");
    const sandbox = owner.sandbox, snapshot = sandbox.toolSnapshot, catalog = sandbox.toolCatalog;
    localReads = 0; remoteReads = 0;
    const second = await run('text("CATALOG:"+JSON.stringify({count:ALL_TOOLS.length}));');
    assert.equal(second.count, count); assert.equal(localReads + remoteReads, 0);
    const unchangedReads = localReads + remoteReads;
    assert.equal(owner.descriptors, descriptors); assert.equal(sandbox.toolSnapshot, snapshot); assert.equal(sandbox.toolCatalog, catalog);
    const wireCatalogBytes = Buffer.byteLength(JSON.stringify(catalog)); // Once, outside production, explicit measurement only.
    assert.equal(catalogReads, beforeScripts.catalogReads, "output/progress do not scan the directory");
    assert.equal(promptBuilds, beforeScripts.promptBuilds, "output/progress do not rebuild prompts");
    assert.equal(selectionModeReads, beforeScripts.selectionModeReads, "output/progress do not query mode owners");
    session.setActiveToolsByName(names.slice(0, -1));
    assert.equal((session as any)._toolDefinitions, definitions);
    assert.equal(sandbox.toolSnapshot, undefined);
    const removed = await run(`text("CATALOG:"+JSON.stringify({count:ALL_TOOLS.length,present:ALL_TOOLS.some(t=>t.name===${JSON.stringify(target)}),declaration:await describeTools([${JSON.stringify(target)}])}));`);
    assert.equal(removed.count, count - 1); assert.equal(removed.present, false);
    assert.match(removed.declaration, /^\[TOOL_UNAVAILABLE\]/);
    assert.ok(!removed.declaration.includes(target));
    await owner.close();
    const closedStats = sandbox.stats;
    assert.equal(closedStats.activeExecutions, 0); assert.equal(closedStats.workersStarted, closedStats.workersStopped);
    assert.equal(owner.descriptors.length, 0); assert.equal(owner.current, undefined);
    const retainedDocumentationSchemasAfterClose = owner.documentationSnapshot?.schemas.length ?? 0;
    assert.equal(retainedDocumentationSchemasAfterClose, 0);
    const retainedNameMappingsAfterClose = owner.identifiers.size + owner.identifierNames.size;
    const retainedDeclarationCharsAfterClose = Math.max(0, owner.definition.description.length - CODEMODE_DESCRIPTION.length);
    session.dispose(); await owner.close();
    await boundary.dispose(); assert.equal(boundary.participantCount, 0);
    const wrappedDeclarationCharsAfterDispose = {
      registry: Math.max(0, ((session as any)._toolRegistry.get("codemode")?.description.length ?? 0) - CODEMODE_DESCRIPTION.length),
      active: Math.max(0, (session.agent.state.tools.find(tool => tool.name === "codemode")?.description.length ?? 0) - CODEMODE_DESCRIPTION.length),
      model: Math.max(0, (session.agent.state.modelTools?.find(tool => tool.name === "codemode")?.description.length ?? 0) - CODEMODE_DESCRIPTION.length),
    };
    // Simulate an already admitted callback reaching the session API after disposal.
    await nextTask(); session.setActiveToolsByName(names);
    const lateCallbackNameMappings = owner.identifiers.size + owner.identifierNames.size;
    await owner.close();
    refs.push(new WeakRef(session), new WeakRef(owner), new WeakRef(sandbox), new WeakRef(descriptors), new WeakRef(snapshot), new WeakRef(catalog));
    return { count, localCount, activation, directory, chromeSelection, outputDirectoryReads: 0, outputPromptBuilds: 0, outputSelectionModeReads: 0,
      activationUpdates: 2, definitionReusedAcrossActivation: true, discovery: { scripts: 1, describeCalls: first.pages ?? 1, ...first, schemaPropertyReads: discoveryReads },
      unchanged: { schemaPropertyReads: unchangedReads, descriptorReused: true, snapshotReused: true, catalogReused: true },
      wireCatalogBytes, afterRemoval: removed, ...closedStats,
      retainedNameMappingsAfterClose, retainedDeclarationCharsAfterClose, retainedDocumentationSchemasAfterClose, wrappedDeclarationCharsAfterDispose, lateCallbackNameMappings };
  } finally { await owner.close(); session.dispose(); }
}
const profiler = new Session(); profiler.connect();
try {
  if (process.argv.includes("--catalog") || process.argv.includes("--documentation") || process.argv.includes("--registration-plan")) {
    const pagedJson = process.argv.includes("--documentation");
    const registration = process.argv.includes("--registration-plan");
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const catalogs = [];
    if (registration) catalogs.push(await registrationCycle());
    else for (const count of pagedJson ? [16] : [8, 512]) catalogs.push(await catalogCycle(count, pagedJson));
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    let bytes = 0; const stack = [profile.head], sites: { name: string; url: string; line: number; bytes: number }[] = [];
    while (stack.length) { const node = stack.pop()!; bytes += node.selfSize;
      if (node.selfSize) sites.push({ name: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, bytes: node.selfSize });
      for (const child of node.children) stack.push(child);
    }
    sites.sort((a, b) => b.bytes - a.bytes);
    loader = undefined;
    for (let i = 0; i < 8; i++) { await nextTask(); gc(); }
    let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
    assert.equal(retained, 0);
    process.stdout.write(JSON.stringify({ benchmark: registration ? "codemode-session-registration" : pagedJson ? "codemode-session-documentation" : "codemode-session-catalog", node: process.version, platform: process.platform,
      catalogs, trackedReferences: refs.length, retainedAfterGc: retained, sampledHostBytes: bytes, leadingSites: sites.slice(0, 6),
      directorySites: sites.filter(site => /getAllTools|getActiveToolNames|getToolCatalog|getToolSelectionMode/.test(site.name)),
      coverage: registration ? "Real SDK registerTool -> registry -> Codemode -> prompt rebuild, one existing mode participant, 8 names replaced across 32 registrations; no Worker/model/server."
        : `${pagedJson ? "16 large JSON schemas with 8000-unit pages" : "8/512 registered host tools"} (MCP names are metadata fixtures); real SDK, controller, describe bridge, compiled Worker and disposal. No real server/model, provider token/cache measurement or Worker heap.` }) + "\n");
  } else {
  await cycle(); startupMs.length = 0; firstMs.length = 0; warmMs.length = 0;
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < 10; i++) await cycle();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let bytes = 0; const stack = [profile.head], sites: { name: string; bytes: number }[] = [];
  while (stack.length) { const node = stack.pop()!; bytes += node.selfSize; if (node.selfSize) sites.push({ name: node.callFrame.functionName || node.callFrame.url, bytes: node.selfSize }); for (const child of node.children) stack.push(child); }
  // The shared fixture loader owns the last bound extension runtime. Release
  // that fixture root before testing collection of its last session as well.
  loader = undefined;
  for (let i = 0; i < 8; i++) { await nextTask(); gc(); }
  let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
  assert.equal(retained, 0); assert.equal(ledgerPending, 0); assert.equal(childCalls, 242); assert.equal(workersStarted, 11); assert.equal(workersStopped, 11);
  startupMs.sort(compare); firstMs.sort(compare); warmMs.sort(compare); sites.sort((a, b) => b.bytes - a.bytes);
  process.stdout.write(JSON.stringify({ benchmark: "codemode-session", browserRouting, node: process.version, platform: process.platform, sampledCycles: 10, excludedWarmupCycles: 1,
    startupMedianMs: startupMs[5], startupP95Ms: startupMs[9], firstBatchMedianMs: firstMs[5], firstBatchP95Ms: firstMs[9], warmBatchMedianMs: warmMs[5], warmBatchP95Ms: warmMs[9],
    childCalls, progress, workersStarted, workersStopped, trackedReferences: refs.length, retainedAfterGc: retained, pendingEvidenceAfterTurn: ledgerPending,
    sampledHostBytes: bytes, leadingSites: sites.slice(0, 5), coverage: "real SDK, built-in reads, AgentSession policy/hooks/results/store, Worker, projection and disposal; offline provider; excludes UI, worker heap and disk sessions" }) + "\n");
  }
} finally { profiler.disconnect(); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
