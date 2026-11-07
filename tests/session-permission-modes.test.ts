import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import type { BigIntStats, PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { WorkspaceSandboxBackend } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { alphaSession, alphaModelRuntime, ALPHA_MODEL } from "./helpers/alpha-session.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FileService } from "../packages/coding-agent/src/core/files/file-service.ts";
import { MAX_WRITE_BYTES } from "../packages/coding-agent/src/core/files/write-limits.ts";
import { sessionDirectories } from "../packages/coding-agent/src/core/session-execution-profile.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

function mockSourceChecks(t: test.TestContext, version = true): void {
  t.mock.method(WorkspaceSandboxBackend.prototype, "assertWorkspaceCurrent", async () => {});
  if (version) t.mock.method(WorkspaceSandboxBackend.prototype, "assertSourceVersion", () => {});
  t.mock.method(WorkspaceSandboxBackend.prototype, "recordPublication", async () => {});
}

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

test("guest writes retain original path and host version checks before publication", async t => {
  mockSourceChecks(t, false);
  let baseline: BigIntStats | undefined;
  t.mock.method(WorkspaceSandboxBackend.prototype, "assertSourceVersion", (_name: string, current: any) => {
    if (baseline && (current.size !== baseline.size || current.mtimeNs !== baseline.mtimeNs || current.ctimeNs !== baseline.ctimeNs)) throw new Error("Original source identity changed");
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-workspace-policy-"));
  const runtime = createExtensionRuntime(), entries: unknown[] = [];
  runtime.appendEntry = (type, value) => { entries.push([type, value]); };
  const policy = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "sandbox", {}, "sandbox-write");
  const owner = new WorkspaceSandboxTools(root, root, "sandbox-write", () => runtime), base: any = {};
  owner.install(base); for (const definition of Object.values(base)) policy.registerDefinition(definition as any);
  const ctx: any = { cwd: root, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: SessionManager.inMemory(root) };
  let changes: any[] = [{ path: "new.txt", before: null, content: Buffer.from("中文").toString("base64") }];
  t.mock.method(WorkspaceSandboxBackend.prototype, "invoke", async () => ({ id: "fixture", ok: true, text: "done", changes }));
  try {
    await base.powershell.execute("publish", {}, ctx.signal, undefined, ctx);
    assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "中文");
    changes = [{ path: "new.txt", before: "0".repeat(64), content: Buffer.from("stale").toString("base64") }];
    await assert.rejects(base.powershell.execute("stale", {}, ctx.signal, undefined, ctx), /changed since/);
    assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "中文");
    changes = [{ path: "../escape.txt", before: null, content: "eA==" }];
    await assert.rejects(base.powershell.execute("escape", {}, ctx.signal, undefined, ctx), /Protected candidate/);
    baseline = await fs.stat(path.join(root, "new.txt"), { bigint: true });
    const prepare = FileService.prototype.prepare;
    t.mock.method(FileService.prototype, "prepare", async function(this: FileService, ...args: Parameters<typeof prepare>) {
      const item = await prepare.apply(this, args);
      if (args[0] === "delete") await fs.writeFile(path.join(root, "new.txt"), "external update during preparation");
      return item;
    });
    changes = [{ path: "new.txt", before: createHash("sha256").update("中文").digest("hex"), content: null }];
    await assert.rejects(base.powershell.execute("delete-race", {}, ctx.signal, undefined, ctx), /Original source identity changed/);
    assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "external update during preparation");
    changes = [{ path: "failed.txt", before: null, content: "eA==" }];
    t.mock.method(FileService.prototype, "execute", async () => ({ ok: false, status: "failed_no_change", cause: "commit fixture" } as any));
    await assert.rejects(base.powershell.execute("commit-failure", {}, ctx.signal, undefined, ctx), /Host commit did not succeed/);
    await assert.rejects(fs.stat(path.join(root, "failed.txt")), { code: "ENOENT" });
    assert.ok(entries.length > 0);
  } finally { await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); }
});

