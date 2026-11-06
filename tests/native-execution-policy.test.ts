import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import type { SessionPermissionMode } from "../packages/coding-agent/src/core/permission-mode.ts";
import { consumePermissionPathApproval } from "../packages/coding-agent/src/core/files/file-invocation.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";
import { createLsToolDefinition } from "../packages/coding-agent/src/core/tools/ls.ts";
import { consumeToolPath } from "../packages/coding-agent/src/core/files/tool-path-authorization.ts";
import { consumeBrowserExecAuthorization } from "../packages/coding-agent/src/core/files/extension-permissions.ts";
import { consumeDelegatedTaskPolicies } from "../packages/extensions/subagent/delegation.ts";
import { consumeStructuredReadonlyWorkspacePolicy } from "../packages/extensions/structured-readonly-command/delegation.ts";
import structuredReadonlyCommand from "../packages/extensions/structured-readonly-command/index.ts";

async function fixture(t: TestContext, config = {}, environment: "sandbox" | "trusted-host" = "sandbox", mode?: SessionPermissionMode, directories: readonly string[] = []) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-native-policy-")));
    const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(root);
    runtime.appendEntry = (customType, data) => { manager.appendCustomEntry(customType, data); };
    const ctx: any = { cwd: root, hasUI: false, signal: new AbortController().signal,
        sessionManager: manager, ui: {} };
    const owner = new SessionExecutionPolicy(runtime, environment, config, mode, directories);
    t.after(async () => { owner.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); });
    function event(toolName: string, input: object) { return { type: "tool_call", toolName, input, toolCallId: "test-call" } as any; }
    function definition(name: string) { const d: any = { name }; owner.registerDefinition(d); return d; }
    return { root, runtime, manager, get branch() { return manager.getEntries(); }, ctx, owner, event, definition };
}

test("native sandbox denies unsupported aliases and respects exact deny before broad allow", async t => {
    const f = await fixture(t, { rules: [{ tool: "*", decision: "allow" }, { tool: "powershell", command: "blocked", decision: "deny" }] });
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "blocked" }), f.ctx, f.definition("powershell")), /Explicitly denied/);
    await assert.rejects(f.owner.authorize(f.event("bash", { command: "echo x" }), f.ctx, f.definition("bash")), /SANDBOX_UNSUPPORTED/);
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "ok" }), f.ctx, { name: "powershell" } as any), /SANDBOX_UNSUPPORTED/);
});

test("sandbox observation authorizes guest-only paths while preserving workspace and explicit deny", async t => {
    const f = await fixture(t, { rules: [{ tool: "*", path: "blocked", decision: "deny" }] }, "sandbox", "sandbox-write");
    for (const [tool, target] of [["read", ".artifacts/guest.txt"], ["ls", "guest-only-directory"]]) {
        (await f.owner.authorize(f.event(tool!, { path: target }), f.ctx, f.definition(tool!))).release();
    }
    await assert.rejects(f.owner.authorize(f.event("read", { path: "blocked/guest.txt" }), f.ctx, f.definition("read")), /Explicitly denied/);
    await assert.rejects(f.owner.authorize(f.event("read", { path: "../outside.txt" }), f.ctx, f.definition("read")), /outside the workspace/);
    const host = await fixture(t, {}, "trusted-host", "host-write");
    await assert.rejects(host.owner.authorize(host.event("read", { path: "missing.txt" }), host.ctx), { code: "ENOENT" });
});

