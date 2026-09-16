import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session as InspectorSession } from "node:inspector/promises";
import { createJiti } from "jiti";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createToolResultPresentationOwner, getToolResultModelContent, createToolResultPresentationCounters } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import { estimateContextTokensFromParts } from "@super-pi/ai";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";

const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<any>("../packages/extensions/mutation-guard-write/index.ts");
const { default: guardrails } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
const body = (content: readonly any[]) => content.filter(b => b.type === "text").map(b => b.text).join("\n");
const note = { type: "text", text: "Read audit: local text inspected." } as const;
const metadata = { type: "text", readBoundary: "metadata", text: "[Snapshot edit] snapshot=snap_0000000000000000000000; editable lines=1-200. Use this snapshot and its LINE#ID anchors together." } as const;
const lines = { type: "text", readBoundary: "lines", text: "1#1234|short\n" + "2#5678|source payload 中文😀\n".repeat(199) } as const;

for (const position of ["none", "after", "before"] as const) test(`paired read metadata survives a ${position} annotation using the real estimator`, () => {
 const source = position === "none" ? [lines, metadata] : position === "after" ? [lines, metadata, note] : [lines, note, metadata];
 const probe = createToolResultPresentationOwner({ enabled: true, budgetTokens: 512 }, "read-layout")!;
 const sample = probe.create([lines, metadata], "read")!;
 assert.equal(sample.version, 2);
 const recovery = sample.modelContent[sample.truncation.noticeBlockIndex];
 // Budget explicitly includes the entire notice, a whole source row, metadata,
 // and annotation. Slack covers cursor-coordinate digit changes, not source loss.
 const required = estimateToolOutputTokens([{ type: "text", text: "1#1234|short\n" }, recovery, metadata, note]).estimatedTokens;
 probe.release(); probe.dispose();
 const budget = required + 32;
 const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: budget }, "read-layout")!;
 try {
  const p = owner.create(source, "read")!; assert.equal(p.version, 2);
  assert.equal(getToolResultModelContent(p, source), p.modelContent);
  assert.ok(body(p.modelContent).includes(metadata.text));
  assert.ok(body(p.modelContent).includes("1#1234|short\n"));
  if (position !== "none") assert.ok(body(p.modelContent).includes(note.text));
  assert.ok(estimateToolOutputTokens(p.modelContent).estimatedTokens <= budget);
  const canonical: any[] = [{ role: "toolResult", toolCallId: "read", content: source }];
  const chunk = owner.readContinuation(p.continuation.cursor, canonical, 512);
  assert.match(body(chunk.content), /^2#5678\|source payload/);
  assert.doesNotMatch(body(chunk.content), /Snapshot edit|Read audit/);
  let recovered = p.modelContent[0].type === "text" ? p.modelContent[0].text : "";
  let part = chunk, steps = 0;
  for (;;) {
   assert.ok(part.estimatedTokens <= 512);
   recovered += part.content.map(b => b.type === "text" ? b.text : "").join("");
   if (part.done) break;
   assert.ok(++steps < 50); part = owner.readContinuation(part.nextCursor!, canonical, 512);
  }
  assert.equal(recovered, lines.text, "cursor covers exactly the omitted source, without gaps or repeated suffix annotations");
  assert.equal(owner.readArtifact(p.artifact!.id, canonical).content, source);
  assert.equal(p.truncation.originalTextCodeUnits, source.reduce((n, b) => n + b.text.length, 0));
  assert.equal(p.truncation.omittedTextCodeUnits, p.truncation.originalTextCodeUnits - p.truncation.retainedTextCodeUnits);
  const moved = position === "after" ? [lines, note, metadata] : [lines, metadata, note];
  assert.throws(() => owner.readContinuation(p.continuation.cursor, [{ ...canonical[0], content: moved }]), /changed|match|ambiguous|active branch/);
 } finally { owner.release(); owner.dispose(); }
 assert.equal(owner.counters.projectionRecordEntries, 0);
 assert.equal(owner.counters.retainedProjectionCodeUnits, 0);
});

