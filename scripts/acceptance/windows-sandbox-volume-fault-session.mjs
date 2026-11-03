// Explicit fault-only coordination. Importing never creates processes, volumes or files.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CapturedProcess, SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner, ManagerLossFactory } from "./windows-sandbox-volume.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { SharingLifetime, boundedText } from "./windows-sandbox-volume-session.mjs";
import { SHARING_ROOT } from "./windows-sandbox-volume-share-acceptance.mjs";
import { nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
import { DiagnosticResultChannel } from "./windows-sandbox-volume-diagnostic-channel.mjs";
import { DiagnosticReceiptFile } from "./windows-sandbox-volume-diagnostic-file.mjs";
import { FaultCleanupContract, FAULT_CLEANUP_FILES } from "./windows-sandbox-volume-fault-cleanup.mjs";
import { volumeSnapshot } from "./windows-sandbox-volume-share.mjs";
const need = (condition, message) => { if (!condition) throw Error(message); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const IO_METHODS = ["lstatSync","realpathSync","readdirSync","openSync","fstatSync","readSync","closeSync","unlinkSync","rmdirSync"];
// Only this bounded reader/deleter owns the separate diagnostic readback fd.
// Physical closure and fixed root are prerequisites, not reconstructed from report flags.
export class FaultArtifacts {
    #root; #rootId; #imageId; #imageBytes; #io; #methods; #guard; #files; #fingerprints; #removed = 0;
    #calls = 0; #inIo = false; #reading = false; #readAttempted = false; #cleaning = false; #disposed = false;
    #scratch; #allocated = 0; #cleared = 0; #rootRemoved = false; #unknown = false; #fileSha; #readFingerprint;
    #cleanupAttempted = false;
    #read = { opened: false, fd: undefined, id: null, bytes: 0, readCalls: 0, closeAttempts: 0, closed: false,
        operationFailed: false, operationError: undefined, closeFailed: false, closeError: undefined };
    constructor({ root, rootId, imageId, imageBytes }, guard, io = fs) {
        need(root === SHARING_ROOT && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(rootId)
            && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(imageId) && rootId !== imageId
            && Number.isInteger(imageBytes) && imageBytes >= 134217728 && imageBytes <= 135266304
            && typeof guard === "function", "Fixed fault artifact binding");
        const methods = {};
        for (const name of IO_METHODS) { need(typeof io[name] === "function", "Fault artifact I/O"); methods[name] = io[name]; }
        this.#root = root; this.#rootId = rootId; this.#imageId = imageId; this.#imageBytes = imageBytes;
        this.#io = io; this.#methods = Object.freeze(methods); this.#guard = guard;
    }
    get snapshot() { return Object.freeze({ calls: this.#calls, removedFiles: this.#removed, rootRemoved: this.#rootRemoved,
        active: this.#reading || this.#inIo || this.#cleaning, unknown: this.#unknown, filesystemHeld: !!this.#io,
        read: Object.freeze({ ...this.#read }), allocatedBytes: this.#allocated, clearedBytes: this.#cleared,
        retainedBytes: this.#scratch?.length ?? 0, diagnosticFileSha256: this.#fileSha ?? null, disposed: this.#disposed }); }
    #call(name, ...args) {
        need(!this.#disposed && !this.#inIo && !this.#unknown && this.#calls < 256, "Fault artifact I/O admission");
        this.#inIo = true;
        try { need(this.#guard() === true, "Original fault cleanup permission revoked"); this.#calls++;
            return Reflect.apply(this.#methods[name], this.#io, args); }
        finally { this.#inIo = false; }
    }
    #checkRoot() {
        const stat = this.#call("lstatSync", this.#root, { bigint: true });
        need(stat.isDirectory() && !stat.isSymbolicLink() && nativePrivateIdentity(stat) === this.#rootId
            && this.#call("realpathSync", this.#root) === this.#root, "Original artifact root changed");
    }
    #leaf(name, maximum) {
        const file = path.win32.join(this.#root, name), stat = this.#call("lstatSync", file, { bigint: true });
        need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(maximum)
            && typeof stat.mtimeNs === "bigint" && typeof stat.ctimeNs === "bigint"
            && this.#call("realpathSync", file) === file, "Artifact leaf type/path/bound");
        const id = nativePrivateIdentity(stat);
        need(id !== this.#rootId && id.slice(0,9) === this.#rootId.slice(0,9), "Private artifact volume");
        return { name, id, bytes: Number(stat.size), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs) };
    }
    readReceipt(expected) {
        need(!this.#disposed && !this.#reading && !this.#inIo && !this.#cleaning && !this.#readAttempted
            && expected.name === "fault-diagnostic.json" && expected.bytes > 0 && expected.bytes <= 4096
            && /^[0-9a-f]{64}$/.test(expected.sha256), "Single bounded receipt readback");
        this.#readAttempted = true; this.#reading = true;
        const record = this.#read; let fingerprint;
        try {
            this.#checkRoot(); fingerprint = this.#leaf(expected.name, 4096);
            need(fingerprint.id === expected.id && fingerprint.bytes === expected.bytes, "Written receipt identity");
            const fd = this.#call("openSync", path.win32.join(this.#root, expected.name), "r");
            record.fd = fd;
            if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) { this.#unknown = true; throw Error("Unknown readback descriptor"); }
            record.opened = true;
            const before = this.#call("fstatSync", fd, { bigint: true });
            record.id = nativePrivateIdentity(before);
            need(before.isFile() && before.nlink === 1n && record.id === expected.id && Number(before.size) === expected.bytes
                && String(before.mtimeNs) === fingerprint.modified && String(before.ctimeNs) === fingerprint.changed, "Readback handle changed");
            this.#scratch = Buffer.alloc(expected.bytes); this.#allocated = this.#scratch.length;
            while (record.bytes < this.#scratch.length) {
                need(record.readCalls < 4, "Readback progress budget"); record.readCalls++;
                const remaining = this.#scratch.length - record.bytes;
                const count = this.#call("readSync", fd, this.#scratch, record.bytes, remaining, record.bytes);
                need(Number.isInteger(count) && count > 0 && count <= remaining, "Readback invalid progress"); record.bytes += count;
            }
            const after = this.#call("fstatSync", fd, { bigint: true });
            need(after.isFile() && after.nlink === 1n && nativePrivateIdentity(after) === record.id && after.size === before.size
                && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs, "Readback changed during read");
            this.#checkRoot(); need(same(this.#leaf(expected.name,4096), fingerprint), "Readback path changed");
            need(hash(this.#scratch) === expected.sha256, "Stored receipt differs from original process bytes");
            this.#fileSha = expected.sha256;
            this.#readFingerprint = Object.freeze(fingerprint);
        } catch (error) { record.operationFailed = true; record.operationError = error; }
        finally {
            if (record.opened) {
                record.closeAttempts = 1; this.#calls++;
                try { Reflect.apply(this.#methods.closeSync,this.#io,[record.fd]); record.closed = true; }
                catch (error) { record.closeFailed = true; record.closeError = error; this.#unknown = true; }
            }
            this.#reading = false;
            if (!this.#unknown && this.#scratch) { this.#scratch.fill(0); this.#cleared += this.#scratch.length; this.#scratch = undefined; }
        }
        if(record.operationFailed && record.closeFailed)throw new AggregateError([record.operationError,record.closeError],"Readback and close failed");
        if(record.operationFailed)throw record.operationError;
        if(record.closeFailed)throw record.closeError;
        return Object.freeze(fingerprint);
    }
    #scan() {
        this.#checkRoot();
        const expected = FAULT_CLEANUP_FILES.slice(this.#removed), names = this.#call("readdirSync",this.#root);
        need(Array.isArray(names) && names.length === expected.length && names.every(name => expected.some(row=>row[0]===name)),
            "Exact remaining fault leaves required");
        const files = expected.map(([name,max])=>this.#leaf(name,max));
        need(new Set(files.map(item=>item.id)).size === files.length, "Artifact identity alias");
        const image=files.find(item=>item.name==="task.vhd");
        if(image)need(image.id===this.#imageId && image.bytes===this.#imageBytes,"Original image changed");
        return files;
    }
    freezeManifest() {
        need(!this.#files && !this.#inIo && !this.#reading && !this.#cleaning && this.#read.closed
            && !this.#read.operationFailed && !this.#read.closeFailed && this.#fileSha, "Readback must conclude before manifest freeze");
        const fingerprints=this.#scan();
        need(same(fingerprints.find(item=>item.name==="fault-diagnostic.json"), this.#readFingerprint),
            "Readback leaf identity/content metadata changed before freeze");
        this.#fingerprints=fingerprints;
        this.#files=Object.freeze(fingerprints.map(({name,id,bytes})=>Object.freeze({name,id,bytes})));
        return this.#files;
    }
    observe() {
        need(this.#files && !this.#inIo && !this.#reading && !this.#unknown, "Artifact observation unavailable");
        if(this.#rootRemoved) {
            let absent=false;
            try{this.#call("lstatSync",this.#root,{bigint:true});}catch(error){if(error?.code==="ENOENT")absent=true;else throw error;}
            need(absent,"Removed root reappeared");return{root:{present:false,id:null},files:[]};
        }
        need(same(this.#scan(),this.#fingerprints.slice(this.#removed)),"Frozen artifact identity/content metadata changed");
        return{root:{present:true,id:this.#rootId},files:this.#files.slice(this.#removed)};
    }
    cleanup(contract,token) {
        need(!this.#inIo&&!this.#reading&&!this.#cleaning&&!this.#unknown&&!this.#rootRemoved&&!this.#cleanupAttempted,"One exact fault cleanup");
        this.#cleanupAttempted=true; this.#cleaning=true;
        try {
            FaultCleanupContract.prototype.consume.call(contract,token);
            for(const [name] of FAULT_CLEANUP_FILES) {
                const item=FaultCleanupContract.prototype.beforeLeaf.call(contract,token,name);
                need(item===this.#files[this.#removed]||same(item,this.#files[this.#removed]),"Original removal identity");
                // Contract observation checks the original root/leaf immediately before this fixed unlink.
                this.#call("unlinkSync",path.win32.join(this.#root,name));this.#removed++;
                FaultCleanupContract.prototype.leafRemoved.call(contract,token);
            }
            FaultCleanupContract.prototype.beforeRoot.call(contract,token);
            this.#call("rmdirSync",this.#root);this.#rootRemoved=true;
            FaultCleanupContract.prototype.rootRemoved.call(contract,token);
        } finally{this.#cleaning=false;}
    }
    dispose() {
        if(this.#disposed)return;
        need(this.#rootRemoved&&!this.#unknown&&!this.#inIo&&!this.#reading&&!this.#cleaning&&this.#read.closed,"Artifact responsibility remains");
        this.#io=undefined;this.#methods=undefined;this.#guard=undefined;this.#files=undefined;this.#fingerprints=undefined;
        this.#readFingerprint=undefined;this.#read.operationError=undefined;this.#read.closeError=undefined;this.#disposed=true;
    }
}


// One outer owner exists before any launch or byte transfer. Only this cold host object
// can connect the pure contract to physical deletion; serialized reports grant no authority.
export class FaultSession {
    #report; #save; #io; #rootId; #runtime; #volume; #driver; #vm; #factory; #lifetime;
    #user = new AbortController(); #fault = new AbortController(); #binding; #original;
    #diagnostic; #channel; #receipt; #artifacts; #contract; #raw; #proof; #delivery;
    #rejected = false; #rejectionAttempted = false; #triggered = false; #completionAttempted = false;
    #logFrozen = false; #footerSettled = false; #disposed = false; #received = 0; #cleared = 0;
    #volumeRecord; #failed = false;
    constructor(report, save, rootId, io = fs) {
        need(report.artifactRoot === SHARING_ROOT && typeof save === "function", "Fixed fault session required");
        this.#report = report; this.#save = save; this.#rootId = rootId; this.#io = io;
        this.#runtime = new LiveSandboxRuntime(report.taskId);
    }
    get driver() { return this.#driver; }
    get volume() { return this.#volume; }
    get vm() { return this.#vm; }
    get runtime() { return this.#runtime; }
    get signal() { return this.#user.signal; }
    get snapshot() { return Object.freeze({ disposed: this.#disposed, taskRejected: this.#rejected,
        receivedBytes: this.#received, clearedBytes: this.#cleared, retainedBytes: this.#raw?.length ?? 0,
        referencesHeld: !!(this.#runtime || this.#driver || this.#vm || this.#factory || this.#io || this.#save),
        contract: this.#contract?.diagnostics ?? null, artifacts: this.#artifacts?.snapshot ?? null,
        receipt: this.#receipt?.snapshot ?? null, channel: this.#channel?.snapshot ?? null }); }
    bindLifetime(lifetime) {
        need(!this.#lifetime && lifetime instanceof SharingLifetime && lifetime.profile === "fault", "Original fault lifetime required");
        this.#lifetime = lifetime;
    }
    bindFactory(factory) {
        need(!this.#factory && factory instanceof ManagerLossFactory && factory.snapshot.taskId === this.#report.taskId,
            "Original manager factory required"); this.#factory = factory;
    }
    attach(driver) {
        need(!this.#driver && driver === this.#factory.driver, "Original manager driver required"); this.#driver = driver;
        this.#volume = new TaskVolumeOwner({ driver, taskId: this.#report.taskId, readRuntime: this.#runtime.read,
            journal: value => { this.#volumeRecord = value; this.#report.volume = volumeSnapshot(value); this.#save(); },
            revokeCandidates: () => { this.#report.revoked = true; },
            cancelExecution: () => { this.#fault.abort(); this.#report.cancelled = true; } });
    }
    cancel() { this.#user.abort(); this.#factory?.revoke(); this.#volume?.revoke(); }
    unsafe() { this.#failed = true; this.#factory?.revoke(); this.#volume?.onUnsafe(); }
    #captureBinding() {
        const root = this.#io.lstatSync(SHARING_ROOT, { bigint: true });
        need(root.isDirectory() && !root.isSymbolicLink() && nativePrivateIdentity(root) === this.#rootId
            && this.#io.realpathSync(SHARING_ROOT) === SHARING_ROOT, "Original fault root changed");
        const file = path.win32.join(SHARING_ROOT, "task.vhd"), image = this.#io.lstatSync(file, { bigint: true });
        need(image.isFile() && !image.isSymbolicLink() && image.nlink === 1n && image.size >= 134217728n && image.size <= 135266304n
            && this.#io.realpathSync(file) === file && nativePrivateIdentity(image) === this.#volume.facts.imageId,
            "Original fault image and actual EOF required");
        this.#binding = Object.freeze({ taskId: this.#report.taskId, instanceId: this.#vm.id, rootId: this.#rootId,
            imageId: nativePrivateIdentity(image), imageBytes: Number(image.size), volumePath: this.#volume.facts.volumePath });
        this.#original = Object.freeze({ volume: this.#volume, driver: this.#driver, vm: this.#vm, runtime: this.#runtime, factory: this.#factory });
    }
    async trigger(buildVm) {
        need(!this.#triggered && !this.signal.aborted && !this.#failed, "Fault scene is one-shot"); this.#triggered = true;
        await this.#volume.prepare(); need(!this.signal.aborted, "User stopped before VM creation");
        this.#vm = buildVm(experimentalGuidConfig(this.#volume)); this.#runtime.bind(this.#vm);
        const ticket = await this.#volume.issueExperimentalMapping(this.#vm);
        await this.#volume.startExperimentalMapping(ticket, this.#vm, this.signal);
        await this.#factory.verifyAndArm(this, this.signal);
        this.#captureBinding(); this.#report.binding = this.#binding; this.#save();
        need(!this.signal.aborted && !this.#failed, "Fault request revoked");
        this.#factory.request();
        // The expected abnormal close returns false. Physical closure is checked independently below.
        await this.#driver.waitClosed();
        need(this.#driver.physicallyClosed && this.#driver.childReleased && !this.#driver.pending
            && this.#driver.diagnostics.buffersReleased, "Original manager still owns physical work");
        need(await this.#vm.cleanup(), "Original VM cleanup unresolved");
        // Invoke the actual admission gate exactly once; no caller-provided rejection flag.
        this.#rejectionAttempted = true;
        try { TaskVolumeOwner.prototype.beginCandidateRead.call(this.#volume); }
        catch { this.#rejected = true; }
        this.#assertClosed(); this.#report.taskRejected = this.#rejected; this.#report.unsafe = true; this.#save();
    }
    #assertClosed() {
        const o = this.#original, b = this.#binding, f = this.#factory?.snapshot, v = this.#volumeRecord;
        need(!this.#disposed && !this.#failed && !this.signal.aborted && !this.#report.journalFailed && o && b
            && this.#volume === o.volume && this.#driver === o.driver && this.#vm === o.vm && this.#runtime === o.runtime && this.#factory === o.factory
            && this.#factory.driver === this.#driver && f.taskId === b.taskId && f.instanceId === b.instanceId && f.verified
            && f.attempts === 1 && f.requestReturned === true && !f.requestThrew && f.closeObserved && !f.childHeld
            && !f.recordFailed && !f.recordInFlight && f.pendingRecords === 0 && !f.recordObserverFailed && f.childErrorCount === 0
            && f.pid === this.#driver.pid && f.exitCode === this.#driver.diagnostics.exitCode && f.signal === this.#driver.diagnostics.signal
            && (f.signal === "SIGTERM" || f.signal === null && Number.isInteger(f.exitCode) && f.exitCode !== 0)
            && this.#driver.physicallyClosed && this.#driver.childReleased && this.#driver.blocked && !this.#driver.pending
            && this.#driver.diagnostics.buffersReleased && this.#driver.diagnostics.stderr.seenBytes === 0
            && this.#volume.state === "blocked" && v?.state === "blocked" && v.revoked && !v.pending && !v.reading && !v.closeUnknown
            && !v.candidateAttempted && !v.candidateLeaseHeld && v.candidateStage === "none"
            && this.#fault.signal.aborted && this.#rejectionAttempted && this.#rejected, "Original manager-loss facts unavailable");
        const runtime = this.#runtime.read();
        need(runtime.owner === this.#vm && runtime.taskId === b.taskId && runtime.instanceId === b.instanceId
            && runtime.state === "closed" && runtime.instanceAbsent && runtime.callsClosed
            && this.#vm.state === "closed" && !this.#vm.active && !this.#vm.execution && !this.#vm.connection
            && this.#vm.calls.every(call => !["exec", "connect"].includes(call.kind)), "Original VM/CLI closure required");
        return true;
    }
    #guard = () => { this.#assertClosed(); return true; };
    // Version/tool verification precedes the original-object guard. The lifetime calls
    // this after reservation/journal and then immediately invokes the capture constructor.
    diagnosticAuthorization(verifySources) {
        return { owner: this, signal: this.signal, validate: owner => {
            need(owner === this && !this.#diagnostic && !this.#channel, "One original diagnostic dispatch");
            verifySources(); this.#assertClosed();
            this.#lifetime.faultProcessFacts(this, this.#driver); return true;
        } };
    }
    async diagnose(launch) {
        need(!this.#diagnostic && !this.#channel && !this.#completionAttempted, "Diagnostic already attempted"); this.#assertClosed();
        this.#diagnostic = launch(this.#binding); // Lifetime also holds it before post-launch persistence.
        need(this.#diagnostic instanceof CapturedProcess, "Recorded capture required");
        this.#channel = new DiagnosticResultChannel(this.#binding, this.#diagnostic);
        await this.#channel.waitOnce(this.signal);
        this.#assertClosed(); this.#lifetime.faultProcessFacts(this, this.#driver, this.#diagnostic);
        this.#receipt = new DiagnosticReceiptFile({ root: SHARING_ROOT, ...this.#binding }, this.#guard, this.#io);
        this.#receipt.adopt(this.#channel); this.#receipt.writeOnce();
        const evidence = this.#receipt.evidence();
        this.#artifacts = new FaultArtifacts({ root: SHARING_ROOT, ...this.#binding }, this.#guard, this.#io);
        this.#artifacts.readReceipt(evidence.file);
        return evidence;
    }
    #observe = () => {
        this.#assertClosed();
        const p = this.#lifetime.faultProcessFacts(this, this.#driver, this.#diagnostic), f = this.#factory.snapshot;
        need(!this.#lifetime.output.pending && !this.#lifetime.output.failed && this.#logFrozen && this.#raw
            && !this.#receipt.snapshot.unknown && this.#receipt.snapshot.activeDescriptors === 0
            && !this.#artifacts.snapshot.unknown && this.#artifacts.snapshot.read.closed, "Evidence/IO responsibility remains");
        const result = { pid: this.#proof.pid, exitCode: this.#proof.exitCode, signal: this.#proof.signal, launchError: this.#proof.launchError,
            closedUtc: this.#proof.closedUtc, stdoutBytes: this.#proof.stdoutBytes, stderrBytes: this.#proof.stderrBytes, truncated: this.#proof.truncated };
        return { generation: 1, refs: { owner: this.#volume, vm: this.#vm, driver: this.#driver, runtime: this.#runtime,
                diagnostic: this.#diagnostic, output: this.#lifetime.output },
            fault: { attempts: f.attempts, requestAccepted: f.requestReturned, managerPid: f.pid, exitCode: f.exitCode, signal: f.signal,
                unsafe: this.#volume.state === "blocked", cancelled: this.#fault.signal.aborted, taskRejected: this.#rejected, execCount: 0, captureCount: 0 },
            lifecycle: { ...p, vmTaskId: this.#vm.taskId, vmInstanceId: this.#vm.id, vmState: this.#vm.state,
                vmAbsent: this.#runtime.read().instanceAbsent, unknownHandles: 0, candidateBytes: 0 },
            diagnostic: { raw: this.#raw, result }, diagnosticFileSha256: this.#artifacts.snapshot.diagnosticFileSha256,
            delivery: this.#delivery, ...this.#artifacts.observe() };
    };
    async complete(evidence) {
        need(!this.#completionAttempted, "Fault completion is one-shot"); this.#completionAttempted = true;
        const r = this.#report, lifetime = this.#lifetime;
        lifetime.beginCompletion();
        try {
            this.#assertClosed();
            // Recreate evidence only from the original file owner; the argument is never authority.
            const original = this.#receipt.evidence(); need(same(evidence, original), "Original evidence changed");
            r.fault = this.#factory.snapshot; r.diagnostic = original.proof; r.file = original.file;
            r.readback = { calls: this.#artifacts.snapshot.calls, bytes: this.#artifacts.snapshot.read.bytes,
                allocated: this.#artifacts.snapshot.allocatedBytes, cleared: this.#artifacts.snapshot.clearedBytes };
            r.taskRejected = this.#rejected; r.unsafe = true; r.cancelled = true; r.taskPassed = false;
            r.reportedUtc = new Date().toISOString(); lifetime.snapshot(); this.#save();
            this.#logFrozen = true; r.cleanupStarted = true;
            this.#artifacts.freezeManifest();
            const line = JSON.stringify(r) + "\n"; need(Buffer.byteLength(line) <= 7680, "Fault report bound");
            await lifetime.output.write(original.wire.line); this.#assertClosed();
            await lifetime.output.write(line); this.#assertClosed();
            this.#delivery = Object.freeze({ pending: false, failed: false, logFrozen: true, reportBytes: Buffer.byteLength(line),
                reportDeliveredBytes: Buffer.byteLength(line), reportSha256: hash(line), diagnosticDeliveredBytes: original.wire.bytes,
                diagnosticWireSha256: original.wire.sha256 });
            // Already-created receiver registers the exact buffer before any callback/check.
            const transfer = DiagnosticReceiptFile.prototype.takeForCleanup.call(this.#receipt);
            this.#raw = transfer.bytes; this.#proof = transfer.proof; this.#received = this.#raw.length;
            this.#contract = new FaultCleanupContract({ ...this.#binding, managerPid: this.#driver.pid,
                refs: { owner: this.#volume, vm: this.#vm, driver: this.#driver, runtime: this.#runtime,
                    diagnostic: this.#diagnostic, output: lifetime.output } }, this.#observe);
            const { token } = this.#contract.prepare(); this.#artifacts.cleanup(this.#contract, token);
            r.artifactsRemoved = true; r.removedFiles = 5;
            const footer = JSON.stringify({ kind: "fault-cleanup", taskId: r.taskId, faultAcceptancePassed: true,
                taskPassed: false, unsafe: true, cancelled: true, taskRejected: this.#rejected, artifactsRemoved: true }) + "\n";
            need(Buffer.byteLength(footer) <= 512, "Fault footer bound");
            await lifetime.output.write(footer); this.#footerSettled = true;
            need(!lifetime.output.failed, "Fault footer output failed");
            r.faultAcceptancePassed = true; r.retained = false;
            lifetime.closeTaskBinding();
        } catch (error) { this.fail(error); }
        finally { lifetime.finish(); }
        return r;
    }
    fail(error) {
        this.#failed = true; this.#report.retained = true; this.#report.faultAcceptancePassed = false;
        this.#report.error ??= boundedText(error instanceof Error ? error.message : String(error));
        if (!this.#logFrozen) { try { this.#save(); } catch {} }
    }
    quiescent() {
        return !this.#failed && this.#contract?.diagnostics.state === "model-complete" && this.#artifacts?.snapshot.rootRemoved
            && this.#footerSettled && !this.#lifetime.output.pending && !this.#lifetime.output.failed && this.#lifetime.physicalClosed;
    }
    dispose() {
        need(!this.#disposed && this.quiescent(), "Fault outer responsibilities remain");
        this.#artifacts.dispose(); this.#receipt.dispose(); this.#channel.dispose();
        this.#factory.dispose(); this.#runtime.dispose();
        this.#raw.fill(0); this.#cleared += this.#raw.length; this.#raw = undefined;
        this.#proof = undefined; this.#delivery = undefined; this.#original = undefined; this.#binding = undefined; this.#volumeRecord = undefined;
        // All closed components become unreachable together. Ordinary release remains blocked.
        this.#vm = undefined; this.#volume = undefined; this.#driver = undefined; this.#runtime = undefined; this.#factory = undefined;
        this.#diagnostic = undefined; this.#io = undefined; this.#save = undefined; this.#lifetime = undefined; this.#report = undefined;
        this.#disposed = true;
    }
}