test("search scopes enforce nested deny/ask on explicit and default roots without widening scoped allow", async t => {
    for (const mode of ["read-only", "sandbox-write", "host-write"] as const) {
        for (const decision of ["deny", "ask"] as const) {
            const f = await fixture(t, { rules: [{ tool: "*", decision: "allow" }, { tool: "*", path: "private", decision }] },
                mode === "host-write" ? "trusted-host" : "sandbox", mode);
            await fs.mkdir(path.join(f.root, "private")); await fs.mkdir(path.join(f.root, "public"));
            await fs.writeFile(path.join(f.root, "private/secret.txt"), "secret");
            await fs.symlink(path.join(f.root, "private"), path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
            for (const tool of ["grep", "find", "ls"]) {
                const definition = f.definition(tool);
                for (const target of [undefined, ".", "private", "alias", "private/secret.txt"]) {
                    await assert.rejects(f.owner.authorize(f.event(tool, { path: target, pattern: "secret" }), f.ctx, definition),
                        decision === "deny" ? /Explicitly denied/ : /APPROVAL_REQUIRED/);
                }
                (await f.owner.authorize(f.event(tool, { path: "public" }), f.ctx, definition)).release();
            }
        }
    }
    const f = await fixture(t, { rules: [{ tool: "find", path: "public", decision: "allow" }] });
    await fs.mkdir(path.join(f.root, "public"));
    const definition = f.definition("find");
    (await f.owner.authorize(f.event("find", { path: "public" }), f.ctx, definition)).release();
    await assert.rejects(f.owner.authorize(f.event("find", {}), f.ctx, definition), /APPROVAL_REQUIRED/);
    await assert.rejects(f.owner.authorize(f.event("find", { path: ".." }), f.ctx, definition), /outside the workspace/);
});

test("native LSP write grants bind root, exact input and lifetime; preview remains read-only", async t => {
    const f = await fixture(t, {}, "trusted-host", "host-write");
    await fs.mkdir(path.join(f.root, "src")); await fs.mkdir(path.join(f.root, ".sp"));
    await fs.writeFile(path.join(f.root, "src/example.ts"), "const n = 1;");
    f.ctx.signal = undefined; // SDK contexts borrow the boundary signal when no caller signal exists.
    const input = { root: "src", path: "example.ts", write: true };
    const invocation = await f.owner.authorize(f.event("lsp_fix", input), f.ctx);
    const grant = consumePermissionPathApproval(input, "test-call", "lsp_fix")!;
    assert.equal(grant.canonicalTarget, await fs.realpath(path.join(f.root, "src/example.ts")));
    assert.equal(grant.revocationSignal, f.runtime.executionBoundary.signal);
    assert.equal(consumePermissionPathApproval(input, "test-call", "lsp_fix"), undefined);
    input.root = ".";
    assert.throws(() => invocation.consume(input, "test-call", "lsp_fix"), /changed after authorization/);
    invocation.release();
    await assert.rejects(f.owner.authorize(f.event("lsp_fix", { root: ".sp", path: "config.ts", write: true }), f.ctx), /workspace_sp_root/);
    f.runtime.executionBoundary.register("plan-fixture", { revoke() {}, async drain() {}, toolSelectionMode: () => "plan" });
    await assert.rejects(f.owner.authorize(f.event("lsp_fix", { ...input, root: "src" }), f.ctx), /Plan mode/);
    const preview = { ...input, root: "src", write: false };
    (await f.owner.authorize(f.event("lsp_fix", preview), f.ctx)).release();
    assert.equal(consumePermissionPathApproval(preview, "test-call", "lsp_fix"), undefined);
    await f.runtime.executionBoundary.transition(() => undefined);
    assert.throws(() => grant.assertCurrent!(), /expired/); assert.equal(grant.revocationSignal?.aborted, true);
    const sandbox = await fixture(t, {}, "sandbox", "sandbox-write");
    await assert.rejects(sandbox.owner.authorize(sandbox.event("lsp_fix", input), sandbox.ctx, sandbox.definition("lsp_fix")), /SANDBOX_UNSUPPORTED/);
});

test("host paths authorize normalized targets and execute the bound read/search target", async t => {
    const f = await fixture(t, { rules: [{ tool: "*", path: "private", decision: "deny" }] }, "trusted-host", "host-write");
    for (const directory of ["private", "@private", "public", "@public"]) await fs.mkdir(path.join(f.root, directory));
    await fs.writeFile(path.join(f.root, "private/secret.txt"), "secret");
    await fs.writeFile(path.join(f.root, "@private/secret.txt"), "decoy");
    for (const tool of ["read", "grep", "find", "ls"]) {
        const suffix = tool === "read" ? "/secret.txt" : "";
        for (const prefix of ["", "@"]) await assert.rejects(
            f.owner.authorize(f.event(tool, { path: prefix + "private" + suffix }), f.ctx), /Explicitly denied/);
    }
    const file = path.join(f.root, "public/example.txt"); await fs.writeFile(file, "expected content");
    for (const operation of ["write", "edit"]) {
        const input = { path: "@private/secret.txt", content: "denied", edits: [] };
        await assert.rejects(f.owner.authorize(f.event(operation, input), f.ctx), /Explicitly denied/);
        await assert.rejects(f.owner.authorize(f.event("file_batch", { operations: [{ ...input, operation }] }), f.ctx), /Explicitly denied/);
    }
    const write = { path: "@public/new.txt", content: "allowed" }, writeInvocation = await f.owner.authorize(f.event("write", write), f.ctx);
    assert.equal(consumePermissionPathApproval(write, "test-call", "write")!.canonicalTarget, path.join(await fs.realpath(f.root), "public/new.txt"));
    writeInvocation.release();
    const read = createReadToolDefinition(f.root);
    const spellings = ["@public/example.txt", file], fromHome = path.relative(os.homedir(), file);
    // A task-owned TEMP can be on another Windows drive; ~/D:/... is not a valid home-relative spelling.
    if (!path.isAbsolute(fromHome)) spellings.push("~/" + fromHome.replaceAll("\\", "/"));
    for (const raw of spellings) {
        const input = { path: raw }, invocation = await f.owner.authorize(f.event("read", input), f.ctx);
        invocation.consume(input, "test-call", "read");
        const result = await read.execute("test-call", input, undefined, undefined, f.ctx);
        assert.match((result.content[0] as any).text, /expected content/); invocation.release();
    }
    const listing = { path: "@public" }, lsInvocation = await f.owner.authorize(f.event("ls", listing), f.ctx);
    const listed = await createLsToolDefinition(f.root).execute("test-call", listing, undefined, undefined, f.ctx);
    assert.match((listed.content[0] as any).text, /example.txt/); lsInvocation.release();
    // A newly appearing spelling must not redirect a read authorized via screenshot fallback.
    await fs.writeFile(path.join(f.root, "capture’s.txt"), "original variant");
    const variant = { path: "capture's.txt" }, bound = await f.owner.authorize(f.event("read", variant), f.ctx);
    await fs.writeFile(path.join(f.root, "capture's.txt"), "later spelling");
    const result = await read.execute("test-call", variant, undefined, undefined, f.ctx);
    assert.match((result.content[0] as any).text, /original variant/); bound.release();
    const changed = { path: "public" }, pending = await f.owner.authorize(f.event("find", changed), f.ctx);
    changed.path = "private";
    assert.throws(() => consumeToolPath(changed, "find", "test-call"), /path changed/); pending.release();
    const stale = { path: "public" }, expired = await f.owner.authorize(f.event("grep", stale), f.ctx);
    await f.runtime.executionBoundary.transition(() => undefined);
    assert.throws(() => consumeToolPath(stale, "grep", "test-call"), /expired/); expired.release();
});

test("native delegated tools receive exact one-call scopes and revoke with their parent", async t => {
    const f = await fixture(t, {}, "trusted-host", "host-write"); f.ctx.signal = undefined;
    await fs.mkdir(path.join(f.root, "src"));
    const task = { agent: "worker", task: "inspect", cwd: "src" };
    await assert.rejects(f.owner.authorize(f.event("subagent", task), f.ctx), /Parent execution channel is unavailable/);
    f.runtime.openSubagentExecution = () => { throw new Error("This authorization-only fixture must not execute a task"); };
    for (const input of [task, { tasks: [task, { ...task, readOnly: true }] }, { chain: [task] }]) {
        const invocation = await f.owner.authorize(f.event("subagent", input), f.ctx);
        const requests = "tasks" in input ? input.tasks! : "chain" in input ? input.chain! : [input];
        const grants = consumeDelegatedTaskPolicies(input, requests.map(item => item.cwd), f.root, "test-call");
        assert.equal(grants.length, requests.length); assert.equal(grants[0].canonicalCwd, await fs.realpath(path.join(f.root, "src")));
        assert.equal(grants[0].writable, true); if (grants.length === 2) assert.equal(grants[1].writable, false);
        assert.equal(grants[0].parentExecution?.profile.workspace, f.root);
        assert.equal(grants[0].parentExecution?.profile.mode, "host-write");
        assert.throws(() => consumeDelegatedTaskPolicies(input, requests.map(item => item.cwd), f.root, "test-call"), /delegation is missing/);
        invocation.release();
    }
    const structured = { command: "git", args: ["status", "--short"], cwd: "src" };
    const invocation = await f.owner.authorize(f.event("structured_readonly_command", structured), f.ctx);
    const policy = consumeStructuredReadonlyWorkspacePolicy(structured, "test-call");
    assert.equal(policy.canonicalRoot, await fs.realpath(f.root)); assert.equal(policy.canonicalCwd, await fs.realpath(path.join(f.root, "src")));
    assert.equal(policy.revocationSignal, f.runtime.executionBoundary.signal); invocation.release();
    const browser = { code: "return 1" }, browserInvocation = await f.owner.authorize(f.event("browser_exec", browser), f.ctx);
    const browserGrant = consumeBrowserExecAuthorization(browser, "test-call"); browserInvocation.release();
    f.runtime.executionBoundary.register("plan-fixture", { revoke() {}, async drain() {}, toolSelectionMode: () => "plan" });
    const plan = await f.owner.authorize(f.event("subagent", task), f.ctx);
    assert.equal(consumeDelegatedTaskPolicies(task, [task.cwd], f.root, "test-call")[0].writable, false); plan.release();
    await assert.rejects(f.owner.authorize(f.event("browser_exec", browser), f.ctx), /Plan mode/);
    await f.runtime.executionBoundary.transition(() => undefined);
    assert.throws(() => policy.assertCurrent(), /expired/); assert.throws(() => browserGrant.assertCurrent(), /expired/);
    assert.equal(policy.revocationSignal.aborted, true);
    const sandbox = await fixture(t, {}, "sandbox", "sandbox-write");
    for (const name of ["subagent", "structured_readonly_command", "browser_exec"])
        await assert.rejects(sandbox.owner.authorize(sandbox.event(name, {}), sandbox.ctx, sandbox.definition(name)), /SANDBOX_UNSUPPORTED/);
});

test("native delegation enforces scoped rules, exact identities and changed input", async t => {
    const f = await fixture(t, { rules: [{ tool: "*", path: "private", decision: "deny" }] }, "trusted-host", "host-write");
    f.runtime.openSubagentExecution = () => { throw new Error("This authorization-only fixture must not execute a task"); };
    await fs.mkdir(path.join(f.root, "private")); await fs.mkdir(path.join(f.root, "public"));
    await assert.rejects(f.owner.authorize(f.event("subagent", { agent: "worker", task: "inspect" }), f.ctx), /Explicitly denied/);
    await assert.rejects(f.owner.authorize(f.event("structured_readonly_command", { command: "rg", args: ["x", "private"] }), f.ctx), /Explicitly denied/);
    const task = { agent: "worker", task: "inspect", cwd: "public", readOnly: false }, invocation = await f.owner.authorize(f.event("subagent", task), f.ctx);
    task.readOnly = true;
    assert.throws(() => invocation.consume(task, "test-call", "subagent"), /changed after authorization/); invocation.release();
    await fs.rename(path.join(f.root, "public"), path.join(f.root, "original-public")); await fs.mkdir(path.join(f.root, "public"));
    assert.throws(() => consumeDelegatedTaskPolicies(task, ["public"], f.root, "test-call"), /identity changed/);
});

test("native structured command executes in its granted cwd and includes exact external argument roots", async t => {
    const f = await fixture(t, {}, "trusted-host", "host-write"), outside = await fixture(t, {}, "trusted-host", "host-write");
    execFileSync("git", ["init", "--quiet", f.root], { windowsHide: true });
    await fs.writeFile(path.join(f.root, "example.txt"), "untracked");
    let definition: any; structuredReadonlyCommand({ registerTool(tool: any) { definition = tool; } } as any);
    const input = { command: "git", args: ["status", "--short"] };
    const invocation = await f.owner.authorize(f.event("structured_readonly_command", input), f.ctx);
    invocation.consume(input, "test-call", "structured_readonly_command");
    const result = await definition.execute("test-call", input, undefined, undefined, f.ctx);
    assert.match(result.content[0].text, /example.txt/); invocation.release();
    await fs.writeFile(path.join(outside.root, "input.txt"), "needle");
    const external = { command: "rg", args: ["-e", "needle", path.join(outside.root, "input.txt")] };
    const externalInvocation = await f.owner.authorize(f.event("structured_readonly_command", external), f.ctx);
    const scope = consumeStructuredReadonlyWorkspacePolicy(external, "test-call");
    assert.deepEqual(scope.authorizedRoots, [await fs.realpath(f.root), await fs.realpath(outside.root)]); externalInvocation.release();
    const relative = { command: "git", args: ["status"], cwd: path.relative(f.root, outside.root) };
    const relativeInvocation = await f.owner.authorize(f.event("structured_readonly_command", relative), f.ctx);
    assert.equal(consumeStructuredReadonlyWorkspacePolicy(relative, "test-call").canonicalCwd, await fs.realpath(outside.root)); relativeInvocation.release();
});
test("ask never silently grants, and changed arguments cannot consume an approval", async t => {
    const f = await fixture(t, { approval: "never", rules: [{ tool: "powershell", decision: "ask" }] });
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "ok" }), f.ctx, f.definition("powershell")), /APPROVAL_REQUIRED/);
    const g = await fixture(t);
    const input = { command: "ok", inputs: [] };
    const grant = await g.owner.authorize(g.event("powershell", input), g.ctx, g.definition("powershell"));
    input.command = "different";
    assert.throws(() => grant.consume(input, "test-call", "powershell"), /changed after authorization/);
    grant.release();
});
test("all batch paths are checked before any native mutation is prepared", async t => {
    const f = await fixture(t, { rules: [{ tool: "file_batch", decision: "allow", path: "." }] });
    await assert.rejects(f.owner.authorize(f.event("file_batch", { operations: [
        { operation: "write", path: "ok.txt", content: "x" }, { operation: "write", path: "../escape.txt", content: "x" },
    ] }), f.ctx, f.definition("file_batch")), /workspace_escape/);
    assert.deepEqual(await fs.readdir(f.root), []);
});