test("minimum whole-row fallback retains metadata in the middle when density rounding removes the affordable first row", () => {
 const row = "1#1234|" + "a".repeat(400) + "\n";
 const source = [{ ...lines, text: row + "2#5678|中文😀\n".repeat(400) }, metadata, note];
 const probe = createToolResultPresentationOwner({ enabled: true, budgetTokens: 512 }, "minimum-layout")!;
 const p = probe.create([lines, metadata], "read")!; assert.equal(p.version, 2);
 const budget = estimateToolOutputTokens([{ type: "text", text: row }, p.modelContent[p.truncation.noticeBlockIndex], metadata, note]).estimatedTokens + 8;
 probe.release(); probe.dispose();
 const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: budget }, "minimum-layout")!;
 try {
  const result = owner.create(source, "read")!; assert.equal(result.version, 2);
  assert.ok(body(result.modelContent).includes(row)); assert.ok(body(result.modelContent).includes(metadata.text)); assert.ok(body(result.modelContent).includes(note.text));
  assert.ok(estimateToolOutputTokens(result.modelContent).estimatedTokens <= budget);
  assert.equal(result.truncation.headTextCodeUnits, row.length);
  assert.ok(owner.counters.modelProjectionArraysCreated >= 2, "must exercise the minimum-row fallback rather than just the density candidate");
 } finally { owner.release(); owner.dispose(); }
});

const model: any = { id: "read-recovery", name: "Offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };

async function sdkFixture(t: test.TestContext, budget: number, original = "x".repeat(12000) + "\nshort target\n", invalidLayout = false) {
 const root = mkdtempSync(join(tmpdir(), "pi-read-review-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const cwd = join(root, "work"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
 writeFileSync(join(cwd, "fixture.txt"), original);
 const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
 const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noSkills: true, noThemes: true,
  extensionFactories: [mutation, guardrails, pi => { pi.on("tool_result", event => {
   if (event.toolName !== "read") return undefined;
   return { content: invalidLayout ? [event.content.at(-1)!, ...event.content.slice(0, -1), note] : [...event.content, note] };
  }); }],
 });
 await resourceLoader.reload();
 const manager = SessionManager.create(cwd, join(root, "sessions"));
 const requests: any[] = [], deliveries: any[] = [], userErrors: string[] = [];
 let readCalls = 0;
 let next: ((wire: any) => any[] | undefined) | undefined;
 const runtime: any = { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getAuth: async () => undefined, getModel: () => undefined, registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
  streamSimple: (m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "offline", maxRetries: 0, fetch: async (_url, init) => {
   const wire = JSON.parse(String(init?.body)); requests.push(wire);
   const calls = next?.(wire);
   const delta = calls ? { tool_calls: calls.map((args, index) => ({ index, id: `read-${requests.length}-${index}`, type: "function", function: { name: "read", arguments: JSON.stringify(args) } })) } : { content: "Recorded read acknowledged." };
   const event = { choices: [{ index: 0, delta, finish_reason: null }] };
   const end = { choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] };
   return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } }),
 };
 async function open(presentationBudget: number, sessionManager = manager) {
  const counters = createToolResultPresentationCounters();
  const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, settingsManager, sessionManager, resourceLoader, tools: ["read"], toolResultPresentation: { enabled: true, budgetTokens: presentationBudget, counters } });
  const read = session.agent.state.tools.find(tool => tool.name === "read")!; const execute = read.execute;
  read.execute = async (...args) => { readCalls++; return execute(...args); };
  session.subscribe(event => {
   if (event.type === "message_end" && event.message.role === "toolResult") deliveries.push(event);
   if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage) userErrors.push(event.message.errorMessage);
  });
  return { session, counters };
 }
 const opened = await open(budget);
 t.after(() => opened.session.dispose());
 return { ...opened, open, manager, requests, deliveries, userErrors, setNext(fn: typeof next) { next = fn; }, readCalls: () => readCalls, assertUnchanged() { assert.equal(readFileSync(join(cwd, "fixture.txt"), "utf8"), original); } };
}

