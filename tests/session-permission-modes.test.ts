import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { alphaSession, alphaModelRuntime, ALPHA_MODEL } from "./helpers/alpha-session.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { sessionDirectories } from "../packages/coding-agent/src/core/session-execution-profile.ts";

test("readonly refuses writes even with broad allow and valid native definitions", async () => {
  const runtime = createExtensionRuntime();
  const policy = new SessionExecutionPolicy(runtime, "sandbox", { rules: [{ tool: "*", decision: "allow" }] }, "read-only");
  const ctx: any = { cwd: process.cwd(), signal: new AbortController().signal, sessionManager: SessionManager.inMemory(process.cwd()) };
  try {
    for (const name of ["write", "edit", "delete", "move", "file_batch"]) {
      const definition: any = { name }; policy.registerDefinition(definition);
      await assert.rejects(policy.authorize({ type: "tool_call", toolName: name, toolCallId: "blocked", input: {} } as any, ctx, definition), /只读/);
    }
    const alias: any = { name: "read" };
    await assert.rejects(policy.authorize({ type: "tool_call", toolName: "read", toolCallId: "alias", input: {} } as any, ctx, alias), /SANDBOX_UNSUPPORTED/);
  } finally { policy.dispose(); await runtime.executionBoundary.dispose(); }
});

test("sandbox and host sessions expose their respective shells and reject legacy VM selection", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mxc-mode-"));
  t.after(() => fs.rm(root, { recursive: true }));
  for (const mode of ["read-only", "sandbox-write", "host-restricted", "host-auto", "host-write"] as const) {
    const settings = SettingsManager.inMemory(); settings.setPermissionModeForSession(mode);
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), model: ALPHA_MODEL, modelRuntime: alphaModelRuntime() });
    try {
      const sandbox = mode === "read-only" || mode === "sandbox-write", names = session.getAllTools().map(tool => tool.name);
      assert.equal(names.includes("bash"), !sandbox, mode); assert.ok(names.includes("powershell"), mode);
      assert.equal(names.includes("exec_command"), false);
      if (sandbox) {
        await assert.rejects(session.executeBash("echo unavailable"), /SANDBOX_UNSUPPORTED/);
        const backend = (session as any)._workspaceSandbox.backend;
        t.mock.method(backend, "invoke", async (name: string, input: { command: string }) => {
          assert.equal(name, "powershell"); assert.equal(input.command, "Write-Output fixture");
          return { ok: true, text: "fixture", execution: { exitCode: 23, stdout: "fixture", stderr: "", closed: true, timedOut: false } };
        });
        const result = await session.executeShellCommand("Write-Output fixture"); assert.equal(result.exitCode, 23);
      }
    } finally { session.dispose(); await session.waitForSessionLeaseRelease(); }
  }
  const settings = SettingsManager.inMemory({ executionEnvironment: "sandbox" });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  try { await assert.rejects(createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), model: ALPHA_MODEL, modelRuntime: alphaModelRuntime() }), /SANDBOX_MIGRATION/); }
  finally { await loader.getExtensions().runtime.executionBoundary.dispose(); }
  if (process.platform === "win32") {
    const agentDir = path.join(root, "fresh-agent");
    for (let load = 0; load < 2; load++) {
      const fresh = SettingsManager.create(root, agentDir);
      assert.equal(fresh.getGlobalSettings().executionEnvironment, undefined);
      assert.equal(fresh.getPermissionMode(), "sandbox-write");
      assert.equal(fresh.getExecutionEnvironment(), "sandbox");
    }
  }
});

test("interactive sandbox commands bypass host Bash extension hooks", async t => {
  const fixture = await alphaSession();
  fixture.session.settingsManager.setPermissionModeForSession("sandbox-write");
  let calls = 0;
  t.mock.method(fixture.session.extensionRunner, "emitUserBash", async () => { throw new Error("host hook must not run"); });
  t.mock.method(fixture.session, "executeShellCommand", async (command: string) => {
    assert.equal(command, "Write-Output fixture"); calls++;
    return { output: "fixture", exitCode: 0, cancelled: false, truncated: false, processCleanup: "complete" };
  });
  try { await fixture.internal.handleBashCommand("Write-Output fixture"); assert.equal(calls, 1); }
  finally { await fixture.release(); }
});

