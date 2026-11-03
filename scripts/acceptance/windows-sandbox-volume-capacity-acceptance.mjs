// Explicit manual entry: one fixed 128MiB task volume, one VM, one bounded direct file-fill attempt.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { acquireAcceptanceRoot, CapturedProcess, SandboxLifecycle, CLI_PATH, CLI_SHA256 } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { TaskVolumeOwner, launchVolumeHelper, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";
import { LiveSandboxRuntime } from "./windows-sandbox-volume-sharing.mjs";
import { PREFLIGHT } from "./windows-sandbox-volume-native-acceptance.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, boundedText } from "./windows-sandbox-volume-session.mjs";
import { volumeSnapshot, vmSnapshot, vmQuiescent, preflightSnapshot, operationErrorSnapshot } from "./windows-sandbox-volume-share.mjs";
import { PrivateReceiptReader, SHARING_ROOT, SHARING_SOURCES, sourceReceipt, hostLaunchGuard } from "./windows-sandbox-volume-share-acceptance.mjs";
import { capacityReport, capacityHelpers, exerciseCapacity } from "./windows-sandbox-volume-capacity.mjs";
const DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", CSC_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const NODE = "D:\\Nodes\\26.13.0\\node.exe", NODE_SHA256 = "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
const COMMANDS = ["prepare", "verify", "install-capacity", "read-capacity", "release", "exit"];
const need = (value, message) => { if (!value) throw new Error(message); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex"), hashFile = file => sha256(fs.readFileSync(file));
export const CAPACITY_SOURCES = Object.freeze([...SHARING_SOURCES,
    "windows-sandbox-volume-capacity-core.cs", "windows-sandbox-volume-capacity-protocol.cs", "windows-sandbox-volume-capacity-guest.cs",
    "windows-sandbox-volume-capacity-host.cs", "windows-sandbox-volume-capacity.mjs", "windows-sandbox-volume-capacity-acceptance.mjs"]);
export function capacitySourceManifest(read = name => fs.readFileSync(path.join(DIRECTORY, name))) {
    let bytes = 0;
    const files = CAPACITY_SOURCES.map(name => { const data = read(name); need(Buffer.isBuffer(data) && data.length <= 131072 && (bytes += data.length) <= 1048576, "Capacity source byte bound");
        return ["scripts/acceptance/" + name, sha256(data)]; });
    const manifest = { protocol: "super-pi-capacity-sources-v1", files }; return { manifest, sha256: sha256(Buffer.from(JSON.stringify(manifest))), bytes };
}
export function capacityCliGuard(task, expectedBundle, authorization, dependencies = { capacitySourceManifest, hashFile }) {
    return { owner: authorization?.owner ?? task, signal: authorization?.signal, validate(owner) {
        need(dependencies.capacitySourceManifest().sha256 === expectedBundle && dependencies.hashFile(CLI_PATH) === CLI_SHA256, "Capacity source or CLI changed before physical dispatch");
        return authorization ? authorization.validate(owner) === true : owner === task;
    } };
}
function compiledBinary(root, name, maximum) {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum && fs.realpathSync(file) === file, "Compiled capacity binary shape/size");
    return hashFile(file);
}
export async function runCapacityAcceptance(expectedBundle) {
    need(typeof expectedBundle === "string" && /^[0-9a-f]{64}$/.test(expectedBundle), "Reviewed capacity bundle required");
    need(process.execPath === NODE && hashFile(NODE) === NODE_SHA256, "Pinned Node required"); verifyPowerShell7();
    need(hashFile(CSC) === CSC_SHA256 && hashFile(CLI_PATH) === CLI_SHA256, "Pinned capacity compiler/CLI changed");
    const bundle = capacitySourceManifest(); need(bundle.sha256 === expectedBundle, "Reviewed capacity sources changed");
    const resource = acquireAcceptanceRoot(), taskId = randomUUID(), stat = fs.lstatSync(resource.root, { bigint: true });
    const rootId = String(stat.dev) + ":" + String(stat.ino), report = capacityReport(taskId, resource.root, rootId);
    report.sources = { ...sourceReceipt(bundle), guestSha256: null, nodeSha256: NODE_SHA256 }; report.privateReceipts = null;
    const controller = new AbortController(), runtime = new LiveSandboxRuntime(taskId); let helpers, reader;
    const task = { runtime, vm: undefined, volume: undefined, driver: undefined, installation: undefined,
        cancel() { controller.abort(); this.volume?.revoke(); }, unsafe() { controller.abort(); this.volume?.onUnsafe(); },
        quiescent() { return !helpers?.active && report.receiptUnknownHandles.length === 0 && vmQuiescent(this)
            && (this.driver ? this.volume?.state === "released" && this.driver.physicallyClosed && !this.driver.pending : this.volume === undefined); },
        dispose() { need(this.quiescent(), "Capacity owner remains unresolved"); this.runtime.dispose();
            if (helpers) { helpers.calls.length = 0; helpers.persist = undefined; helpers.launch = undefined; }
            this.vm = undefined; this.volume = undefined; this.driver = undefined; this.runtime = undefined; this.installation = undefined; helpers = undefined; reader = undefined; },
    };
    const save = sessionJournal(resource, report, () => task.unsafe());
    const lifetime = new SharingLifetime({ bus: process, stream: process.stdout, report, save, task, profile: "capacity" });
    const launchGuard = executable => hostLaunchGuard(task, controller.signal, expectedBundle, executable,
        { sourceManifest: capacitySourceManifest, verifyPowerShell7, hashFile });
    helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = capacityHelpers(helpers.calls); save(); }, (executable, args, cwd) => {
        need(executable === POWERSHELL7_PATH || executable === CSC, "Fixed capacity helpers only");
        return lifetime.launch(executable === CSC ? "compile" : "preflight", () => new CapturedProcess(executable, args, cwd), launchGuard(executable));
    });
    reader = new PrivateReceiptReader(resource.root, rootId, report.receiptUnknownHandles, fs, "capacity");
    const readReceipt = (name, optional = false) => { try { return reader.read(name, optional); } finally { report.privateReceipts = { ...reader.counters }; } };
    const cli = { launch(args, authorization) {
        need(["list", "start", "exec", "stop"].includes(args[0]), "Fixed capacity CLI command required");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), capacityCliGuard(task, expectedBundle, authorization));
    } };
    try {
        need(resource.root === SHARING_ROOT && stat.isDirectory() && !stat.isSymbolicLink(), "Fixed capacity owner root changed"); save();
        const preflight = await helpers.run(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")], 15000, controller.signal);
        report.preflight = preflightSnapshot(JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""))); save();
        need(!controller.signal.aborted, "Cancelled before capacity native compile");
        await helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + path.join(resource.root, "volume-native.dll"),
            ...["windows-sandbox-volume-native.cs", "windows-sandbox-volume-capacity-host.cs", "windows-sandbox-volume-capacity-core.cs", "windows-sandbox-volume-capacity-protocol.cs"].map(name => path.join(DIRECTORY, name))], 15000, controller.signal);
        report.sources.nativeSha256 = compiledBinary(resource.root, "volume-native.dll", 131072); save();
        need(!controller.signal.aborted, "Cancelled before capacity guest compile");
        await helpers.run(CSC, ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(resource.root, "capacity-probe.exe"),
            ...["windows-sandbox-volume-capacity-core.cs", "windows-sandbox-volume-capacity-protocol.cs", "windows-sandbox-volume-capacity-guest.cs"].map(name => path.join(DIRECTORY, name))], 15000, controller.signal);
        report.sources.guestSha256 = compiledBinary(resource.root, "capacity-probe.exe", 65536); save();
        need(!controller.signal.aborted, "Cancelled before capacity manager");
        task.driver = lifetime.launch("manager", () => launchVolumeHelper({ root: resource.root, taskId,
            nativeSha256: report.sources.nativeSha256, capacityProbeSha256: report.sources.guestSha256 }), launchGuard(POWERSHELL7_PATH));
        task.volume = new TaskVolumeOwner({ driver: task.driver, taskId, readRuntime: runtime.read,
            journal(value) { report.volume = volumeSnapshot(value); save(); }, revokeCandidates() { report.revoked = true; }, cancelExecution() { controller.abort(); report.cancelled = true; } });
        await exerciseCapacity(task, report, controller.signal, config => new SandboxLifecycle({ cli, config, taskId,
            journal(value) { report.vm = vmSnapshot(value); save(); } }), stage => readReceipt("volume-capacity-" + stage + ".json"), report.sources.guestSha256);
    } catch (error) { report.error ??= boundedText(error.message); }
    for (const command of COMMANDS) {
        if (report.receiptUnknownHandles.length) break;
        try { const value = readReceipt("volume-error-" + command + ".json", true); if (value !== undefined) report.operationErrors.push(operationErrorSnapshot(value, command)); }
        catch (error) { report.cleanupError ??= boundedText(error.message); report.retained = true; }
    }
    if (report.operationErrors.length) { report.sequencePassed = false; report.error ??= "Capacity manager reported operation failure"; }
    return await completeSharingSession({ report, task, lifetime, save, root: resource.root, rootId });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 5 && process.argv[2] === "--run-capacity-once" && process.argv[3] === "--source-bundle", "Explicit reviewed capacity invocation required");
    if (!(await runCapacityAcceptance(process.argv[4])).passed) process.exitCode = 1;
}