test("real SDK read hooks: short range alone forms a request with complete paired metadata and trailing annotation", async t => {
 const f = await sdkFixture(t, 512);
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt", offset: 2, limit: 1 }] : undefined);
 await f.session.prompt("Read only line two.");
 assert.equal(f.requests.length, 2); assert.equal(f.readCalls(), 1);
 const raw = f.session.messages.find((m: any) => m.role === "toolResult") as any;
 assert.equal(raw.isError, false);
 assert.equal(raw.content.at(-1).text, note.text);
 assert.equal(raw.content.at(-2).readBoundary, "metadata");
 const sent = f.requests[1].messages.find((m: any) => m.role === "tool").content;
 assert.match(sent, /2#[A-F0-9]{4}\|short target/); assert.match(sent, /snapshot=snap_/); assert.ok(sent.includes(note.text));
 assert.doesNotMatch(JSON.stringify(f.requests[1]), /readBoundary|ctrl\+o/);
 assert.equal(f.userErrors.length, 0); f.assertUnchanged();
});

test("real read plus tool-result annotation projects a large source without dropping its metadata or short note", async t => {
 const f = await sdkFixture(t, 512, "short target 中文😀\n".repeat(500));
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt" }] : undefined);
 await f.session.prompt("Read the source.");
 assert.equal(f.requests.length, 2); assert.equal(f.readCalls(), 1);
 const p = f.deliveries[0].toolResultPresentation;
 assert.equal(p.version, 2);
 const minimal = [{ type: "text", text: "1#1234|short target 中文😀\n" }, p.modelContent[p.truncation.noticeBlockIndex], ...p.uiContent.slice(1)];
 assert.ok(estimateToolOutputTokens(minimal).estimatedTokens < 512, "real estimator must prove this is not budget exhaustion");
 const sent = f.requests[1].messages.find((m: any) => m.role === "tool").content;
 assert.match(sent, /1#[A-F0-9]{4}\|short target 中文😀\n/);
 assert.match(sent, /snapshot=snap_/); assert.ok(sent.includes(note.text));
 assert.ok(estimateToolOutputTokens(p.modelContent).estimatedTokens <= 512);
 f.assertUnchanged();
});

test("real SDK oversized read recovers through a targeted read while the canonical old result stays in history", async t => {
 const f = await sdkFixture(t, 512);
 f.setNext(wire => {
  if (f.requests.length === 1) return [{ path: "fixture.txt" }];
  const old = wire.messages.find((m: any) => m.role === "tool").content;
  assert.match(old, /Read output omitted.*budget/); assert.match(old, /offset\/limit/);
  assert.doesNotMatch(old, /\d+#[A-F0-9]{4}\||snapshot=snap_/);
  if (f.requests.length === 2) return [{ path: "fixture.txt", offset: 2, limit: 1 }];
  const fresh = wire.messages.filter((m: any) => m.role === "tool").at(-1).content;
  assert.match(fresh, /2#[A-F0-9]{4}\|short target/); assert.match(fresh, /snapshot=snap_/);
  return undefined;
 });
 await f.session.prompt("Read and recover using the advertised range operation.");
 assert.equal(f.requests.length, 3); assert.equal(f.readCalls(), 2);
 assert.equal(f.deliveries.length, 2); assert.equal(f.userErrors.length, 0);
 const omitted = f.deliveries[0].toolResultPresentation;
 assert.equal(omitted.version, 2); assert.equal(omitted.truncation.retainedTextCodeUnits, 0);
 assert.equal(getToolResultModelContent(omitted, []), omitted.modelContent);
 assert.ok(estimateToolOutputTokens(omitted.modelContent).estimatedTokens <= 512);
 assert.throws(() => f.session.readToolResultContinuation(omitted.continuation.cursor, 128), /budget|forward progress/);
 const chunk = f.session.readToolResultContinuation(omitted.continuation.cursor, 6000);
 assert.ok(body(chunk.content).includes("x".repeat(12000)));
 assert.equal(chunk.content.some((b: any) => b.readBoundary !== undefined), false);
 const canonical = f.session.messages.filter((m: any) => m.role === "toolResult") as any[];
 assert.equal(canonical[0].isError, false); assert.ok(body(canonical[0].content).includes("x".repeat(12000)));
 assert.ok(body(canonical[0].content).includes("snapshot=snap_"));
 const persisted = SessionManager.open(f.manager.getSessionFile()!).buildSessionContext().messages.filter((m: any) => m.role === "toolResult") as any[];
 assert.deepEqual(persisted.map(r => r.content), canonical.map(r => r.content));
 // Historical replay/resume must form another request without a third read.
 const resumed = await f.open(512, SessionManager.open(f.manager.getSessionFile()!));
 try { await resumed.session.prompt("Continue from the recorded results."); assert.equal(f.requests.length, 4); assert.equal(f.readCalls(), 2); }
 finally { resumed.session.dispose(); }
 f.assertUnchanged();
});

test("minimum recovery notice cannot fit: user receives the reason, canonical read persists, configured resume forms requests", async t => {
 const f = await sdkFixture(t, 1);
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt" }] : undefined);
 await f.session.prompt("Read the source.");
 assert.equal(f.requests.length, 1); assert.equal(f.readCalls(), 1);
 assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].message.isError, false);
 assert.equal(f.deliveries[0].toolResultPresentation, undefined);
 assert.match(f.userErrors.at(-1)!, /Request preparation blocked: result-batch-budget.*Read budget 1/);
 assert.match(f.userErrors.at(-1)!, /read recovery notice.*offset\/limit.*increase the tool-result budget/);
 assert.ok(f.userErrors.at(-1)!.length < 1400);
 await f.session.prompt("Keep the result; the budget has not changed yet.");
 assert.equal(f.requests.length, 1); assert.equal(f.readCalls(), 1);
 assert.match(f.userErrors.at(-1)!, /Request preparation blocked: configured result budget.*Read budget 1/);
 assert.equal(f.counters.activeContextualCoordinators, 0);
 const saved = SessionManager.open(f.manager.getSessionFile()!);
 assert.equal(saved.buildSessionContext().messages.filter((m: any) => m.role === "toolResult" && !m.isError).length, 1);
 f.session.dispose();
 assert.equal(f.counters.projectionRecordEntries, 0); assert.equal(f.counters.retainedProjectionCodeUnits, 0);
 // Budget is an SDK configuration; resume the saved session with usable capacity.
 const resumed = await f.open(512, saved);
 try {
  f.setNext(wire => {
   const old = wire.messages.find((m: any) => m.role === "tool").content;
   assert.match(old, /Read output omitted.*budget/); assert.match(old, /offset\/limit/);
   return f.requests.length === 2 ? [{ path: "fixture.txt", offset: 2, limit: 1 }] : undefined;
  });
  await resumed.session.prompt("Capacity adjusted; read the short target range.");
  assert.equal(f.requests.length, 3); assert.equal(f.readCalls(), 2);
  assert.match(f.requests[2].messages.filter((m: any) => m.role === "tool").at(-1).content, /2#[A-F0-9]{4}\|short target/);
 } finally { resumed.session.dispose(); }
 assert.equal(resumed.counters.projectionRecordEntries, 0); assert.equal(resumed.counters.activeDispatchPresentationScopes, 0);
 f.assertUnchanged();
});

for (const budget of [256, 512]) test(`real simultaneous reads: contextual share ${budget / 2} preserves outcomes and reaches recovery`, async t => {
 const f = await sdkFixture(t, budget);
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt" }, { path: "fixture.txt", offset: 1, limit: 1 }] : undefined);
 await f.session.prompt("Read two independent diagnostic results.");
 assert.equal(f.readCalls(), 2); assert.equal(f.deliveries.length, 2);
 for (const delivery of f.deliveries) assert.equal(delivery.message.isError, false);
 if (budget === 256) {
  assert.equal(f.requests.length, 1);
  assert.match(f.userErrors.at(-1)!, /Request preparation blocked: result-batch-budget.*toolShare=128.*Read budget 128/);
  assert.match(f.userErrors.at(-1)!, /offset\/limit.*increase the tool-result budget/);
  f.session.dispose();
  const resumed = await f.open(512, SessionManager.open(f.manager.getSessionFile()!));
  try { await resumed.session.prompt("Capacity adjusted; use the saved results without replay."); }
  finally { resumed.session.dispose(); }
 } else assert.equal(f.userErrors.length, 0);
 assert.equal(f.requests.length, 2); assert.equal(f.readCalls(), 2);
 const results = f.requests[1].messages.filter((m: any) => m.role === "tool");
 assert.equal(results.length, 2);
 for (const result of results) { assert.match(result.content, /Read output omitted/); assert.doesNotMatch(result.content, /snapshot=snap_|\d+#[A-F0-9]{4}\|/); }
 if (budget === 512) assert.ok(results.reduce((n: number, r: any) => n + estimateToolOutputTokens([{ type: "text", text: r.content }]).estimatedTokens, 0) <= budget);
 assert.equal(f.counters.activeContextualCoordinators, 0); f.assertUnchanged();
});

test("unsupported metadata order, duplicates and missing pairs are layout errors rather than token budget errors", () => {
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 512 }, "bad-layout")!;
 try { for (const source of [[metadata, lines], [lines], [lines, metadata, metadata], [lines, lines, metadata]]) assert.throws(() => owner.create(source, "read"), (error: any) => error.code === "invalid-read-layout" && /Restore the read hook layout/.test(error.message)); }
 finally { owner.dispose(); }
 assert.equal(owner.counters.projectionRecordEntries, 0);
});

test("invalid hook layout reaches the user without changing the successful read status or persisted content", async t => {
 const f = await sdkFixture(t, 512, undefined, true);
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt" }] : undefined);
 await f.session.prompt("Read once with a malformed hook layout.");
 assert.equal(f.requests.length, 1); assert.equal(f.readCalls(), 1);
 assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].message.isError, false);
 assert.match(f.userErrors.at(-1)!, /Restore the read hook layout/); assert.doesNotMatch(f.userErrors.at(-1)!, /budget/);
 const saved = SessionManager.open(f.manager.getSessionFile()!).buildSessionContext().messages.find((m: any) => m.role === "toolResult") as any;
 assert.equal(saved.isError, false); assert.deepEqual(saved.content, f.deliveries[0].message.content);
 f.assertUnchanged();
});

test("real SDK conversion context headroom reports the read cause to the user and recovers without replay", async t => {
 const f = await sdkFixture(t, 512);
 const convert = f.session.agent.convertToLlm;
 let constrained = true;
 f.session.agent.convertToLlm = (messages, systemPrompt, tools, conversionModel, cap) => {
  if (constrained && messages.some(m => m.role === "toolResult")) {
   const nonCurrent = estimateContextTokensFromParts(systemPrompt, convertToLlm(messages.filter(m => m.role !== "toolResult")), tools).tokens;
   // A real context envelope with only 128 tokens left after response reserve;
   // use the production conversion/coordinator, never inject a fabricated error.
   return convert(messages, systemPrompt, tools, { ...conversionModel!, contextWindow: nonCurrent + 1024 + 4096 + 128 }, cap);
  }
  return convert(messages, systemPrompt, tools, conversionModel, cap);
 };
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt" }] : undefined);
 await f.session.prompt("Read before constructing the constrained next request.");
 assert.equal(f.requests.length, 1); assert.equal(f.readCalls(), 1);
 assert.match(f.userErrors.at(-1)!, /Request preparation blocked: context-headroom.*Read budget/);
 assert.match(f.userErrors.at(-1)!, /read recovery notice.*offset\/limit/);
 assert.equal(f.deliveries[0].message.isError, false);
 constrained = false;
 await f.session.prompt("Context capacity restored; keep the recorded read.");
 assert.equal(f.requests.length, 2); assert.equal(f.readCalls(), 1);
 assert.match(f.requests[1].messages.find((m: any) => m.role === "tool").content, /Read output omitted.*offset\/limit/);
 assert.equal(f.counters.activeContextualCoordinators, 0); f.assertUnchanged();
});

test("read omission and annotated projection reuse scans and release records/model references after history and disposal", async t => {
 const inspector = new InspectorSession(); inspector.connect();
 const refs: WeakRef<object>[] = [];
 async function exercise() {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 512 }, "read-review-profile")!;
  refs.push(new WeakRef(owner));
  for (let i = 0; i < 16; i++) {
   const source = [i % 2 === 0 ? { ...lines, text: "1#1234|" + "x".repeat(12000) + "\n" } : lines, metadata, note];
   const p = owner.create(source, `read-${i}`)!;
   refs.push(new WeakRef(p), new WeakRef(p.modelContent)); owner.release();
   const message: any = { role: "toolResult", toolCallId: `read-${i}`, toolName: "read", content: source, isError: false, timestamp: 0 };
   if (i % 2 === 0 && p.version === 2) {
    const chunk = owner.readContinuation(p.continuation.cursor, [message], 10_000);
    assert.equal(chunk.content.some((b: any) => b.readBoundary !== undefined), false);
    refs.push(new WeakRef(chunk.content));
   }
   for (let replay = 0; replay < 3; replay++) {
    const projected = owner.projectMessagesForModel([message]);
    assert.equal(projected[0].role, "toolResult");
    refs.push(new WeakRef(projected));
   }
  }
  assert.equal(owner.counters.fullSourceEstimatorScans, 16);
  assert.equal(owner.counters.sourceDigestConstructions, 16);
  assert.equal(owner.counters.residentReadHits, 48);
  assert.equal(owner.counters.continuationChunksCreated, 8);
  assert.equal(owner.counters.activeDispatchPresentationScopes, 0);
  assert.ok(owner.counters.modelProjectionArraysCreated <= 16 * 6);
  const arrays = owner.counters.modelProjectionArraysCreated;
  owner.clearProjectionRecords(); owner.dispose();
  assert.equal(owner.counters.projectionRecordEntries, 0); assert.equal(owner.counters.retainedProjectionCodeUnits, 0);
  return arrays;
 }
 try {
  await inspector.post("HeapProfiler.enable");
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const arrays = await exercise();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let projectionBytes = 0; const stack = [profile.head];
  while (stack.length) { const node = stack.pop()!; if (node.callFrame.url.includes("tool-result-presentation")) projectionBytes += node.selfSize; stack.push(...node.children); }
  for (let i = 0; i < 3; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  assert.ok(projectionBytes > 0 && projectionBytes < 16 * 64 * 1024);
  t.diagnostic(JSON.stringify({ scans: 16, digests: 16, residentReadHits: 48, continuationChunks: 8, arrays, projectionSampledBytes: projectionBytes, samplingInterval: 1024, retainedRefs: 0, recordsAfterClear: 0, retainedCodeUnits: 0 }));
 } finally { inspector.disconnect(); }
});