test("permissions menu exposes exactly five modes and never switches after cancellation or stale UI", async t => {
  const fixture = await alphaSession();
  let choices: string[] = [], selection = 1, confirms = 0; const switched: string[] = [];
  fixture.internal.createExtensionUIContext = () => ({
    select: async (_title: string, values: string[]) => { choices = values; return selection < 0 ? undefined : values[selection]; },
    confirm: async () => { confirms++; return false; },
  });
  t.mock.method(fixture.runtime, "setPermissionMode", async (mode: string) => { switched.push(mode); return { cancelled: false }; });
  fixture.internal.showExtensionNotify = () => {};
  try {
    await fixture.internal.showPermissionsSelector();
    assert.equal(choices.length, 5); assert.match(choices[0], /只读.*沙箱/); assert.match(choices[1], /沙箱读写/);
    assert.match(choices[2], /^3 · 宿主机受限$/); assert.match(choices[3], /宿主机受限 · Auto 审查/); assert.match(choices[4], /宿主机完全权限/);
    assert.deepEqual(switched, ["sandbox-write"]);
    // Every host tier confirms first; a declined confirmation never switches.
    for (selection of [2, 3, 4]) await fixture.internal.showPermissionsSelector();
    assert.equal(confirms, 3); assert.equal(switched.length, 1);
    selection = -1; await fixture.internal.showPermissionsSelector(); assert.equal(switched.length, 1);
    fixture.internal.createExtensionUIContext = () => ({ select: async (_title: string, values: string[]) => {
      fixture.internal.tuiLifecycleGeneration++; return values[0];
    } });
    await fixture.internal.showPermissionsSelector(); assert.equal(switched.length, 1);
  } finally { await fixture.release(); }
});

test("native approval UI has no countdown and releases cancelled dialogs before asking again", { timeout: 8000 }, async t => {
  const fixture = await alphaSession({ mode: "fullscreen" });
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(fixture.root);
  runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
  const owner = new SessionExecutionPolicy(runtime, "trusted-host", { rules: [{ tool: "powershell", decision: "ask" }] }, "host-write");
  const ui = fixture.internal.createExtensionUIContext(); let prompts = 0, visibleFrames = 0;
  let opened: (() => void) | undefined;
  fixture.sink.physicalMarker = text => { if (text.includes("允许这次操作")) visibleFrames++; };
  const ctx: any = { cwd: fixture.root, hasUI: true, sessionManager: manager, signal: runtime.executionBoundary.signal,
    ui: { select(title: string, choices: string[], opts: any) {
      prompts++; assert.equal(opts.timeout, undefined);
      const result = ui.select(title, choices, opts);
      opened?.(); return result;
    } } };
  const event: any = { type: "tool_call", toolName: "powershell", toolCallId: "ui-approval", input: { command: "Write-Output fixture" } };
  fixture.internal.ui.start();
  try {
    for (const action of ["escape", "cancel", "allow"]) {
      const ready = new Promise<void>(resolve => { opened = resolve; });
      const pending = owner.authorize(event, ctx);
      const cancelled = action === "allow" ? undefined : assert.rejects(pending, /APPROVAL_CANCELLED/);
      await Promise.race([ready, pending]); opened = undefined;
      fixture.internal.ui.renderNow(true); await fixture.internal.ui.flushTerminalFrames();
      const component = fixture.internal.extensionSelector;
      assert.ok(component); assert.equal(component.countdown, undefined); assert.equal(getEventListeners(ctx.signal, "abort").length, 1);
      if (action === "escape") component.handleInput("\x1b");
      else if (action === "cancel") component.cancel();
      else if (action === "allow") { component.handleInput("\x1b[A"); component.handleInput("\r"); }
      if (cancelled) await cancelled;
      else (await pending).release();
      assert.equal(component.details, undefined); assert.equal(component.terminal, undefined);
      assert.equal(fixture.internal.extensionSelector, undefined); assert.equal(fixture.internal.extensionSelectorOverlay, undefined);
      assert.equal(getEventListeners(ctx.signal, "abort").length, 0);
      assert.deepEqual(owner.listRefusals(ctx), []);
    }
    assert.equal(prompts, 3); assert.ok(visibleFrames > 0); assert.equal(manager.getEntryCount(), 0);
    t.diagnostic(JSON.stringify({ prompts, escaped: 1, cancelled: 1, approved: 1, persistedRefusals: 0, dialogTimers: 0, abortListeners: 0, visibleFrames }));
  } finally { owner.dispose(); await runtime.executionBoundary.dispose(); fixture.sink.physicalMarker = undefined; await fixture.release(); }
});

