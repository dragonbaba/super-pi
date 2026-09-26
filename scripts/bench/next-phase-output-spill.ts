// Measurement-only slow filesystem injection. Every temporary path belongs to this process.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { costSession, costCall, costText } from "../../tests/helpers/next-phase-session.ts";

const originalOpen = fs.openSync, originalCreate = fs.createWriteStream, originalWrite = (fs.WriteStream.prototype as any)._write, originalWritev = (fs.WriteStream.prototype as any)._writev;
const originalTmp = process.env.TMP, originalTemp = process.env.TEMP, originalTmpdir = process.env.TMPDIR;
let scope = "", firstOpenMs: number | undefined, start = 0, writes = 0, maxQueuedBytes = 0, pendingWrites = 0, delayMs = 0;
let cancel: (() => void) | undefined, cancelledAt: number | undefined;
const streams = new Set<fs.WriteStream>();
const descriptors = new Set<number>();
function ownedPath(path: unknown): boolean { return typeof path === "string" && path.startsWith(join(scope, "sp-bash-")); }
(fs as any).openSync = function measuredOpen(path: any, ...args: any[]) {
  const measured = ownedPath(path), before = performance.now();
  if (measured && delayMs) { const until = before + delayMs; while (performance.now() < until) {} }
  const fd = (originalOpen as any)(path, ...args); if (measured) { descriptors.add(fd); if (firstOpenMs === undefined) firstOpenMs = performance.now() - start; }
  return fd;
};
(fs as any).createWriteStream = function measuredCreate(path: any, options: any) {
  const stream = originalCreate(path, options); if (descriptors.has(options?.fd)) streams.add(stream); return stream;
};
function measureWrite(stream: fs.WriteStream, vector: boolean, chunk: any, encoding: any, callback: any) {
  if (!streams.has(stream)) return vector ? originalWritev.call(stream, chunk, callback) : originalWrite.call(stream, chunk, encoding, callback);
  writes++; pendingWrites++;
  maxQueuedBytes = Math.max(maxQueuedBytes, stream.writableLength);
  if (cancel && cancelledAt === undefined) { cancelledAt = performance.now(); cancel(); }
  const done = (error?: Error | null) => { pendingWrites--; callback(error); };
  const write = () => vector ? originalWritev.call(stream, chunk, done) : originalWrite.call(stream, chunk, encoding, done);
  if (delayMs) setTimeout(write, delayMs); else write();
}
(fs.WriteStream.prototype as any)._write = function measuredWrite(chunk: any, encoding: any, callback: any) { return measureWrite(this, false, chunk, encoding, callback); };
(fs.WriteStream.prototype as any)._writev = function measuredWritev(chunks: any, callback: any) { return measureWrite(this, true, chunks, undefined, callback); };
syncBuiltinESMExports();
try {
  for (const scenario of ["first-spill", "cap", "slow", "cancel"] as const) {
    const f = await costSession(), ownedTemp = join(f.root, "large-temp"); fs.mkdirSync(ownedTemp); scope = ownedTemp;
    // The bounded old-file scan sees a deliberately large directory of harmless fixture entries.
    for (let index = 0; index < 1024; index++) fs.writeFileSync(join(ownedTemp, `entry-${index}`), "");
    process.env.TMP = process.env.TEMP = process.env.TMPDIR = ownedTemp; assert.equal(tmpdir(), ownedTemp);
    firstOpenMs = undefined; writes = 0; maxQueuedBytes = 0; pendingWrites = 0; cancelledAt = undefined; streams.clear(); descriptors.clear();
    delayMs = scenario === "slow" || scenario === "cancel" ? 8 : 0; cancel = scenario === "cancel" ? () => f.session.agent.abort() : undefined;
    const source = scenario === "cancel" ? "let n=0;const timer=setInterval(()=>{process.stdout.write('x'.repeat(65536));if(++n===100)clearInterval(timer)},5)"
      : `process.stdout.write('x'.repeat(${scenario === "cap" ? 6 * 1024 * 1024 : 256 * 1024})+'\\nFINAL-TAIL')`;
    const command = `node -e "${source}"`;
    const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable(); global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(); start = performance.now();
    try {
      await f.run([[costCall("spill", "bash", { command, cwd: f.cwd })]]);
      const result = f.result("spill"), end = performance.now(), used = process.cpuUsage(cpu); delay.disable();
      assert.ok(firstOpenMs !== undefined, JSON.stringify(result)); assert.ok(writes > 0); assert.equal(pendingWrites, 0);
      for (const stream of streams) assert.equal(stream.closed, true);
      const path = result.details?.fullOutputPath; let fileBytes: number | undefined;
      if (path) { assert.equal(dirname(path), ownedTemp); fileBytes = fs.statSync(path).size; assert.ok(fileBytes <= 5 * 1024 * 1024); }
      if (scenario === "cap") { assert.equal(fileBytes, 5 * 1024 * 1024); assert.ok(fs.readFileSync(path, "utf8").includes("spill file capped at 5 MiB")); }
      if (scenario !== "cancel") { assert.equal(result.isError, false, JSON.stringify(result)); assert.ok(costText(result).includes("FINAL-TAIL")); }
      else { assert.equal(result.isError, true); assert.ok(cancelledAt !== undefined); }
      console.log(JSON.stringify({ benchmark: "N4-output-spill", implementation: process.env.SP_COST_LABEL ?? "candidate", scenario, node: process.version,
        injectedOpenAndWriteDelayMs: delayMs, temporaryEntries: 1024, firstOpenMs, elapsedMs: end - start, cancelSettlementMs: cancelledAt === undefined ? null : end - cancelledAt,
        cpuUs: used.user + used.system, eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopP99Ms: delay.percentile(99) / 1e6, eventLoopMaxMs: delay.max / 1e6,
        writes, maxQueuedBytes, fileBytes, closedStreams: streams.size, pendingWrites, heapBefore, sampledPeakHeap: f.metrics.sampledPeakHeap,
        shellFacts: result.details?.shellExecution ?? null, quality: "real default SDK process/output/cap/cancellation and settled streams" }));
    } finally {
      delay.disable(); cancel = undefined; streams.clear(); descriptors.clear(); scope = ""; delayMs = 0;
      if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp;
      if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp;
      if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
      await f.release();
    }
    global.gc?.(); console.log(JSON.stringify({ release: "N4-output-spill", scenario, heapAfterRelease: process.memoryUsage().heapUsed, removedRoot: !fs.existsSync(f.root), pendingWrites }));
  }
} finally { fs.openSync = originalOpen; fs.createWriteStream = originalCreate; (fs.WriteStream.prototype as any)._write = originalWrite; (fs.WriteStream.prototype as any)._writev = originalWritev; syncBuiltinESMExports(); }
