// Production task adapter over the same volume, VM, capture and cleanup owners
// exercised by the manual acceptance. Importing this module creates no resources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { CapturedProcess, SandboxLifecycle, CLI_PATH, CLI_SHA256 } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { launchVolumeHelper, POWERSHELL7_PATH, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession } from "./windows-sandbox-volume-session.mjs";
import { vmSnapshot } from "./windows-sandbox-volume-share.mjs";
import { PrivateCandidateChannel, nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { WindowsSourceNative } from "./windows-sandbox-source-native.mjs";
import { INPUT_LIMITS } from "./windows-sandbox-input-snapshot.mjs";
import { CapturedWriteBatch } from "./windows-sandbox-candidate-write-batch.mjs";
import { taskReport, taskFrame, taskHelpers, runOwnedTaskChain, finishInputCandidates } from "./windows-sandbox-task-session.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const compilerHash = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const nativeSources = ["windows-sandbox-volume-native.cs", "windows-sandbox-volume-candidate-manifest.cs",
    "windows-sandbox-volume-candidate-batch.cs", "windows-sandbox-input-install.cs", "windows-sandbox-task-install.cs"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const identity = stat => ({ dev: stat.dev, ino: stat.ino });

function createRoot(parent) {
    fs.mkdirSync(parent, { recursive: true });
    need(fs.realpathSync(parent) === parent && !fs.lstatSync(parent).isSymbolicLink(), "Sandbox artifact parent is redirected");
    const root = fs.mkdtempSync(path.join(parent, "task-")), stat = fs.lstatSync(root, { bigint: true });
    const rootId = `${stat.dev}:${stat.ino}`;
    return { root, rootId, privateRootId: nativePrivateIdentity(stat), journal(record) {
        const current = fs.lstatSync(root, { bigint: true });
        need(`${current.dev}:${current.ino}` === rootId && fs.realpathSync(root) === root, "Sandbox artifact identity changed");
        // Direct bounded journal updates avoid an unregistered staging leaf.
        fs.writeFileSync(path.join(root, "lifecycle.json"), JSON.stringify(record));
    } };
}
function compiled(root, name, maximum) {
    const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maximum)
        && fs.realpathSync(file) === file, "Sandbox compiler artifact changed");
    return { identity: nativePrivateIdentity(stat), bytes: Number(stat.size), sha256: fileHash(file) };
}
function inputCapture(borrow, taskId, snapshotId) {
    if (!borrow.request.inputs.length) return undefined;
    borrow.assertInputsCurrent();
    const root = borrow.ctx.cwd, source = borrow.files.pinReadRevisions(borrow.ctx);
    try {
        const rootIdentity = identity(fs.lstatSync(root, { bigint: true })), entries = [];
        for (const input of borrow.request.inputs) {
            const revision = source.revisions.get(input.snapshot);
            need(revision && revision.canonicalPath === path.join(root, ...input.path.split("/")), "Original sandbox input revision required");
            const parents = [], parts = input.path.split("/");
            for (let depth = 1; depth < parts.length; depth++) {
                const relative = parts.slice(0, depth).join("/"), absolute = path.join(root, ...parts.slice(0, depth));
                const stat = fs.lstatSync(absolute, { bigint: true });
                need(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(absolute) === absolute, "Sandbox input parent is redirected");
                parents.push({ path: relative, identity: identity(stat) });
            }
            entries.push({ path: input.path, classification: "ordinary", expose: true,
                operation: borrow.request.writes.some(write => write.path === input.path) ? "modify" : null,
                parents, revision: input.snapshot, identity: { dev: revision.identity.dev, ino: revision.identity.ino,
                    size: revision.identity.size, mtimeNs: revision.identity.mtimeNs, ctimeNs: revision.identity.ctimeNs }, sha256: revision.sha256 });
        }
        const drive = path.parse(root).root, anchorIdentity = identity(fs.lstatSync(drive, { bigint: true }));
        const native = new WindowsSourceNative(); let volumePath;
        try { volumePath = native.volumeForDrive(drive); } finally { native.dispose(); }
        borrow.assertInputsCurrent();
        return new WindowsWorkspaceInputCapture({ taskId, snapshotId, sessionId: borrow.ctx.sessionManager.getSessionId(),
            epoch: source.revisions.generation, sourceRoot: { path: root, identity: rootIdentity }, budget: { ...INPUT_LIMITS }, entries },
            { drive, volumePath, identity: anchorIdentity }, borrow.files, borrow.ctx);
    } finally { source.dispose(); }
}
class EvidenceSink extends Writable {
    bytes = 0;
    _write(chunk, _encoding, done) {
        this.bytes += chunk.length;
        done(this.bytes <= 24000 ? undefined : new Error("Sandbox completion evidence exceeded its bound"));
    }
}

