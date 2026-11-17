import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

test("external tool discovery preserves native lookup without version subprocesses or stale environment state", async t => {
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
    for (const result of results) assert.equal(result, "rg");
  });

  await t.test("PATH changes and removed files are reflected without a retained resolver cache", () => {
    const first = executable(join(owned.root, "first bin", name("rg")));
    const second = executable(join(owned.root, "second bin", name("rg")));
    process.env.PATH = dirname(first) + delimiter + dirname(second);
    assert.equal(getToolPath("rg"), "rg");
    unlinkSync(first); assert.equal(getToolPath("rg"), "rg");
    process.env.PATH = dirname(first); assert.equal(getToolPath("rg"), null);
    process.env.PATH = dirname(second); assert.equal(getToolPath("rg"), "rg");
    assert.equal(probes, 0);
  });

  await t.test("scoped search pins a canonical executable outside primary and additional workspaces", async () => {
    const oldCwd = process.cwd(), oldOffline = process.env.SP_OFFLINE;
    const project = join(owned.root, "untrusted project"), additional = join(owned.root, "additional workspace");
    const rogue = executable(join(project, name("rg"))), second = executable(join(additional, name("rg")));
    const trusted = executable(join(owned.root, "trusted install", name("rg")));
    const scope = { workspace: project, directories: [additional] };
    const alias = join(owned.root, "workspace binary alias");
    let aliasCreated = false;
    try {
      process.chdir(project); process.env.PATH = [dirname(rogue), dirname(second), dirname(trusted)].join(delimiter);
      assert.equal(getToolPath("rg", scope), trusted, "a native search must not hand spawn a bare project-local command");
      assert.equal(await ensureTool("rg", true, scope), trusted);
      symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
      aliasCreated = true;
      process.env.PATH = [alias, dirname(trusted)].join(delimiter);
      assert.equal(getToolPath("rg", scope), trusted, "an external PATH entry pointing back into a workspace is not trusted");
      executable(join(project, name("fd"))); executable(join(additional, name("fd")));
      const trustedFd = executable(join(dirname(trusted), name("fdfind")));
      process.env.PATH = [project, additional, dirname(trusted)].join(delimiter);
      assert.equal(getToolPath("fd", scope), trustedFd, "the fd alias has the same pinned workspace exclusions");
      process.env.PATH = [dirname(rogue), dirname(second)].join(delimiter); process.env.SP_OFFLINE = "1";
      assert.equal(getToolPath("rg", scope), null); assert.equal(await ensureTool("rg", true, scope), undefined);
      assert.equal(probes, 0);
    } finally {
      if (aliasCreated) { if (process.platform === "win32") rmdirSync(alias); else unlinkSync(alias); }
      process.chdir(oldCwd);
      if (oldOffline === undefined) delete process.env.SP_OFFLINE; else process.env.SP_OFFLINE = oldOffline;
    }
  });

  await t.test("Windows portable tools in cwd precede PATH unless current-directory lookup is disabled", { skip: process.platform !== "win32" }, () => {
    const oldCwd = process.cwd(), oldDisable = process.env.NoDefaultCurrentDirectoryInExePath;
    const cwd = join(owned.root, "portable cwd"), system = join(owned.root, "system bin");
    const portable = executable(join(cwd, "rg.exe")), onPath = executable(join(system, "rg.exe"));
    try {
      process.chdir(cwd); process.env.PATH = system;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      assert.equal(getToolPath("rg"), "rg");
      process.env.NoDefaultCurrentDirectoryInExePath = "1";
      assert.equal(getToolPath("rg"), "rg");
      for (const path of [`;${system}`, `${system};;`, "", ";;"]) {
        process.env.PATH = path;
        assert.equal(getToolPath("rg"), path.includes(system) ? "rg" : null, "empty PATH entries must not bypass the cwd opt-out");
      }
      delete process.env.PATH; assert.equal(getToolPath("rg"), null);
      process.env.PATH = "."; assert.equal(getToolPath("rg"), "rg", "explicit cwd remains supported");
      process.env.PATH = system;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      unlinkSync(portable); assert.equal(getToolPath("rg"), "rg");
      assert.equal(probes, 0);
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = oldDisable;
      process.env.PATH = join(owned.root, "second bin");
    }
  });

  await t.test("PATH keeps platform empty-entry semantics and quoted Windows semicolons/native suffix precedence", () => {
    const oldCwd = process.cwd(), oldDisable = process.env.NoDefaultCurrentDirectoryInExePath;
    const cwd = join(owned.root, "path semantics");
    const portable = executable(join(cwd, name("rg")));
    try {
      process.chdir(cwd);
      if (process.platform === "win32") {
        const quoted = executable(join(owned.root, "quoted;bin", "rg.exe"));
        process.env.NoDefaultCurrentDirectoryInExePath = "1";
        for (const quote of ['"', "'"]) {
          process.env.PATH = `${quote}${dirname(quoted)}${quote};;`;
          assert.equal(getToolPath("rg"), "rg");
        }
        const com = executable(join(dirname(quoted), "rg.com"));
        unlinkSync(quoted); assert.equal(getToolPath("rg"), "rg"); unlinkSync(com);
      } else {
        process.env.PATH = delimiter + join(owned.root, "absent");
        assert.equal(getToolPath("rg"), "rg");
      }
    } finally {
      process.chdir(oldCwd);
      if (oldDisable === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = oldDisable;
      process.env.PATH = join(owned.root, "second bin");
    }
  });

  await t.test("Unix actual launches preserve missing-interpreter fallback and symlink/parent traversal", { skip: process.platform === "win32" }, async () => {
    const broken = executable(join(owned.root, "broken", "rg"));
    writeFileSync(broken, "#!/no/such/pi-test-interpreter\n");
    const working = executable(join(owned.root, "installed", "bin", "rg"));
    writeFileSync(working, "#!/bin/sh\nprintf 'native search result\\n'\n");
    const link = join(owned.root, "links", "link");
    mkdirSync(dirname(link), { recursive: true });
    mkdirSync(join(owned.root, "installed", "sub"));
    symlinkSync(join(owned.root, "installed", "sub"), link);
    try {
      for (const path of [dirname(broken) + delimiter + dirname(working), `${link}/../bin`]) {
        process.env.PATH = path;
        const command = getToolPath("rg"); assert.equal(command, "rg");
        const output = await new Promise<string>((resolve, reject) => childProcess.execFile(command!, ["--files"], (error, stdout) => error ? reject(error) : resolve(stdout)));
        assert.equal(output.trim(), "native search result");
      }
      assert.equal(probes, 0);
    } finally { unlinkSync(link); process.env.PATH = join(owned.root, "second bin"); }
  });

  await t.test("managed binaries retain precedence; directories and unavailable offline tools are not reported present", async () => {
    const managed = executable(join(owned.root, "bin", name("rg")));
    assert.equal(getToolPath("rg"), managed); unlinkSync(managed);
    mkdirSync(managed);
    assert.equal(getToolPath("rg"), "rg");
    process.env.PATH = join(owned.root, "absent"); process.env.SP_OFFLINE = "1";
    assert.equal(await ensureTool("rg", true), undefined);
    const alias = executable(join(owned.root, "fd alias", name("fdfind")));
    process.env.PATH = dirname(alias); assert.equal(getToolPath("fd"), "fdfind");
    if (process.platform !== "win32") { chmodSync(alias, 0o644); assert.equal(getToolPath("fd"), null); }
    assert.equal(probes, 0);
  });

  await t.test("a scoped search never installs tools or accepts a managed binary inside a workspace", async st => {
    let requests = 0;
    st.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("search must not download tools"); });
    const oldOffline = process.env.SP_OFFLINE;
    try {
      process.env.SP_OFFLINE = "0"; process.env.PATH = "";
      const managed = join(owned.root, "bin", name("rg"));
      rmdirSync(managed); executable(managed);
      assert.equal(getToolPath("rg"), managed, "the unsafe scoped candidate is an otherwise executable managed file");
      const scope = { workspace: owned.root };
      assert.equal(getToolPath("rg", scope), null);
      assert.equal(await ensureTool("rg", true, scope), undefined);
      assert.equal(requests, 0); assert.equal(probes, 0);
    } finally { if (oldOffline === undefined) delete process.env.SP_OFFLINE; else process.env.SP_OFFLINE = oldOffline; }
  });

  await t.test("managed tool directories follow an explicit agent-root change without stale module state", async () => {
    const agent = process.env.SP_CODING_AGENT_DIR;
    const alternate = join(owned.root, "alternate agent");
    const binary = executable(join(alternate, "bin", name("rg")));
    try {
      process.env.SP_CODING_AGENT_DIR = alternate; process.env.PATH = "";
      assert.equal(getToolPath("rg"), binary);
      assert.equal(await ensureTool("rg", true), binary);
      assert.equal(probes, 0);
    } finally { if (agent === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = agent; }
  });
});
