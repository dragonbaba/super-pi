import assert from "node:assert/strict";
import test from "node:test";
import { resolve, join } from "node:path";
import { workspaceMutationItems } from "../packages/coding-agent/src/core/sandbox/workspace-paths.ts";
import { workspaceFilePath, validFileIdentity } from "../packages/coding-agent/src/core/files/file-workspace-path.mjs";
import { nativeItemRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";

test("v3 source/destination workspace assignments are independent for 2,000 targets", () => {
  const primary = resolve("primary"), sourceRoot = resolve("source-root"), destinationRoot = resolve("destination-root"), items = [];
  for (let index = 0; index < 2000; index++) items.push({ path: join(sourceRoot, "source-" + index), destination: index % 2 ? join(destinationRoot, "target-" + index) : "target-" + index });
  const input = { items, overwrite: true }, result = workspaceMutationItems(primary, "copy", input, [sourceRoot, destinationRoot]);
  assert.equal(result.length, 2000);
  for (let index = 0; index < result.length; index++) {
    assert.equal(result[index].workspaceIndex, 1); assert.equal(result[index].destinationWorkspaceIndex, index % 2 ? 2 : 0);
    assert.equal(result[index].inputHash, nativeItemRequestHash("copy", input, index)); assert.equal(result[index].overwrite, true);
    assert.equal(workspaceFilePath([primary, sourceRoot, destinationRoot], result[index].workspaceIndex, result[index].path), items[index].path);
  }
});

test("host path table binds alias expansion and rejects incomplete or model-assigned identities", () => {
  const primary = resolve("primary"), additional = resolve("added"), input = { path: "alias/source", destination: "relative-destination" };
  const result = workspaceMutationItems(primary, "move", input, [additional], [join(additional, "source"), join(primary, "relative-destination")]);
  assert.equal(result[0].workspaceIndex, 1); assert.equal(result[0].destinationWorkspaceIndex, 0);
  assert.throws(() => workspaceMutationItems(primary, "move", input, [additional], [join(additional, "source")]), /path|Path|undefined/);
  assert.throws(() => workspaceMutationItems(primary, "copy", { ...input, workspaceIndex: 1 }, [additional]), /TOOL_ARGS_INVALID|assigned/);
  assert.throws(() => workspaceFilePath([primary], 0, "../escape"), /leaves/);
  assert.throws(() => workspaceFilePath([primary], 0, ".git/config"), /Protected/);
  assert.throws(() => workspaceFilePath([primary], 0, "."), /protected root/);
  assert.equal(workspaceFilePath([primary], 0, ".", true), primary);
});

test("manifest identities retain full 64-bit object IDs and reject malformed row metadata", () => {
  const path = resolve("source"), identity = { path, canonical: path, device: "18446744073709551615", inode: "18446744073709551614", size: "1", mtime: "-1", ctime: "2", mode: "33188", links: "1", directory: false };
  assert(validFileIdentity(identity)); assert(validFileIdentity({ ...identity, symbolicLink: true }, true));
  assert(!validFileIdentity({ ...identity, symbolicLink: true })); assert(!validFileIdentity({ ...identity, inode: "1:2" }));
  assert(!validFileIdentity({ ...identity, extra: true })); assert(!validFileIdentity({ ...identity, size: "9007199254740992" }));
});
