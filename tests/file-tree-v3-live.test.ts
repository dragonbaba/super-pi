import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { nativeFileSession, sandboxFileSession } from "./helpers/sandbox-file-session.ts";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { FileService } from "../packages/coding-agent/src/core/files/file-service.ts";
import { SandboxFileService } from "../packages/coding-agent/src/core/files/file-sandbox-service.ts";
import { FileResultReader } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { MXC_FILE_WORKER_PATH } from "../packages/coding-agent/src/core/files/file-runtime-assets.mjs";

const enabled = process.env.SUPERPI_FILE_V3_TREE_STRESS === "1";
const selected = process.env.SUPERPI_FILE_V3_TREE_ENVIRONMENT;
for (const environment of ["native", "mxc"] as const) test(`${environment} directory: full session copy/move/delete cover 50,000 files and release inventories`,
  { skip: !enabled || selected !== undefined && selected !== environment || environment === "mxc" && process.platform !== "win32", timeout: 60 * 60 * 1000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-tree-session-"))), cwd = join(root, "workspace");
  let cleanup: (() => Promise<void>) | undefined;
  t.after(async () => { try { await cleanup?.(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(cwd);
  const f = environment === "native" ? nativeFileSession(cwd) : sandboxFileSession(cwd, "sandbox-write");
  const owner = environment === "mxc" ? new WorkspaceSandboxTools(cwd, join(root, "runtime"), "sandbox-write", () => f.runtime, { network: "disabled" }) : undefined;
  const definitions: any = owner ? owner.install({}) : {}; if (!owner) f.files.install(definitions);
  for (const definition of Object.values(definitions)) f.policy.registerDefinition(definition as any);
  cleanup = async () => { await owner?.close(); await f.close(); await disposeNativeFileWorker(); };
  let metricsPath: string | undefined;
  if (owner) {
    const backend = (owner as any).backend, open = backend.openFileRpc.bind(backend);
    backend.openFileRpc = async (signal: AbortSignal) => {
      const context = await open(signal);
      if (!metricsPath) {
        metricsPath = join(context.exchange, randomUUID().replaceAll("-", "") + "-usage.jsonl");
        await writeFile(metricsPath, "", { flag: "wx" });
        const entry = join(backend.tools, MXC_FILE_WORKER_PATH), original = join(dirname(entry), "worker-under-profile.mjs");
        await rename(entry, original);
        // Task-owned measurement wrapper only. The actual packaged entry and
        // modules execute unchanged under the real MXC policy and Job owner.
        await writeFile(entry, `import {appendFileSync} from 'node:fs';\nfunction captureWorkerUsage(){const r=process.resourceUsage();appendFileSync(${JSON.stringify(metricsPath)},JSON.stringify({pid:process.pid,maxRSSKiB:r.maxRSS,userCpuMicroseconds:r.userCPUTime,systemCpuMicroseconds:r.systemCPUTime})+'\\n');}\nprocess.once('exit',captureWorkerUsage);\nawait import('./${basename(original)}');\n`, { flag: "wx" });
      }
      return context;
    };
  }
  const inspector = new InspectorSession(); inspector.connect(); const references: WeakRef<object>[] = [], probes = [];
  for (const prototype of [FileService.prototype, SandboxFileService.prototype]) {
    const prepare = prototype.prepareV3;
    probes.push(t.mock.method(prototype, "prepareV3", async function(this: any, ...args: any[]) {
      const item = await (prepare as any).apply(this, args); references.push(new WeakRef(item)); if (item.tree) references.push(new WeakRef(item.tree));
      if (item.remote) references.push(new WeakRef(item.remote.prepared)); return item;
    }));
  }
  let peakHeap = 0, peakRss = 0;
  function sampleMemory() { const memory = process.memoryUsage(); peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss); }
  const timer = setInterval(sampleMemory, 100), samples = [];
  try {
    await mkdir(join(cwd, "source"));
    for (let directory = 0; directory < 100; directory++) {
      const path = join(cwd, "source", String(directory)); await mkdir(path);
      for (let file = 0; file < 500; file++) await writeFile(join(path, String(file)), "x");
    }
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (const operation of ["copy", "move", "delete"] as const) {
      const start = performance.now(), cpu = process.cpuUsage();
      process.stdout.write(JSON.stringify({ fixture: "file-tree-v3-session", environment, operation, phase: "starting", files: 50000 }) + "\n");
      const input = operation === "copy" ? { path: "source", destination: "copied" } : operation === "move" ? { path: "copied", destination: "moved" } : { path: "moved", recursive: true };
      const result = await f.invoke(definitions, operation, input); assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.details.files, 50000); assert.equal(result.details.directories, 101); assert.equal(result.details.bytes, 50000); assert.equal(result.details.coverageComplete, true);
      if (operation === "delete") await assert.rejects(lstat(join(cwd, "moved")), { code: "ENOENT" });
      else for (let directory = 0; directory < 100; directory++) for (let file = 0; file < 500; file++)
        assert.equal(await readFile(join(cwd, operation === "copy" ? "copied" : "moved", String(directory), String(file)), "utf8"), "x");
      if (operation === "move") await assert.rejects(lstat(join(cwd, "copied")), { code: "ENOENT" });
      const reader = new FileResultReader(f.manager); try { const page = reader.read(result.details.resultRef); assert.equal(page.callComplete, true); assert.equal(page.coverageComplete, true); } finally { reader.dispose(); }
      const sample = { environment, operation, files: 50000, milliseconds: performance.now() - start, hostCpuMicroseconds: process.cpuUsage(cpu), diagnostics: owner?.diagnostics };
      samples.push(sample); process.stdout.write(JSON.stringify({ fixture: "file-tree-v3-session", phase: "verified", ...sample }) + "\n");
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling"); let sampledBytes = 0; const stack = [profile.head];
    while (stack.length) { const item = stack.pop()!; sampledBytes += item.selfSize; for (const child of item.children) stack.push(child); }
    const workerUsage = [];
    if (metricsPath) {
      const body = await readFile(metricsPath, "utf8"); assert(Buffer.byteLength(body) <= 65536);
      for (const row of body.trim().split("\n")) workerUsage.push(JSON.parse(row));
      assert.equal(workerUsage.length, owner!.diagnostics.fileRpcRequests); assert.equal(owner!.diagnostics.ownedArtifacts, 0);
    }
    await cleanup(); cleanup = undefined;
    for (const probe of probes) probe.mock.resetCalls();
    for (let count = 0; count < 4; count++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
    let retainedPlans = 0; for (const ref of references) if (ref.deref()) retainedPlans++;
    assert.equal(retainedPlans, 0); sampleMemory();
    t.diagnostic(JSON.stringify({ fixture: "file-tree-v3-session", environment, files: 50000, samples, peakHeap, peakRss, sampledBytes,
      sampledNotTotalAllocations: true, workerUsage, planReferences: references.length, retainedPlans, remainingArtifacts: owner?.diagnostics.ownedArtifacts ?? 0 }));
  } finally { clearInterval(timer); inspector.disconnect(); }
});
