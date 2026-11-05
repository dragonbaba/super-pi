import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import type { BigIntStats, PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

function mockSourceChecks(t: test.TestContext, version = true): void {
  t.mock.method(WorkspaceSandboxBackend.prototype, "assertWorkspaceCurrent", async () => {});
  if (version) t.mock.method(WorkspaceSandboxBackend.prototype, "assertSourceVersion", () => {});
  t.mock.method(WorkspaceSandboxBackend.prototype, "recordPublication", async () => {});
}

test("readonly refuses writes even with broad allow and valid native definitions", async () => {
  const runtime = createExtensionRuntime();
  const policy = new SessionExecutionPolicy(runtime, "sandbox", { rules: [{ tool: "*", decision: "allow" }] }, "read-only");
  const ctx: any = { cwd: process.cwd(), signal: new AbortController().signal, sessionManager: { getSessionId: () => "readonly", getLeafEntry: () => undefined } };
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
  const ctx: any = { cwd: root, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: { getSessionId: () => "publication", getLeafEntry: () => undefined } };
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
  const ctx: any = { cwd: root, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: { getSessionId: () => "receipt", getLeafEntry: () => undefined } };
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

test("permissions menu exposes exactly three modes and never switches after cancellation or stale UI", async t => {
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
    assert.equal(choices.length, 3); assert.match(choices[0], /只读.*沙箱/); assert.match(choices[1], /沙箱读写/); assert.match(choices[2], /宿主机/);
    assert.deepEqual(switched, ["sandbox-write"]);
    selection = 2; await fixture.internal.showPermissionsSelector(); assert.equal(confirms, 1); assert.equal(switched.length, 1);
    selection = -1; await fixture.internal.showPermissionsSelector(); assert.equal(switched.length, 1);
    fixture.internal.createExtensionUIContext = () => ({ select: async (_title: string, values: string[]) => {
      fixture.internal.tuiLifecycleGeneration++; return values[0];
    } });
    await fixture.internal.showPermissionsSelector(); assert.equal(switched.length, 1);
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
    assert.deepEqual(errors, []); assert.equal(applied, 4);
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
  const ctx: any = { cwd: root, hasUI: true, ui: { confirm: async () => { prompts++; return false; } }, signal: runtime.executionBoundary.signal,
    sessionManager: { getSessionId: () => "denial", getLeafEntry: () => undefined } };
  t.mock.method(WorkspaceSandboxBackend.prototype, "invoke", async () => ({ id: "fixture", ok: true, changes: [{ path: "existing.txt",
    before: createHash("sha256").update("before").digest("hex"), content: Buffer.from("after").toString("base64") }] }));
  try {
    await assert.rejects(base.powershell.execute("first", {}, ctx.signal, undefined, ctx), /User declined/);
    await assert.rejects(base.powershell.execute("retry", {}, ctx.signal, undefined, ctx), /Explicitly denied/);
    assert.equal(prompts, 1); assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "before");
  } finally { await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); }
});

test("ordinary guest failure retires its snapshot and permits a fresh operation without replay", async t => {
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
      await fs.writeFile(path.join(exchange, "response.json"), JSON.stringify({ id: request.id, ok: calls > 1, error: "Missing guest file", text: "fresh" }));
    } };
  });
  try {
    await assert.rejects(backend.invoke("read", { path: "missing" }), /Missing guest file/);
    assert.equal(backend.diagnostics.root, undefined); assert.equal(backend.diagnostics.ownedArtifacts, 0);
    assert.equal((await backend.invoke("read", { path: "exists" })).text, "fresh");
    assert.equal(starts, 2); assert.equal(calls, 2); assert.equal(cleaned, 1);
    await backend.close(); assert.equal(cleaned, 2);
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
  const ctx: any = { cwd: root, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: { getSessionId: () => "review", getLeafEntry: () => undefined } };
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
