// Unique reviewed generic command acceptance. No automatic or production entry.
import fs from "node:fs";
import assert from "node:assert/strict";
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
import { INPUT_SOURCES as PREVIOUS_SOURCES, INPUT_HOST_SOURCES } from "./windows-sandbox-input-writeback-acceptance.mjs";
import { parseSandboxTaskRequest } from "../../packages/coding-agent/src/core/sandbox/task-request.ts";
import { TaskPackageBuilder } from "../../packages/coding-agent/src/core/sandbox/task-package.ts";
import { parseTaskResult } from "./windows-sandbox-task-result.mjs";
import { taskReport, taskFrame, taskHelpers, taskOutputPreview, produceTaskCandidates, finishInputCandidates, TASK_NORMAL_FILES } from "./windows-sandbox-task-session.mjs";
const DIRECTORY = fileURLToPath(new URL(".", import.meta.url)), REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", CSC_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const NODE = "D:\\Nodes\\26.13.0\\node.exe", NODE_SHA256 = "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
const KOFFI_SHA256 = "072efa48190587a6181be48f99f28d52db106c4d2137fe237de0d49b892a00f6";
const TYPESCRIPT_SHA256 = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), hashFile = file => hash(fs.readFileSync(file));
export const TASK_SOURCES = Object.freeze([...PREVIOUS_SOURCES,
    "windows-sandbox-task-install.cs", "windows-sandbox-task-worker.cs", "windows-sandbox-task-publication.mjs",
    "windows-sandbox-task-result.mjs", "windows-sandbox-task-session.mjs", "windows-sandbox-task-acceptance.mjs"]);
export const TASK_HOST_SOURCES = Object.freeze([...INPUT_HOST_SOURCES,
    "packages/coding-agent/src/core/sandbox/task-request.ts", "packages/coding-agent/src/core/sandbox/task-binding.ts",
    "tests/windows-sandbox-task-binding.test.mjs", "packages/coding-agent/src/core/sandbox/task-package.ts",
    "packages/coding-agent/src/core/tools/powershell.ts"]);
export function taskSourceManifest() {
    let bytes = 0;
    const files = [...TASK_SOURCES.map(name => "scripts/acceptance/" + name), ...TASK_HOST_SOURCES].map(name => {
        const data = fs.readFileSync(path.join(REPOSITORY, name));
        need(data.length <= 262144 && (bytes += data.length) <= 2097152, "Input source manifest byte bound");
        return [name, hash(data)];
    });
    const manifest = { protocol: "super-pi-task-sources-v1", files };
    return { manifest, sha256: hash(Buffer.from(JSON.stringify(manifest))), bytes };
}
function cliGuard(task, expected, authorization) {
    return { owner: authorization?.owner ?? task, signal: authorization?.signal, validate(owner) {
        need(taskSourceManifest().sha256 === expected && hashFile(CLI_PATH) === CLI_SHA256, "Input source/CLI changed before dispatch");
        return authorization ? authorization.validate(owner) === true : owner === task;
    } };
}
function compiled(root, name, maximum) {
    const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maximum)
        && fs.realpathSync(file) === file, "Compiled input artifact identity/bound");
    return Object.freeze({ identity: nativePrivateIdentity(stat), bytes: Number(stat.size), sha256: hashFile(file) });
}

