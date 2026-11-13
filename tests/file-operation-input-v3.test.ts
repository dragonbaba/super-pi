import assert from "node:assert/strict";
import test from "node:test";
import { copyNativeInvocation, validateNativeInvocation, type NativeFileOperation } from "../packages/coding-agent/src/core/files/file-operation-input.ts";
import { mutationRequestHash, nativeItemRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";

test("native scalar forms stay compatible and nonempty arrays have no count cap", () => {
  for (const operation of ["copy", "delete", "move"] as const) {
    const scalar = operation === "delete" ? { path: "a", recursive: true } : { path: "a", destination: "b" };
    assert.equal(copyNativeInvocation(operation, scalar).items.length, 1);
    const paths = [], items = [];
    for (let index = 0; index < 2000; index++) { paths.push("源/" + index); items.push({ path: "源/" + index, destination: "目标/" + index }); }
    const normalized = copyNativeInvocation(operation, operation === "delete" ? { paths, recursive: true } : { items });
    assert.equal(normalized.items.length, 2000); assert.equal(normalized.arrayMode, true); assert(Object.isFrozen(normalized.items[1999]));
    for (const item of normalized.items) assert.doesNotThrow(() => validateNativeInvocation(operation, item));
  }
});
test("mixed forms, empty arrays, incomplete pairs and wrong-operation flags reject", () => {
  const invalid: Array<[NativeFileOperation, unknown]> = [
    ["delete", { paths: [] }], ["delete", { path: "a", paths: ["b"] }], ["delete", { path: "a", destination: "b" }],
    ["copy", { items: [] }], ["move", { items: [{ path: "a" }] }], ["copy", { destination: "b" }],
    ["copy", { path: "a", destination: "b", items: [{ path: "x", destination: "y" }] }],
    ["move", { path: "a", destination: "b", overwrite: false }], ["copy", { path: "a", destination: "b", recursive: true }],
    ["delete", { path: "a", recursive: "yes" }], ["delete", { paths: ["*"] }], ["delete", { paths: ["a\0"] }],
  ];
  for (const [operation, input] of invalid) assert.throws(() => copyNativeInvocation(operation, input), /TOOL_ARGS_INVALID/);
  const accessor = Object.defineProperty({}, "path", { get() { throw new Error("getter must not run"); }, enumerable: true });
  assert.throws(() => copyNativeInvocation("delete", accessor), /accessor/);
});
test("copied targets cannot be changed by caller edits after preflight", () => {
  const raw = { items: [{ path: "a", destination: "b" }], overwrite: true };
  const copy = copyNativeInvocation("copy", raw), before = mutationRequestHash("copy", raw);
  raw.items[0].destination = "external";
  assert.equal(copy.items[0].destination, "b"); assert.notEqual(mutationRequestHash("copy", raw), before);
  assert.notEqual(mutationRequestHash("delete", { paths: ["a"], recursive: true }), mutationRequestHash("delete", { paths: ["a"], recursive: false }));
  assert.notEqual(mutationRequestHash("copy", { items: [{ path: "a", destination: "b" }], overwrite: true }), mutationRequestHash("copy", { items: [{ path: "a", destination: "b" }], overwrite: false }));
});
test("direct per-item hashes equal normalized item bindings, including Unicode and false flags", () => {
  const cases = [
    ["copy", { items: [{ path: "汉/é", destination: "q\\x" }], overwrite: false, purpose: "purpose", dryRun: false }],
    ["delete", { paths: ["a", "汉"], recursive: true }], ["move", { path: "a", destination: "b", dryRun: false }],
  ] as const;
  for (const [operation, input] of cases) {
    const normalized = copyNativeInvocation(operation, input);
    for (let index = 0; index < normalized.items.length; index++) assert.equal(nativeItemRequestHash(operation, input as any, index), mutationRequestHash(operation, normalized.items[index]));
  }
});