test("canonical workspace selection protects additional roots through aliases and permits ordinary siblings", async t => {
    const additional = await fixture(t), f = await fixture(t, { rules: [{ tool: "*", decision: "allow" }] }, "trusted-host", "host-write", [additional.root]);
    for (const name of [".git", ".sp"]) {
        await fs.mkdir(path.join(additional.root, name));
        await fs.writeFile(path.join(additional.root, name, "config"), "protected");
    }
    await fs.writeFile(path.join(additional.root, "ordinary.txt"), "ordinary");
    await fs.symlink(additional.root, path.join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
    for (const target of ["alias", "alias/.git/config", "alias/.sp/config"]) {
        await assert.rejects(f.owner.authorize(f.event("delete", { path: target }), f.ctx), /workspace_(root|git_root|sp_root)/);
    }
    const input = { path: "alias/ordinary.txt", content: "allowed" };
    const invocation = await f.owner.authorize(f.event("write", input), f.ctx);
    assert.equal(consumePermissionPathApproval(input, "test-call", "write")!.canonicalTarget, await fs.realpath(path.join(additional.root, "ordinary.txt")));
    invocation.release();
    await fs.mkdir(path.join(f.root, "..ordinary"));
    const sandbox = await fixture(t, {}, "sandbox", "sandbox-write", [additional.root]);
    await fs.symlink(additional.root, path.join(sandbox.root, "alias"), process.platform === "win32" ? "junction" : "dir");
    (await sandbox.owner.authorize(sandbox.event("read", { path: "alias/ordinary.txt" }), sandbox.ctx, sandbox.definition("read"))).release();
    (await f.owner.authorize(f.event("write", { path: "..ordinary/new.txt", content: "allowed" }), f.ctx)).release();
});

test("unavailable additional grants block their own paths without disabling the primary host workspace", async t => {
    const additional = await fixture(t), directory = path.join(additional.root, "grant");
    await fs.mkdir(directory);
    const f = await fixture(t, {}, "trusted-host", "host-write", [directory]);
    await fs.writeFile(path.join(f.root, "ordinary.txt"), "ordinary");
    await fs.rmdir(directory);
    (await f.owner.authorize(f.event("read", { path: "ordinary.txt" }), f.ctx)).release();
    (await f.owner.authorize(f.event("write", { path: "new.txt", content: "allowed" }), f.ctx)).release();
    await assert.rejects(f.owner.authorize(f.event("write", { path: path.join(directory, "new.txt"), content: "blocked" }), f.ctx), /unavailable|redirected/i);
    await fs.symlink(f.root, directory, process.platform === "win32" ? "junction" : "dir");
    (await f.owner.authorize(f.event("read", { path: "ordinary.txt" }), f.ctx)).release();
    await assert.rejects(f.owner.authorize(f.event("read", { path: path.join(directory, "ordinary.txt") }), f.ctx), /unavailable|redirected/i);
    const sandbox = await fixture(t, {}, "sandbox", "sandbox-write", [directory]);
    await assert.rejects(sandbox.owner.authorize(sandbox.event("ls", { path: "." }), sandbox.ctx, sandbox.definition("ls")), /unavailable|redirected/i);
});
test("native workspace leases retain original directory identity and revoke on transitions", async t => {
    const f = await fixture(t);
    const target = path.join(f.root, "input.txt"); await fs.writeFile(target, "input");
    const read = await f.owner.prepareInputRead(f.ctx, [target]);
    const workspace = await f.owner.prepareInputWorkspaceRead(f.ctx, [target]);
    await workspace.renew();
    assert.equal(workspace.binding.canonicalPath, await fs.realpath(f.root));
    await f.runtime.executionBoundary.transition(() => undefined);
    assert.throws(() => read.assertCurrent(), /expired/);
    assert.throws(() => workspace.assertCurrent(), /expired/);
    read.dispose(); workspace.dispose();
    assert.equal(read.diagnostics.weakReferences, 0); assert.equal(workspace.diagnostics.weakReferences, 0);
});
test("legacy grants are not widened after an explicit refusal", async t => {
    const f = await fixture(t, { rules: [{ tool: "powershell", decision: "ask" }] });
    f.ctx.hasUI = true; let prompts = 0; f.ctx.ui.select = async (_title: string, choices: string[]) => { prompts++; return choices[1]; };
    const e = f.event("powershell", { command: "exact" }), d = f.definition("powershell");
    await assert.rejects(f.owner.authorize(e, f.ctx, d), /User declined/);
    await assert.rejects(f.owner.authorize(e, f.ctx, d), /Explicitly denied/);
    assert.equal(prompts, 1); assert.equal((f.branch[0] as any).customType, "native-permission-denial-v2");
    f.manager.appendCustomEntry("session-permission-state-v1", { mode: "full-access", approvalPolicy: "never-ask" });
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "another" }), f.ctx, d), /LEGACY_PERMISSION_MIGRATION/);
});

