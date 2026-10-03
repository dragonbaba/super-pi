import assert from "node:assert/strict";
import { lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Only accepts a caller-owned mkdtemp root immediately below the OS temp dir.
 * Unlink reparse entries before their targets: some Windows runtimes report
 * dangling links via readdir but ENOENT via lstat, so recursive rm leaves them. */
export function removeOwnedFixture(root: string): void {
  root = resolve(root);
  assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()));
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) unlinkSync(path);
      else if (entry.isDirectory()) directories.push(path);
    }
  }
  rmSync(root, { recursive: true, force: true });
}