/** One invocation, kept alive by the session until finish confirms all owners closed. */
export async function executeWindowsTask(borrow, parent) {
    need(process.platform === "win32" && process.arch === "x64", "This sandbox profile requires Windows x64");
    borrow.assertInputsCurrent(); verifyPowerShell7();
    need(fileHash(compiler) === compilerHash && fileHash(CLI_PATH) === CLI_SHA256, "Sandbox toolchain version changed");
    const resource = createRoot(parent), taskId = randomUUID(), snapshotId = randomUUID();
    const report = taskReport(taskId, snapshotId, resource.root, resource.rootId);
    const controller = new AbortController(), task = taskFrame(report, controller);
    const save = sessionJournal(resource, report, () => task.unsafe(), "task");
    const sink = new EvidenceSink(), bus = new EventEmitter();
    const lifetime = new SharingLifetime({ bus, stream: sink, report, save, task, profile: "task" });
    const signal = AbortSignal.any([controller.signal, borrow.signal]);
    const onAbort = () => lifetime.cancel();
    borrow.signal.addEventListener("abort", onAbort, { once: true });
    let output, candidateInput, finished = false;
    const guard = (executable, authorization) => ({ owner: authorization?.owner ?? task, signal: authorization?.signal,
        validate(owner) {
            if (executable === CLI_PATH) need(fileHash(CLI_PATH) === CLI_SHA256, "Sandbox CLI changed");
            else { signal.throwIfAborted(); borrow.assertInputsCurrent();
                if (executable === compiler) need(fileHash(compiler) === compilerHash, "Sandbox compiler changed");
                else { need(executable === POWERSHELL7_PATH, "Unexpected sandbox helper"); verifyPowerShell7(); } }
            return authorization ? authorization.validate(owner) === true : owner === task;
        } });
    task.helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = taskHelpers(task.helpers.calls); save(); },
        (executable, args, cwd) => lifetime.launch("compile", () => new CapturedProcess(executable, args, cwd), guard(executable)));
    const cli = { launch(args, authorization) {
        need(["list", "start", "exec", "stop"].includes(args[0]), "Unsupported sandbox lifecycle command");
        return lifetime.launch(args[0], () => new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH)), guard(CLI_PATH, authorization));
    } };
    const handle = {
        result: undefined, input: undefined,
        async finish() {
            if (finished) return;
            try {
                finishInputCandidates(task, report);
                if (task.capture) {
                    need(task.capture.dispose() === true, "Sandbox input capture remains owned"); task.capture = undefined;
                }
                task.hostDone = true;
                // A failed command may be safely cleaned. Unknown physical ownership
                // still retains the original task and journal and blocks reuse.
                if (task.quiescent() && lifetime.physicalClosed && !report.cleanupError && !report.journalFailed) report.retained = false;
                report.sequencePassed = !report.error && !report.cancelled;
                await completeSharingSession({ report, task, lifetime, save, root: resource.root, rootId: resource.rootId });
                need(report.artifactsRemoved && report.taskReferencesReleased, "Sandbox cleanup unresolved: " + resource.root);
                finished = true; this.input = undefined; candidateInput = undefined;
                borrow.signal.removeEventListener("abort", onAbort); sink.destroy(); bus.removeAllListeners();
                this.diagnostics = { taskId, rootRemoved: true, physicalClosed: report.physical.physicallyClosed,
                    pendingProcesses: report.physical.pending.length, candidateBuffersReleased: report.candidate?.buffersReleased ?? true,
                    resultBytesReleased: report.resultReader?.afterRelease?.retainedBytes === 0, evidenceBytes: sink.bytes };
            } catch (error) {
                // The error retains this exact owner; callers must keep it until
                // explicit recovery confirms release, never guess or rescan PIDs.
                error.sandboxOwner = handle; throw error;
            }
        },
        diagnostics: { taskId, root: resource.root, rootRemoved: false },
    };
    try {
        task.capture = inputCapture(borrow, taskId, snapshotId);
        await task.helpers.run(compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + path.join(resource.root, "volume-native.dll"),
            ...nativeSources.map(name => path.join(directory, name))], 15000, signal);
        const assembly = compiled(resource.root, "volume-native.dll", 131072);
        await task.helpers.run(compiler, ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(resource.root, "task-runner.exe"),
            path.join(directory, "windows-sandbox-task-worker.cs")], 15000, signal);
        const tool = compiled(resource.root, "task-runner.exe", 65536);
        const produced = await runOwnedTaskChain(task, report, signal, borrow, {
            root: resource.root, rootId: resource.privateRootId, tool, save, fixture: false,
            onResult(result) {
                // Exactly one bounded UTF-8 materialization per stream at completion.
                output = { exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout.toString("utf8"),
                    stderr: result.stderr.toString("utf8"), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
                    stdoutSeen: result.stdoutSeen, stderrSeen: result.stderrSeen, elapsedMs: result.elapsedMs };
            },
            attachManager(declaration) {
                const driver = lifetime.launch("manager", () => launchVolumeHelper({ root: resource.root, taskId, nativeSha256: assembly.sha256,
                    candidateCapture: true, taskPackageSha256: declaration.package.sha256, taskRunnerSha256: tool.sha256, taskSnapshotId: snapshotId }), guard(POWERSHELL7_PATH));
                task.attach(driver, save);
            },
            buildVm(config) { return new SandboxLifecycle({ cli, config, taskId, journal(value) { report.vm = vmSnapshot(value); save(); } }); },
            buildChannel(current) { return new PrivateCandidateChannel({ owner: current.volume, vm: current.vm, taskId, root: resource.root,
                rootId: resource.privateRootId, volumePath: current.volume.facts.volumePath, exchangeId: current.volume.facts.exchangeId }); },
        });
        if (produced.candidate) {
            const conversion = new CapturedWriteBatch();
            try {
                conversion.prepare(produced.candidate); const request = conversion.take();
                for (const key of ["taskId", "snapshotId", "instanceId", "volumePath", "exchangeId"])
                    need(request.binding[key] === produced.binding[key], "Sandbox candidate association changed");
                candidateInput = request.input;
            } finally { conversion.dispose(); }
        }
        handle.result = output; handle.input = candidateInput; return handle;
    } catch (error) {
        error.sandboxDiagnostics = { report, command: output };
        try { await handle.finish(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Sandbox execution and cleanup failed", { cause: cleanup }); }
        throw error;
    }
}
