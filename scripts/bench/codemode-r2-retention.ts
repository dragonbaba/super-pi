import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { alphaSession } from "../../tests/helpers/alpha-session.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { usage } from "../../tests/codemode-recovery/fixture.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
const refs: { kind: string; ref: WeakRef<object> }[] = [];
const seen = new WeakSet<object>();
function track(kind: string, value: object | undefined): void {
  if (value && !seen.has(value)) { seen.add(value); refs.push({ kind, ref: new WeakRef(value) }); }
}
const peaks = { records: 0, retainedCodeUnits: 0, retainedImageCodeUnits: 0, shownBlocks: 0, shownCodeUnits: 0, tombstones: 0, recovering: 0, inputReferences: 0 };
let children = 0, saves = 0, workersStarted = 0, workersStopped = 0;
const paths = new Set<string>();
const lifecycle: unknown[] = [];
function inspect(owner: any): void {
  const current = owner.current;
  if (!current) return;
  track("invocation", current); track("records", current.records); track("shown", current.shown);
  peaks.records = Math.max(peaks.records, current.records.size);
  peaks.retainedCodeUnits = Math.max(peaks.retainedCodeUnits, current.retainedChars);
  peaks.retainedImageCodeUnits = Math.max(peaks.retainedImageCodeUnits, current.retainedImageChars);
  peaks.shownBlocks = Math.max(peaks.shownBlocks, current.shown.length);
  peaks.shownCodeUnits = Math.max(peaks.shownCodeUnits, current.shownChars);
  peaks.tombstones = Math.max(peaks.tombstones, current.evicted.size);
  peaks.recovering = Math.max(peaks.recovering, current.recovering.size);
  for (const record of current.records.values()) {
    track("record", record); track("result", record.result); track("content", record.result.content);
    if (record.input) peaks.inputReferences++;
  }
  for (const block of current.shown) track("shownBlock", block);
  for (const fact of current.facts) if (fact.outputPath) paths.add(fact.outputPath);
  assert.ok(current.retainedChars <= 1024 * 1024 && current.retainedImageChars <= 16 * 1024 * 1024);
  assert.ok(current.shown.length <= 256 && current.shownChars <= 256 * 1024 && current.records.size <= 256);
}

