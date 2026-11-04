import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

for (const scene of ["overlap", "multi", "crlf", "cr", "utf16", "bytes", "long", "large", "budget", "budget-exact", "limit", "error", "abort"]) {
  test(`grep context stream: ${scene}`, t => {
    const owned = createOwnedTaskFixture("h08-grep-context-"); t.after(owned.cleanup);
    const startedAt = new Date().toISOString();
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./helpers/grep-context-fixture.ts", import.meta.url)), owned.root, scene], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root, SP_CODING_AGENT_DIR: owned.root, SP_OFFLINE: "1", RIPGREP_CONFIG_PATH: "" },
    });
    writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent, childPid: child.pid, startedAt, code: child.status, purpose: scene }));
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr + child.stdout);
    t.diagnostic(child.stdout.trim());
  });
}
