import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, rm, readdir, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { selectCommitMetadata } from "../../packages/extensions/mutation-guard-write/file-commit-metadata.ts";
import { commitPreparedFile } from "../../packages/extensions/mutation-guard-write/file-commit.ts";
import { capturePathIdentity } from "../../packages/extensions/mutation-guard-write/native-file-core.ts";
import { nativeFileDiagnostics, nativeFileRequest, disposeNativeFileWorker } from "../../packages/extensions/mutation-guard-write/native-file-client.ts";
import { protectWindowsFixture } from "../../tests/helpers/native-metadata-fixture.ts";
import { createJiti } from "jiti";

const lspFix = process.argv.includes("--lsp-fix")
  ? (await createJiti(import.meta.url).import<any>("../../packages/lsp/src/runner.ts")).runFix : undefined;
if (lspFix && !global.gc) throw new Error("The LSP lifecycle fixture requires --expose-gc.");

async function measuredLspFix(path: string, root: string, fill: number, references: WeakRef<object>[]): Promise<void> {
  const cancellation = new AbortController();
  const authority = { schemaVersion: 1, sequence: 0, toolCallId: "bench", operation: "lsp_fix", requestHash: "fixture",
    canonicalTarget: path, protectedRoots: [], assertCurrent() {}, revocationSignal: cancellation.signal };
  const client = { didOpen() {}, didClose() {}, async diagnostics() { return []; },
    async codeActions(uri: string) { return [{ title: "bounded fix", kind: "source.fixAll", edit: { changes: { [uri]: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: String.fromCharCode(fill) },
    ] } } }]; }, async resolveActions(actions: unknown) { return actions; } };
  const pool = { async acquire() { return { client }; }, release() {}, async discard() {} };
  const result = await lspFix(pool, { name: "fixture", isSupportedFile() { return true; }, languageIdFor() { return "typescript"; } },
    { root, path, write: true }, 5000, undefined, { ui: { setStatus() {} } }, "lsp", authority);
  assert.equal(result.details.commit.outcome, "committed"); assert.equal((await readFile(path))[0], fill);
  references.push(new WeakRef(authority), new WeakRef(cancellation.signal), new WeakRef(client), new WeakRef(pool), new WeakRef(result), new WeakRef(result.details.commit));
}

async function installedBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    bytes += entry.isDirectory() ? await installedBytes(file) : Number((await lstat(file)).size);
  }
  return bytes;
}
// A completed call boundary keeps the benchmark's own last loop scope out of the GC measurement.
async function measuredCommit(path: string, root: string, content: Buffer, fill: number, references: WeakRef<object>[]): Promise<Buffer> {
  const target = await capturePathIdentity(path), parent = await capturePathIdentity(root);
  const metadata = await selectCommitMetadata(target), next = Buffer.alloc(content.length, fill);
  const plan = { target, parent, metadata, previousSha256: createHash("sha256").update(content).digest("hex") };
  const hooks = { assertPathAllowed: async () => target.canonical };
  const receipt = await commitPreparedFile(plan, next, hooks);
  references.push(new WeakRef(plan), new WeakRef(metadata), new WeakRef(hooks), new WeakRef(receipt));
  assert.equal(receipt.outcome, "committed"); assert.deepEqual(await readFile(path), next);
  return next;
}
const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "sp-native-cost-"));
const path = join(root, "file"), samples: number[] = [];
const references: WeakRef<object>[] = [];
const loop = monitorEventLoopDelay({ resolution: 1 });
const profiler = new Session();
global.gc?.(); const before = process.memoryUsage();
let content = Buffer.alloc(lspFix ? 4 * 1024 * 1024 : 64 * 1024, 65);
const fixtureBytes = content.length;
await writeFile(path, content);
try {
  await protectWindowsFixture(path);
  profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  loop.enable();
  const firstStart = performance.now();
  const first = await selectCommitMetadata(await capturePathIdentity(path));
  const firstLoadMilliseconds = performance.now() - firstStart;
  assert.equal(first.strategy, "staged_replace", first.reason);
  for (let i = 0; i < (lspFix ? 2 : 50); i++) {
    const started = performance.now();
    if (lspFix) await measuredLspFix(path, root, 66 + i, references);
    else content = await measuredCommit(path, root, content, 66 + i % 20, references);
    samples.push(performance.now() - started);
  }
  const native = await nativeFileRequest("stats"), diagnostics = nativeFileDiagnostics();
  assert.equal(native.activeHandles, 0); assert.equal(diagnostics.pending, 0); assert.equal(diagnostics.workerStarts, 1);
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampledBytes = 0; const nodes = [profile.head];
  while (nodes.length) { const node = nodes.pop()!; sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
  profile.head.children.length = 0;
  const profileSamples = (profile as typeof profile & { samples?: unknown[] }).samples;
  if (profileSamples) profileSamples.length = 0;
  profiler.disconnect();
  if (lspFix) content = Buffer.alloc(0);
  const releaseStart = performance.now(); await disposeNativeFileWorker(); const releaseMilliseconds = performance.now() - releaseStart;
  loop.disable(); global.gc?.();
  for (let i = 0; i < 8; i++) { await tick(); global.gc?.(); }
  const liveReferences = references.filter(reference => reference.deref()).length;
  if (global.gc) assert.equal(liveReferences, 0, "completed commits release plans, metadata, hooks and receipts");
  if (lspFix) {
    assert.ok(sampledBytes <= 32 * 1024 * 1024, `LSP fix sampled allocation regression: ${sampledBytes}`);
    assert.ok(process.memoryUsage().arrayBuffers - before.arrayBuffers < 1024 * 1024, "LSP source/candidate buffers must be released after GC");
  }
  samples.sort((a, b) => a - b);
  const platformPackage = resolve(`node_modules/@koromix/koffi-${process.platform}-x64`);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, fixture: lspFix ? "lsp-fix" : "commit", bytes: fixtureBytes, commits: samples.length,
    ...(lspFix ? { sourceBuffersPerCall: 1, maxSourceBufferBytes: 4 * 1024 * 1024 + 1, sampledAllocationLimit: 32 * 1024 * 1024 } : {}),
    installedMainBytes: await installedBytes(resolve("node_modules/koffi")), installedPlatformBytes: await installedBytes(platformPackage),
    firstLoadMilliseconds, medianMilliseconds: samples[Math.floor(samples.length / 2)], p95Milliseconds: samples[Math.ceil(samples.length * 0.95) - 1], releaseMilliseconds,
    eventLoopP95Milliseconds: loop.percentile(95) / 1e6, eventLoopMaxMilliseconds: loop.max / 1e6,
    sampledMainThreadBytes: sampledBytes, sampledMainThreadBytesPerCommit: sampledBytes / samples.length,
    references: { total: references.length, live: liveReferences, gcEnabled: Boolean(global.gc) },
    memoryBefore: before, memoryAfterRelease: process.memoryUsage(), native, diagnostics, afterRelease: nativeFileDiagnostics(),
    scope: "One process; source entry; supported staged fixture (protected Windows DACL), includes verification/readback. Fixture setup precedes measurement. Main-thread sampling excludes native allocator and worker heap; no speedup or zero-allocation claim." }, null, 2));
} finally {
  loop.disable(); profiler.disconnect(); await disposeNativeFileWorker();
  assert.equal(dirname(root), temporary); await rm(root, { recursive: true, force: true });
}
