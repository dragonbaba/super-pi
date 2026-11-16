import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

test("external tool discovery uses executable paths without version subprocesses or stale environment state", async t => {
  const owned = createOwnedTaskFixture("tool-resolution-");
  const previousAgent = process.env.SP_CODING_AGENT_DIR, previousPath = process.env.PATH, previousOffline = process.env.SP_OFFLINE;
  process.env.SP_CODING_AGENT_DIR = owned.root;
  const { getToolPath, ensureTool } = await import("../packages/coding-agent/src/utils/tools-manager.ts");
  let probes = 0;
  t.mock.method(childProcess, "spawnSync", () => { probes++; assert.fail("executable discovery launched a subprocess"); });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const [key, value] of [["SP_CODING_AGENT_DIR", previousAgent], ["PATH", previousPath], ["SP_OFFLINE", previousOffline]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    owned.cleanup();
  });
  const name = (tool: string) => tool + (process.platform === "win32" ? ".exe" : "");
  const executable = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture executable metadata"); chmodSync(path, 0o755); return path; };

  await t.test("repeated rg resolution and ensure calls never execute the binary", async () => {
    process.env.PATH = process.platform === "win32" ? `"${dirname(rgPath)}"` : dirname(rgPath);
    const results: Array<string | null | undefined> = [];
    for (let index = 0; index < 25; index++) { results.push(getToolPath("rg")); results.push(await ensureTool("rg", true)); }
    assert.equal(probes, 0, "availability discovery must not run --version or another subprocess");
    for (const result of results) assert.equal(result, resolve(rgPath));
  });

  await t.test("PATH changes and removed files are reflected without a retained resolver cache", () => {
    const first = executable(join(owned.root, "first bin", name("rg")));
    const second = executable(join(owned.root, "second bin", name("rg")));
    process.env.PATH = dirname(first) + delimiter + dirname(second);
    assert.equal(getToolPath("rg"), first);
    unlinkSync(first); assert.equal(getToolPath("rg"), second);
    process.env.PATH = dirname(first); assert.equal(getToolPath("rg"), null);
    process.env.PATH = dirname(second); assert.equal(getToolPath("rg"), second);
    assert.equal(probes, 0);
  });

  await t.test("Windows portable tools in cwd precede PATH unless current-directory lookup is disabled", { skip: process.platform !== "win32" }, () => {
    const oldCwd = process.cwd(), oldDisable = process.env.NoDefaultCurrentDirectoryInExePath;
    const cwd = join(owned.root, "portable cwd"), system = join(owned.root, "system bin");
    const portable = executable(join(cwd, "rg.exe")), onPath = executable(join(system, "rg.exe"));
    try {
      process.chdir(cwd); process.env.PATH = system;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      assert.equal(getToolPath("rg"), portable);
      process.env.NoDefaultCurrentDirectoryInExePath = "1";
      assert.equal(getToolPath("rg"), onPath);
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      unlinkSync(portable); assert.equal(getToolPath("rg"), onPath);
      assert.equal(probes, 0);
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = oldDisable;
      process.env.PATH = join(owned.root, "second bin");
    }
  });

  await t.test("managed binaries retain precedence; directories and unavailable offline tools are not reported present", async () => {
    const managed = executable(join(owned.root, "bin", name("rg")));
    assert.equal(getToolPath("rg"), managed); unlinkSync(managed);
    mkdirSync(managed);
    assert.equal(getToolPath("rg"), join(owned.root, "second bin", name("rg")));
    process.env.PATH = join(owned.root, "absent"); process.env.SP_OFFLINE = "1";
    assert.equal(await ensureTool("rg", true), undefined);
    const alias = executable(join(owned.root, "fd alias", name("fdfind")));
    process.env.PATH = dirname(alias); assert.equal(getToolPath("fd"), alias);
    if (process.platform !== "win32") { chmodSync(alias, 0o644); assert.equal(getToolPath("fd"), null); }
    assert.equal(probes, 0);
  });
});