async function cycle(mode: "normal" | "characters" | "failure" | "cancel" | "close"): Promise<void> {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const f = await alphaSession({ g2: false, codemode: true, settings: { compaction: { enabled: false }, retry: { enabled: false } }, customTools: [{
    name: "payload", label: "payload", description: "R2 output retention fixture",
    parameters: { type: "object", properties: { kind: { type: "string" }, blob: { type: "string" } } },
    execute: async (_id: string, input: { kind: string }, signal?: AbortSignal) => {
      children++; track("input", input);
      if (input.kind === "wait") {
        started();
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      const result = { content: input.kind === "blocks" ? Array.from({ length: 100 }, (_, i) => ({ type: "text" as const, text: `block-${i}` }))
        : [{ type: "text" as const, text: input.kind === "failure" ? "Error: expected failure" : "retained-result\n" + "x".repeat(120000) }],
        details: {}, isError: input.kind === "failure" };
      track("rawResult", result); track("rawContent", result.content);
      return result;
    },
  }] });
  const owner = (f.session as any)._codemode;
  track("session", f.session); track("controller", owner);
  const runChild = owner.runChild;
  owner.runChild = async function (...args: unknown[]) {
    try { return await runChild.apply(this, args); } finally { inspect(this); }
  };
  const show = owner.show;
  owner.show = async function (...args: unknown[]) {
    try { return await show.apply(this, args); } finally { inspect(this); }
  };
  const recover = owner.recoverRecord;
  owner.recoverRecord = async function (record: any) {
    inspect(this);
    if (!record.recoveryAttempted) saves++;
    return recover.call(this, record);
  };
  const prefix = `for(let i=0;i<3;i++) await show((await tools.payload({kind:"${mode === "characters" ? "large" : "blocks"}"})).ref);const first=await tools.payload({kind:"large",blob:"x".repeat(220000)});for(let i=0;i<9;i++) await tools.payload({kind:"large"});text(await show(first.ref));`;
  const code = prefix + (mode === "failure" ? 'await tools.payload({kind:"failure"});'
    : mode === "normal" || mode === "characters" ? 'await callTool("payload",{kind:"failure"},{allowFailure:true});store("done",true);'
    : 'await tools.payload({kind:"wait"});');
  let sent = false;
  f.session.agent.streamFunction = () => {
    const script = !sent; sent = true;
    const message: any = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage, timestamp: Date.now(),
      content: script ? [{ type: "toolCall", id: `r2-${mode}`, name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }], stopReason: script ? "toolUse" : "stop" };
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  };
  try {
    const work = f.session.prompt("Run offline retention fixture");
    let sandbox;
    if (mode === "cancel" || mode === "close") {
      await waiting;
      sandbox = owner.sandbox;
      if (mode === "cancel") f.session.agent.abort(); else await owner.close();
    }
    await work;
    for (const result of f.session.messages) if (result.role === "toolResult") {
      assert.equal(result.isError, mode !== "normal" && mode !== "characters");
      for (const block of result.content) if (block.type === "text") {
        const path = /Recover the saved output with read: (.+)\. Do not/.exec(block.text)?.[1];
        if (path) paths.add(path);
      }
      for (const fact of (result.details as any)?.codemode?.calls ?? []) if (fact.outputPath) paths.add(fact.outputPath);
    }
    assert.equal(owner.current, undefined); assert.equal(owner.pendingStore, undefined);
    sandbox ??= owner.sandbox;
    if (sandbox) { await owner.close(); workersStarted += sandbox.stats.workersStarted; workersStopped += sandbox.stats.workersStopped; }
    assert.equal(owner.displayedReads.size, 0); assert.equal(owner.visibleReads.length, 0);
    assert.equal(Object.keys(owner.store.snapshot).length, 0);
    lifecycle.push({ mode, currentReferences: 0, pendingStore: 0, pendingReads: 0, disposedStoreKeys: 0 });
  } finally { await owner.close(); await f.release(); }
}

const profiler = new Session(); profiler.connect();
try {
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (const mode of ["normal", "characters", "failure", "cancel", "close"] as const) await cycle(mode);
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampledHostBytes = 0;
  const stack = [profile.head], sites: { name: string; bytes: number }[] = [];
  while (stack.length) {
    const node = stack.pop()!; sampledHostBytes += node.selfSize;
    if (node.selfSize) sites.push({ name: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
    for (const child of node.children) stack.push(child);
  }
  for (let i = 0; i < 8; i++) { await nextTask(); gc(); }
  const retained = refs.filter(item => item.ref.deref()).map(item => item.kind);
  assert.deepEqual(retained, []); assert.equal(peaks.inputReferences, 0);
  sites.sort((a, b) => b.bytes - a.bytes);
  process.stdout.write(JSON.stringify({ benchmark: "codemode-r2-retention", node: process.version, children, saves, peaks, lifecycle,
    workersStarted, workersStopped, trackedReferences: refs.length, retainedAfterGc: retained.length, sampledHostBytes,
    leadingSites: sites.slice(0, 10), recoveryFiles: paths.size,
    coverage: "real SDK/controller/compiled Worker; show/ref body, input and invocation WeakRefs through normal/failure/cancel/close. Host sampling includes fixture instrumentation and startup, excludes Worker heap. New stress scene; no old-scene speedup claim." }) + "\n");
} finally {
  profiler.disconnect();
  for (const path of paths) {
    assert.equal(readFileSync(path + ".sp-owned", "utf8"), "super-pi-output-spill-v2\n");
    unlinkSync(path); unlinkSync(path + ".sp-owned");
  }
}