test("cancelled approvals never persist; explicit reasons and revocations survive disk restore", async t => {
    const f = await fixture(t, { rules: [{ tool: "powershell", decision: "ask" }] }, "trusted-host", "host-write");
    const manager = SessionManager.create(f.root, path.join(f.root, "history"));
    manager.appendMessage({ role: "user", content: "permission fixture", timestamp: 1 });
    f.ctx.sessionManager = manager; f.ctx.hasUI = true;
    f.runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
    let selection: number | undefined, explanation: string | undefined, prompts = 0;
    f.ctx.ui.select = async (_title: string, choices: string[], options: any) => {
        prompts++; assert.equal(options.timeout, 60000); assert.equal(options.kind, "permission");
        assert.match(options.details, /cwd:/); return selection === undefined ? undefined : choices[selection];
    };
    f.ctx.ui.input = async () => explanation;
    const event = f.event("powershell", { command: "Write-Output fixture" });
    await assert.rejects(f.owner.authorize(event, f.ctx), /APPROVAL_CANCELLED/);
    selection = 2;
    await assert.rejects(f.owner.authorize(event, f.ctx), /APPROVAL_CANCELLED/);
    assert.deepEqual(f.owner.listRefusals(f.ctx), []); assert.equal(manager.getEntryCount(), 1);
    selection = 0; (await f.owner.authorize(event, f.ctx)).release();
    selection = 2; explanation = "Keep this request blocked";
    await assert.rejects(f.owner.authorize(event, f.ctx), /User declined.*Keep this request blocked/);
    assert.equal(prompts, 4);
    const refused = f.owner.listRefusals(f.ctx)[0]!;
    assert.equal(refused.source, "explicit"); assert.equal(refused.reason, explanation);
    f.owner.dispose();

    const runtime = createExtensionRuntime(), restored = SessionManager.open(manager.getSessionFile()!);
    runtime.appendEntry = (type, data) => { restored.appendCustomEntry(type, data); };
    const owner = new SessionExecutionPolicy(runtime, "trusted-host", { rules: [{ tool: "powershell", decision: "ask" }] }, "host-write");
    const ctx = { ...f.ctx, sessionManager: restored, signal: runtime.executionBoundary.signal };
    try {
        await assert.rejects(owner.authorize(event, ctx), /Explicitly denied/);
        assert.equal(prompts, 4); assert.deepEqual(owner.listRefusals(ctx), [refused]);
        assert.equal(owner.revokeRefusal(ctx, refused.key), true);
        assert.equal(owner.revokeRefusal(ctx, refused.key), false);
        ctx.sessionManager = SessionManager.open(manager.getSessionFile()!);
        assert.deepEqual(owner.listRefusals(ctx), [], "disk restoration includes the explicit revocation");
        selection = 0; (await owner.authorize(event, ctx)).release();
        assert.equal(prompts, 5, "revocation asks again rather than granting permanent allow");
    } finally { owner.dispose(); await runtime.executionBoundary.dispose(); }
});

