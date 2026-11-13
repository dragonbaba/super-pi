import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildManifestLevels, manifestLeafHash, manifestProof, verifyManifestProof, appendReverseManifest } from "../packages/coding-agent/src/core/files/file-manifest-proof.ts";

test("per-item manifest membership and reverse page accumulation agree for odd/even scales", () => {
  for (const count of [1, 2, 3, 4, 5, 17, 128, 513, 2000]) {
    const leaves = [];
    for (let index = 0; index < count; index++) leaves.push(manifestLeafHash(String(index), createHash("sha256").update(String(index)).digest("hex")));
    const levels = buildManifestLevels(leaves), root = levels[levels.length - 1][0], frontier: Array<string | null> = [];
    let observed: string | undefined;
    for (let index = count - 1; index >= 0; index--) {
      const proof = manifestProof(levels, index);
      assert(verifyManifestProof(leaves[index], index, count, proof, root));
      if (count > 1) assert.equal(verifyManifestProof(leaves[index], (index + 1) % count, count, proof, root), false);
      observed = appendReverseManifest(frontier, leaves[index], index, count);
      assert(frontier.length <= 32);
    }
    assert.equal(observed, root);
  }
});
test("manifest proofs reject changed row identity, missing siblings and foreign hashes", () => {
  const hash = createHash("sha256").update("row").digest("hex"), leaf = manifestLeafHash("entry", hash), levels = buildManifestLevels([leaf, "b".repeat(64), "c".repeat(64)]);
  const root = levels[levels.length - 1][0], proof = manifestProof(levels, 0);
  assert.equal(verifyManifestProof(manifestLeafHash("another-entry", hash), 0, 3, proof, root), false);
  assert.equal(verifyManifestProof(leaf, 0, 3, [], root), false);
  proof[0] = "invalid";
  assert.equal(verifyManifestProof(leaf, 0, 3, proof, root), false);
});
