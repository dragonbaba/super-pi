import assert from "node:assert/strict";
import test from "node:test";
import { planFileRpc, serializeFileRpc, fileRpcItemChunk, type FileRpcEnvelope } from "../packages/coding-agent/src/core/files/file-rpc-chunks.ts";
import { FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES } from "../packages/coding-agent/src/core/files/file-operation-limits.mjs";

const envelope: FileRpcEnvelope = { id: "rpc", mode: "sandbox-write", workspaces: ["C:/工作区", "D:/目标"], operation: "file_batch", exchange: "C:/exchange",
  maxWriteBytes: 1024 * 1024, callId: "call", requestHash: "a".repeat(64), generation: 1, workspaceIdentities: ["1:1", "2:2"] };
test("transport plans every one of 2,000 Unicode/escaped items within both budgets", () => {
  const input = [];
  for (let index = 0; index < 2000; index++) input.push(Object.freeze({ index, operation: index % 2 ? "delete" : "copy", path: "汉/\\\"\t".repeat(200) + index, destination: "D:/" + index, workspaceIndex: 0, destinationWorkspaceIndex: 1 }));
  const plan = planFileRpc(envelope, input);
  assert.equal(plan.itemCount, 2000); assert(plan.chunks.length > 1);
  assert(plan.replyReservationBytes <= FILE_RPC_REPLY_BYTES); assert(plan.maxRequestBytes <= FILE_RPC_REQUEST_BYTES);
  let next = 0;
  for (const chunk of plan.chunks) {
    assert.equal(chunk.start, next);
    for (const phase of ["prepare", "validate"] as const) {
      const encoded = serializeFileRpc(envelope, input, chunk, phase);
      assert(Buffer.byteLength(encoded.serialized) <= FILE_RPC_REQUEST_BYTES); assert.equal(encoded.bytes, Buffer.byteLength(encoded.serialized));
      const parsed = JSON.parse(encoded.serialized); assert.equal(parsed.phase, phase); assert.equal(parsed.items[0].index, next);
    }
    next = chunk.end;
  }
  assert.equal(next, 2000);
});
test("the last oversized item rejects whole-call transport preflight", () => {
  const items = [{ operation: "delete", path: "safe" }, { operation: "write", path: "last", content: "x".repeat(FILE_RPC_REQUEST_BYTES) }];
  assert.throws(() => planFileRpc(envelope, items), /Item 1.*no items executed/);
});
test("JSON escaping and complete envelope size participate in request preflight", () => {
  const items = [{ content: "\u0001".repeat(FILE_RPC_REQUEST_BYTES / 4) }];
  assert.throws(() => planFileRpc(envelope, items), /BUDGET/);
  assert.throws(() => planFileRpc({ ...envelope, exchange: "x".repeat(FILE_RPC_REQUEST_BYTES) }, [{ path: "a" }]), /BUDGET/);
});
test("a transport chunk binds original item bodies and global sequence", () => {
  const items = [{ index: 0, path: "a" }, { index: 1, path: "b" }], plan = planFileRpc(envelope, items);
  items[1].path = "changed";
  assert.throws(() => serializeFileRpc(envelope, items, plan.chunks[0], "validate"), /manifest changed/);
  assert.throws(() => serializeFileRpc(envelope, items, plan.chunks[0], "execute"), /exactly one published intent/);
});
test("single-effect envelopes retain global indexes and reserve prepared/ready/intent facts", () => {
  const items = [{ index: 0, path: "a" }, { index: 1, path: "b" }];
  planFileRpc(envelope, items);
  const control = { readyHash: "a".repeat(64), intentId: "actual-published-id", prepared: [{ name: "host-assigned", sha256: "b".repeat(64), device: "1", inode: "2", bytes: 1234, records: 5 }] };
  const encoded = serializeFileRpc(envelope, items, fileRpcItemChunk(envelope, items, 1), "execute", control), request = JSON.parse(encoded.serialized);
  assert.equal(request.start, 1); assert.equal(request.itemCount, 2); assert.equal(request.items.length, 1); assert.equal(request.items[0].index, 1);
  assert.deepEqual(request.control, control); assert.equal(encoded.bytes, Buffer.byteLength(encoded.serialized)); assert(encoded.bytes <= FILE_RPC_REQUEST_BYTES);
});