test("publication failure retains committed receipts when baseline bookkeeping fails", async t => {
  t.mock.method(WorkspaceSandboxBackend.prototype, "assertWorkspaceCurrent", async () => {});
  t.mock.method(WorkspaceSandboxBackend.prototype, "assertSourceVersion", () => {});
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-publication-receipts-"))), runtime = createExtensionRuntime();
  runtime.appendEntry = () => {};
  runtime.nativePermissions = new SessionExecutionPolicy(runtime, "sandbox", {}, "sandbox-write");
  const owner = new WorkspaceSandboxTools(root, root, "sandbox-write", () => runtime), base: any = {};
  owner.install(base); for (const definition of Object.values(base)) runtime.nativePermissions.registerDefinition(definition as any);
  const ctx: any = { cwd: root, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: SessionManager.inMemory(root) };
  t.mock.method(WorkspaceSandboxBackend.prototype, "invoke", async () => ({ id: "fixture", ok: true, text: "command completed",
    execution: { exitCode: 0, timedOut: false, closed: true, stdout: "retained", stderr: "" },
    changes: [{ path: "published.txt", before: null, content: Buffer.from("written").toString("base64") }] }));
  t.mock.method(WorkspaceSandboxBackend.prototype, "recordPublication", async () => { throw new Error("baseline bookkeeping failed"); });
  try {
    const result = await base.bash.execute("publication", {}, ctx.signal, undefined, ctx);
    assert.equal(result.isError, true); assert.equal(result.details.phase, "publication");
    assert.equal(result.details.published, 1); assert.equal(result.details.partial, 0);
    assert.equal(result.details.writeback.length, 1); assert.equal(result.details.writeback[0].stateChanged, true);
    assert.equal(await fs.readFile(path.join(root, "published.txt"), "utf8"), "written");
    assert.match(result.content[0].text, /baseline bookkeeping failed/); assert.match(result.content[0].text, /retained/);
  } finally { await owner.close(); runtime.nativePermissions.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); }
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

test("native approval UI cancels on Escape and a real countdown, then asks again without retained dialog state", { timeout: 8000 }, async t => {
  const fixture = await alphaSession({ mode: "fullscreen" });
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(fixture.root);
  runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
  const owner = new SessionExecutionPolicy(runtime, "trusted-host", { rules: [{ tool: "powershell", decision: "ask" }] }, "host-write");
  const ui = fixture.internal.createExtensionUIContext(); let shortDeadline = false, prompts = 0, visibleFrames = 0;
  let opened: (() => void) | undefined;
  fixture.sink.physicalMarker = text => { if (text.includes("允许这次操作")) visibleFrames++; };
  const ctx: any = { cwd: fixture.root, hasUI: true, sessionManager: manager, signal: runtime.executionBoundary.signal,
    ui: { select(title: string, choices: string[], opts: any) {
      prompts++; assert.equal(opts.timeout, 60000);
      const result = ui.select(title, choices, { ...opts, timeout: shortDeadline ? 1 : opts.timeout });
      opened?.(); return result;
    } } };
  const event: any = { type: "tool_call", toolName: "powershell", toolCallId: "ui-approval", input: { command: "Write-Output fixture" } };
  fixture.internal.ui.start();
  try {
    for (const action of ["escape", "timeout", "allow"]) {
      shortDeadline = action === "timeout";
      const ready = new Promise<void>(resolve => { opened = resolve; });
      const pending = owner.authorize(event, ctx);
      const cancelled = action === "allow" ? undefined : assert.rejects(pending, /APPROVAL_CANCELLED/);
      await Promise.race([ready, pending]); opened = undefined;
      fixture.internal.ui.renderNow(true); await fixture.internal.ui.flushTerminalFrames();
      const component = fixture.internal.extensionSelector, countdown = component.countdown;
      assert.ok(component); assert.ok(countdown); assert.equal(getEventListeners(ctx.signal, "abort").length, 1);
      if (action === "escape") component.handleInput("\x1b");
      else if (action === "allow") { component.handleInput("\x1b[A"); component.handleInput("\r"); }
      if (cancelled) await cancelled;
      else (await pending).release();
      assert.equal(countdown.intervalId, undefined); assert.equal(countdown.tui, undefined);
      assert.equal(component.details, undefined); assert.equal(component.terminal, undefined);
      assert.equal(fixture.internal.extensionSelector, undefined); assert.equal(fixture.internal.extensionSelectorOverlay, undefined);
      assert.equal(getEventListeners(ctx.signal, "abort").length, 0);
      assert.deepEqual(owner.listRefusals(ctx), []);
    }
    assert.equal(prompts, 3); assert.ok(visibleFrames > 0); assert.equal(manager.getEntryCount(), 0);
    t.diagnostic(JSON.stringify({ prompts, escaped: 1, realCountdownExpired: 1, approved: 1, persistedRefusals: 0, dialogTimers: 0, abortListeners: 0, visibleFrames }));
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

test("writeback refusals remain stable across freshly captured host revision IDs", async t => {
  mockSourceChecks(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-workspace-denial-")), runtime = createExtensionRuntime();
  runtime.appendEntry = () => {};
  await fs.writeFile(path.join(root, "existing.txt"), "before");
  const policy = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "sandbox", { rules: [{ tool: "write", decision: "ask" }] }, "sandbox-write");
  const owner = new WorkspaceSandboxTools(root, root, "sandbox-write", () => runtime), base: any = {};
  owner.install(base); for (const definition of Object.values(base)) policy.registerDefinition(definition as any);
  let prompts = 0;
  const ctx: any = { cwd: root, hasUI: true, ui: { select: async (_title: string, choices: string[]) => { prompts++; return choices[1]; } }, signal: runtime.executionBoundary.signal,
    sessionManager: SessionManager.inMemory(root) };
  t.mock.method(WorkspaceSandboxBackend.prototype, "invoke", async () => ({ id: "fixture", ok: true, changes: [{ path: "existing.txt",
    before: createHash("sha256").update("before").digest("hex"), content: Buffer.from("after").toString("base64") }] }));
  try {
    await assert.rejects(base.powershell.execute("first", {}, ctx.signal, undefined, ctx), /User declined/);
    await assert.rejects(base.powershell.execute("retry", {}, ctx.signal, undefined, ctx), /Explicitly denied/);
    assert.equal(prompts, 1); assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "before");
  } finally { await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); }
});

test("only explicit no-effects failures retain the VM; uncertain failures start fresh without replay", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-review-recovery-")));
  const backend = new WorkspaceSandboxBackend(root, root, "sandbox-write"), internal = backend as any;
  let starts = 0, calls = 0, cleaned = 0;
  t.mock.method(internal, "start", async () => {
    starts++;
    internal.root = await fs.mkdtemp(path.join(root, "owner-"));
    const stat = await fs.lstat(internal.root, { bigint: true }); internal.identity = stat.dev + ":" + stat.ino;
    await internal.remember(internal.root);
    const exchange = path.join(internal.root, "exchange"); await fs.mkdir(exchange); await internal.remember(exchange);
    internal.sourceRoot = root;
    const source = await fs.lstat(root, { bigint: true }); internal.sourceIdentity = source.dev + ":" + source.ino;
    internal.vm = { id: "fixture", calls: [], state: "running", async cleanup() { cleaned++; this.state = "closed"; }, async invoke() {
      calls++;
      const request = JSON.parse(await fs.readFile(path.join(exchange, "request.json"), "utf8"));
      const outcome = calls === 1 ? {ok:false,phase:"read",noEffects:true,error:"Missing guest file"}
        : calls === 3 ? {ok:false,phase:"mutation",noEffects:true,error:"Inconsistent outcome"}
        : calls === 5 ? {ok:false,error:"Unclassified guest failure"} : {ok:true,text:"fresh"};
      await fs.writeFile(path.join(exchange, "response.json"), JSON.stringify({ id: request.id, ...outcome }));
    } };
  });
  try {
    await assert.rejects(backend.invoke("read", { path: "missing" }), /Missing guest file/);
    assert.equal(backend.diagnostics.vm, true); assert.equal(cleaned, 0);
    await assert.rejects(backend.invoke("read", { path: path.resolve(root,"../outside") }), /workspace|Workspace/);
    assert.equal(backend.diagnostics.vm, true); assert.equal(calls, 1);
    assert.equal((await backend.invoke("read", { path: "exists" })).text, "fresh");
    assert.equal(starts, 1); assert.equal(calls, 2);
    await assert.rejects(backend.invoke("read", { path: "exists" }), /Invalid no-effects outcome/);
    assert.equal(backend.diagnostics.vm, false); assert.equal(backend.diagnostics.ownedArtifacts, 0);
    assert.equal((await backend.invoke("read", { path: "exists" })).text, "fresh");
    assert.equal(starts, 2); assert.equal(calls, 4); assert.equal(cleaned, 1);
    await assert.rejects(backend.invoke("read", { path: "missing" }), /Unclassified guest failure/);
    assert.equal(backend.diagnostics.vm, false);
    assert.equal((await backend.invoke("read", { path: "exists" })).text, "fresh");
    assert.equal(starts, 3); assert.equal(calls, 6);
    await backend.close(); assert.equal(cleaned, 3);
    await assert.rejects(backend.invoke("read", {}), /closed/);
  } finally { try { await backend.close(); } finally { await fs.rm(root, { recursive: true }); } }
});

test("validate the entire candidate envelope before publishing any file", async t => {
  mockSourceChecks(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-review-candidates-")), runtime = createExtensionRuntime();
  runtime.appendEntry = () => {};
  const policy = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "sandbox", {}, "sandbox-write");
  const owner = new WorkspaceSandboxTools(root, root, "sandbox-write", () => runtime), base: any = {};
  owner.install(base); for (const definition of Object.values(base)) policy.registerDefinition(definition as any);
  const ctx: any = { cwd: root, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: SessionManager.inMemory(root) };
  const first = { path: "first.txt", before: null, content: "eA==" };
  let changes: any[] = [];
  t.mock.method(WorkspaceSandboxBackend.prototype, "invoke", async () => ({ id: "fixture", ok: true, changes }));
  const large = Buffer.alloc(MAX_WRITE_BYTES, 65).toString("base64");
  try {
    for (const invalid of [
      [{ path: "../escape.txt", before: null, content: "eA==" }],
      [{ ...first, path: "FIRST.txt" }],
      [{ path: "bad.txt", before: null, content: "/w==" }],
      [{ path: "too-large.txt", before: null, content: Buffer.alloc(MAX_WRITE_BYTES + 1, 65).toString("base64") }],
      [{ path: "multibyte.txt", before: null, content: Buffer.from("界".repeat(Math.floor(MAX_WRITE_BYTES / 3) + 1)).toString("base64") }],
      Array.from({ length: 16 }, (_, i) => ({ path: `large-${i}.txt`, before: null, content: large })),
    ]) {
      changes = [first, ...invalid];
      await assert.rejects(base.powershell.execute("invalid", {}, ctx.signal, undefined, ctx));
      assert.deepEqual(await fs.readdir(root), []);
    }
    changes = [first, { path: "at-limit.txt", before: null, content: large }]; await base.powershell.execute("valid", {}, ctx.signal, undefined, ctx);
    assert.equal((await fs.stat(path.join(root, "at-limit.txt"))).size, MAX_WRITE_BYTES);
    assert.equal(await fs.readFile(path.join(root, first.path), "utf8"), "x");
    changes = [{ ...first, path: "committed.txt" }, first];
    await assert.rejects(base.powershell.execute("conflict", {}, ctx.signal, undefined, ctx), /1 file\(s\) already published/);
    assert.equal(await fs.readFile(path.join(root, "committed.txt"), "utf8"), "x");
  } finally { await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); }
});

