import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { canonicalSessionDirectory, loadSessionExecutionProfile, saveSessionExecutionProfile, sessionDirectories, WORKSPACE_TOOL_NAMES } from "../packages/coding-agent/src/core/session-execution-profile.ts";
import { mergeHostPath, refreshedHostEnvironment } from "../packages/coding-agent/src/core/sandbox/host-path.ts";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { AgentSessionRuntime } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";

test("directory replacement persists only applied choices and closes the old runtime", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-replacement-")));
  const cwd = path.join(root, "project"), assets = path.join(root, "assets"), agentDir = path.join(root, "agent");
  for (const directory of [cwd, assets, agentDir]) fs.mkdirSync(directory);
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  let ignoreDirectories = false;
  async function create(target: Parameters<ConstructorParameters<typeof AgentSessionRuntime>[2]>[0]) {
    const settings = SettingsManager.inMemory();
    settings.setPermissionModeForSession(target.permissionMode ?? "sandbox-write");
    settings.setSessionDirectories(ignoreDirectories ? [] : target.directories ?? []);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const result = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader,
      sessionManager: target.sessionManager, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), noTools: "all" });
    return { ...result, services: { cwd, agentDir } as any, diagnostics: [] };
  }
  const first = await create({ cwd, agentDir, sessionManager: manager });
  const owner = new AgentSessionRuntime(first.session, first.services, create);
  try {
    const previous = (owner.session as any)._workspaceSandbox;
    assert.equal((await owner.setWorkingDirectories([assets])).cancelled, false);
    assert.equal(previous.diagnostics.closed, true);
    assert.deepEqual(loadSessionExecutionProfile(agentDir, manager), { mode: "sandbox-write", directories: [assets] });
    await owner.setPermissionMode("host-write");
    assert.deepEqual(loadSessionExecutionProfile(agentDir, manager), { mode: "host-write", directories: [assets] });
    fs.rmdirSync(assets);
    await owner.setWorkingDirectories([]);
    assert.deepEqual(loadSessionExecutionProfile(agentDir, manager), { mode: "host-write", directories: [] });
    fs.mkdirSync(assets); ignoreDirectories = true;
    await assert.rejects(owner.setWorkingDirectories([assets]), /factory did not apply/);
    assert.deepEqual(loadSessionExecutionProfile(agentDir, manager), { mode: "host-write", directories: [] }, "failed replacement cannot save an un-applied directory grant");
  } finally { await owner.dispose(); fs.rmSync(root, { recursive: true }); }
});

test("local execution profile restores explicit choices only for the same session, cwd and machine", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-profile-")));
  for (const directory of ["project", "assets", "agent", "sessions", "other"]) fs.mkdirSync(path.join(root, directory));
  const project = path.join(root, "project"), assets = path.join(root, "assets"), agent = path.join(root, "agent");
  const manager = SessionManager.create(project, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  try {
    assert.equal(loadSessionExecutionProfile(agent, manager), undefined);
    manager.appendCustomEntry("session-permission-mode-v2", { mode: "host-write", source: "user-command" });
    assert.equal(loadSessionExecutionProfile(agent, manager), undefined, "transcript content cannot grant authority");
    for (const mode of ["host-write", "read-only", "sandbox-write"] as const) {
      saveSessionExecutionProfile(agent, manager, { mode, directories: [assets] });
      assert.deepEqual(loadSessionExecutionProfile(agent, SessionManager.open(manager.getSessionFile()!)), { mode, directories: [assets] });
    }
    assert.equal(loadSessionExecutionProfile(agent, SessionManager.open(manager.getSessionFile()!, undefined, path.join(root, "other"))), undefined);
    const imported = path.join(root, "sessions", "imported.jsonl"); fs.copyFileSync(manager.getSessionFile()!, imported);
    assert.equal(loadSessionExecutionProfile(agent, SessionManager.open(imported)), undefined);
    assert.equal(loadSessionExecutionProfile(agent, SessionManager.create(project, path.join(root, "sessions"))), undefined);
    const record = path.join(agent, "session-execution", fs.readdirSync(path.join(agent, "session-execution"))[0]);
    if (process.platform === "win32") {
      const spelling = assets.toUpperCase(), canonical = fs.realpathSync.native(assets);
      assert.deepEqual(sessionDirectories(project, [spelling]), [canonical]);
      assert.equal(canonicalSessionDirectory(spelling), canonical);
      const legacy = JSON.parse(fs.readFileSync(record, "utf8")); legacy.directories = [spelling];
      fs.writeFileSync(record, JSON.stringify(legacy));
      assert.deepEqual(loadSessionExecutionProfile(agent, manager)?.directories, [canonical], "old saved spellings use the native identity on restore");
    }
    const value = JSON.parse(fs.readFileSync(record, "utf8")); value.machine += "-different"; fs.writeFileSync(record, JSON.stringify(value));
    assert.equal(loadSessionExecutionProfile(agent, manager), undefined);
    assert.throws(() => sessionDirectories(project, [root]), /overlap/);
    assert.throws(() => sessionDirectories(project, [assets, assets]), /overlap/);
    fs.rmdirSync(assets);
    saveSessionExecutionProfile(agent, manager, { mode: "read-only", directories: [assets] });
    assert.deepEqual(loadSessionExecutionProfile(agent, manager), { mode: "read-only", directories: [assets] });
    assert.deepEqual(sessionDirectories(project, [], false), [], "a missing directory can be removed without reopening it");
    assert.throws(() => sessionDirectories(project, [assets]), /ENOENT/, "new grants still require an existing directory");
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("persistent PATH refresh preserves process precedence without duplicate directory growth", () => {
  assert.equal(mergeHostPath("D:\\Custom;C:\\Tools", ["c:\\tools;D:\\New Tool", "D:\\User"]), "D:\\Custom;C:\\Tools;D:\\New Tool;D:\\User");
  assert.equal(mergeHostPath("D:\\Custom", [null, ""]), "D:\\Custom");
  assert.throws(() => mergeHostPath("", ["bad\0path", ""]), /Invalid/);
  assert.throws(() => mergeHostPath("", new Array(3)), /Invalid/);
  const refreshed = refreshedHostEnvironment({ Path: "D:\\Old", KEEP: "fixture" }, ["D:\\New", ""]);
  assert.equal(refreshed.Path, "D:\\Old;D:\\New"); assert.equal(refreshed.PATH, refreshed.Path); assert.equal(refreshed.KEEP, "fixture");
});

test("sandbox shell capability comes from the workspace adapter; legacy SDK cannot expose host Bash", async () => {
  const runtime = createExtensionRuntime(), owner = new WorkspaceSandboxTools(process.cwd(), process.cwd(), "sandbox-write", () => runtime);
  const definitions: Record<string, any> = {}; owner.install(definitions);
  const policy = new SessionExecutionPolicy(runtime, "sandbox", {}, "sandbox-write");
  try {
    assert.deepEqual(Object.keys(definitions), [...WORKSPACE_TOOL_NAMES]);
    for (const definition of Object.values(definitions)) { policy.registerDefinition(definition); assert.ok(policy.supports(definition)); }
    assert.match(definitions.bash.description, /Bash.*Windows Sandbox/);
    const legacyRuntime = createExtensionRuntime(), legacy = new SessionExecutionPolicy(legacyRuntime, "sandbox");
    try { legacy.registerDefinition(definitions.bash); assert.equal(legacy.supports(definitions.bash), false); }
    finally { legacy.dispose(); await legacyRuntime.executionBoundary.dispose(); }
  } finally { await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose(); }
});
