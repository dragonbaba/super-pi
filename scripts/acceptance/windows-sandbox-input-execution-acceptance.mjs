// Explicit single-run actual input -> isolated guest -> original host apply acceptance.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { acquireAcceptanceRoot, CapturedProcess, SandboxLifecycle, CLI_PATH, CLI_SHA256 } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { launchVolumeHelper, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";
import { PREFLIGHT } from "./windows-sandbox-volume-native-acceptance.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, snapshotSessionFiles, boundedText } from "./windows-sandbox-volume-session.mjs";
import { vmSnapshot, preflightSnapshot } from "./windows-sandbox-volume-share.mjs";
import { SHARING_ROOT, sourceReceipt, hostLaunchGuard } from "./windows-sandbox-volume-share-acceptance.mjs";
import { PrivateCandidateChannel, nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
import { CANDIDATE_SOURCES } from "./windows-sandbox-volume-candidate-acceptance.mjs";
import { inputReport, inputTask, inputHelpers, produceInputCandidates, finishInputCandidates, INPUT_NORMAL_FILES } from "./windows-sandbox-input-execution-session.mjs";
const DIRECTORY = fileURLToPath(new URL(".", import.meta.url)), REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", CSC_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const NODE = "D:\\Nodes\\26.13.0\\node.exe", NODE_SHA256 = "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
const KOFFI_SHA256 = "072efa48190587a6181be48f99f28d52db106c4d2137fe237de0d49b892a00f6";
const TYPESCRIPT_SHA256 = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), hashFile = file => hash(fs.readFileSync(file));
export const INPUT_SOURCES = Object.freeze([...new Set([...CANDIDATE_SOURCES,
    "windows-sandbox-input-install.cs", "windows-sandbox-offline-worker.cs", "windows-sandbox-input-publication.mjs",
    "windows-sandbox-input-execution-session.mjs", "windows-sandbox-input-host-fixture.mjs", "windows-sandbox-input-execution-acceptance.mjs",
    "windows-sandbox-workspace-input-capture.mjs", "windows-sandbox-workspace-source-reader.mjs", "windows-sandbox-input-snapshot.mjs",
    "windows-sandbox-source-reader.mjs", "windows-sandbox-source-native.mjs", "windows-sandbox-input-revision-lease.mjs",
    "windows-sandbox-apply-captured-writes.mjs", "windows-sandbox-candidate-write-batch.mjs"])]);
