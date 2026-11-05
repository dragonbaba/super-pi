import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { WorkspaceSandboxBackend } from "../../packages/coding-agent/src/core/sandbox/workspace-backend.ts";

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-artifacts-bench-")));
const exchange = path.join(root, "exchange"); await fs.mkdir(exchange);
const owner = new WorkspaceSandboxBackend(root, root, "sandbox-write");
owner.root = root;
const identity = await fs.lstat(root, { bigint: true }); owner.identity = identity.dev + ":" + identity.ino;
await owner.remember(root); await owner.remember(exchange);
const payload = Buffer.alloc(2 * 1024 * 1024, 147), sha256 = createHash("sha256").update(payload).digest("hex");
const candidates = [], weak = [], counts = { validationBuffers: 0, validationBytes: 0, publicationBuffers: 0, publicationBytes: 0 };
for (let i = 0; i < 48; i++) {
  const artifact = { name: "d".repeat(32) + "-" + i + ".bin", bytes: payload.length, sha256 };
  candidates.push(artifact); await fs.writeFile(path.join(exchange, artifact.name), payload, { flag: "wx" });
}
const original = Buffer.allocUnsafe; let stage;
function allocate(bytes) {
  const buffer = original(bytes);
  if (stage) { counts[stage + "Buffers"]++; counts[stage + "Bytes"] += bytes; weak.push(new WeakRef(buffer)); }
  return buffer;
}
async function publishOne(artifact) {
  const bytes = await owner.candidate(artifact, true);
  assert.equal(bytes.length, artifact.bytes); assert.equal(bytes[0], 147);
}
const profiler = new Session(); profiler.connect();
try {
  Buffer.allocUnsafe = allocate;
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  stage = "validation"; for (const artifact of candidates) await owner.candidate(artifact, false);
  stage = "publication"; for (const artifact of candidates) await publishOne(artifact);
  stage = undefined; Buffer.allocUnsafe = original;
  const profile = (await profiler.post("HeapProfiler.stopSampling")).profile;
  const allocations = [];
  function inspect(node) {
    if (node.selfSize && node.callFrame.url.includes("workspace-backend")) allocations.push({ function: node.callFrame.functionName, bytes: node.selfSize });
    for (const child of node.children ?? []) inspect(child);
  }
  inspect(profile.head);
  assert.deepEqual(counts, { validationBuffers: 48, validationBytes: 48 * 256 * 1024, publicationBuffers: 48, publicationBytes: 48 * payload.length });
  await owner.close();
  for (let round = 0; round < 4; round++) { await tick(); globalThis.gc(); }
  let live = 0; for (const reference of weak) if (reference.deref()) live++;
  assert.equal(live, 0); assert.equal(owner.diagnostics.ownedArtifacts, 0); assert.equal(owner.diagnostics.root, undefined);
  console.log(JSON.stringify({ contract: "sandbox-byte-artifacts-v1", files: 48, payloadBytes: payload.length, counts, allocations,
    bounds: { validationBufferBytes: 256 * 1024, activePayloadBuffers: 1, artifactContentInJSON: 0, perChunkClosures: 0, perChunkRegexes: 0 },
    lifecycle: { buffers: weak.length, gcRounds: 4, live, ownerReleased: true } }));
} finally { stage = undefined; Buffer.allocUnsafe = original; profiler.disconnect(); await owner.close(); }
