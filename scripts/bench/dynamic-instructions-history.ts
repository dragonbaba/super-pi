import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { buildSystemPromptComposition } from "../../packages/coding-agent/src/core/system-prompt.ts";
import { promptFixture } from "../../tests/helpers/prompt-fixture.ts";
import { readIntegerOption } from "./benchmark.ts";

const gc = globalThis.gc;
assert.ok(gc, "Run with --expose-gc");
const history = readIntegerOption("--history", 10000), turns = readIntegerOption("--turns", 100);
const earlyMarker = process.argv.includes("--early-marker");
function seedHistory(manager: SessionManager): void {
  for (let index = 0; index < history; index++) manager.appendMessage({ role: "user", content: "bounded fixture history", timestamp: index });
}
const sourceArg = process.argv.indexOf("--extension");
const source = sourceArg < 0 ? new URL("../../packages/dynamic-instructions/src/index.ts", import.meta.url)
  : pathToFileURL(resolve(process.argv[sourceArg + 1]!));
const { default: extension } = await import(source.href);
const runtime = createExtensionRuntime(), events = createEventBus(), manager = SessionManager.inMemory();
const loaded = await loadExtensionFromFactory(extension, process.cwd(), events, runtime);
const runner = new ExtensionRunner([loaded], runtime, process.cwd(), manager, {} as never);
runner.onError(error => { throw new Error(error.error); });
if (!earlyMarker) seedHistory(manager);
let options: ReturnType<typeof promptFixture> | undefined = promptFixture("nested");
let composition: ReturnType<typeof buildSystemPromptComposition> | undefined = buildSystemPromptComposition(options);
const references = [new WeakRef(options), new WeakRef(composition), new WeakRef(composition.segments)];
const first = await runner.emitBeforeAgentStart("first", undefined, composition.text, options, composition);
for (const message of first?.messages ?? []) manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
if (earlyMarker) seedHistory(manager);
let branchCopies = 0, copiedEntries = 0, indexedReads = 0;
const originalBranch = manager.getBranch, originalEntry = manager.getEntry;
manager.getBranch = function(fromId) { branchCopies++; const entries = originalBranch.call(this, fromId); copiedEntries += entries.length; return entries; };
manager.getEntry = function(id) { indexedReads++; return originalEntry.call(this, id); };
const times = new Float64Array(turns), profiler = new Session(); profiler.connect();
gc(); const heapBefore = process.memoryUsage().heapUsed; let peakHeap = heapBefore;
await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
let sampled;
try {
  for (let index = 0; index < turns; index++) {
    manager.appendMessage({ role: "user", content: "next fixture turn", timestamp: history + index });
    const start = performance.now();
    const result = await runner.emitBeforeAgentStart("next", undefined, composition.text, options, composition);
    times[index] = performance.now() - start;
    assert.equal(result?.messages, undefined, "unchanged visible instructions are never duplicated");
    assert.equal(result?.systemPrompt, first?.systemPrompt);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  sampled = await profiler.post("HeapProfiler.stopSampling");
} finally {
  profiler.disconnect();
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  await runtime.executionBoundary.dispose(); events.clear();
}
let sampledBytes = 0; const stack = [sampled!.profile.head];
while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize; for (const child of node.children ?? []) stack.push(child); }
options = undefined; composition = undefined;
for (let index = 0; index < 6; index++) { await nextTurn(); gc(); }
let retained = 0; for (const reference of references) if (reference.deref()) retained++;
assert.equal(retained, 0, "shutdown releases projections while the runner remains live");
times.sort();
console.log(JSON.stringify({ history, turns, marker: earlyMarker ? "early" : "recent", branchCopies, copiedEntries, indexedReads, p50Ms: times[Math.floor(turns * .5)],
  p95Ms: times[Math.min(turns - 1, Math.floor(turns * .95))], sampledBytes, heapBefore, peakHeap,
  controlledGcHeap: process.memoryUsage().heapUsed, trackedReferences: references.length, retained, node: process.version }));
assert.ok(runner);
