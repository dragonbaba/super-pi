import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, rm, readdir, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { selectCommitMetadata } from "../../packages/extensions/mutation-guard-write/file-commit-metadata.ts";
import { commitPreparedFile } from "../../packages/extensions/mutation-guard-write/file-commit.ts";
import { capturePathIdentity } from "../../packages/extensions/mutation-guard-write/native-file-core.ts";
import { nativeFileDiagnostics, nativeFileRequest, disposeNativeFileWorker } from "../../packages/extensions/mutation-guard-write/native-file-client.ts";

async function installedBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    bytes += entry.isDirectory() ? await installedBytes(file) : Number((await lstat(file)).size);
  }
  return bytes;
}
const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "sp-native-cost-"));
const path = join(root, "file"), samples: number[] = [];
const loop = monitorEventLoopDelay({ resolution: 1 });
const profiler = new Session();
global.gc?.(); const before = process.memoryUsage();
let content = Buffer.alloc(64 * 1024, 65);
await writeFile(path, content);
try {
  profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
  loop.enable();
  const firstStart = performance.now();
  const first = await selectCommitMetadata(await capturePathIdentity(path));
  const firstLoadMilliseconds = performance.now() - firstStart;
  assert.equal(first.strategy, "staged_replace", first.reason);
  for (let i = 0; i < 50; i++) {
    const started = performance.now(), target = await capturePathIdentity(path), parent = await capturePathIdentity(root);
    const metadata = await selectCommitMetadata(target), next = Buffer.alloc(content.length, 66 + i % 20);
    const receipt = await commitPreparedFile({ target, parent, metadata, previousSha256: createHash("sha256").update(content).digest("hex") }, next, { assertPathAllowed: async () => target.canonical });
    assert.equal(receipt.outcome, "committed"); assert.deepEqual(await readFile(path), next);
    content = next; samples.push(performance.now() - started);
  }
  const native = await nativeFileRequest("stats"), diagnostics = nativeFileDiagnostics();
  assert.equal(native.activeHandles, 0); assert.equal(diagnostics.pending, 0); assert.equal(diagnostics.workerStarts, 1);
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampledBytes = 0; const nodes = [profile.head];
  while (nodes.length) { const node = nodes.pop()!; sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
  const releaseStart = performance.now(); await disposeNativeFileWorker(); const releaseMilliseconds = performance.now() - releaseStart;
  loop.disable(); global.gc?.();
  samples.sort((a, b) => a - b);
  const platformPackage = resolve(`node_modules/@koromix/koffi-${process.platform}-x64`);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, bytes: content.length, commits: samples.length,
    installedMainBytes: await installedBytes(resolve("node_modules/koffi")), installedPlatformBytes: await installedBytes(platformPackage),
    firstLoadMilliseconds, medianMilliseconds: samples[25], p95Milliseconds: samples[47], releaseMilliseconds,
    eventLoopP95Milliseconds: loop.percentile(95) / 1e6, eventLoopMaxMilliseconds: loop.max / 1e6,
    sampledMainThreadBytes: sampledBytes, sampledMainThreadBytesPerCommit: sampledBytes / samples.length,
    memoryBefore: before, memoryAfterRelease: process.memoryUsage(), native, diagnostics, afterRelease: nativeFileDiagnostics(),
    scope: "One process; source entry; includes verification/readback. Main-thread sampling excludes native allocator and worker heap; no speedup or zero-allocation claim." }, null, 2));
} finally {
  loop.disable(); profiler.disconnect(); await disposeNativeFileWorker();
  assert.equal(dirname(root), temporary); await rm(root, { recursive: true, force: true });
}