test("historical metadata-only continuation loses canonical layout markers and can enter a later model request", async t => {
 const f = await sdkFixture(t, 512);
 f.setNext(() => f.requests.length === 1 ? [{ path: "fixture.txt" }] : undefined);
 await f.session.prompt("Read the source once.");
 const p = f.deliveries[0].toolResultPresentation;
 // The real estimator makes the source-row-only chunk affordable, leaving the
 // paired metadata for a later chunk. No partial row is accepted.
 const raw = f.deliveries[0].message.content;
 const rowBudget = estimateToolOutputTokens([raw[0]]).estimatedTokens;
 const first = f.session.readToolResultContinuation(p.continuation.cursor, rowBudget);
 assert.equal(first.done, false); assert.ok(first.nextCursor);
 const tail = f.session.readToolResultContinuation(first.nextCursor, 256);
 assert.equal(tail.done, true); assert.match(body(tail.content), /snapshot=snap_/);
 assert.equal(tail.content.some((b: any) => b.readBoundary !== undefined), false);
 // Exercise SDK convertToLlm and the real offline sender with a fixture history
 // tool/result pair carrying the actual API chunk, not a fresh native read.
 const historyTurn: any = structuredClone(f.session.messages.find((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "toolCall")));
 historyTurn.content = [{ type: "toolCall", id: "historical-tail", name: "history", arguments: { cursor: first.nextCursor } }];
 f.session.agent.state.messages.push(historyTurn, { role: "toolResult", toolCallId: "historical-tail", toolName: "history", content: tail.content, isError: false, timestamp: 0 } as any);
 await f.session.prompt("Acknowledge the historical result without another read.");
 assert.equal(f.requests.length, 3); assert.equal(f.readCalls(), 1);
 assert.match(f.requests[2].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "historical-tail").content, /snapshot=snap_/);
 f.assertUnchanged();
});