export const INPUT_HOST_SOURCES = Object.freeze([
    "packages/coding-agent/src/core/files/input-workspace-grant-lease.ts",
    "packages/coding-agent/src/core/files/session-files.ts",
    "packages/extensions/resource-lifecycle-guard/permission-state.ts",
    "packages/extensions/resource-lifecycle-guard/permission-controller.ts",
    "packages/coding-agent/src/core/files/session-input-workspace-permission.ts",
    "packages/coding-agent/src/core/files/file-parameters.ts",
    "packages/coding-agent/src/core/files/file-batch-protocol.ts",
    "packages/coding-agent/src/core/files/file-service.ts",
    "packages/coding-agent/src/core/files/file-invocation.ts",
    "packages/coding-agent/src/core/files/file-batch.ts",
    "packages/coding-agent/src/core/files/changes.ts",
    "packages/coding-agent/src/core/files/regex.ts",
    "packages/extensions/resource-lifecycle-guard/index.ts",
    "packages/coding-agent/src/core/files/file-commit.ts",
    "packages/coding-agent/src/core/files/file-creation.ts",
    "packages/chrome-devtools/src/browser-manager.ts",
    "packages/chrome-devtools/src/runtime.ts",
    "packages/chrome-devtools/package.json",
    "packages/agent/src/agent.ts",
    "packages/agent/src/agent-loop.ts",
    "packages/agent/src/nested-tool-dispatch.ts",
    "packages/coding-agent/src/core/tools/tool-definition-wrapper.ts",
    "packages/coding-agent/src/core/extensions/runner.ts",
    "packages/coding-agent/src/core/tools/read.ts",
    "packages/coding-agent/src/core/files/session-file-revision-source.ts",
    "packages/coding-agent/src/core/files/session-input-read-permission.ts",
    "packages/coding-agent/src/core/files/native-file-client.ts",
    "packages/coding-agent/src/core/files/native-file-worker.mjs",
    "packages/coding-agent/src/core/files/native-file-regex.mjs",
    "packages/coding-agent/src/core/files/native-file-core.ts",
    "packages/coding-agent/src/core/files/file-host.ts",
    "packages/coding-agent/src/core/files/snapshot-line-edit.ts",
    "packages/coding-agent/src/core/execution-boundary.ts",
    "packages/coding-agent/src/core/extensions/loader.ts",
    "packages/coding-agent/src/core/event-bus.ts",
    "packages/coding-agent/src/core/session-manager.ts",
]);
export function inputSourceManifest() {
    let bytes = 0;
    const files = [...INPUT_SOURCES.map(name => "scripts/acceptance/" + name), ...INPUT_HOST_SOURCES].map(name => {
        const data = fs.readFileSync(path.join(REPOSITORY, name));
        need(data.length <= 262144 && (bytes += data.length) <= 2097152, "Input source manifest byte bound");
        return [name, hash(data)];
    });
    const manifest = { protocol: "super-pi-input-execution-sources-v1", files };
    return { manifest, sha256: hash(Buffer.from(JSON.stringify(manifest))), bytes };
}
function cliGuard(task, expected, authorization) {
    return { owner: authorization?.owner ?? task, signal: authorization?.signal, validate(owner) {
        need(inputSourceManifest().sha256 === expected && hashFile(CLI_PATH) === CLI_SHA256, "Input source/CLI changed before dispatch");
        return authorization ? authorization.validate(owner) === true : owner === task;
    } };
}
function compiled(root, name, maximum) {
    const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maximum)
        && fs.realpathSync(file) === file, "Compiled input artifact identity/bound");
    return Object.freeze({ identity: nativePrivateIdentity(stat), bytes: Number(stat.size), sha256: hashFile(file) });
}
export async function runInputExecutionAcceptance(expectedBundle) {
    need(typeof expectedBundle === "string" && /^[0-9a-f]{64}$/.test(expectedBundle) && typeof globalThis.gc === "function", "Reviewed input bundle and controlled GC required");
    need(process.execPath === NODE && hashFile(NODE) === NODE_SHA256, "Pinned Node required"); verifyPowerShell7();
    need(hashFile(CSC) === CSC_SHA256 && hashFile(CLI_PATH) === CLI_SHA256, "Pinned input compiler/CLI changed");
    need(hashFile(path.join(REPOSITORY, "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node")) === KOFFI_SHA256
        && hashFile(path.join(REPOSITORY, "node_modules/typescript/lib/typescript.js")) === TYPESCRIPT_SHA256, "Pinned native/compiler dependency changed");
    const bundle = inputSourceManifest(); need(bundle.sha256 === expectedBundle, "Reviewed input source set changed");
    const resource = acquireAcceptanceRoot(), taskId = randomUUID(), snapshotId = randomUUID();
    const stat = fs.lstatSync(resource.root, { bigint: true }), rootId = String(stat.dev) + ":" + String(stat.ino), privateRootId = nativePrivateIdentity(stat);
    const report = inputReport(taskId, snapshotId, resource.root, rootId);
    report.sources = { ...sourceReceipt(bundle), nodeSha256: NODE_SHA256, koffiSha256: KOFFI_SHA256, typescriptSha256: TYPESCRIPT_SHA256 };
    const controller = new AbortController(), task = inputTask(report, controller);
    const save = sessionJournal(resource, report, () => task.unsafe(), "input");
    const lifetime = new SharingLifetime({ bus: process, stream: process.stdout, report, save, task, profile: "input" });
    const launchGuard = executable => hostLaunchGuard(task, controller.signal, expectedBundle, executable,
        { sourceManifest: inputSourceManifest, verifyPowerShell7, hashFile });
    task.helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = inputHelpers(task.helpers.calls); save(); }, (executable, args, cwd) => {
        need(executable === POWERSHELL7_PATH || executable === CSC, "Fixed input helpers only");
        return lifetime.launch(executable === CSC ? "compile" : "preflight", () => new CapturedProcess(executable, args, cwd), launchGuard(executable));
    });
    const cli = { launch(args, authorization) {
        need(["list", "start", "exec", "stop"].includes(args[0]), "Fixed input CLI command");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), cliGuard(task, expectedBundle, authorization));
    } };
    let receiptWeak = [];
    try {
        need(resource.root === SHARING_ROOT && stat.isDirectory() && !stat.isSymbolicLink(), "Fixed input root changed"); save();
        const preflight = await task.helpers.run(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")], 15000, controller.signal);
        report.preflight = preflightSnapshot(JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""))); save();
        await task.helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + path.join(resource.root, "volume-native.dll"),
            ...["windows-sandbox-volume-native.cs", "windows-sandbox-volume-candidate-manifest.cs", "windows-sandbox-volume-candidate-batch.cs", "windows-sandbox-input-install.cs"]
                .map(name => path.join(DIRECTORY, name))], 15000, controller.signal);
        const assembly = compiled(resource.root, "volume-native.dll", 131072);
        await task.helpers.run(CSC, ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(resource.root, "offline-worker.exe"),
            path.join(DIRECTORY, "windows-sandbox-offline-worker.cs")], 15000, controller.signal);
        const tool = compiled(resource.root, "offline-worker.exe", 65536);
        report.sources.nativeSha256 = assembly.sha256; report.sources.toolSha256 = tool.sha256; save();
        const { runInputHostFixture } = await import("./windows-sandbox-input-host-fixture.mjs");
        const host = await runInputHostFixture((capture, revision) => produceInputCandidates(task, report, controller.signal, capture, revision, {
            root: resource.root, rootId: privateRootId, tool,
            attachManager(declaration) {
                need(!controller.signal.aborted, "Cancelled before input manager");
                const driver = lifetime.launch("manager", () => launchVolumeHelper({ root: resource.root, taskId, nativeSha256: assembly.sha256,
                    candidateCapture: true, inputSourceSha256: declaration.source.sha256, inputToolSha256: declaration.tool.sha256 }), launchGuard(POWERSHELL7_PATH));
                task.attach(driver, save);
            },
            buildVm(config) { return new SandboxLifecycle({ cli, config, taskId, journal(value) { report.vm = vmSnapshot(value); save(); } }); },
            buildChannel(current) { return new PrivateCandidateChannel({ owner: current.volume, vm: current.vm, taskId,
                root: resource.root, rootId: privateRootId, volumePath: current.volume.facts.volumePath, exchangeId: current.volume.facts.exchangeId }); },
        }), taskId, snapshotId, responsibility => { task.hostRetention = responsibility; });
        report.host = host.summary; task.hostRetention = host.retained; task.hostDone = host.passed; receiptWeak = host.weak;
        need(host.passed, "Original host apply or fixture cleanup failed");
        finishInputCandidates(task, report);
        const manifest = snapshotSessionFiles(resource.root, rootId, fs, "input");
        need(manifest.length === INPUT_NORMAL_FILES.length && manifest.every(item => INPUT_NORMAL_FILES.includes(item.name))
            && new Set(manifest.map(item => item.name)).size === INPUT_NORMAL_FILES.length, "Input artifacts incomplete or unexpected");
        report.sequencePassed = report.released === true && report.candidate?.buffersReleased === true && report.host?.succeeded === true
            && report.guestExit?.exitCode === 0 && !task.capture && !task.publication && !task.hostRetention;
    } catch (error) {
        report.error ??= boundedText(error instanceof Error ? error.message : String(error));
        report.retained = true; report.retentionReason ??= "input-entry-failure";
        try { finishInputCandidates(task, report); } catch (cleanup) { report.cleanupError ??= boundedText(cleanup instanceof Error ? cleanup.message : String(cleanup)); }
    }
    const weak = [...task.weak, ...receiptWeak];
    const completed = await completeSharingSession({ report, task, lifetime, save, root: resource.root, rootId });
    if (completed.passed) {
        for (let round = 0; round < 4; round++) { await tick(); globalThis.gc(); await tick(); }
        const live = weak.filter(value => value.deref() !== undefined).length;
        const gcPassed = weak.length === 5 && live === 0;
        console.log(JSON.stringify({ kind: "input-reference-release", gcRounds: 4, targets: weak.length, live, passed: gcPassed }));
        if (!gcPassed) completed.passed = false; // Earlier cleanup footer is a resource result, not this GC result.
    }
    return completed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 5 && process.argv[2] === "--run-input-once" && process.argv[3] === "--source-bundle", "Explicit reviewed input invocation required");
    if (!(await runInputExecutionAcceptance(process.argv[4])).passed) process.exitCode = 1;
}
