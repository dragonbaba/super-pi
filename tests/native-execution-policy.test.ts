import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";

async function fixture(t: TestContext, config = {}, environment: "sandbox" | "trusted-host" = "sandbox") {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-native-policy-"));
    const runtime = createExtensionRuntime(), branch: any[] = [];
    runtime.appendEntry = (customType, data) => { branch.push({ type: "custom", customType, data }); };
    const getEntry = (id: string): any => {
        const index = Number(id), entry = branch[index];
        return entry && Object.assign(entry, { id, parentId: index > 0 ? String(index - 1) : null });
    };
    const ctx: any = { cwd: root, hasUI: false, signal: new AbortController().signal,
        sessionManager: { getSessionId: () => "policy-test", getBranch: () => branch, getLeafEntry: () => getEntry(String(branch.length - 1)), getEntry }, ui: {} };
    const owner = new SessionExecutionPolicy(runtime, environment, config);
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
