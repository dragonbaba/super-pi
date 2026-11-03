// Success-byte admission only. The fault lifetime owns and reserves the original call before construction.
import { createHash } from "node:crypto";
import { validateFaultDiagnosticText } from "./windows-sandbox-volume-fault-cleanup.mjs";
const need = (value, message) => { if (!value) throw Error(message); };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/;
const VOLUME = /^\\\\\?\\Volume\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}\\$/;
const own = (value, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && "value" in descriptor, "Original data property required");
    return descriptor.value;
};
function binding(input) {
    need(input && Reflect.ownKeys(input).length === 6 && Object.keys(input).sort().join(",") === "imageBytes,imageId,instanceId,rootId,taskId,volumePath", "Diagnostic binding fields");
    const result = {};
    for (const key of ["taskId", "instanceId", "rootId", "imageId", "imageBytes", "volumePath"]) result[key] = own(input, key);
    need(typeof result.taskId === "string" && UUID.test(result.taskId) && typeof result.instanceId === "string" && UUID.test(result.instanceId)
        && typeof result.rootId === "string" && ID.test(result.rootId) && typeof result.imageId === "string" && ID.test(result.imageId)
        && Number.isInteger(result.imageBytes) && result.imageBytes >= 134217728 && result.imageBytes <= 135266304
        && typeof result.volumePath === "string" && VOLUME.test(result.volumePath), "Diagnostic original identity");
    return Object.freeze(result);
}
export const DIAGNOSTIC_CHANNEL_LIMITS = Object.freeze({ waitMs: 15000, receiptBytes: 4096,
    capturedStdoutBytes: 16384, capturedStderrBytes: 16384, reconstructedBytes: 4096 });
// Call objects and their wait function are trusted host dependencies, never guest declarations.
// Future fixed dispatch must supply the recorded CapturedProcess object; fakes here prove only this gate.
export class DiagnosticResultChannel {
    #binding; #call; #wait; #pid; #state = "new"; #waiting = false; #bytes; #proof; #error; #failed = false;
    #allocated = 0; #cleared = 0; #transferred = 0;
    constructor(input, originalCall) {
        this.#binding = binding(input);
        need(originalCall && typeof originalCall === "object", "Original diagnostic call required");
        const wait = originalCall.wait, pid = originalCall.pid;
        need(typeof wait === "function" && Number.isInteger(pid) && pid > 0, "Original diagnostic call required");
        this.#call = originalCall; this.#wait = wait; this.#pid = pid;
    }
    get snapshot() { return Object.freeze({ state: this.#state, pid: this.#pid, waiting: this.#waiting, failed: this.#failed,
        callHeld: this.#call !== undefined, bindingHeld: this.#binding !== undefined, waitHeld: this.#wait !== undefined,
        allocatedBytes: this.#allocated, clearedBytes: this.#cleared, transferredBytes: this.#transferred,
        retainedBytes: this.#bytes?.length ?? 0 }); }
    get originalError() { return this.#error; }
    #closed() {
        return this.#call && this.#call.pid === this.#pid && this.#call.result
            && this.#call.child === undefined && this.#call.out === undefined && this.#call.err === undefined;
    }
    async waitOnce(signal) {
        need(this.#state === "new", "Diagnostic wait is one-shot"); this.#state = "waiting"; this.#waiting = true;
        try {
            const outcome = await Reflect.apply(this.#wait, this.#call, [DIAGNOSTIC_CHANNEL_LIMITS.waitMs, signal]);
            need(outcome === "settled" && !signal?.aborted && this.#closed(), "Diagnostic not eligible after logical wait");
            const source = this.#call.result, result = {};
            for (const key of ["pid", "exitCode", "signal", "launchError", "closedUtc", "stdout", "stderr", "stdoutSeen", "stderrSeen", "truncated"])
                result[key] = own(source, key);
            need(result.pid === this.#pid && result.exitCode === 0 && result.signal === null && result.launchError === null
                && result.stderrSeen === 0 && result.stderr === "" && result.truncated === false
                && typeof result.closedUtc === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.closedUtc),
            "Diagnostic process failure or incomplete capture");
            const text = result.stdout;
            need(typeof text === "string" && Number.isInteger(result.stdoutSeen) && result.stdoutSeen > 0 && result.stdoutSeen <= 4096
                && result.stdoutSeen === text.length && result.stdoutSeen === Buffer.byteLength(text, "utf8"), "Diagnostic exact byte count");
            for (let i = 0; i < text.length; i++) need(text.charCodeAt(i) <= 127, "Diagnostic success must be untouched ASCII");
            need(text.endsWith("\n") && !text.endsWith("\r\n"), "Original success LF required");
            validateFaultDiagnosticText(text, this.#binding); // Shared strict schema; no trim/BOM removal or reserialization.
            need(this.#call.result === source && this.#closed(), "Original diagnostic result changed");
            this.#bytes = Buffer.alloc(text.length); this.#allocated = this.#bytes.length;
            need(this.#bytes.write(text, "utf8") === this.#bytes.length, "Exact success reconstruction");
            this.#proof = Object.freeze({ pid: this.#pid, exitCode: 0, signal: null, launchError: null, closedUtc: result.closedUtc,
                stdoutBytes: this.#bytes.length, stderrBytes: 0, truncated: false,
                sha256: createHash("sha256").update(this.#bytes).digest("hex"), reconstruction: "complete-ascii-utf8" });
            this.#state = "ready"; return this.#proof;
        } catch (error) {
            this.#failed = true; this.#error = error; this.#state = "blocked"; throw error;
        } finally { this.#waiting = false; }
    }
    takeSuccess() {
        need(this.#state === "ready" && !this.#waiting && this.#closed(), "Diagnostic byte ownership unavailable");
        const result = Object.freeze({ bytes: this.#bytes, proof: this.#proof });
        this.#transferred = this.#bytes.length; this.#bytes = undefined; this.#state = "transferred";
        // Exactly one owner transfer. The receiving host file owner must retain and eventually clear these bytes.
        return result;
    }
    dispose() {
        if (this.#state === "disposed") return;
        need(!this.#waiting && this.#closed(), "Original diagnostic call remains unresolved");
        if (this.#bytes) { this.#bytes.fill(0); this.#cleared += this.#bytes.length; this.#bytes = undefined; }
        this.#call = undefined; this.#wait = undefined; this.#binding = undefined; this.#proof = undefined; this.#error = undefined;
        this.#state = "disposed"; // This releases only the channel, never the outer task or filesystem.
    }
}

