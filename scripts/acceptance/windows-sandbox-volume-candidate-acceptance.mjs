// Explicit manual entry only: one fixed volume/VM and synthetic candidate; no real workspace.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { acquireAcceptanceRoot, CapturedProcess, SandboxLifecycle, CLI_PATH, CLI_SHA256 } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { launchVolumeHelper, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";
import { PREFLIGHT } from "./windows-sandbox-volume-native-acceptance.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, snapshotSessionFiles, boundedText } from "./windows-sandbox-volume-session.mjs";
import { vmSnapshot, preflightSnapshot, helperSnapshots } from "./windows-sandbox-volume-share.mjs";
import { SHARING_ROOT, SHARING_SOURCES, sourceReceipt, hostLaunchGuard } from "./windows-sandbox-volume-share-acceptance.mjs";
import { PrivateCandidateChannel, nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
import { candidateReport, candidateTask, exerciseCandidates, CANDIDATE_NORMAL_FILES } from "./windows-sandbox-volume-candidate-session.mjs";
const DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", CSC_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const NODE = "D:\\Nodes\\26.13.0\\node.exe", NODE_SHA256 = "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
const need = (value, message) => { if (!value) throw Error(message); };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex"), hashFile = file => sha256(fs.readFileSync(file));
export const CANDIDATE_SOURCES = Object.freeze([...SHARING_SOURCES,
    "windows-sandbox-volume-candidate-private.mjs",
    "windows-sandbox-volume-candidate-manifest.cs", "windows-sandbox-volume-candidate-batch.cs",
    "windows-sandbox-volume-candidate-session.mjs", "windows-sandbox-volume-candidate-acceptance.mjs"]);
export function candidateSourceManifest(read = name => fs.readFileSync(path.join(DIRECTORY, name))) {
    let bytes = 0;
    const files = CANDIDATE_SOURCES.map(name => {
        const data = read(name); need(Buffer.isBuffer(data) && data.length <= 131072 && (bytes += data.length) <= 1048576, "Candidate source byte bound");
        return ["scripts/acceptance/" + name, sha256(data)];
    });
    const manifest = { protocol: "super-pi-candidate-sources-v1", files };
    return { manifest, sha256: sha256(Buffer.from(JSON.stringify(manifest))), bytes };
}
export function candidateCliGuard(task, expectedBundle, authorization, dependencies = { candidateSourceManifest, hashFile }) {
    return { owner: authorization?.owner ?? task, signal: authorization?.signal, validate(owner) {
        need(dependencies.candidateSourceManifest().sha256 === expectedBundle && dependencies.hashFile(CLI_PATH) === CLI_SHA256,
            "Candidate source or CLI changed before dispatch");
        return authorization ? authorization.validate(owner) === true : owner === task;
    } };
}
export function requireNormalCandidateFiles(manifest) {
    need(manifest.length === CANDIDATE_NORMAL_FILES.length
        && manifest.every(item => CANDIDATE_NORMAL_FILES.includes(item.name))
        && new Set(manifest.map(item => item.name)).size === CANDIDATE_NORMAL_FILES.length, "Unexpected or missing normal candidate artifacts");
}
export async function runCandidateAcceptance(expectedBundle) {
    need(typeof expectedBundle === "string" && /^[0-9a-f]{64}$/.test(expectedBundle), "Reviewed candidate source bundle required");
    need(process.execPath === NODE && hashFile(NODE) === NODE_SHA256, "Pinned Node required"); verifyPowerShell7();
    need(hashFile(CSC) === CSC_SHA256 && hashFile(CLI_PATH) === CLI_SHA256, "Pinned candidate compiler/CLI changed");
    const bundle = candidateSourceManifest(); need(bundle.sha256 === expectedBundle, "Reviewed candidate source set changed");
    const resource = acquireAcceptanceRoot(), taskId = randomUUID(), snapshotId = randomUUID();
    const stat = fs.lstatSync(resource.root, { bigint: true }), rootId = String(stat.dev) + ":" + String(stat.ino), privateRootId = nativePrivateIdentity(stat);
    const report = candidateReport(taskId, snapshotId, resource.root, rootId);
    report.sources = { ...sourceReceipt(bundle), nodeSha256: NODE_SHA256 };
    const controller = new AbortController(), task = candidateTask(report, controller);
    const save = sessionJournal(resource, report, () => task.unsafe());
    const lifetime = new SharingLifetime({ bus: process, stream: process.stdout, report, save, task, profile: "candidate" });
    const launchGuard = executable => hostLaunchGuard(task, controller.signal, expectedBundle, executable,
        { sourceManifest: candidateSourceManifest, verifyPowerShell7, hashFile });
    task.helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = helperSnapshots(task.helpers.calls); save(); }, (executable, args, cwd) => {
        need(executable === POWERSHELL7_PATH || executable === CSC, "Fixed candidate helpers only");
        return lifetime.launch(executable === CSC ? "compile" : "preflight", () => new CapturedProcess(executable, args, cwd), launchGuard(executable));
    });
    const cli = { launch(args, authorization) {
        need(["list", "start", "exec", "stop"].includes(args[0]), "Fixed candidate CLI command");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), candidateCliGuard(task, expectedBundle, authorization));
    } };
    try {
        need(resource.root === SHARING_ROOT && stat.isDirectory() && !stat.isSymbolicLink(), "Fixed candidate owner root changed"); save();
        const preflight = await task.helpers.run(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")], 15000, controller.signal);
        report.preflight = preflightSnapshot(JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""))); save();
        need(!controller.signal.aborted, "Cancelled before candidate compile");
        await task.helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + path.join(resource.root, "volume-native.dll"),
            ...["windows-sandbox-volume-native.cs", "windows-sandbox-volume-candidate-manifest.cs", "windows-sandbox-volume-candidate-batch.cs"]
                .map(name => path.join(DIRECTORY, name))], 15000, controller.signal);
        const assembly = path.join(resource.root, "volume-native.dll"), assemblyStat = fs.lstatSync(assembly);
        need(assemblyStat.isFile() && !assemblyStat.isSymbolicLink() && assemblyStat.nlink === 1 && assemblyStat.size > 0
            && assemblyStat.size <= 131072 && fs.realpathSync(assembly) === assembly, "Candidate assembly shape/bound");
        report.sources.nativeSha256 = hashFile(assembly); save();
        need(!controller.signal.aborted, "Cancelled before candidate manager");
        const driver = lifetime.launch("manager", () => launchVolumeHelper({ root: resource.root, taskId,
            nativeSha256: report.sources.nativeSha256, candidateCapture: true }), launchGuard(POWERSHELL7_PATH));
        task.attach(driver, save);
        await exerciseCandidates(task, report, controller.signal, config => new SandboxLifecycle({ cli, config, taskId,
            journal(value) { report.vm = vmSnapshot(value); save(); } }), current => new PrivateCandidateChannel({
                owner: current.volume, vm: current.vm, taskId, root: resource.root, rootId: privateRootId,
                volumePath: current.volume.facts.volumePath, exchangeId: current.volume.facts.exchangeId }));
        if (report.sequencePassed) requireNormalCandidateFiles(snapshotSessionFiles(resource.root, rootId, fs, "candidate"));
    } catch (error) {
        report.error ??= boundedText(error instanceof Error ? error.message : String(error));
        report.retained = true; report.retentionReason ??= "candidate-entry-failure";
    }
    // Failed paths keep all fixed artifacts and the outer owner, including partially created carriers or missing error receipts.
    return await completeSharingSession({ report, task, lifetime, save, root: resource.root, rootId });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 5 && process.argv[2] === "--run-candidate-once" && process.argv[3] === "--source-bundle", "Explicit reviewed candidate invocation required");
    if (!(await runCandidateAcceptance(process.argv[4])).passed) process.exitCode = 1;
}
