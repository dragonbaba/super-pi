// Manual, reviewed manager-loss scene only. Importing never runs the scene.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { acquireAcceptanceRoot, CapturedProcess, SandboxLifecycle, CLI_PATH, CLI_SHA256 } from "./windows-sandbox-lifecycle.mjs";
import { createManagerLossFactory, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";
import { PREFLIGHT } from "./windows-sandbox-volume-native-acceptance.mjs";
import { SharingLifetime, sessionJournal } from "./windows-sandbox-volume-session.mjs";
import { SHARING_ROOT, SHARING_SOURCES, sourceReceipt } from "./windows-sandbox-volume-share-acceptance.mjs";
import { sharingReport, preflightSnapshot, vmSnapshot } from "./windows-sandbox-volume-share.mjs";
import { nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
import { FaultSession } from "./windows-sandbox-volume-fault-session.mjs";
const DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", CSC_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const NODE = "D:\\Nodes\\26.13.0\\node.exe", NODE_SHA256 = "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
const need = (ok, message) => { if (!ok) throw Error(message); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), hashFile = file => hash(fs.readFileSync(file));
export const FAULT_SOURCES = Object.freeze([...SHARING_SOURCES, "windows-sandbox-volume-candidate-private.mjs",
    "windows-sandbox-volume-fault-cleanup.mjs", "windows-sandbox-volume-fault-diagnostic.cs", "windows-sandbox-volume-diagnostic.ps1",
    "windows-sandbox-volume-diagnostic-channel.mjs", "windows-sandbox-volume-diagnostic-file.mjs",
    "windows-sandbox-volume-fault-session.mjs", "windows-sandbox-volume-fault-acceptance.mjs"]);
export function faultSourceManifest(read = name => fs.readFileSync(path.join(DIRECTORY, name))) {
    let bytes = 0;
    const files = FAULT_SOURCES.map(name => {
        const data = read(name); need(Buffer.isBuffer(data) && data.length <= 131072 && (bytes += data.length) <= 1048576, "Fault source bound");
        return ["scripts/acceptance/" + name, hash(data)];
    });
    const manifest = { protocol: "super-pi-fault-sources-v1", files };
    return { manifest, sha256: hash(JSON.stringify(manifest)), bytes };
}
export function faultReport(taskId, rootId) {
    const report = sharingReport(taskId, SHARING_ROOT, rootId);
    report.protocol = "super-pi-manager-loss-acceptance-v1";
    report.userCancelled = false; report.taskPassed = false; report.taskRejected = false;
    report.unsafe = false; report.faultAcceptancePassed = false;
    return report;
}
export function faultDiagnosticArguments(binding, nativeSha256) {
    return [...POWERSHELL7_PREFIX, "-File", path.join(DIRECTORY, "windows-sandbox-volume-diagnostic.ps1"), "-RunDiagnostic",
        "-TaskId", binding.taskId, "-InstanceId", binding.instanceId, "-Root", SHARING_ROOT, "-RootId", binding.rootId,
        "-ImageId", binding.imageId, "-ImageBytes", String(binding.imageBytes), "-VolumePath", binding.volumePath, "-NativeSha256", nativeSha256];
}
export async function runFaultAcceptance(expectedBundle) {
    need(typeof expectedBundle === "string" && /^[0-9a-f]{64}$/.test(expectedBundle), "Reviewed fault source bundle required");
    need(process.platform === "win32" && process.execPath === NODE && hashFile(NODE) === NODE_SHA256, "Pinned fault Node required");
    verifyPowerShell7();
    need(hashFile(CSC) === CSC_SHA256 && hashFile(CLI_PATH) === CLI_SHA256, "Pinned fault tools changed");
    const bundle = faultSourceManifest(); need(bundle.sha256 === expectedBundle, "Fault source bundle changed");
    const resource = acquireAcceptanceRoot(), stat = fs.lstatSync(resource.root, { bigint: true }), rootId = nativePrivateIdentity(stat);
    const report = faultReport(randomUUID(), rootId); report.sources = { ...sourceReceipt(bundle), nodeSha256: NODE_SHA256 };
    let task;
    const save = sessionJournal(resource, report, () => task?.unsafe());
    task = new FaultSession(report, save, rootId);
    const lifetime = new SharingLifetime({ bus: process, stream: process.stdout, report, save, task, profile: "fault" });
    task.bindLifetime(lifetime);
    const sourceCheck = executable => {
        need(!task.signal.aborted && faultSourceManifest().sha256 === expectedBundle, "Fault source/stop changed before launch");
        if (executable === POWERSHELL7_PATH) verifyPowerShell7();
        else need(executable === CSC && hashFile(CSC) === CSC_SHA256 || executable === CLI_PATH && hashFile(CLI_PATH) === CLI_SHA256,
            "Fixed fault executable changed");
    };
    const authorization = executable => ({ owner: task, signal: task.signal, validate(owner) { sourceCheck(executable); return owner === task; } });
    const nativeCheck = () => {
        sourceCheck(POWERSHELL7_PATH);
        const file = path.join(SHARING_ROOT, "volume-native.dll"), current = fs.lstatSync(file, { bigint: true });
        need(current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && current.size > 0n && current.size <= 131072n
            && fs.realpathSync(file) === file && nativePrivateIdentity(current) === report.nativeId && hashFile(file) === report.sources.nativeSha256,
            "Original compiled diagnostic assembly changed");
    };
    const helper = async (kind, executable, args) => {
        const call = lifetime.launch(kind, () => new CapturedProcess(executable, args, SHARING_ROOT), authorization(executable));
        const outcome = await call.wait(15000, task.signal), r = call.result;
        need(outcome === "settled" && !task.signal.aborted && call.child === undefined && call.out === undefined && call.err === undefined
            && r?.exitCode === 0 && r.signal === null && r.launchError === null && !r.truncated && r.stderrSeen === 0, "Fault helper incomplete");
        report.helperCalls.push({ kind, pid: call.pid, exitCode: r.exitCode, stdoutBytes: r.stdoutSeen, stderrBytes: r.stderrSeen }); save();
        return r;
    };
    const cli = { launch(args, original) {
        need(["list", "start", "stop"].includes(args[0]), "Fault guest execution forbidden");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), {
            owner: original?.owner ?? task, signal: task.signal, validate(owner) {
                sourceCheck(CLI_PATH);
                return original ? original.validate(owner) === true : owner === task;
            } });
    } };
    try {
        need(resource.root === SHARING_ROOT && stat.isDirectory() && !stat.isSymbolicLink(), "Fixed fault root changed"); save();
        const preflight = await helper("preflight", POWERSHELL7_PATH,
            [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")]);
        report.preflight = preflightSnapshot(JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""))); save();
        await helper("compile", CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + path.join(SHARING_ROOT, "volume-native.dll"),
            ...["windows-sandbox-volume-native.cs", "windows-sandbox-volume-fault-diagnostic.cs"].map(name => path.join(DIRECTORY, name))]);
        const assembly = path.join(SHARING_ROOT, "volume-native.dll"), assemblyStat = fs.lstatSync(assembly, { bigint: true });
        need(assemblyStat.isFile() && !assemblyStat.isSymbolicLink() && assemblyStat.nlink === 1n && assemblyStat.size > 0n
            && assemblyStat.size <= 131072n && fs.realpathSync(assembly) === assembly, "Fault assembly bound");
        report.nativeId = nativePrivateIdentity(assemblyStat); report.sources.nativeSha256 = hashFile(assembly); save();
        const factory = createManagerLossFactory({ root: SHARING_ROOT, taskId: report.taskId, nativeSha256: report.sources.nativeSha256 },
            (_kind, value) => { report.fault = value; save(); });
        task.bindFactory(factory);
        task.attach(lifetime.launch("manager", () => factory.launch(), authorization(POWERSHELL7_PATH)));
        await task.trigger(config => new SandboxLifecycle({ cli, config, taskId: report.taskId,
            journal(value) { report.vm = vmSnapshot(value); save(); } }));
        const evidence = await task.diagnose(binding => {
            const args = faultDiagnosticArguments(binding, report.sources.nativeSha256);
            return lifetime.launch("diagnostic", () => new CapturedProcess(POWERSHELL7_PATH, args, SHARING_ROOT), task.diagnosticAuthorization(nativeCheck));
        });
        return await task.complete(evidence);
    } catch (error) {
        task.fail(error); lifetime.beginCompletion(); lifetime.finish(); return report;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 5 && process.argv[2] === "--run-fault-once" && process.argv[3] === "--source-bundle", "Explicit reviewed fault invocation required");
    if (!(await runFaultAcceptance(process.argv[4])).faultAcceptancePassed) process.exitCode = 1;
}
