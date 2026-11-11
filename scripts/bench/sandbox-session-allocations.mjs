import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHook } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy } from "../../packages/coding-agent/src/core/execution-policy.ts";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const weak = [], counts = { hotPromises: 0, hotControllers: 0, policyChecks: 0, ordinaryChecks: 0 };
let hot = false;
const hooks = createHook({ init(_id, type) { if (hot && type === "PROMISE") counts.hotPromises++; } });
const originalController = globalThis.AbortController;
globalThis.AbortController = class extends originalController { constructor() { super(); if (hot) counts.hotControllers++; } };
const profiler = new Session(); profiler.connect();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sp-sandbox-perf-")));
const rootId = fs.lstatSync(root, { bigint: true });
const leaf = path.join(root, "input.txt"); fs.writeFileSync(leaf, "bounded input");
const leafId = fs.lstatSync(leaf, { bigint: true });

async function policyRun() {
    const runtime = createExtensionRuntime(), owner = new SessionExecutionPolicy(runtime, "sandbox");
    const ctx = { cwd: root, signal: new AbortController().signal, sessionManager: { getSessionId: () => "performance" } };
    const lease = await owner.prepareInputWorkspaceRead(ctx, [root, leaf]);
    weak.push(new WeakRef(owner), new WeakRef(ctx), new WeakRef(lease));
    for (let index = 0; index < 10000; index++) lease.assertCurrent();
    hot = true;
    try { for (let index = 0; index < 100000; index++) { lease.assertCurrent(); lease.assertGrantIdentity(); counts.policyChecks += 2; } }
    finally { hot = false; }
    lease.dispose(); assert.equal(lease.diagnostics.weakReferences, 0);
    owner.dispose(); await runtime.executionBoundary.dispose(); runtime.invalidate();
}
async function ordinaryRun() {
    const runtime = createExtensionRuntime();
    const runner = new ExtensionRunner([], runtime, root, SessionManager.inMemory(), {});
    const event = { type: "tool_call", toolName: "ordinary", toolCallId: "performance", input: {} };
    const guard = (await runner.emitToolCall(event)).finalAuthorization;
    weak.push(new WeakRef(runtime), new WeakRef(runner), new WeakRef(guard));
    hot = true;
    try { for (let index = 0; index < 200000; index++) { guard.consume(event.input, event.toolCallId, event.toolName); counts.ordinaryChecks++; } }
    finally { hot = false; }
    assert.equal(runner.finalAuthorizations, undefined);
    await runtime.executionBoundary.transition(() => undefined);
    assert.throws(() => guard.consume(event.input, event.toolCallId, event.toolName), /revoked/);
    runner.invalidate(); await runtime.executionBoundary.dispose(); runtime.invalidate();
}
try {
    hooks.enable();
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await policyRun(); await ordinaryRun();
    const profile = await profiler.post("HeapProfiler.stopSampling");
    hooks.disable(); globalThis.AbortController = originalController;
    const allocations = [];
    function inspect(node) {
        if (node.selfSize && /execution-policy|input-workspace-grant-lease|session-input-read-permission|extensions\/runner/.test(node.callFrame.url))
            allocations.push({ function: node.callFrame.functionName, line: node.callFrame.lineNumber + 1, bytes: node.selfSize });
        for (const child of node.children ?? []) inspect(child);
    }
    inspect(profile.profile.head);
    const workspaceCheckSampledBytes = allocations.reduce((sum, item) => sum + (item.function === "assertWorkspace" ? item.bytes : 0), 0);
    assert.ok(workspaceCheckSampledBytes <= 65536, "repeated workspace checks regressed to per-check allocations");
    const ordinaryCheckSampledBytes = allocations.reduce((sum, item) => sum + (item.function === "consume" ? item.bytes : 0), 0);
    assert.ok(ordinaryCheckSampledBytes <= 65536, "ordinary epoch checks regressed to per-check allocations");
    for (let round = 0; round < 4; round++) { await tick(); globalThis.gc(); }
    const live = weak.reduce((total, item) => total + Number(item.deref() !== undefined), 0);
    assert.equal(live, 0); assert.equal(counts.hotPromises, 0); assert.equal(counts.hotControllers, 0);
    console.log(JSON.stringify({ contract: "sandbox-session-allocation-v1", counts, allocations, workspaceCheckSampledBytes, ordinaryCheckSampledBytes,
        lifecycle: { targets: weak.length, gcRounds: 4, live }, hotPermissionChecks: { promises: counts.hotPromises, controllers: counts.hotControllers }, note: "Closure/array/wrapper counts also require source invariants; profiler samples include cold startup and completion." }));
} finally {
    hooks.disable(); globalThis.AbortController = originalController; profiler.disconnect();
    const currentRoot = fs.lstatSync(root, { bigint: true }), currentLeaf = fs.lstatSync(leaf, { bigint: true });
    assert.equal(currentRoot.dev, rootId.dev); assert.equal(currentRoot.ino, rootId.ino); assert.equal(fs.realpathSync(root), root);
    assert.equal(currentLeaf.dev, leafId.dev); assert.equal(currentLeaf.ino, leafId.ino);
    fs.unlinkSync(leaf); fs.rmdirSync(root);
}
