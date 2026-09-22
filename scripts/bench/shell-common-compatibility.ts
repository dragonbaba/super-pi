import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createBashTool } from "../../packages/coding-agent/src/core/tools/bash.ts";
import { OutputAccumulator, type OutputSnapshot } from "../../packages/coding-agent/src/core/tools/output-accumulator.ts";

function compareNumbers(left: number, right: number): number { return left - right; }
function compareSites(left: AllocationSite, right: AllocationSite): number { return right.bytes - left.bytes; }

interface AllocationSite { site: string; bytes: number; }

async function runTimingBaseline(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "sp-shell-bench-"));
  const tool = createBashTool(cwd, { exposeSessionEnvironment: false, shellPath: process.env.SP_BENCH_BASH });
  const cases = [
    ["ordinary", "printf 'ok\\n'", 12],
    ["complex", "for t in printf cat; do command -v \"$t\" >/dev/null 2>&1; done; { printf out; printf err >&2; } 2>&1 | head -c 16", 12],
    ["large-output", "node -e \"process.stdout.write('x'.repeat(6*1024*1024))\"", 3],
  ] as const;

  try {
    for (const [name, command, runs] of cases) {
      const samples: number[] = [];
      let capped: boolean | undefined;
      let bytes: number | undefined;
      for (let index = 0; index < runs; index++) {
        const start = performance.now();
        const result = await tool.execute(`bench-${name}-${index}`, { command });
        samples.push(performance.now() - start);
        capped = (result.details as { spillFileCapped?: boolean } | undefined)?.spillFileCapped;
        bytes = result.details?.truncation?.totalBytes;
        const path = result.details?.fullOutputPath;
        if (path) {
          unlinkSync(path);
          if (existsSync(path + ".sp-owned")) unlinkSync(path + ".sp-owned");
        }
      }
      samples.sort(compareNumbers);
      process.stdout.write(JSON.stringify({ name, runs, medianMs: Number(samples[Math.floor(samples.length / 2)]!.toFixed(2)), p95Ms: Number(samples[Math.ceil(samples.length * .95) - 1]!.toFixed(2)), bytes, capped }) + "\n");
    }
  } finally {
    rmSync(cwd, { recursive: true });
  }
}

function summarizeProfile(head: { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children?: typeof head[] }): AllocationSite[] {
  const sites = new Map<string, number>();
  const pending = [head];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const frame = node.callFrame;
    const site = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
    sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
    if (node.children) for (const child of node.children) pending.push(child);
  }
  const result: AllocationSite[] = [];
  for (const [site, bytes] of sites) result.push({ site, bytes });
  result.sort(compareSites);
  return result;
}

async function runReleasedOwner(chunk: Buffer): Promise<WeakRef<OutputAccumulator>> {
  const output = new OutputAccumulator({ tempFilePrefix: "sp-shell-allocation-lifecycle" });
  try {
    output.append(chunk);
    output.snapshot({ persistIfTruncated: true });
    output.finish();
    await output.closeTempFile();
    return new WeakRef(output);
  } finally {
    await output.discardTempFile();
  }
}

async function runAllocationGate(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  assert.ok(gc, "run with --expose-gc");
  const inspector = new Session();
  const output = new OutputAccumulator({ tempFilePrefix: "sp-shell-allocation-gate" });
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  const appendCalls = 96;
  let snapshotCalls = 0;
  let snapshot: OutputSnapshot | undefined;
  let sampledBytes = 0;
  let topAllocationSites: AllocationSite[] = [];
  let spillFileBytes = 0;
  let spillFilesCreated = 0;
  let spillFileCapped = false;
  let spillErrors = 0;
  try {
    inspector.connect();
    await inspector.post("HeapProfiler.enable");
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 8192 });
    try {
      for (let index = 0; index < appendCalls; index++) {
        output.append(chunk);
        snapshot = output.snapshot({ persistIfTruncated: true });
        snapshotCalls++;
      }
      output.finish();
      await output.closeTempFile();
    } finally {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      topAllocationSites = summarizeProfile(profile.head);
      for (const site of topAllocationSites) sampledBytes += site.bytes;
      inspector.disconnect();
    }
    const path = snapshot?.fullOutputPath;
    assert.ok(path, "large output creates a spill file");
    spillFilesCreated = 1;
    spillFileCapped = snapshot!.spillFileCapped;
    spillFileBytes = statSync(path).size;
    assert.ok(spillFileBytes <= 5 * 1024 * 1024);
    assert.match(readFileSync(path).subarray(-100).toString(), /later output was not persisted/);
  } catch (error) {
    spillErrors++;
    throw error;
  } finally {
    await output.discardTempFile();
  }

  const releasedLifecycles = 20;
  const weakOwners: WeakRef<OutputAccumulator>[] = [];
  for (let index = 0; index < releasedLifecycles; index++) weakOwners.push(await runReleasedOwner(chunk));
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let index = 0; index < 3; index++) {
    gc();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  let liveOwnersAfterGc = 0;
  for (const owner of weakOwners) if (owner.deref()) liveOwnersAfterGc++;
  assert.equal(liveOwnersAfterGc, 0, "completed spill lifecycles retain no output owner");
  assert.equal(spillFileCapped, true);
  const sampledBytesPerAppend = Math.round(sampledBytes / appendCalls);
  assert.ok(sampledBytesPerAppend < 128_000, "append/snapshot allocation exceeded the regression ceiling");
  process.stdout.write(JSON.stringify({
    mode: "allocation-gate", counters: { appendCalls, snapshotCalls, spillFilesCreated, spillFileCapped, spillFileBytes, spillErrors, releasedLifecycles, liveOwnersAfterGc },
    sampledBytesPerAppend, topAllocationSites: topAllocationSites.slice(0, 5),
  }) + "\n");
}

if (process.argv.includes("--allocation-gate")) await runAllocationGate();
else await runTimingBaseline();