test("legacy refusal recovery is explicit and a batch revocation only removes its selected operation", async t => {
    const f = await fixture(t, { rules: [{ tool: "write", decision: "ask" }, { tool: "file_batch", decision: "ask" }] }, "trusted-host", "host-write");
    f.ctx.hasUI = true; let prompts = 0, choice = 1;
    f.ctx.ui.select = async (_title: string, choices: string[]) => { prompts++; return choices[choice]; };
    f.manager.appendCustomEntry("fixture", {}); const fork = f.manager.getLeafId()!;
    const first = { operation: "write", path: "first.txt", content: "first" }, second = { operation: "write", path: "second.txt", content: "second" };
    const batch = f.event("file_batch", { operations: [first, second] });
    await assert.rejects(f.owner.authorize(batch, f.ctx), /User declined/);
    const records = f.owner.listRefusals(f.ctx); assert.equal(records.length, 2);
    f.manager.appendCustomEntry("native-permission-denial-v1", { key: records[0]!.key });
    assert.equal(f.owner.listRefusals(f.ctx)[0]!.source, "legacy");
    f.manager.branch(fork);
    await assert.rejects(f.owner.authorize(batch, f.ctx), /Explicitly denied/);
    assert.equal(f.owner.revokeRefusal(f.ctx, records[0]!.key), true);
    choice = 0;
    (await f.owner.authorize(f.event("write", { path: first.path, content: first.content }), f.ctx)).release();
    await assert.rejects(f.owner.authorize(batch, f.ctx), /Explicitly denied/);
    await assert.rejects(f.owner.authorize(f.event("write", { path: second.path, content: second.content }), f.ctx), /Explicitly denied/);
    assert.equal(prompts, 2); assert.deepEqual(f.owner.listRefusals(f.ctx).map(record => record.key), [records[1]!.key]);
});

