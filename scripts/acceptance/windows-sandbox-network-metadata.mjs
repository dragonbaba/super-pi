// Manual metadata-only entry. No CLI construction or network acceptance invocation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireAcceptanceRoot } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { sha256 } from "./windows-sandbox-package.mjs";

const SOURCES = ["windows-sandbox-network.cs", "windows-sandbox-network-metadata.cs"].map(name => fileURLToPath(new URL(name, import.meta.url)));
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const STAGES = new Set(["enumerate", "count", "identity", "type", "status", "properties", "unicast-count", "gateway-count", "unicast", "gateway", "complete"]);
const REASONS = new Set([null, "interface-count-bound", "interface-identity", "unknown-interface-kind-or-state", "interface-address-count-bound", "unknown-address-family", "unknown-gateway-family"]);
const need = (value, error) => { if (!value) throw new Error(error); };
function exactKeys(value, keys) { need(value && Object.keys(value).sort().join(",") === keys.split(",").sort().join(","), "Unknown metadata fields"); }
export function validateInterfaceMetadata(value, taskId, pid) {
    exactKeys(value, "protocol,taskId,errorType,pid,hresult,nativeErrorCode,trace");
    need(value.protocol === "super-pi-wsb-network-metadata-v1" && value.taskId === taskId && value.pid === pid && Number.isInteger(pid) && pid > 0, "Metadata identity mismatch");
    const t = value.trace;
    exactKeys(t, "stage,reason,count,index,type,status,unicastCount,gatewayCount,completedCount,complete");
    need(STAGES.has(t.stage) && REASONS.has(t.reason) && typeof t.complete === "boolean", "Unknown metadata stage");
    for (const key of ["count", "index", "unicastCount", "gatewayCount"]) need(t[key] === null || Number.isInteger(t[key]) && t[key] >= 0 && t[key] <= 2147483647, "Invalid observed count");
    for (const v of [t.type, t.status, value.hresult, value.nativeErrorCode]) need(v === null || Number.isInteger(v) && v >= -2147483648 && v <= 2147483647, "Invalid observed code");
    need(Number.isInteger(t.completedCount) && t.completedCount >= 0 && t.completedCount <= 32 && (t.count === null ? t.completedCount === 0 : t.completedCount <= t.count), "Invalid completed count");
    need(t.index === null || t.count !== null && t.count <= 32 && t.index < t.count && t.index < 32, "Invalid failure index");
    need(value.errorType === null || typeof value.errorType === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value.errorType), "Invalid exception type");
    if (t.stage === "enumerate") need(t.count === null && t.index === null && t.type === null && t.status === null && t.unicastCount === null && t.gatewayCount === null && t.completedCount === 0 && t.reason === null, "Invented enumeration evidence");
    else need(t.count !== null, "Missing observed interface count");
    if (t.stage === "count") need(t.index === null && t.type === null && t.status === null && t.unicastCount === null && t.gatewayCount === null && t.completedCount === 0, "Invented pre-interface values");
    else if (!["enumerate", "complete"].includes(t.stage)) need(t.index !== null && t.completedCount === t.index, "Missing current interface index");
    if (t.reason !== null) {
        const allowed = { "interface-count-bound": ["count"], "interface-identity": ["identity"], "unknown-interface-kind-or-state": ["type", "status"],
            "interface-address-count-bound": ["unicast-count", "gateway-count"], "unknown-address-family": ["unicast"], "unknown-gateway-family": ["gateway"] };
        need(allowed[t.reason].includes(t.stage) && value.errorType === "InvalidOperationException", "Invalid local rejection reason");
    }
    if (t.complete) need(t.stage === "complete" && t.reason === null && t.count !== null && t.count <= 32 && t.completedCount === t.count && value.errorType === null && value.hresult === null && value.nativeErrorCode === null, "Unproven metadata completion");
    else need(t.stage !== "complete" && value.errorType !== null && value.hresult !== null, "Missing failure evidence");
    return value; // Unknown observed enum values remain diagnostics, never accepted interfaces.
}
export async function runInterfaceMetadata() {
    const resource = acquireAcceptanceRoot();
    const report = { taskId: randomUUID(), kind: "network-interface-metadata", sources: null, compilerSha256: COMPILER_HASH, binarySha256: null,
        helperCalls: [], helperPendingPid: null, receipt: null, error: null, cleanupError: null, artifactRoot: resource.root, artifactsRemoved: false };
    const save = () => resource.journal(report);
    const helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = helpers.calls; report.helperPendingPid = helpers.active?.pid ?? null; save(); });
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    async function helper(executable, args, ms) { need(!controller.signal.aborted, "Cancelled before metadata operation"); return helpers.run(executable, args, ms, controller.signal); }
    try {
        need(process.platform === "win32" && sha256(COMPILER) === COMPILER_HASH, "Pinned compiler changed");
        report.sources = SOURCES.map(source => ({ name: path.basename(source), sha256: sha256(source) })); save();
        const executable = path.join(resource.root, "network-metadata.exe");
        await helper(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/main:NetworkMetadataEntry", "/out:" + executable, ...SOURCES], 30000);
        report.binarySha256 = sha256(executable); save();
        const result = await helper(executable, [report.taskId], 5000);
        need(Buffer.byteLength(result.stdout, "utf8") <= 8192, "Metadata output bound");
        report.receipt = validateInterfaceMetadata(JSON.parse(result.stdout), report.taskId, result.pid); save();
    } catch (error) { report.error = String(error.message); }
    finally {
        process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
        if (helpers.active) { report.cleanupError = "Metadata helper exit unconfirmed"; save(); }
        else { try { resource.remove({ state: "closed-before-start" }); report.artifactsRemoved = true; } catch (error) { report.cleanupError = String(error.message); } }
    }
    process.stdout.write(JSON.stringify(report) + "\n"); return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 2, "No arguments accepted");
    const report = await runInterfaceMetadata(); if (report.error || report.cleanupError || !report.artifactsRemoved) process.exitCode = 1;
}
