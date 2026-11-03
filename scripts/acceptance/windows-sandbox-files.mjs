// Fixed disposable RO/RW and six-path mapping acceptance. No actual workspace is shared.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { acquireAcceptanceRoot, FixedCli, SandboxLifecycle, successful } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { windowsSandboxConfig, sha256 } from "./windows-sandbox-package.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
export const FILE_PROTOCOL = "super-pi-wsb-files-v1";
export const DENIED_NAMES = ["host-private", "parent-neighbor", "host-git", "parent-git", "host-sp", "parent-sp"];
const HOST_ROOT = "D:\\RMProjects\\Pi\\.artifacts\\windows-sandbox-acceptance-owner";
const SOURCE = fileURLToPath(new URL("./windows-sandbox-files.cs", import.meta.url));
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const need = (value, error) => { if (!value) throw new Error(error); };
function exact(value, keys) { need(value && Object.keys(value).sort().join(",") === keys.split(",").sort().join(","), "Unknown file evidence fields"); }
function openResult(value, name, incomplete) {
    exact(value, "name,opened,openError,closeError"); need(value.name === name && typeof value.opened === "boolean", "Wrong operation identity");
    for (const code of [value.openError, value.closeError]) need(code === null || Number.isInteger(code) && code >= 0 && code <= 0xFFFFFFFF, "Invalid native error code");
    need(value.opened ? value.openError === null : (value.openError !== null || incomplete) && value.closeError === null, "Mixed open and close evidence");
}
export function validateFileReceipt(value, taskId) {
    exact(value, "protocol,taskId,error,pid,sessionId,system,inputReadMatched,outputMatched,complete,ro,denied");
    need(value.protocol === FILE_PROTOCOL && value.taskId === taskId && Number.isInteger(value.pid) && value.pid > 0 && value.sessionId === 0 && value.system === true, "Wrong file probe identity");
    for (const key of ["inputReadMatched", "outputMatched", "complete"]) need(typeof value[key] === "boolean", "Missing file evidence flag");
    need(value.error === null || typeof value.error === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value.error), "Invalid probe error");
    if (value.ro !== null) openResult(value.ro, "ro-append", value.error !== null);
    need(Array.isArray(value.denied) && value.denied.length <= DENIED_NAMES.length, "Invalid denied operations");
    value.denied.forEach((item, index) => openResult(item, DENIED_NAMES[index], value.error !== null));
    return value; // Preserve unexpected opens even if a later error makes the report incomplete.
}
class ObservedFileChange extends Error {}
function unchanged(value, reason) { if (!value) throw new ObservedFileChange(reason); }
export function readBoundedFile(file, maximum, io = fs) {
    const before = io.lstatSync(file, { bigint: true });
    unchanged(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && io.realpathSync(file) === file, "identity");
    unchanged(before.size <= BigInt(maximum), "length");
    const fd = io.openSync(file, "r"); let primaryError;
    try {
        const opened = io.fstatSync(fd, { bigint: true }); unchanged(opened.dev === before.dev && opened.ino === before.ino && opened.isFile() && opened.nlink === 1n, "identity");
        unchanged(opened.size === before.size, "length");
        const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) { const count = io.readSync(fd, bytes, offset, bytes.length - offset); unchanged(count > 0, "short-read"); offset += count; }
        const after = io.fstatSync(fd, { bigint: true });
        unchanged(after.dev === before.dev && after.ino === before.ino && after.nlink === 1n, "identity");
        unchanged(after.size === before.size, "length");
        return { bytes, dev: before.dev.toString(), ino: before.ino.toString(), size: Number(before.size) };
    } catch (error) { primaryError = error; throw error; }
    finally { try { io.closeSync(fd); } catch (error) { if (!primaryError) throw error; } }
}
export function snapshotFixture(file, length, io = fs) {
    const read = readBoundedFile(file, length, io); unchanged(read.size === length, "length");
    return { file, dev: read.dev, ino: read.ino, size: read.size, sha256: createHash("sha256").update(read.bytes).digest("hex") };
}
export function verifyFixture(expected, io = fs) {
    let current;
    try { current = io.lstatSync(expected.file, { bigint: true }); }
    catch (error) { return { file: expected.file, status: error.code === "ENOENT" ? "changed" : "unavailable", reason: error.code === "ENOENT" ? "missing" : "stat-error" }; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev.toString() !== expected.dev || current.ino.toString() !== expected.ino)
        return { file: expected.file, status: "changed", reason: "identity" };
    if (current.size !== BigInt(expected.size)) return { file: expected.file, status: "changed", reason: "length" }; // No hash/read after a length mismatch.
    try {
        const now = snapshotFixture(expected.file, expected.size, io);
        return { file: expected.file, status: now.dev === expected.dev && now.ino === expected.ino && now.sha256 === expected.sha256 ? "unchanged" : "changed", reason: "bounded-comparison" };
    } catch (error) {
        if (error instanceof ObservedFileChange || error.code === "ENOENT") return { file: expected.file, status: "changed", reason: error.code === "ENOENT" ? "missing" : error.message };
        return { file: expected.file, status: "unavailable", reason: "read-error" };
    }
}
export function fileVerdict(record) {
    const receipt = record.receipt;
    if (record.hostChecks.some(item => item.status === "changed") || receipt?.ro?.opened || receipt?.denied?.some(item => item.opened)) return "boundary-failure";
    if (record.error || record.cleanupError || record.helperPendingPid !== null || !record.artifactsRemoved || !record.closed || record.wrapperExitCode !== 0
        || record.hostChecks.length !== 5 || record.hostChecks.some(item => item.status !== "unchanged") || !record.outputMatched
        || !receipt || !receipt.complete || receipt.error || !receipt.inputReadMatched || !receipt.outputMatched || receipt.ro?.openError !== 5
        || receipt.ro.closeError !== null || receipt.denied.length !== 6 || receipt.denied.some(item => ![2, 3, 5].includes(item.openError) || item.closeError !== null)
        || record.lifecycle?.state !== "closed" || !record.lifecycle.stopAttempted || record.lifecycle.controlPending || record.lifecycle.executionPending || record.lifecycle.connectionPending
        || !record.lifecycle.calls.some(item => item.kind === "exec") || record.lifecycle.calls.some(item => !successful(item.result))) return "inconclusive";
    return "limited-pass";
}
export async function runFileAcceptance() {
    const resource = acquireAcceptanceRoot();
    const report = { protocol: FILE_PROTOCOL, taskId: randomUUID(), sourceSha256: null, compilerSha256: COMPILER_HASH, probeSha256: null,
        fixtures: [], hostChecks: [], outputMatched: false, receipt: null, wrapperExitCode: null, lifecycle: null, closed: false,
        helperCalls: [], helperPendingPid: null, error: null, cleanupError: null, artifactRoot: resource.root, artifactsRemoved: false };
    const save = () => resource.journal(report);
    const helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = helpers.calls; report.helperPendingPid = helpers.active?.pid ?? null; save(); });
    const controller = new AbortController(), cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    let owner; const input = path.join(resource.root, "input"), output = path.join(resource.root, "output");
    try {
        need(resource.root === HOST_ROOT && process.platform === "win32" && sha256(COMPILER) === COMPILER_HASH, "Pinned file acceptance environment changed");
        report.sourceSha256 = sha256(SOURCE); save(); fs.mkdirSync(input); fs.mkdirSync(output);
        const publicBytes = Buffer.from("super-pi-read-control:" + report.taskId), control = path.join(input, "control.bin");
        fs.writeFileSync(control, publicBytes, { flag: "wx" }); report.fixtures.push(snapshotFixture(control, publicBytes.length));
        for (const name of ["private", "neighbor", ".git", ".sp"]) {
            const directory = path.join(resource.root, name); fs.mkdirSync(directory); const file = path.join(directory, "sentinel.bin");
            const bytes = randomBytes(32); try { fs.writeFileSync(file, bytes, { flag: "wx" }); } finally { bytes.fill(0); }
            report.fixtures.push(snapshotFixture(file, 32));
        }
        save(); need(!controller.signal.aborted, "Cancelled before file probe compile");
        const executable = path.join(input, "probe.exe");
        await helpers.run(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable, SOURCE], 30000, controller.signal);
        report.probeSha256 = sha256(executable); fs.writeFileSync(path.join(input, "request.json"), JSON.stringify({ protocol: FILE_PROTOCOL, taskId: report.taskId }), { flag: "wx" }); save();
        need(!controller.signal.aborted, "Cancelled before file instance");
        owner = new SandboxLifecycle({ cli: new FixedCli(), config: windowsSandboxConfig(input, output).replaceAll("SuperPiProbe", "SuperPiFiles"), taskId: report.taskId,
            workload: { kind: "fixed-file-boundary", input, output, probeSha256: report.probeSha256 }, journal(value) { report.lifecycle = value; save(); } });
        await owner.start(controller.signal); report.wrapperExitCode = parseFixedEntryExit(await owner.executeFileProbe(controller.signal));
    } catch (error) { report.error = String(error.message); }
    if (owner) { report.closed = await owner.cleanup(); report.cleanupError = owner.cleanupError ?? null; }
    if (report.closed) {
        // Each host sentinel is checked even if the guest result is absent, invalid or reports an error.
        report.hostChecks = report.fixtures.map(fixture => verifyFixture(fixture)); save();
        try { report.receipt = validateFileReceipt(JSON.parse(readBoundedFile(path.join(output, "result.json"), 4096).bytes.toString("utf8")), report.taskId); }
        catch (error) { report.error ??= String(error.message); }
        try { report.outputMatched = readBoundedFile(path.join(output, "allowed.bin"), 256).bytes.equals(Buffer.from("super-pi-write-control:" + report.taskId)); }
        catch (error) { report.error ??= String(error.message); }
    }
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (helpers.active || owner && !report.closed) { report.cleanupError ??= "Owned file probe remains unresolved"; save(); }
    else { try { resource.remove(owner ?? { state: "closed-before-start" }); report.artifactsRemoved = true; } catch (error) { report.cleanupError = String(error.message); } }
    report.verdict = fileVerdict(report); report.passed = report.verdict === "limited-pass"; process.stdout.write(JSON.stringify(report) + "\n"); return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 2, "No arguments accepted"); if (!(await runFileAcceptance()).passed) process.exitCode = 1;
}