test("ordinary no-policy tools share only an epoch gate; revocation still blocks every borrowed gate", async () => {
    const runtime = createExtensionRuntime();
    const runner = new ExtensionRunner([], runtime, process.cwd(), SessionManager.inMemory(process.cwd()), {} as any);
    const gates = [];
    for (let index = 0; index < 129; index++) gates.push((await runner.emitToolCall({ type: "tool_call", toolName: "probe", toolCallId: String(index), input: {} } as any))!.finalAuthorization!);
    assert.equal(new Set(gates).size, 1); assert.equal((runner as any).finalAuthorizations, undefined);
    const input = {}; assert.equal(gates[0].consume(input, "0", "probe"), input);
    runner.invalidate("test revoke", true);
    for (const gate of gates) assert.throws(() => gate.consume(input, "0", "probe"), /revoked/);
    assert.equal((runner as any).ordinaryToolEpoch, undefined);
    await runtime.executionBoundary.dispose();
});

test("authorization scans only new branch entries and rechecks a different branch", async t => {
    const runtime = createExtensionRuntime(), session = SessionManager.inMemory(process.cwd());
    const owner = new SessionExecutionPolicy(runtime, "sandbox", { rules: [{ tool: "*", decision: "allow" }] });
    const definition: any = { name: "powershell" }; owner.registerDefinition(definition);
    for (let i = 0; i < 10000; i++) session.appendCustomEntry("history", {});
    const fork = session.getLeafId()!;
    const ctx: any = { cwd: process.cwd(), sessionManager: session, hasUI: false, signal: runtime.executionBoundary.signal };
    const event: any = { type: "tool_call", toolName: "powershell", toolCallId: "review", input: { command: "exact" } };
    let lookups = 0, visits = 0; const getEntry = session.getEntry.bind(session), visit = owner.visitSessionEntry;
    owner.visitSessionEntry = function(entry) { visits++; visit.call(owner, entry); };
    t.mock.method(session, "getBranch", () => { throw new Error("Unbounded branch materialization"); });
    t.mock.method(session, "getEntries", () => { throw new Error("Unbounded session materialization"); });
    t.mock.method(session, "getEntry", (id: string) => { lookups++; return getEntry(id); });
    try {
        (await owner.authorize(event, ctx, definition)).release(); const initial = lookups;
        assert.equal(visits, 10000);
        for (let i = 0; i < 20; i++) (await owner.authorize(event, ctx, definition)).release();
        assert.equal(lookups, initial); assert.equal(visits, 10000);
        session.appendCustomEntry("history", {}); session.appendCustomEntry("history", {});
        (await owner.authorize(event, ctx, definition)).release(); assert.equal(lookups - initial, 2); assert.equal(visits, 10002);
        session.branch(fork); session.appendCustomEntry("session-permission-state-v1", {});
        await assert.rejects(owner.authorize(event, ctx, definition), /LEGACY_PERMISSION_MIGRATION/);
        session.branch(fork); (await owner.authorize(event, ctx, definition)).release();
        t.diagnostic(JSON.stringify({ history: 10000, unchangedInvocations: 20, unchangedLookups: 0, unchangedAppendVisits: 0, appendedLookups: 2, appendedVisits: 2, historyArrays: 0 }));
    } finally {
        owner.dispose(); await runtime.executionBoundary.dispose();
        assert.equal((owner as any).denied.size, 0); assert.equal((owner as any).refusalManager, undefined);
        assert.equal((owner as any).scannedLeaf, undefined); assert.equal((owner as any).refusalCursor, 0);
    }
});