function runPureContracts(taskId, snapshotId) {
    const request = parseSandboxTaskRequest({ version: 1, profile: "windows-powershell-foreground-v1",
        command: "[Console]::Write('中文')", cwd: ".", timeoutMs: 10000, inputs: [], writes: [] });
    const builder = new TaskPackageBuilder(request, taskId, snapshotId, []), packageBytes = builder.finish();
    let refusals = 0, carrier, previewInput;
    const refuse = operation => { assert.throws(operation); refusals++; };
    try {
        assert.equal(packageBytes.toString("latin1", 0, 8), "SPTASK01");
        assert.equal(packageBytes.readUInt32LE(8), packageBytes.length);
        assert.equal(packageBytes[97], 0); assert.equal(packageBytes[98], 0);
        assert.equal(packageBytes.readUInt32LE(12) + 16, packageBytes.length);
        refuse(() => builder.finish());
        const abandoned = new TaskPackageBuilder(request, taskId, snapshotId, []);
        abandoned.dispose(); assert.equal(abandoned.diagnostics.allocatedBytes, abandoned.diagnostics.clearedBytes);
        carrier = Buffer.alloc(131); carrier.write("SPRES001"); carrier.writeUInt32LE(131, 8); carrier.writeUInt32LE(128, 12);
        carrier.write(taskId, 16, "ascii"); carrier.write(snapshotId, 52, "ascii");
        carrier.writeUInt32LE(995, 92); carrier.writeUInt32LE(3, 96); carrier.writeBigUInt64LE(3n, 104);
        carrier.writeUInt32LE(20, 120); carrier.write("中", 128, "utf8");
        const result = parseTaskResult(carrier, taskId, snapshotId, 10000);
        assert.equal(result.stdout.toString("utf8"), "中"); assert.equal(result.stderr.length, 0);
        const mutations = [
            bytes => { bytes[0] |= 128; }, bytes => bytes.writeUInt32LE(130, 8),
            bytes => bytes.writeUInt32LE(129, 12), bytes => { bytes[16] = 120; },
            bytes => bytes.writeUInt32LE(1, 124), bytes => bytes.writeUInt32LE(0, 92),
            bytes => bytes.writeUInt32LE(995 | 1024, 92), bytes => bytes.writeUInt32LE(4, 96),
            bytes => bytes.writeBigUInt64LE(4n, 104), bytes => bytes.writeUInt32LE(995 | 8, 92),
            bytes => bytes.writeUInt32LE(995 | 4, 92), bytes => bytes.writeUInt32LE(20001, 120),
        ];
        for (const mutate of mutations) {
            const altered = Buffer.from(carrier);
            try { mutate(altered); refuse(() => parseTaskResult(altered, taskId, snapshotId, 10000)); }
            finally { altered.fill(0); }
        }
        refuse(() => parseTaskResult(carrier.subarray(0, 127), taskId, snapshotId, 10000));
        refuse(() => parseTaskResult(carrier, taskId, snapshotId, 0));
        previewInput = Buffer.alloc(32768, 0x61);
        let previewDecodedBytes = 0, previewSourceBytes = 0, previewMaximumJsonBytes = 0;
        for (let variant = 0; variant < 3; variant++) {
            if (variant === 1) previewInput.fill(1); // JSON expands each control byte into six characters.
            if (variant === 2) { previewInput.fill(0x61); previewInput.write("中", 63, "utf8"); }
            const preview = taskOutputPreview(previewInput);
            assert.equal(preview.sourceBytes, 32768); assert.equal(preview.decodedBytes, 64); assert.equal(preview.omittedBytes, 32704);
            const jsonBytes = Buffer.byteLength(JSON.stringify(preview.text)); assert.ok(jsonBytes <= 192);
            previewDecodedBytes += preview.decodedBytes; previewSourceBytes += preview.sourceBytes;
            previewMaximumJsonBytes = Math.max(previewMaximumJsonBytes, jsonBytes);
            if (variant === 0) assert.equal(preview.text, "a".repeat(64));
            if (variant === 1) assert.ok(preview.text.endsWith("…") && preview.text.length < 64);
            if (variant === 2) assert.equal(preview.text, "a".repeat(63) + "\uFFFD");
        }
        assert.equal(previewDecodedBytes, 192); assert.equal(previewSourceBytes, 98304);
        const previewSource = fs.readFileSync(path.join(DIRECTORY, "windows-sandbox-task-session.mjs"), "utf8");
        const previewBody = /export function taskOutputPreview\(bytes\) \{([\s\S]*?)\n\}/.exec(previewSource)?.[1];
        assert.ok(previewBody?.includes('bytes.toString("utf8", 0, decodedBytes)'));
        assert.ok(previewBody.includes("Math.min(bytes.length, PREVIEW_BYTES)"));
        assert.ok(previewSource.includes("const PREVIEW_BYTES = 64, PREVIEW_JSON_BYTES = 192;"));
        assert.equal(/result\.(stdout|stderr)\.toString\(/.test(previewSource), false);
        // Successful output loop only: exception construction belongs to the
        // bounded overflow rejection branch, never ordinary output delivery.
        const source = fs.readFileSync(path.join(DIRECTORY, "windows-sandbox-task-worker.cs"), "utf8");
        const loop = /while \(true\) \{\s*int count = Stream\.Read([\s\S]*?)\n                \}/.exec(source)?.[1];
        assert.ok(loop);
        const normal = loop.replace('throw new InvalidOperationException("Output counter overflow");', "");
        assert.equal(/\bnew\b|ToString\(|GetString\(|Task\.|BeginRead|StringBuilder/.test(normal), false);
        assert.ok(source.includes("if (U32(Accounting, 40) == 0)"));
        assert.ok(source.includes("job.Assign(process); stdout.Start(); stderr.Start();"));
        assert.ok(source.indexOf("job.Assign(process);") < source.indexOf('process.StandardInput.WriteLine("SUPERPI_GO")'));
        assert.ok(source.includes("TerminateJobObject(Handle, 1460)"));
        assert.ok(source.includes("CreateJobObjectW(IntPtr.Zero, null)"));
        assert.equal(refusals, 15);
        return { packageTransfer: true, zeroInput: true, releasedAbandonedPackage: true, refusals,
            pumpApplicationAllocationsPerRead: 0, jobBeforeGate: true, treeSettlementIncludesNormalExit: true,
            previewCases: 3, previewSourceBytes, previewDecodedBytes, previewMaximumJsonBytes, fullOutputStrings: 0 };
    } finally { packageBytes.fill(0); carrier?.fill(0); previewInput?.fill(0); builder.dispose(); }
}

export async function runTaskAcceptance(expectedBundle) {
    need(typeof expectedBundle === "string" && /^[0-9a-f]{64}$/.test(expectedBundle) && typeof globalThis.gc === "function", "Reviewed input bundle and controlled GC required");
    need(process.execPath === NODE && hashFile(NODE) === NODE_SHA256, "Pinned Node required"); verifyPowerShell7();
    need(hashFile(CSC) === CSC_SHA256 && hashFile(CLI_PATH) === CLI_SHA256, "Pinned input compiler/CLI changed");
    need(hashFile(path.join(REPOSITORY, "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node")) === KOFFI_SHA256
        && hashFile(path.join(REPOSITORY, "node_modules/typescript/lib/typescript.js")) === TYPESCRIPT_SHA256, "Pinned native/compiler dependency changed");
    const bundle = taskSourceManifest(); need(bundle.sha256 === expectedBundle, "Reviewed input source set changed");
    const resource = acquireAcceptanceRoot(), taskId = randomUUID(), snapshotId = randomUUID();
    const stat = fs.lstatSync(resource.root, { bigint: true }), rootId = String(stat.dev) + ":" + String(stat.ino), privateRootId = nativePrivateIdentity(stat);
    const report = taskReport(taskId, snapshotId, resource.root, rootId);
    report.sources = { ...sourceReceipt(bundle), nodeSha256: NODE_SHA256, koffiSha256: KOFFI_SHA256, typescriptSha256: TYPESCRIPT_SHA256 };
    const controller = new AbortController(), task = taskFrame(report, controller);
    const save = sessionJournal(resource, report, () => task.unsafe(), "task");
    const lifetime = new SharingLifetime({ bus: process, stream: process.stdout, report, save, task, profile: "task" });
    const launchGuard = executable => hostLaunchGuard(task, controller.signal, expectedBundle, executable,
        { sourceManifest: taskSourceManifest, verifyPowerShell7, hashFile });
    task.helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = taskHelpers(task.helpers.calls); save(); }, (executable, args, cwd) => {
        const runnerPath = path.join(resource.root, "task-runner.exe"), contract = executable === runnerPath;
        need(executable === POWERSHELL7_PATH || executable === CSC || contract && args.length === 1 && args[0] === "--contract-check", "Fixed task helpers only");
        const guard = contract ? { owner: task, signal: controller.signal, validate(owner) {
            need(owner === task && !controller.signal.aborted && taskSourceManifest().sha256 === expectedBundle
                && reviewedRunner && compiled(resource.root, "task-runner.exe", 65536).sha256 === reviewedRunner.sha256,
                "Original compiled contract runner changed"); return true;
        } } : launchGuard(executable);
        return lifetime.launch(contract ? "contract" : executable === CSC ? "compile" : "preflight", () => new CapturedProcess(executable, args, cwd), guard);
    });
    const cli = { launch(args, authorization) {
        need(["list", "start", "exec", "stop"].includes(args[0]), "Fixed input CLI command");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), cliGuard(task, expectedBundle, authorization));
    } };
    let receiptWeak = [], reviewedRunner;
    try {
        need(resource.root === SHARING_ROOT && stat.isDirectory() && !stat.isSymbolicLink(), "Fixed task root changed");
        report.contracts = runPureContracts(taskId, snapshotId); save();
        const preflight = await task.helpers.run(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")], 15000, controller.signal);
        report.preflight = preflightSnapshot(JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""))); save();
        await task.helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + path.join(resource.root, "volume-native.dll"),
            ...["windows-sandbox-volume-native.cs", "windows-sandbox-volume-candidate-manifest.cs", "windows-sandbox-volume-candidate-batch.cs", "windows-sandbox-input-install.cs", "windows-sandbox-task-install.cs"]
                .map(name => path.join(DIRECTORY, name))], 15000, controller.signal);
        const assembly = compiled(resource.root, "volume-native.dll", 131072);
        await task.helpers.run(CSC, ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(resource.root, "task-runner.exe"),
            path.join(DIRECTORY, "windows-sandbox-task-worker.cs")], 15000, controller.signal);
        const tool = compiled(resource.root, "task-runner.exe", 65536);
        reviewedRunner = tool;
        const pump = await task.helpers.run(path.join(resource.root, "task-runner.exe"), ["--contract-check"], 15000, controller.signal);
        report.pump = JSON.parse(pump.stdout.trim());
        assert.deepEqual(report.pump, { protocol: "super-pi-task-pump-contract-v1", seen: 131073, retained: 32768, reads: 34,
            allocated: 36864, cleared: 36864, liveBuffers: 0, nativeCalls: 0, packageRefusals: 9 });
        report.sources.nativeSha256 = assembly.sha256; report.sources.toolSha256 = tool.sha256; save();
        const { runInputHostFixture } = await import("./windows-sandbox-input-host-fixture.mjs");
        const host = await runInputHostFixture((capture, revision, original) => produceTaskCandidates(task, report, controller.signal, capture, revision, original, {
            root: resource.root, rootId: privateRootId, tool, save,
            attachManager(declaration) {
                need(!controller.signal.aborted, "Cancelled before input manager");
                const driver = lifetime.launch("manager", () => launchVolumeHelper({ root: resource.root, taskId, nativeSha256: assembly.sha256,
                    candidateCapture: true, taskPackageSha256: declaration.package.sha256, taskRunnerSha256: declaration.tool.sha256, taskSnapshotId: declaration.snapshotId }), launchGuard(POWERSHELL7_PATH));
                task.attach(driver, save);
            },
            buildVm(config) { return new SandboxLifecycle({ cli, config, taskId, journal(value) { report.vm = vmSnapshot(value); save(); } }); },
            buildChannel(current) { return new PrivateCandidateChannel({ owner: current.volume, vm: current.vm, taskId,
                root: resource.root, rootId: privateRootId, volumePath: current.volume.facts.volumePath, exchangeId: current.volume.facts.exchangeId }); },
        }), taskId, snapshotId, responsibility => { task.hostRetention = responsibility; });
        report.host = host.summary; task.hostRetention = host.retained; task.hostDone = host.passed; receiptWeak = host.weak;
        need(host.passed, "Original host apply or fixture cleanup failed");
        finishInputCandidates(task, report);
        const manifest = snapshotSessionFiles(resource.root, rootId, fs, "task");
        need(manifest.length === TASK_NORMAL_FILES.length && manifest.every(item => TASK_NORMAL_FILES.includes(item.name))
            && new Set(manifest.map(item => item.name)).size === TASK_NORMAL_FILES.length, "Input artifacts incomplete or unexpected");
        report.sequencePassed = report.released === true && report.candidate?.buffersReleased === true && report.host?.succeeded === true
            && report.guestExit?.wrapperExitCode === 0 && report.command?.exitCode === 0 && !report.command.timedOut
            && !task.capture && !task.publication && !task.resultReader && !task.binding && !task.hostRetention;
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
        const gcPassed = weak.length === 7 && live === 0;
        console.log(JSON.stringify({ kind: "generic-task-reference-release", gcRounds: 4, targets: weak.length, live, passed: gcPassed }));
        if (!gcPassed) completed.passed = false; // Earlier cleanup footer is a resource result, not this GC result.
    }
    return completed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 5 && process.argv[2] === "--run-generic-task-once" && process.argv[3] === "--source-bundle", "Explicit reviewed input invocation required");
    if (!(await runTaskAcceptance(process.argv[4])).passed) process.exitCode = 1;
}
