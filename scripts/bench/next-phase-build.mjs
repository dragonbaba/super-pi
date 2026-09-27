import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Cold measurement provenance. No symlinked dist artifact is silently followed. */
export function captureBuiltArtifacts(project) {
  const files = [], pending = [[join(project, "packages"), false]];
  while (pending.length) {
    const [directory, built] = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name), included = built || entry.name === "dist";
      if (entry.isSymbolicLink()) { assert.equal(included, false, `Unbound symlinked build artifact: ${path}`); continue; }
      if (entry.isDirectory()) pending.push([path, included]);
      else if (built) {
        assert.equal(entry.isFile(), true, path);
        const bytes = readFileSync(path);
        files.push({ path: relative(project, path).split(sep).join("/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  files.sort(compareArtifacts);
  assert.ok(files.length > 0, "No built artifacts found");
  return { lockfileSha256: createHash("sha256").update(readFileSync(join(project, "package-lock.json"))).digest("hex"),
    files, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}
function compareArtifacts(left, right) { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; }
