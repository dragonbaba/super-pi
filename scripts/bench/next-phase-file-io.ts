// Explicit diagnostic process: wrappers/coverage never ship in production imports.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
import { Session } from "node:inspector/promises";
import { costSession, costCall, costText, costModule } from "../../tests/helpers/next-phase-session.ts";
import { FIXTURE_SNAPSHOT_ID_PATTERN, FIXTURE_SECOND_LINE_ANCHOR_PATTERN } from "../../tests/helpers/next-phase-fixture-regex.ts";

const originalOpen = fsp.open, originalReadFile = fsp.readFile, originalReadSync = fs.readFileSync, originalUpdate = crypto.Hash.prototype.update;
let scope = "", scopeAlias = "", active = false;
let counters = { bytesRead: 0, hashBytes: 0, hashUpdates: 0, explicitOpens: 0, explicitCloses: 0, implicitReadFiles: 0, activeHandles: 0, peakHandles: 0 };
function scoped(path: unknown): boolean { return active && typeof path === "string" && (path.startsWith(scope) || path.startsWith(scopeAlias)); }
function byteLength(value: any): number { return typeof value === "string" ? Buffer.byteLength(value) : value.byteLength; }
(fsp as any).open = async function measuredOpen(path: any, ...args: any[]) {
  const handle = await (originalOpen as any)(path, ...args); if (!scoped(path)) return handle;
  counters.explicitOpens++; counters.activeHandles++; counters.peakHandles = Math.max(counters.peakHandles, counters.activeHandles);
  const read = handle.read, readFile = handle.readFile, close = handle.close; let closed = false, wholeRead = false;
  handle.read = async function measuredRead(...readArgs: any[]) { const result = await read.apply(this, readArgs); if (!wholeRead) counters.bytesRead += result.bytesRead; return result; };
  handle.readFile = async function measuredHandleReadFile(...readArgs: any[]) { wholeRead = true; try { const result = await readFile.apply(this, readArgs); counters.bytesRead += byteLength(result); return result; } finally { wholeRead = false; } };
  handle.close = async function measuredClose() { await close.call(this); if (!closed) { closed = true; counters.explicitCloses++; counters.activeHandles--; } };
  return handle;
};
(fsp as any).readFile = async function measuredReadFile(path: any, ...args: any[]) { const result = await (originalReadFile as any)(path, ...args); if (scoped(path)) { counters.implicitReadFiles++; counters.bytesRead += byteLength(result); } return result; };
(fs as any).readFileSync = function measuredReadFileSync(path: any, ...args: any[]) { const result = (originalReadSync as any)(path, ...args); if (scoped(path)) { counters.implicitReadFiles++; counters.bytesRead += byteLength(result); } return result; };
crypto.Hash.prototype.update = function measuredUpdate(value: any, encoding?: any): any { if (active) { counters.hashUpdates++; counters.hashBytes += typeof value === "string" ? Buffer.byteLength(value, encoding) : value.byteLength; } return originalUpdate.call(this, value, encoding); };
syncBuiltinESMExports();
const profiler = new Session(); profiler.connect(); await profiler.post("Profiler.enable");
const tracked = new Set(["prepareExactEditContent", "prepareEdits", "prepareCompactEdits", "generateDiffString", "generateUnifiedPatch"]);
async function run(count: number, size: number, kind: "exact" | "snapshot") {
  const f = await costSession();
  try {
  scope = fs.realpathSync.native(f.cwd) + sep; scopeAlias = f.cwd + sep;
  const line = "data=" + "x".repeat(122) + "\n";
  const before = "FIRST\nSECOND\n" + line.repeat(Math.ceil((size - 14) / line.length)).slice(0, size - 14) + "\n", after = before.replace("SECOND", "CHANGED");
  assert.equal(Buffer.byteLength(before), size);
  for (let index = 0; index < count; index++) fs.writeFileSync(join(f.cwd, `file${index}`), before);
  await f.run([[costCall("discover", "tool_search", { query: "file_batch", limit: 1 })]]);
  counters = { bytesRead: 0, hashBytes: 0, hashUpdates: 0, explicitOpens: 0, explicitCloses: 0, implicitReadFiles: 0, activeHandles: 0, peakHandles: 0 };
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = performance.now();
  f.metrics.sampledPeakHeap = heapBefore;
  await profiler.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true }); active = true;
  let unavailableSnapshots = 0;
    // At most three 2MiB snapshots coexist under the unchanged 8MiB resident bound.
    // Sixteen-file tasks use explicit read/edit groups; no eviction/safety bypass.
    for (let offset = 0; offset < count; offset += 3) {
      const operations: any[] = [];
      for (let index = offset; index < Math.min(count, offset + 3); index++) {
        await f.run([[costCall(`read${index}`, "read", { path: `file${index}`, offset: 1, limit: 2 })]]);
        const read = f.result(`read${index}`); assert.equal(read.isError, false, JSON.stringify(read));
        if (kind === "exact") operations.push({ operation: "edit", path: `file${index}`, edits: [{ oldText: "SECOND", newText: "CHANGED" }] });
        else {
          const text = costText(read), snapshot = FIXTURE_SNAPSHOT_ID_PATTERN.exec(text)?.[1], anchor = FIXTURE_SECOND_LINE_ANCHOR_PATTERN.exec(text)?.[0];
          if (!snapshot || !anchor) { unavailableSnapshots++; continue; }
          operations.push({ operation: "edit", path: `file${index}`, snapshot, edits: [{ kind: "replace", start: anchor, newLines: ["CHANGED"] }] });
        }
      }
      if (operations.length) { const id = `edit${offset}`; await f.run([[costCall(id, "file_batch", { operations })]]); assert.equal(f.result(id).isError, false, JSON.stringify(f.result(id))); }
    }
    active = false; const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    const coverage = await profiler.post("Profiler.takePreciseCoverage"); await profiler.post("Profiler.stopPreciseCoverage");
    const calls: Record<string, number> = {};
    for (const script of coverage.result) for (const fn of script.functions) if (tracked.has(fn.functionName)) {
      const name = script.url.slice(script.url.lastIndexOf("/") + 1) + ":" + fn.functionName; calls[name] = (calls[name] ?? 0) + fn.ranges[0].count;
    }
    assert.ok(unavailableSnapshots === 0 || unavailableSnapshots === count);
    for (let index = 0; index < count; index++) assert.equal(fs.readFileSync(join(f.cwd, `file${index}`), "utf8"), unavailableSnapshots ? before : after);
    assert.equal(counters.activeHandles, 0); assert.equal(counters.explicitOpens, counters.explicitCloses);
    console.log(JSON.stringify({ benchmark: "N4-file-io", implementation: process.env.SP_COST_LABEL ?? "candidate", node: process.version, count, size, kind, grouping: 3,
      ...counters, calls, elapsedMs, cpuUs: used.user + used.system, heapBefore, sampledPeakHeap: f.metrics.sampledPeakHeap,
      unavailableSnapshots, measuredScope: "fixture file bytes/API explicit handles; hash updates include request/proof/commit; readFile implicit opens are separate; precise counts only synchronous named constructors",
      quality: unavailableSnapshots ? "default window read issued no snapshot; no edit/fallback; all bytes unchanged" : "exact final bytes and no active explicit handles" }));
  } finally { active = false; try { await profiler.post("Profiler.stopPreciseCoverage"); } finally { await f.release(); } }
  global.gc?.(); console.log(JSON.stringify({ release: "N4-file-io", count, size, kind, heapAfterFixtureRelease: process.memoryUsage().heapUsed, removedRoot: !fs.existsSync(f.root) }));
}
async function runLegacyCompact(count: number) {
  const { createReadToolDefinition } = await costModule("packages/coding-agent/src/core/tools/read.ts");
  const { issueSnapshotForRead, executeSnapshotLineEdit, resetSnapshotLineStore } = await costModule("packages/extensions/mutation-guard-write/snapshot-line-edit.ts");
  const f = await costSession(), size = 8 * 1024 * 1024;
  try {
  const original = "FIRST\nSECOND\n" + "filler\n".repeat(Math.ceil(size / 7));
  const read = createReadToolDefinition(f.cwd, { operations: { access: (path: string) => fsp.access(path), readFile: (path: string) => fsp.readFile(path), detectImageMimeType: async () => null } });
  for (let index = 0; index < count; index++) fs.writeFileSync(join(f.cwd, `legacy${index}.txt`), original);
  scope = fs.realpathSync.native(f.cwd) + sep; scopeAlias = f.cwd + sep;
  counters = { bytesRead: 0, hashBytes: 0, hashUpdates: 0, explicitOpens: 0, explicitCloses: 0, implicitReadFiles: 0, activeHandles: 0, peakHandles: 0 };
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = performance.now(); let commits = 0, peakHeap = heapBefore;
  await profiler.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true }); active = true;
    for (let index = 0; index < count; index++) {
      const path = join(f.cwd, `legacy${index}.txt`), input = { path, offset: 1, limit: 2 };
      const result = await read.execute(`legacy-read${index}`, input, undefined, undefined, {});
      const annotation = await issueSnapshotForRead(f.manager.getSessionId(), f.cwd, input, result); assert.ok(annotation);
      const snapshot = FIXTURE_SNAPSHOT_ID_PATTERN.exec(annotation)?.[1], anchor = FIXTURE_SECOND_LINE_ANCHOR_PATTERN.exec(costText(result))?.[0]; assert.ok(snapshot && anchor);
      await executeSnapshotLineEdit(f.manager.getSessionId(), f.cwd, path, snapshot, [{ kind: "replace", start: anchor, newLines: ["CHANGED"] }], undefined,
        { assertPathAllowed: () => fsp.realpath(path), beforeCommit() { commits++; } });
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    active = false; const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu), coverage = await profiler.post("Profiler.takePreciseCoverage");
    const calls: Record<string, number> = {};
    for (const script of coverage.result) for (const fn of script.functions) if (tracked.has(fn.functionName)) calls[fn.functionName] = (calls[fn.functionName] ?? 0) + fn.ranges[0].count;
    for (let index = 0; index < count; index++) assert.equal(fs.readFileSync(join(f.cwd, `legacy${index}.txt`), "utf8"), original.replace("SECOND", "CHANGED"));
    assert.equal(commits, count); assert.equal(counters.activeHandles, 0);
    console.log(JSON.stringify({ benchmark: "N4-file-io-legacy-compact", implementation: process.env.SP_COST_LABEL ?? "candidate", count, size: Buffer.byteLength(original),
      ...counters, calls, commits, elapsedMs, cpuUs: used.user + used.system, heapBefore, sampledPeakHeap: peakHeap,
      measuredScope: "existing custom-I/O read projection and compact snapshot subsystem; explicit fixture path hooks, not default SDK authorization", quality: "real read-issued compact snapshots and exact postimages" }));
  } finally { active = false; try { await profiler.post("Profiler.stopPreciseCoverage"); } finally { resetSnapshotLineStore(); await f.release(); } }
  global.gc?.(); console.log(JSON.stringify({ release: "N4-file-io-legacy-compact", count, heapAfterFixtureRelease: process.memoryUsage().heapUsed, removedRoot: !fs.existsSync(f.root) }));
}
try {
  for (const size of [4096, 256 * 1024, 2 * 1024 * 1024 - 1, 8 * 1024 * 1024]) for (const count of [1, 4, 16]) for (const kind of ["exact", "snapshot"] as const) await run(count, size, kind);
  for (const count of [1, 4, 16]) await runLegacyCompact(count);
} finally {
  active = false; fsp.open = originalOpen; fsp.readFile = originalReadFile; fs.readFileSync = originalReadSync; crypto.Hash.prototype.update = originalUpdate; syncBuiltinESMExports(); profiler.disconnect();
  const native = await costModule("packages/extensions/mutation-guard-write/native-file-client.ts").catch(() => undefined);
  if (native) { await native.disposeNativeFileWorker(); assert.equal(native.nativeFileDiagnostics().pending, 0); assert.equal(native.nativeFileDiagnostics().loaded, false); }
}