test("refusal recovery menu shows legacy provenance and only revokes the confirmed current-session record", async () => {
  const fixture = await alphaSession({ settings: { executionEnvironment: "trusted-host" } });
  const key = "d".repeat(64), notices: string[] = [];
  fixture.sessionManager.appendCustomEntry("native-permission-denial-v1", { key });
  let phase = 0, stale = false;
  fixture.internal.createExtensionUIContext = () => ({ select: async (_title: string, choices: string[], opts: any) => {
    assert.equal(opts.kind, "permission");
    if (phase++ === 0) {
      assert.match(choices[0], /历史来源不明/); assert.match(opts.details, /不会自动清空/);
      if (stale) fixture.internal.tuiLifecycleGeneration++;
      return choices[0];
    }
    assert.match(opts.details, /撤销不会直接批准/); return choices[1];
  } });
  fixture.internal.showExtensionNotify = (message: string) => { notices.push(message); };
  try {
    await fixture.internal.showPermissionRefusals();
    assert.deepEqual(fixture.session.getPermissionRefusals(), []); assert.match(notices[0], /已撤销/);
    fixture.sessionManager.appendCustomEntry("native-permission-denial-v1", { key });
    phase = 0; stale = true; await fixture.internal.showPermissionRefusals();
    assert.equal(fixture.session.getPermissionRefusals().length, 1, "stale UI cannot revoke a different permission context");
  } finally { await fixture.release(); }
});

test("directory commands accept Windows case aliases and remove missing grants", { skip: process.platform !== "win32" }, async t => {
  const fixture = await alphaSession(), extra = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-directory-Case-")));
  const errors: string[] = []; let applied = 0;
  fixture.internal.showExtensionNotify = (message: string, type: string) => { if (type === "error") errors.push(message); };
  t.mock.method(fixture.runtime, "setWorkingDirectories", async (values: readonly string[]) => {
    fixture.session.settingsManager.setSessionDirectories(sessionDirectories(fixture.root, values, false));
    applied++; return { cancelled: false };
  });
  try {
    await fixture.internal.handleWorkingDirectoryCommand('/add-dir "' + extra.toUpperCase() + '"');
    assert.deepEqual(fixture.session.settingsManager.getSessionDirectories(), [extra]);
    await fixture.internal.handleWorkingDirectoryCommand('/remove-dir "' + extra.toLowerCase() + '"');
    assert.deepEqual(fixture.session.settingsManager.getSessionDirectories(), []);
    await fixture.internal.handleWorkingDirectoryCommand('/add-dir "' + extra + '"');
    await fs.rmdir(extra);
    await fixture.internal.handleWorkingDirectoryCommand('/remove-dir "' + extra.toUpperCase() + '"');
    assert.deepEqual(fixture.session.settingsManager.getSessionDirectories(), []);
    fixture.session.settingsManager.setSessionDirectories([extra]);
    await fs.symlink(fixture.root, extra, "junction");
    await fixture.internal.handleWorkingDirectoryCommand('/remove-dir "' + extra + '"');
    assert.deepEqual(fixture.session.settingsManager.getSessionDirectories(), [], "a redirected old grant remains removable by its saved identity");
    assert.deepEqual(errors, []); assert.equal(applied, 5);
  } finally {
    await fixture.release();
    await fs.rm(extra, { recursive: true, force: true });
  }
});

test("reload replaces the disposed sandbox owner and preserves the permission mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-workspace-reload-"));
  const settings = SettingsManager.inMemory(); settings.setPermissionModeForSession("read-only");
  settings.setSandboxNetwork("enabled"); await settings.flush();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), model: ALPHA_MODEL, modelRuntime: alphaModelRuntime() });
  const previous = (session as any)._workspaceSandbox, previousBoundary = loader.getExtensions().runtime.executionBoundary;
  try {
    assert.equal(previous.backend.network, "enabled");
    settings.setSandboxNetwork("disabled"); await settings.flush();
    const id = session.sessionId; await session.reload();
    assert.equal((session as any)._workspaceSandbox.backend.network, "disabled");
    assert.equal(previous.diagnostics.closed, true); assert.equal(previousBoundary.participantCount, 0);
    assert.notEqual((session as any)._workspaceSandbox, previous);
    assert.equal((session as any)._workspaceSandbox.diagnostics.closed, false);
    assert.equal(session.settingsManager.getPermissionMode(), "read-only"); assert.equal(session.sessionId, id);
  } finally { session.dispose(); await session.waitForSessionLeaseRelease(); await fs.rm(root, { recursive: true }); }
});
