import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

for (const scene of ["regex", "literal", "no-config", "ignore-case"]) for (const backend of ["host", "custom"]) {
  test(`builtin grep ignores user config: ${scene}/${backend}`, t => {
    const owned = createOwnedTaskFixture("h07-grep-config-");
    t.after(owned.cleanup);
    const startedAt = new Date().toISOString();
    const parentConfig = process.env.RIPGREP_CONFIG_PATH;
    const child = spawnSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("./helpers/grep-config-fixture.ts", import.meta.url)), owned.root, scene, backend], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root,
        SP_CODING_AGENT_DIR: owned.root, SP_OFFLINE: "1", RIPGREP_CONFIG_PATH: scene === "no-config" ? "" : join(owned.root, "ripgrep-config") },
    });
    writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent,
      childPid: child.pid, startedAt, code: child.status, signal: child.signal, purpose: "grep config " + scene + "/" + backend }));
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.equal(process.env.RIPGREP_CONFIG_PATH, parentConfig);
    const report = JSON.parse(child.stdout.trim()) as { searchProcesses: number; closed: boolean; listeners: number };
    assert.equal(report.searchProcesses, 1); assert.equal(report.closed, true); assert.equal(report.listeners, 0);
    t.diagnostic(JSON.stringify(report));
  });
}