test("source identity checks never silently accept an uninitialized owner", async () => {
  const backend = new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "sandbox-write");
  await assert.rejects(backend.assertWorkspaceCurrent(), /not captured/);
  assert.throws(() => backend.assertSourceVersion("a", {} as any), /not captured/);
  await assert.rejects(backend.recordPublication("a", true), /not captured/);
  await backend.close();
});

test("partial artifact cleanup retains only remaining identities and can be retried", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-review-cleanup-")));
  const backend = new WorkspaceSandboxBackend(root, root, "sandbox-write"), internal = backend as any;
  const a = path.join(root, "a"), b = path.join(root, "b");
  await fs.writeFile(a, "a"); await fs.writeFile(b, "b");
  const stat = await fs.lstat(root, { bigint: true }); internal.root = root; internal.identity = stat.dev + ":" + stat.ino;
  await internal.remember(root); await internal.remember(a); await internal.remember(b);
  const unlink = fs.unlink; let fail = true;
  t.mock.method(fs, "unlink", async (file: PathLike) => { if (file === b && fail) { fail = false; throw new Error("sharing violation fixture"); } return unlink(file); });
  try {
    await assert.rejects(backend.close(), /sharing violation/);
    assert.equal(backend.diagnostics.ownedArtifacts, 2);
    await backend.close(); assert.equal(backend.diagnostics.root, undefined); assert.equal(backend.diagnostics.ownedArtifacts, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("snapshot capture excludes configured directories before accounting and explicit empty config restores import", async () => {
  const owned=createOwnedTaskFixture("sandbox-private-capture-"), root=await fs.realpath(owned.root), project=path.join(root,"project");
  await fs.mkdir(project);await fs.mkdir(path.join(project,"control"));
  await fs.writeFile(path.join(project,"ordinary.txt"),"ok");await fs.writeFile(path.join(project,"control/target"),"ok");
  const privateNames=["target",".venv","__pycache__","build/private"];
  for (const name of [...privateNames,".git"]) {
    await fs.mkdir(path.join(project,name),{recursive:true});await fs.writeFile(path.join(project,name,"host.txt"),"host sentinel");
  }
  try {
    for (const excluded of [privateNames,[]]) {
      const artifacts=await fs.mkdtemp(path.join(root,"owner-"));
      const backend=new WorkspaceSandboxBackend(project,root,"sandbox-write",{privateDirectories:excluded}), internal=backend as any;
      internal.root=artifacts;internal.sourceRoot=project;
      const stat=await fs.lstat(artifacts,{bigint:true});internal.identity=stat.dev+":"+stat.ino;await internal.remember(artifacts);
      try {
        await internal.capture(project,path.join(artifacts,"input"));
        assert.equal(backend.diagnostics.sourceFiles,excluded.length?2:6);
        assert.equal(internal.capturedEntries,excluded.length?4:12);
        assert.equal(internal.capturedBytes,excluded.length?4:56);
        assert.equal(await fs.readFile(path.join(artifacts,"input/control/target"),"utf8"),"ok");
        await assert.rejects(fs.stat(path.join(artifacts,"input/.git")),{code:"ENOENT"});
      } finally {await backend.close();assert.equal(backend.diagnostics.ownedArtifacts,0);assert.equal(backend.diagnostics.sourceFiles,0);}
    }
    for (const name of privateNames) assert.equal(await fs.readFile(path.join(project,name,"host.txt"),"utf8"),"host sentinel");
  } finally {owned.cleanup();}
});

test("a growing snapshot source cannot expand its admitted read buffer", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-review-growth-")));
  const project = path.join(root, "project"), artifacts = path.join(root, "owner");
  await fs.mkdir(project); await fs.mkdir(artifacts);
  const file = path.join(project, "growing.txt"); await fs.writeFile(file, Buffer.alloc(1024 * 1024, 65));
  const backend = new WorkspaceSandboxBackend(project, root, "sandbox-write"), internal = backend as any;
  internal.root = artifacts; internal.sourceRoot = project;
  const stat = await fs.lstat(artifacts, { bigint: true }); internal.identity = stat.dev + ":" + stat.ino; await internal.remember(artifacts);
  const open = fs.open; let maximumBuffer = 0, grew = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        maximumBuffer = Math.max(maximumBuffer, buffer.length);
        if (!grew) { grew = true; await fs.truncate(file, 65 * 1024 * 1024); }
        return read(buffer, offset, length, position);
      }) as typeof handle.read;
      handle.readFile = async () => { throw new Error("Unbounded source read"); };
    }
    return handle;
  });
  try {
    await assert.rejects(internal.capture(project, path.join(artifacts, "input")), /Source changed during capture/);
    assert.equal(maximumBuffer, 256 * 1024);
    await backend.close(); assert.equal(backend.diagnostics.ownedArtifacts, 0);
  } finally { await fs.rm(root, { recursive: true }); }
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
