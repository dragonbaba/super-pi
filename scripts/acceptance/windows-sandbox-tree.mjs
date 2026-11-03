// Fixed three-process guest tree; VM termination is the cleanup boundary, not per-process normal exit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { acquireAcceptanceRoot, FixedCli, SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { windowsSandboxConfig, sha256 } from "./windows-sandbox-package.mjs";
import { readBoundedFile } from "./windows-sandbox-files.mjs";
import { awaitReady, validateCancellationReady, cancellationPassed, finishCancellationArtifacts } from "./windows-sandbox-cancel.mjs";
export const TREE_PROTOCOL = "super-pi-wsb-tree-v1";
const SOURCE = fileURLToPath(new URL("./windows-sandbox-tree.cs", import.meta.url));
const EXECUTABLE = "C:\\SuperPiCancel\\Input\\probe.exe";
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const need = (value, error) => { if (!value) throw new Error(error); };
function exact(value, fields) { need(value && Object.keys(value).sort().join(",") === fields.split(",").sort().join(","), "Unknown tree evidence fields"); }
export function validateTreeReady(value, taskId, parentPid) {
    exact(value, "protocol,taskId,complete,nodes,edges");
    need(value.protocol === TREE_PROTOCOL && value.taskId === taskId && value.complete === true && Array.isArray(value.nodes) && value.nodes.length === 3
        && Array.isArray(value.edges) && value.edges.length === 2, "Incomplete fixed tree");
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
        const node = value.nodes[i]; exact(node, "role,pid,creationTicks,path,sessionId,system,alive");
        need(node.role === ["parent", "child", "grandchild"][i] && Number.isInteger(node.pid) && node.pid > 0 && !seen.has(node.pid)
            && typeof node.creationTicks === "string" && /^[1-9][0-9]{17}$/.test(node.creationTicks) && node.path === EXECUTABLE
            && node.sessionId === 0 && node.system === true && node.alive === true, "Wrong tree identity or inactive role"); seen.add(node.pid);
        if (i === 0) need(node.pid === parentPid, "Tree parent differs from ready");
        else need(BigInt(node.creationTicks) >= BigInt(value.nodes[i - 1].creationTicks), "Child predates its parent");
    }
    value.edges.forEach((edge, i) => {
        exact(edge, "parentPid,childPid,childCreationTicks");
        need(edge.parentPid === value.nodes[i].pid && edge.childPid === value.nodes[i + 1].pid && edge.childCreationTicks === value.nodes[i + 1].creationTicks,
            "Start handle and self identity disagree");
    });
    return value;
}
export function treeCancellationPassed(record) {
    try { validateTreeReady(record.treeReady, record.taskId, record.ready?.pid); } catch { return false; }
    return cancellationPassed(record);
}
const monotonicNow = () => performance.now();
export async function observeTreeCancellation(owner, record, controller, readReadiness, state, now = monotonicNow) {
    need(!controller.signal.aborted, "Cancelled before tree execution"); state.dispatchMs = now();
    state.execution = owner.executeCancellationProbe(controller.signal).then(result => ({ result }), error => ({ error: String(error.message) }));
    const slot = owner.execution; need(slot, "Exec was not dispatched");
    const readiness = await readReadiness(slot, state.dispatchMs);
    record.ready = validateCancellationReady(readiness.ready, record.taskId);
    record.treeReady = validateTreeReady(readiness.tree, record.taskId, record.ready.pid);
    record.readyElapsedMs = now() - state.dispatchMs;
    need(!controller.signal.aborted && record.readyElapsedMs < 10000 && owner.execution === slot && !slot.operation.result && slot.entry.outcome === "launching", "No live execution after complete tree readiness");
    record.executionPendingAtCancel = true; record.plannedCancel = true; record.cancelElapsedMs = now() - state.dispatchMs;
    record.cancelRequestedUtc = new Date().toISOString(); controller.abort();
    record.logicalResult = await state.execution; record.logicalCancelled = slot.entry.outcome === "cancelled";
    need(record.logicalCancelled, "Did not observe planned tree cancellation");
}
export async function runTreeAcceptance() {
    const resource = acquireAcceptanceRoot();
    const record = { protocol: TREE_PROTOCOL, taskId: randomUUID(), sourceSha256: null, compilerSha256: COMPILER_HASH, probeSha256: null,
        ready: null, treeReady: null, readyElapsedMs: null, cancelElapsedMs: null, cancelRequestedUtc: null, executionTotalMs: null,
        plannedCancel: false, externalCancelled: false, externalCancelledUtc: null, executionPendingAtCancel: false, logicalCancelled: false, logicalResult: null,
        closed: false, lifecycle: null, helperCalls: [], helperPendingPid: null, error: null, cleanupError: null, artifactRoot: resource.root, artifactsRemoved: false };
    const save = () => resource.journal(record);
    const helpers = new OwnedHelperRunner(resource.root, () => { record.helperCalls = helpers.calls; record.helperPendingPid = helpers.active?.pid ?? null; save(); });
    const controller = new AbortController(), cancel = () => { record.externalCancelled = true; record.externalCancelledUtc ??= new Date().toISOString(); controller.abort(); };
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    let owner; const state = {};
    try {
        need(process.platform === "win32" && sha256(COMPILER) === COMPILER_HASH, "Pinned tree compiler changed"); record.sourceSha256 = sha256(SOURCE); save();
        const input = path.join(resource.root, "input"), output = path.join(resource.root, "output"); fs.mkdirSync(input); fs.mkdirSync(output);
        const outputIdentity = fs.lstatSync(output, { bigint: true }), executable = path.join(input, "probe.exe");
        need(!controller.signal.aborted, "Cancelled before compile");
        await helpers.run(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable, SOURCE], 30000, controller.signal);
        record.probeSha256 = sha256(executable); fs.writeFileSync(path.join(input, "request.json"), JSON.stringify({ protocol: TREE_PROTOCOL, taskId: record.taskId }), { flag: "wx" }); save();
        need(!controller.signal.aborted, "Cancelled before instance");
        owner = new SandboxLifecycle({ cli: new FixedCli(), config: windowsSandboxConfig(input, output).replaceAll("SuperPiProbe", "SuperPiCancel"), taskId: record.taskId,
            workload: { kind: "fixed-tree-cancel", input, output, probeSha256: record.probeSha256 }, journal(value) { record.lifecycle = value; save(); } });
        await owner.start(controller.signal);
        await observeTreeCancellation(owner, record, controller, async (slot, dispatchMs) => ({
            ready: await awaitReady(output, outputIdentity, owner, slot, controller.signal, dispatchMs),
            tree: JSON.parse(readBoundedFile(path.join(output, "tree.json"), 4096).bytes.toString("utf8")),
        }), state); save();
    } catch (error) { record.error = String(error.message); controller.abort(); }
    finally {
        if (owner) { record.closed = await owner.cleanup(); record.cleanupError = owner.cleanupError ?? null; }
        if (state.execution) await state.execution;
        finishCancellationArtifacts(record, resource, owner, helpers.active, state.dispatchMs);
        process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
    record.passed = treeCancellationPassed(record); process.stdout.write(JSON.stringify(record) + "\n"); return record;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 2, "No arguments accepted"); if (!(await runTreeAcceptance()).passed) process.exitCode = 1;
}
