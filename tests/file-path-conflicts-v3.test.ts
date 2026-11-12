import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { assertIndependent } from "../packages/coding-agent/src/core/files/file-path-conflicts.ts";
import type { PathIdentity } from "../packages/coding-agent/src/core/files/native-file-core.ts";

function item(path: string, index: number, existing = false) {
  const target = resolve(path);
  return { itemId: String(index), target, paths: [target], identity: existing ? { device: "1", inode: String(index) } as PathIdentity : undefined };
}
test("segment trie finds ancestor conflicts separated by lexical siblings in either order", () => {
  for (const entries of [[item("a", 0), item("a-other", 1), item("a/child", 2)], [item("a/child", 0), item("a-other", 1), item("a", 2)]]) {
    assert.throws(() => assertIndependent(entries), /overlap/);
  }
  assert.doesNotThrow(() => assertIndependent([item("a", 0), item("a-other", 1), item("abc", 2)]));
});
test("existing Linux case-sensitive paths and prospective ambiguity keep different roles", () => {
  const distinct = [item("CASE", 0, true), item("case", 1, true)];
  if (process.platform === "win32") assert.throws(() => assertIndependent(distinct), /overlap/);
  else assert.doesNotThrow(() => assertIndependent(distinct));
  assert.throws(() => assertIndependent([item("CASE", 0, true), item("case/new", 1)]), /overlap/);
  assert.throws(() => assertIndependent([item("case", 0), item("CASE/new", 1, true)]), /overlap/);
  assert.throws(() => assertIndependent([item("é", 0), item("e\u0301/next", 1, true)]), /overlap/);
});
test("identity aliases and self-overlapping destination are rejected", () => {
  const a = item("a", 0, true), b = item("b", 0, true);
  assert.throws(() => assertIndependent([a, b]), /share a file identity/);
  const c = item("c", 2, true); c.paths.push(resolve("c/destination"));
  assert.throws(() => assertIndependent([c]), /overlap/);
});
test("tree child identities may repeat within one item and cannot alias another top-level item", () => {
  const root = item("directory", 0, true), child = { device: "1", inode: "child" } as PathIdentity;
  const tree = { ...root, native: { tree: { entries: [{ identity: root.identity! }, { identity: child }, { identity: child }] } } };
  assert.equal(assertIndependent([tree]).identities, 2);
  assert.throws(() => assertIndependent([tree, { ...item("external-alias", 1, true), identity: child }]), /share a file identity/);
  assert.throws(() => assertIndependent([{ ...item("external-alias", 1, true), identity: child }, tree]), /share a file identity/);
});
test("shared missing parents allow exact spelling and reject ambiguous spelling on Linux", () => {
  const a = { ...item("shared/a", 0), creation: { directories: [resolve("shared")] } };
  const b = { ...item("shared/b", 1), creation: { directories: [resolve("shared")] } };
  assert.doesNotThrow(() => assertIndependent([a, b]));
  if (process.platform !== "win32") {
    b.creation.directories[0] = resolve("SHARED");
    assert.throws(() => assertIndependent([a, b]), /missing shared parent/i);
  }
});
test("deterministic path visits stay linear at increasing equivalent sizes", t => {
  for (const count of [100, 1000, 10000]) {
    const items = [];
    for (let index = 0; index < count; index++) items.push(item(`root/dir-${index}/leaf`, index, true));
    const start = performance.now(), cpu = process.cpuUsage(), before = process.memoryUsage();
    const counters = assertIndependent(items);
    assert.equal(counters.paths, count); assert.equal(counters.identities, count);
    assert(counters.visits <= count * 40); assert(counters.nodes <= count * 5 + 30);
    const after = process.memoryUsage();
    t.diagnostic(JSON.stringify({ targets: count, ...counters, milliseconds: performance.now() - start, cpuMicroseconds: process.cpuUsage(cpu),
      heapDeltaBytes: after.heapUsed - before.heapUsed, rss: after.rss }));
  }
});
