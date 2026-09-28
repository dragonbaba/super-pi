import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Session } from "node:inspector/promises";
import { createJiti } from "jiti";

// Explicit benchmark only; optional source path permits an isolated historical comparison.
assert.ok(global.gc, "run with --expose-gc");
const source = resolve(process.argv[2] ?? "packages/lsp/src/files.ts");
const root = fs.mkdtempSync(join(tmpdir(), "sp-lsp-allocation-"));
const originalRead = fs.readdirSync;
const inspector = new Session();
const refs = [];
let directoryReads = 0, sampledBytes = 0, submittedFiles = 0;
try {
  for (let dir = 0; dir < 10; dir++) {
    const target = join(root, `dir-${dir}`); fs.mkdirSync(target);
    for (let file = 0; file < 100; file++) fs.writeFileSync(join(target, `${file}.ts`), "const fixture = 1;");
  }
  fs.readdirSync = function (...args) {
    if (typeof args[0] === "string" && (args[0] === root || args[0].startsWith(root + "/") || args[0].startsWith(root + "\\"))) directoryReads++;
    return Reflect.apply(originalRead, fs, args);
  };
  syncBuiltinESMExports();
  const jiti = createJiti(import.meta.url);
  const { collectSupportedFilesByAdapter } = await jiti.import(source);
  const adapters = Array.from({ length: 21 }, (_, index) => {
    const extension = index === 0 ? ".ts" : `.missing${index}`;
    return { name: `fixture-${index}`, extensions: [extension], skipDirectories: new Set(), isSupportedFile(file) { return file.endsWith(extension); } };
  });
  collectSupportedFilesByAdapter(adapters, root, undefined, 50);
  directoryReads = 0; global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let scan = 0; scan < 20; scan++) {
    let result = collectSupportedFilesByAdapter(adapters, root, undefined, 50);
    submittedFiles += result.get(adapters[0]).files.length;
    refs.push(new WeakRef(result)); result = undefined;
  }
  let { profile } = await inspector.post("HeapProfiler.stopSampling");
  await inspector.post("HeapProfiler.disable"); inspector.disconnect();
  const nodes = [profile.head];
  while (nodes.length) { const node = nodes.pop(); sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
  profile = undefined;
  await new Promise(resolve => setImmediate(resolve)); global.gc();
  const retainedResultMaps = refs.filter(ref => ref.deref() !== undefined).length;
  assert.equal(directoryReads, 220); assert.equal(submittedFiles, 1000); assert.equal(retainedResultMaps, 0);
  console.log(JSON.stringify({ sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"), node: process.version, platform: process.platform,
    scans: 20, filesPerScan: 1000, adapters: 21, directoryReads, submittedFiles, retainedResultMaps,
    sampledBytes, heapBefore, heapAfterRelease: process.memoryUsage().heapUsed }, null, 2));
} finally {
  inspector.disconnect(); fs.readdirSync = originalRead; syncBuiltinESMExports();
  assert.equal(dirname(root), tmpdir()); fs.rmSync(root, { recursive: true, force: true });
}
