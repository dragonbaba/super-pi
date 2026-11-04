// Explicit manual acceptance only: one fixed GUID share and one 32-byte round trip.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { acquireAcceptanceRoot, CapturedProcess, SandboxLifecycle, CLI_PATH, CLI_SHA256 } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { TaskVolumeOwner, launchVolumeHelper, POWERSHELL7_PATH, POWERSHELL7_SHA256, POWERSHELL7_PREFIX, verifyPowerShell7, VOLUME_LIMITS } from "./windows-sandbox-volume.mjs";
import { LiveSandboxRuntime } from "./windows-sandbox-volume-sharing.mjs";
import { PREFLIGHT } from "./windows-sandbox-volume-native-acceptance.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, boundedText } from "./windows-sandbox-volume-session.mjs";
import { sharingReport, volumeSnapshot, vmSnapshot, vmQuiescent, preflightSnapshot, helperSnapshots, operationErrorSnapshot, exerciseSharedVolume } from "./windows-sandbox-volume-share.mjs";

export const SHARING_ROOT = "D:\\RMProjects\\Pi\\.artifacts\\windows-sandbox-acceptance-owner";
export const SHARING_SOURCES = Object.freeze([
    "windows-sandbox-clipboard.mjs", "windows-sandbox-fixed-acceptance.mjs", "windows-sandbox-guest.mjs",
    "windows-sandbox-lifecycle.mjs", "windows-sandbox-package.mjs", "windows-sandbox-powershell7.config.json",
    "windows-sandbox-toolchains.mjs",
    "windows-sandbox-volume-capacity-protocol.mjs", "windows-sandbox-volume-capacity-receipt.mjs",
    "windows-sandbox-volume-candidate-contract.mjs", "windows-sandbox-candidates.mjs",
    "windows-sandbox-volume-config.mjs", "windows-sandbox-volume-guest-read.mjs", "windows-sandbox-volume-helper.ps1",
    "windows-sandbox-volume-native-acceptance.mjs", "windows-sandbox-volume-native.cs", "windows-sandbox-volume-session.mjs",
    "windows-sandbox-volume-share-acceptance.mjs", "windows-sandbox-volume-share.mjs", "windows-sandbox-volume-sharing.mjs", "windows-sandbox-volume.mjs",
]);
const DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const CSC_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const COMMANDS = Object.freeze(["prepare", "verify", "read-guest", "release", "exit"]);
const RECEIPTS = new Set(["volume-guest-read.json", ...COMMANDS.map(command => "volume-error-" + command + ".json")]);
const CAPACITY_RECEIPTS = new Set(["volume-capacity-install.json", "volume-capacity-read.json",
    ...["prepare", "verify", "install-capacity", "read-capacity", "release", "exit"].map(command => "volume-error-" + command + ".json")]);
const need = (ok, message) => { if (!ok) throw Error(message); };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const hashFile = file => sha256(fs.readFileSync(file));
const identity = stat => String(stat.dev) + ":" + String(stat.ino);

export function sourceManifest(read = name => fs.readFileSync(path.join(DIRECTORY, name))) {
    let bytes = 0;
    const files = SHARING_SOURCES.map(name => {
        const data = read(name); need(Buffer.isBuffer(data) && data.length <= 131072 && (bytes += data.length) <= 1048576, "Source byte bound");
        return ["scripts/acceptance/" + name, sha256(data)];
    });
    const manifest = { protocol: "super-pi-sharing-sources-v1", files };
    return { manifest, sha256: sha256(Buffer.from(JSON.stringify(manifest), "utf8")), bytes };
}
export function sourceReceipt(bundle, nativeSha256 = null) {
    return { bundleSha256: bundle.sha256, files: bundle.manifest.files.length, nativeSha256,
        powershellSha256: POWERSHELL7_SHA256, compilerSha256: CSC_SHA256, cliSha256: CLI_SHA256, nodeVersion: process.version };
}
// Host-only dependency injection for pure checks; never supplied by guest data or command-line arguments.
export function hostLaunchGuard(task, signal, expectedBundle, executable, dependencies = { sourceManifest, verifyPowerShell7, hashFile }) {
    return { owner: task, signal, validate(current) {
        need(current === task && !signal.aborted && dependencies.sourceManifest().sha256 === expectedBundle, "Source set changed before physical dispatch");
        if (executable === POWERSHELL7_PATH) dependencies.verifyPowerShell7();
        else need(executable === CSC && dependencies.hashFile(CSC) === CSC_SHA256, "Pinned compiler changed before physical dispatch");
        return true;
    } };
}

