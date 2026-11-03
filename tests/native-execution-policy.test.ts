import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import type { SessionPermissionMode } from "../packages/coding-agent/src/core/permission-mode.ts";
import { consumePermissionPathApproval } from "../packages/coding-agent/src/core/files/file-invocation.ts";

async function fixture(t: TestContext, config = {}, environment: "sandbox" | "trusted-host" = "sandbox", mode?: SessionPermissionMode) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-native-policy-"));
    const runtime = createExtensionRuntime(), branch: any[] = [];
    runtime.appendEntry = (customType, data) => { branch.push({ type: "custom", customType, data }); };
    const getEntry = (id: string): any => {
        const index = Number(id), entry = branch[index];
        return entry && Object.assign(entry, { id, parentId: index > 0 ? String(index - 1) : null });
    };
    const ctx: any = { cwd: root, hasUI: false, signal: new AbortController().signal,
        sessionManager: { getSessionId: () => "policy-test", getBranch: () => branch, getLeafEntry: () => getEntry(String(branch.length - 1)), getEntry }, ui: {} };
    const owner = new SessionExecutionPolicy(runtime, environment, config, mode);
    t.after(async () => { owner.dispose(); await runtime.executionBoundary.dispose(); await fs.rm(root, { recursive: true }); });
    function event(toolName: string, input: object) { return { type: "tool_call", toolName, input, toolCallId: "test-call" } as any; }
    function definition(name: string) { const d: any = { name }; owner.registerDefinition(d); return d; }
    return { root, runtime, branch, ctx, owner, event, definition };
}

test("native sandbox denies unsupported aliases and respects exact deny before broad allow", async t => {
    const f = await fixture(t, { rules: [{ tool: "*", decision: "allow" }, { tool: "powershell", command: "blocked", decision: "deny" }] });
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "blocked" }), f.ctx, f.definition("powershell")), /Explicitly denied/);
    await assert.rejects(f.owner.authorize(f.event("bash", { command: "echo x" }), f.ctx, f.definition("bash")), /SANDBOX_UNSUPPORTED/);
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "ok" }), f.ctx, { name: "powershell" } as any), /SANDBOX_UNSUPPORTED/);
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
    await assert.rejects(f.owner.authorize(f.event("lsp_fix", { root: ".sp", path: "config.ts", write: true }), f.ctx), /Protected/);
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
    ] }), f.ctx, f.definition("file_batch")), /out-of-workspace/);
    assert.deepEqual(await fs.readdir(f.root), []);
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
test("old grants are not widened, and new user refusals survive owner recreation", async t => {
    const f = await fixture(t, { rules: [{ tool: "powershell", decision: "ask" }] });
    f.ctx.hasUI = true; let prompts = 0; f.ctx.ui.confirm = async () => { prompts++; return false; };
    const e = f.event("powershell", { command: "exact" }), d = f.definition("powershell");
    await assert.rejects(f.owner.authorize(e, f.ctx, d), /User declined/);
    await assert.rejects(f.owner.authorize(e, f.ctx, d), /Explicitly denied/);
    assert.equal(prompts, 1); assert.equal(f.branch[0].customType, "native-permission-denial-v1");
    f.branch.push({ type: "custom", customType: "session-permission-state-v1", data: { mode: "full-access", approvalPolicy: "never-ask" } });
    await assert.rejects(f.owner.authorize(f.event("powershell", { command: "another" }), f.ctx, d), /LEGACY_PERMISSION_MIGRATION/);
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
    let lookups = 0; const getEntry = session.getEntry.bind(session);
    t.mock.method(session, "getBranch", () => { throw new Error("Unbounded branch materialization"); });
    t.mock.method(session, "getEntry", (id: string) => { lookups++; return getEntry(id); });
    try {
        (await owner.authorize(event, ctx, definition)).release(); const initial = lookups;
        for (let i = 0; i < 20; i++) (await owner.authorize(event, ctx, definition)).release();
        assert.equal(lookups, initial);
        session.appendCustomEntry("history", {}); session.appendCustomEntry("history", {});
        (await owner.authorize(event, ctx, definition)).release(); assert.equal(lookups - initial, 2);
        session.branch(fork); session.appendCustomEntry("session-permission-state-v1", {});
        await assert.rejects(owner.authorize(event, ctx, definition), /LEGACY_PERMISSION_MIGRATION/);
        session.branch(fork); (await owner.authorize(event, ctx, definition)).release();
        t.diagnostic(JSON.stringify({ history: 10000, unchangedInvocations: 20, unchangedLookups: 0, appendedLookups: 2, branchArrays: 0 }));
    } finally { owner.dispose(); await runtime.executionBoundary.dispose(); }
});
