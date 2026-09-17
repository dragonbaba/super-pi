import { Session } from "node:inspector/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const root = resolve(process.argv[2] ?? ".");
const sampled = process.argv.includes("--sample");
const { truncateToVisualLines } = await import(pathToFileURL(resolve(root, "packages/coding-agent/src/modes/interactive/components/visual-truncate.ts")).href);
const { ClipboardArtifactLifecycle } = await import(pathToFileURL(resolve(root, "packages/extensions/auxiliary-vision/clipboard-lifecycle.ts")).href);
const temp = mkdtempSync(resolve(tmpdir(), "pi-input-benchmark-"));
const owner = new ClipboardArtifactLifecycle({ tempDir: temp });
const originalMicrotask = globalThis.queueMicrotask;
let tasks = 0;
globalThis.queueMicrotask = callback => { tasks++; originalMicrotask(callback); };
for (let i = 0; i < 10000; i++) owner.editorChanged(`ordinary text ${i}`);
await Promise.resolve();
globalThis.queueMicrotask = originalMicrotask;
const retainedText = (owner as any).pendingEditorText.length;
owner.shutdown(); rmSync(temp, { recursive: true });
const text = ("\x1b[32m中 🦖 sample é long line\x1b[0m ".repeat(3) + "\r\n").repeat(10000);
for (let i = 0; i < 3; i++) truncateToVisualLines(text, 10, 80);
global.gc?.(); const before = process.memoryUsage().heapUsed;
const inspector = new Session(); inspector.connect();
if (sampled) await inspector.post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
const times: number[] = []; let skipped = 0, returned = 0;
for (let i = 0; i < 20; i++) {
	const start = performance.now(); const result = truncateToVisualLines(text, 10, 80);
	times.push(performance.now() - start); skipped = result.skippedCount; returned = result.visualLines.length;
}
let bytes = 0;
if (sampled) {
	const result: any = await inspector.post("HeapProfiler.stopSampling");
	const pending = [result.profile.head];
	while (pending.length) { const node = pending.pop(); bytes += node.selfSize; pending.push(...node.children); }
}
inspector.disconnect(); global.gc?.(); const after = process.memoryUsage().heapUsed;
times.sort((a, b) => a - b);
console.log(JSON.stringify({ root, sampled, tasks, retainedText, skipped, returned, sampledBytesPerOperation: sampled ? bytes / 20 : null, p50: times[10], p95: times[18], heapAfterGcDelta: after - before }));