// Only host-private fixed receipts. A failed close retains the exact descriptor, never retries it.
export class PrivateReceiptReader {
    #root; #rootId; #io; #unknown; #allowed; #attempted = new Set();
    counters = { opened: 0, closed: 0, active: 0, peak: 0, bytesRead: 0, bytesAllocated: 0 };
    constructor(root, rootId, unknown, io = fs, profile = "sharing") {
        need(profile === "sharing" || profile === "capacity", "Fixed private receipt profile required");
        this.#root = root; this.#rootId = rootId; this.#unknown = unknown; this.#io = io; this.#allowed = profile === "capacity" ? CAPACITY_RECEIPTS : RECEIPTS;
    }
    #checkRoot() {
        const value = this.#io.lstatSync(this.#root, { bigint: true });
        need(path.resolve(this.#root) === this.#root && value.isDirectory() && !value.isSymbolicLink()
            && identity(value) === this.#rootId && this.#io.realpathSync(this.#root) === this.#root, "Receipt root identity changed");
    }
    read(name, optional = false) {
        need(this.#allowed.has(name) && !this.#attempted.has(name) && this.#unknown.length === 0
            && typeof optional === "boolean" && (!optional || name.startsWith("volume-error-")), "Private receipt read admission");
        this.#attempted.add(name); this.#checkRoot();
        const file = path.join(this.#root, name); let before;
        try { before = this.#io.lstatSync(file, { bigint: true }); }
        catch (error) {
            if (!optional || error.code !== "ENOENT") throw error;
            this.#checkRoot(); return undefined; // JSON.parse cannot produce this marker; JSON null still requires schema validation.
        }
        need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= 4096n
            && this.#io.realpathSync(file) === file, "Private receipt shape/size changed");
        const fd = this.#io.openSync(file, "r"); this.counters.opened++; this.counters.active++; this.counters.peak = Math.max(this.counters.peak, this.counters.active);
        let buffer, value, readError, closeError;
        try {
            const opened = this.#io.fstatSync(fd, { bigint: true });
            need(opened.isFile() && identity(opened) === identity(before) && opened.nlink === 1n && opened.size === before.size, "Receipt changed on open");
            buffer = Buffer.alloc(Number(before.size)); this.counters.bytesAllocated += buffer.length;
            let offset = 0;
            while (offset < buffer.length) {
                const count = this.#io.readSync(fd, buffer, offset, buffer.length - offset);
                need(Number.isInteger(count) && count > 0 && count <= buffer.length - offset, "Short private receipt");
                offset += count; this.counters.bytesRead += count;
            }
            const after = this.#io.fstatSync(fd, { bigint: true });
            need(after.isFile() && identity(after) === identity(before) && after.nlink === 1n && after.size === before.size
                && after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs, "Receipt changed while reading");
            this.#checkRoot();
            const leaf = this.#io.lstatSync(file, { bigint: true });
            need(leaf.isFile() && !leaf.isSymbolicLink() && leaf.nlink === 1n && identity(leaf) === identity(before)
                && leaf.size === before.size && this.#io.realpathSync(file) === file, "Receipt leaf changed while reading");
            value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        } catch (error) { readError = error; }
        finally {
            buffer?.fill(0);
            try { this.#io.closeSync(fd); this.counters.closed++; this.counters.active--; }
            catch (error) {
                closeError = error;
                this.#unknown.push({ fd, name, code: boundedText(error.code, 32), message: boundedText(error.message, 96) });
            }
        }
        if (readError) throw readError;
        if (closeError) throw closeError;
        return value; // Guest-read and operation-error consumers separately validate their exact structures/association.
    }
}

export async function runSharedVolumeAcceptance(expectedBundle) {
    need(typeof expectedBundle === "string" && /^[0-9a-f]{64}$/.test(expectedBundle), "Reviewed source bundle required");
    verifyPowerShell7();
    need(hashFile(CSC) === CSC_SHA256 && hashFile(CLI_PATH) === CLI_SHA256, "Pinned compiler or CLI changed");
    const bundle = sourceManifest(); need(bundle.sha256 === expectedBundle, "Reviewed source set changed");
    const resource = acquireAcceptanceRoot(), taskId = randomUUID();
    const rootStat = fs.lstatSync(resource.root, { bigint: true }), rootId = identity(rootStat);
    const report = sharingReport(taskId, resource.root, rootId); report.sources = sourceReceipt(bundle);
    report.privateReceipts = null;
    const controller = new AbortController(), runtime = new LiveSandboxRuntime(taskId);
    let helpers, reader;
    const task = {
        runtime, vm: undefined, volume: undefined, driver: undefined,
        cancel() { controller.abort(); this.volume?.revoke(); },
        unsafe() { controller.abort(); this.volume?.onUnsafe(); },
        quiescent() {
            return !helpers?.active && report.receiptUnknownHandles.length === 0 && vmQuiescent(this)
                && (this.driver ? this.volume?.state === "released" && this.driver.physicallyClosed && !this.driver.pending : this.volume === undefined);
        },
        dispose() {
            need(this.quiescent(), "Real combined owner remains unresolved"); this.runtime.dispose();
            if (helpers) { helpers.calls.length = 0; helpers.persist = undefined; helpers.launch = undefined; }
            this.vm = undefined; this.volume = undefined; this.driver = undefined; this.runtime = undefined; helpers = undefined; reader = undefined;
        },
    };
    const save = sessionJournal(resource, report, () => task.unsafe());
    const lifetime = new SharingLifetime({ bus: process, stream: process.stdout, report, save, task });
    const launchGuard = executable => hostLaunchGuard(task, controller.signal, expectedBundle, executable);
    helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = helperSnapshots(helpers.calls); save(); }, (executable, args, cwd) => {
        need(executable === POWERSHELL7_PATH || executable === CSC, "Fixed sharing helpers only");
        return lifetime.launch(executable === CSC ? "compile" : "preflight", () => new CapturedProcess(executable, args, cwd), launchGuard(executable));
    });
    reader = new PrivateReceiptReader(resource.root, rootId, report.receiptUnknownHandles);
    const readReceipt = (name, optional = false) => {
        try { return reader.read(name, optional); }
        finally { report.privateReceipts = { ...reader.counters }; }
    };
    const cli = { launch(args, authorization) {
        need(["list", "start", "exec", "stop"].includes(args[0]) && hashFile(CLI_PATH) === CLI_SHA256, "Fixed reviewed sharing CLI required");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), authorization);
    } };
    try {
        need(resource.root === SHARING_ROOT && rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Fixed sharing owner root changed"); save();
        const preflight = await helpers.run(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")], 15000, controller.signal);
        report.preflight = preflightSnapshot(JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""))); save();
        need(!controller.signal.aborted, "Preparation cancelled before compile");
        const assembly = path.join(resource.root, "volume-native.dll");
        await helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
            path.join(DIRECTORY, "windows-sandbox-volume-native.cs")], 15000, controller.signal);
        const compiled = fs.lstatSync(assembly, { bigint: true });
        need(compiled.isFile() && !compiled.isSymbolicLink() && compiled.nlink === 1n && compiled.size > 0n
            && compiled.size <= BigInt(VOLUME_LIMITS.nativeBytes) && fs.realpathSync(assembly) === assembly, "Native assembly shape/size changed");
        report.sources.nativeSha256 = hashFile(assembly); save();
        need(!controller.signal.aborted, "Cancelled before manager");
        task.driver = lifetime.launch("manager", () => launchVolumeHelper({ root: resource.root, taskId, nativeSha256: report.sources.nativeSha256 }), launchGuard(POWERSHELL7_PATH));
        task.volume = new TaskVolumeOwner({ driver: task.driver, taskId, readRuntime: runtime.read,
            journal(value) { report.volume = volumeSnapshot(value); save(); }, revokeCandidates() { report.revoked = true; },
            cancelExecution() { controller.abort(); report.cancelled = true; } });
        await exerciseSharedVolume(task, report, controller.signal, config => new SandboxLifecycle({ cli, config, taskId,
            journal(value) { report.vm = vmSnapshot(value); save(); } }), () => readReceipt("volume-guest-read.json"));
    } catch (error) { report.error ??= boundedText(error.message); }
    for (const command of COMMANDS) {
        if (report.receiptUnknownHandles.length) break;
        try {
            const value = readReceipt("volume-error-" + command + ".json", true);
            if (value !== undefined) report.operationErrors.push(operationErrorSnapshot(value, command));
        } catch (error) { report.cleanupError ??= boundedText(error.message); report.retained = true; }
    }
    if (report.operationErrors.length) { report.sequencePassed = false; report.error ??= "Manager reported an operation failure"; }
    return await completeSharingSession({ report, task, lifetime, save, root: resource.root, rootId });
    // No forced exit, broad kill or recovery: unresolved VM/manager/descriptor retains this task and its admission root.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 5 && process.argv[2] === "--run-guid-share-once" && process.argv[3] === "--source-bundle", "Explicit reviewed single GUID invocation required");
    if (!(await runSharedVolumeAcceptance(process.argv[4])).passed) process.exitCode = 1;
}
