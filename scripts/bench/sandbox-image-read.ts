import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { WorkspaceSandboxBackend } from "../../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { detectSupportedImageMimeType } from "../../packages/coding-agent/src/utils/mime.ts";

assert.ok(globalThis.gc, "run with --expose-gc");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "image-allocation-")));
const exchange = path.join(root, "exchange"); await fs.mkdir(exchange);
const backend = new WorkspaceSandboxBackend(root, root, "read-only");
(backend as any).root = root;
const bytes = Buffer.alloc(2 * 1024 * 1024); Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
const artifact = { name: "a".repeat(32) + "-0.bin", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const weak: WeakRef<Buffer>[] = [];
const allocate = Buffer.allocUnsafe;
let allocations = 0, allocatedBytes = 0;
function counted(size: number) { allocations++; allocatedBytes += size; return allocate(size); }
try {
  for (let i = 0; i < 24; i++) {
    await fs.writeFile(path.join(exchange, artifact.name), bytes);
    Buffer.allocUnsafe = counted;
    let payload: Buffer | undefined;
    try { payload = await backend.candidate(artifact, true); } finally { Buffer.allocUnsafe = allocate; }
    assert.ok(payload); assert.equal(detectSupportedImageMimeType(payload), "image/png");
    weak.push(new WeakRef(payload)); payload = undefined;
    await backend.releaseArtifact(artifact);
  }
  for (let i = 0; i < 4; i++) { await nextTurn(); globalThis.gc!(); }
  let retained = 0; for (const ref of weak) if (ref.deref()) retained++;
  assert.equal(allocations, 24); assert.equal(allocatedBytes, 24 * bytes.length); assert.equal(retained, 0);
  assert.deepEqual(await fs.readdir(exchange), []);
  console.log(JSON.stringify({ reads: 24, payloadBytes: bytes.length, payloadAllocations: allocations, cumulativeAllocatedBytes: allocatedBytes,
    retainedPayloadsAfterFourGC: retained, attachmentsRemaining: 0, concurrentPayloads: 1, scope: "validated attachment transport; codec allocation covered by image-encoding-selection" }));
} finally {
  Buffer.allocUnsafe = allocate; (backend as any).root = undefined; await backend.close();
  assert.equal(await fs.realpath(root), root); await fs.rmdir(exchange); await fs.rmdir(root);
}
