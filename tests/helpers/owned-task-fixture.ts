import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Test-only owner. Its cleanup accepts no caller-supplied path. */
export function createOwnedTaskFixture(prefix: string) {
  assert.ok(prefix.length > 0 && !prefix.includes("/") && !prefix.includes("\\"));
  const parent = fileURLToPath(new URL("../../.task-tmp", import.meta.url));
  const createdSharedParent = !existsSync(parent);
  mkdirSync(parent, { recursive: true });
  assert.equal(lstatSync(parent).isSymbolicLink(), false);
  const boundary = realpathSync.native(parent);
  const root = mkdtempSync(join(parent, prefix));
  const identity = lstatSync(root, { bigint: true });
  const manifestPath = join(root, "resources.json");
  writeFileSync(manifestPath, JSON.stringify({ root, createdSharedParent, createdAt: new Date().toISOString(), resources: [manifestPath] }));
  function cleanup() {
    assert.equal(lstatSync(parent).isSymbolicLink(), false);
    assert.equal(realpathSync.native(dirname(root)), boundary);
    const current = lstatSync(root, { bigint: true });
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    const resources: string[] = [manifestPath];
    const directories = [root];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false, "unexpected task reparse boundary; preserve resources for inspection");
        if (path !== manifestPath) resources.push(path);
        if (entry.isDirectory()) directories.push(path);
      }
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.root, root);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, createdSharedParent, resources, cleanup: "owned child closed; exact root verified" }));
    rmSync(root, { recursive: true });
    assert.equal(existsSync(root), false);
    if (createdSharedParent && readdirSync(parent).length === 0) rmdirSync(parent);
  }
  return { root, createdSharedParent, cleanup };
}
