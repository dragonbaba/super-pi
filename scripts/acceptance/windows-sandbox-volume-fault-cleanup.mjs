// Contract-only manager-loss cleanup model. No filesystem, process, CLI or real cleanup authority.
// observe is a fixed trusted-host adapter, never supplied by a guest, CLI or serialized input.
import { createHash } from "node:crypto";
const need = (ok, message) => { if (!ok) throw Error(message); };
const HASH = /^[0-9a-f]{64}$/, ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const VOLUME = /^\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\$/;
const REF_KEYS = ["owner", "vm", "driver", "runtime", "diagnostic", "output"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fields = (value, keys) => {
    need(value && typeof value === "object" && !Array.isArray(value), "Fault cleanup schema");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    need(Reflect.ownKeys(descriptors).every(key => typeof key === "string") && Object.keys(descriptors).sort().join(",") === keys
        && Object.values(descriptors).every(item => Object.hasOwn(item, "value") && item.enumerable), "Fault cleanup data schema");
};
export const FAULT_CLEANUP_LIMITS = Object.freeze({ receipt: 4096, rawEvidence: 6144, journal: 8192, evidence: 7680, footer: 512,
    processes: 99, cli: 95, diagnosticSlots: 4 });
export const FAULT_CLEANUP_FILES = Object.freeze([
    Object.freeze(["task.vhd", 135266304]), Object.freeze(["volume-native.dll", 131072]),
    Object.freeze(["volume-helper.json", 8192]), Object.freeze(["fault-diagnostic.json", 4096]),
    Object.freeze(["lifecycle.json", 8192]),
]);
function context(input) {
    fields(input, "imageBytes,imageId,instanceId,managerPid,refs,rootId,taskId,volumePath");
    need([input.taskId, input.instanceId, input.rootId, input.imageId, input.volumePath].every(value => typeof value === "string")
        && UUID.test(input.taskId) && UUID.test(input.instanceId) && ID.test(input.rootId) && ID.test(input.imageId)
        && VOLUME.test(input.volumePath) && integer(input.managerPid, 2147483647) && input.managerPid > 0
        && integer(input.imageBytes, 135266304) && input.imageBytes >= 134217728, "Fault cleanup binding");
    fields(input.refs, "diagnostic,driver,output,owner,runtime,vm");
    const refs = {};
    for (const key of REF_KEYS) {
        const value = input.refs[key]; need(value && typeof value === "object" && !Array.isArray(value), "Host object reference required"); refs[key] = value;
    }
    need(new Set(Object.values(refs)).size === REF_KEYS.length, "Distinct host bindings required");
    return Object.freeze({ taskId: input.taskId, instanceId: input.instanceId, rootId: input.rootId, imageId: input.imageId,
        volumePath: input.volumePath, imageBytes: input.imageBytes, managerPid: input.managerPid, refs: Object.freeze(refs) });
}
function fault(value, binding) {
    fields(value, "attempts,cancelled,captureCount,execCount,exitCode,managerPid,requestAccepted,signal,taskRejected,unsafe");
    need(value.attempts === 1 && value.requestAccepted === true && value.managerPid === binding.managerPid
        && (value.exitCode === null || Number.isInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 2147483647)
        && (value.signal === null || value.signal === "SIGTERM") && (value.signal !== null || value.exitCode !== null && value.exitCode !== 0)
        && value.unsafe === true && value.cancelled === true && value.taskRejected === true && value.execCount === 0 && value.captureCount === 0,
    "Original manager-loss facts required");
    return Object.freeze({ ...value }); // The failure never becomes a successful task.
}
function lifecycle(value, binding) {
    fields(value, "candidateBytes,cliClosed,cliCount,diagnosticClosed,diagnosticPid,managerClosed,managerPid,pending,processClosed,processCount,unknownHandles,vmAbsent,vmInstanceId,vmState,vmTaskId");
    need(value.vmTaskId === binding.taskId && value.vmInstanceId === binding.instanceId && value.vmState === "closed" && value.vmAbsent === true
        && integer(value.cliCount, 95) && value.cliCount >= 6 && value.cliClosed === value.cliCount
        && value.processCount === value.cliCount + 4 && value.processCount <= 99 && value.processClosed === value.processCount
        && value.managerPid === binding.managerPid && value.managerClosed === true && value.diagnosticClosed === true
        && integer(value.diagnosticPid, 2147483647) && value.diagnosticPid > 0 && value.diagnosticPid !== value.managerPid
        && value.pending === 0 && value.unknownHandles === 0 && value.candidateBytes === 0, "Physical responsibility remains");
    return Object.freeze({ ...value });
}
// Pure schema validation only; this grants no process, file or cleanup authority.
export function validateFaultDiagnosticText(text, binding) {
    need(typeof text === "string" && text.length > 0 && text.length <= 4096 && Buffer.byteLength(text, "utf8") <= 4096, "Bounded diagnostic text");
    need(text.endsWith("\n"), "Diagnostic newline required");
    const body = text.endsWith("\r\n") ? text.slice(0, -2) : text.slice(0, -1);
    const receipt = JSON.parse(body); need(JSON.stringify(receipt) === body, "Canonical diagnostic required");
    fields(receipt, "diskId,guid,handles,imageBytes,imageId,instanceId,isLoaded,protocol,rootId,subtype,taskId,virtualBytes,volumePath");
    need(receipt.protocol === "super-pi-manager-loss-diagnostic-v1" && receipt.taskId === binding.taskId
        && receipt.instanceId === binding.instanceId && receipt.diskId === binding.taskId && receipt.rootId === binding.rootId
        && receipt.imageId === binding.imageId && receipt.imageBytes === binding.imageBytes && receipt.volumePath === binding.volumePath
        && receipt.virtualBytes === 134217728 && receipt.subtype === 2 && receipt.isLoaded === false, "Diagnostic identity or attached state");
    fields(receipt.guid, "error,opened");
    need(receipt.guid.opened === false && [2, 3].includes(receipt.guid.error), "GUID absence not proved");
    need(Array.isArray(receipt.handles) && receipt.handles.length === 3, "Diagnostic handles missing");
    const seen = new Set();
    for (const [index, row] of receipt.handles.entries()) {
        // role, exact handle, attempts, closed, operationFailed, operationError, closeFailed, closeError
        need(Array.isArray(row) && row.length === 8 && row[0] === ["root", "image", "vhd-info"][index]
            && typeof row[1] === "string" && /^[1-9A-F][0-9A-F]{0,15}$/.test(row[1]) && !/^(?:F{8}|F{16})$/.test(row[1]) && !seen.has(row[1])
            && row[2] === 1 && row[3] === true && row[4] === false && row[5] === null && row[6] === false && row[7] === null,
        "Diagnostic handle closure unknown");
        seen.add(row[1]);
    }
}
function diagnostic(raw, result, binding, physical, counters) {
    need(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= FAULT_CLEANUP_LIMITS.receipt, "Bounded raw diagnostic required");
    fields(result, "closedUtc,exitCode,launchError,pid,signal,stderrBytes,stdoutBytes,truncated");
    need(result.pid === physical.diagnosticPid && result.exitCode === 0 && result.signal === null && result.launchError === null
        && result.truncated === false && result.stdoutBytes === raw.length && result.stderrBytes === 0
        && typeof result.closedUtc === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.closedUtc), "Diagnostic process not conclusively closed");
    const copy = Buffer.alloc(raw.length);
    counters.allocated += copy.length; counters.active = copy.length; counters.peak = Math.max(counters.peak, copy.length);
    try {
        copy.set(raw);
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
        validateFaultDiagnosticText(text, binding);
        return { sha256: hash(copy), bytes: copy.length, process: Object.freeze({ ...result }) };
    } finally { copy.fill(0); counters.cleared += copy.length; counters.active = 0; }
}
// This bounded envelope is the complete original receipt, not just a hash or summary.
export function faultDiagnosticEnvelope(taskId, raw) {
    need(typeof taskId === "string" && UUID.test(taskId) && Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 4096, "Raw delivery input");
    const line = JSON.stringify({ kind: "manager-loss-diagnostic-raw", taskId, sha256: hash(raw), base64: raw.toString("base64") }) + "\n";
    need(Buffer.byteLength(line) <= 6144, "Raw evidence envelope bound");
    return Object.freeze({ line, bytes: Buffer.byteLength(line), sha256: hash(line) });
}
function manifest(files, binding, proof, expected) {
    need(Array.isArray(files) && files.length === expected.length, "Exact cleanup file set required");
    const rows = [], ids = new Set();
    for (const [index, item] of files.entries()) {
        fields(item, "bytes,id,name");
        const [name, maximum] = expected[index];
        need(item.name === name && typeof item.id === "string" && ID.test(item.id) && item.id !== binding.rootId && !ids.has(item.id)
            && integer(item.bytes, maximum) && item.bytes > 0, "Cleanup leaf identity/length");
        if (name === "task.vhd") need(item.id === binding.imageId && item.bytes === binding.imageBytes, "Original image changed");
        else need(item.id !== binding.imageId, "Image identity reused");
        if (name === "fault-diagnostic.json") need(item.bytes === proof.bytes, "Diagnostic leaf length");
        ids.add(item.id); rows.push(Object.freeze({ ...item }));
    }
    return Object.freeze(rows);
}
export class FaultCleanupContract {
    #context; #observe; #state = "new"; #token; #plan; #fingerprint; #completed = 0; #pendingLeaf = false; #failure = null; #originalFault;
    #copies = { allocated: 0, cleared: 0, active: 0, peak: 0 };
    constructor(binding, observe) {
        need(typeof observe === "function", "Fixed host observer required");
        this.#context = context(binding); this.#observe = observe;
    }
    get diagnostics() { return Object.freeze({ contractOnly: true, state: this.#state, completedLeaves: this.#completed,
        pendingLeaf: this.#pendingLeaf, contextHeld: this.#context !== undefined, observerHeld: this.#observe !== undefined,
        failure: this.#failure, originalFault: this.#originalFault, copyBytesAllocated: this.#copies.allocated,
        copyBytesCleared: this.#copies.cleared, activeCopyBytes: this.#copies.active, peakCopyBytes: this.#copies.peak }); }
    #block(error) {
        if (this.#state === "model-complete") throw error;
        this.#state = "blocked"; this.#token = undefined;
        let message;
        try { message = String(error instanceof Error ? error.message : error); } catch { message = "unprintable host error"; }
        this.#failure ??= Object.freeze({ type: typeof error, message: message.slice(0, 256) });
        throw error; // No recovery/retry; remaining references are deliberately retained.
    }
    #observeState(expected, rootAbsent = false) {
        const b = this.#context, value = this.#observe();
        fields(value, "delivery,diagnostic,diagnosticFileSha256,fault,files,generation,lifecycle,refs,root");
        fields(value.refs, "diagnostic,driver,output,owner,runtime,vm");
        for (const key of REF_KEYS) need(value.refs[key] === b.refs[key], "Original host object replaced");
        need(integer(value.generation, 65535) && value.generation > 0, "Evidence generation required");
        const failure = fault(value.fault, b); this.#originalFault ??= failure;
        const physical = lifecycle(value.lifecycle, b);
        fields(value.diagnostic, "raw,result");
        const proof = diagnostic(value.diagnostic.raw, value.diagnostic.result, b, physical, this.#copies);
        need(value.diagnosticFileSha256 === proof.sha256, "Diagnostic leaf bytes differ from process receipt");
        const wire = faultDiagnosticEnvelope(b.taskId, value.diagnostic.raw), delivery = value.delivery;
        fields(delivery, "diagnosticDeliveredBytes,diagnosticWireSha256,failed,logFrozen,pending,reportBytes,reportDeliveredBytes,reportSha256");
        need(delivery.pending === false && delivery.failed === false && delivery.logFrozen === true
            && typeof delivery.reportSha256 === "string" && HASH.test(delivery.reportSha256)
            && integer(delivery.reportBytes, 7680) && delivery.reportBytes > 0 && delivery.reportDeliveredBytes === delivery.reportBytes
            && delivery.diagnosticWireSha256 === wire.sha256 && delivery.diagnosticDeliveredBytes === wire.bytes, "Complete evidence delivery required");
        fields(value.root, "id,present");
        need(rootAbsent ? value.root.present === false && value.root.id === null : value.root.present === true && value.root.id === b.rootId, "Owned root changed");
        const files = manifest(value.files, b, proof, expected);
        // Host object identities are checked separately; this binds every bounded evidence value.
        const version = hash(JSON.stringify({ generation: value.generation, failure, physical, proof, delivery }));
        return { version, files, failure };
    }
    #assertToken(token, state) { need(token && token === this.#token && this.#state === state, "Cleanup token unavailable"); }
    #checkRemaining(count, rootAbsent = false) {
        const current = this.#observeState(FAULT_CLEANUP_FILES.slice(count), rootAbsent);
        need(current.version === this.#fingerprint && same(current.files, this.#plan.files.slice(count)), "Cleanup evidence or manifest changed");
        return current;
    }
    prepare() {
        try {
            need(this.#state === "new", "Only one cleanup qualification");
            this.#state = "qualifying";
            const current = this.#observeState(FAULT_CLEANUP_FILES);
            need(this.#state === "qualifying", "Qualification revoked during observation");
            this.#originalFault = current.failure; this.#fingerprint = current.version;
            this.#plan = Object.freeze({ contractOnly: true, taskId: this.#context.taskId, instanceId: this.#context.instanceId,
                evidenceVersion: current.version, files: current.files, originalFault: current.failure });
            this.#token = Object.freeze({}); this.#state = "qualified";
            return Object.freeze({ token: this.#token, plan: this.#plan });
        } catch (error) { return this.#block(error); }
    }
    consume(token) {
        try {
            this.#assertToken(token, "qualified"); this.#state = "consuming"; this.#checkRemaining(0);
            need(this.#state === "consuming", "Consumption revoked during observation"); this.#state = "consumed"; return this.#plan;
        }
        catch (error) { return this.#block(error); }
    }
    beforeLeaf(token, name) {
        try {
            this.#assertToken(token, "consumed");
            need(!this.#pendingLeaf && this.#completed < 5 && this.#plan.files[this.#completed].name === name, "Cleanup order or responsibility");
            this.#state = "leaf-checking"; this.#checkRemaining(this.#completed);
            need(this.#state === "leaf-checking", "Leaf permission revoked during observation");
            this.#state = "consumed"; this.#pendingLeaf = true; return this.#plan.files[this.#completed];
        } catch (error) { return this.#block(error); }
    }
    leafRemoved(token) {
        try {
            this.#assertToken(token, "consumed"); need(this.#pendingLeaf, "No simulated leaf pending");
            this.#state = "leaf-settling"; this.#checkRemaining(this.#completed + 1);
            need(this.#state === "leaf-settling", "Leaf settlement revoked during observation");
            this.#state = "consumed"; this.#completed++; this.#pendingLeaf = false;
        } catch (error) { return this.#block(error); }
    }
    beforeRoot(token) {
        try {
            this.#assertToken(token, "consumed"); need(this.#completed === 5 && !this.#pendingLeaf, "Leaves remain");
            this.#state = "root-checking"; this.#checkRemaining(5);
            need(this.#state === "root-checking", "Root permission revoked during observation"); this.#state = "root-pending";
        } catch (error) { return this.#block(error); }
    }
    rootRemoved(token) {
        try {
            this.#assertToken(token, "root-pending"); this.#state = "root-settling"; this.#checkRemaining(5, true);
            need(this.#state === "root-settling", "Root settlement revoked during observation");
            this.#state = "model-complete"; this.#context = undefined; this.#observe = undefined; this.#token = undefined; this.#plan = undefined;
            // Only this pure model's references are released. Real owner/retained/timers are untouched.
        } catch (error) { return this.#block(error); }
    }
    reject(error) { return this.#block(error); }
}
