// Offline-reviewed experimental glue only. No CLI entry, VHD creation or production integration.
import { SandboxLifecycle, parseRunning } from "./windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "./windows-sandbox-volume.mjs";
import { singleGuidVolumeConfig } from "./windows-sandbox-volume-config.mjs";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const UNBOUND = Object.freeze({ state: "not-started", neverDispatched: true, callsClosed: true, owner: null });
const DISPOSED = Object.freeze({ state: "unknown", neverDispatched: false, callsClosed: false, owner: null });
const CALL_KINDS = new Set(["list", "start", "stop", "exec", "connect"]);
const NEVER_STARTED_STATES = new Set(["prepared", "preflight", "closed-before-start"]);
function need(value, message) { if (!value) throw Error(message); }

export function experimentalGuidConfig(volume) {
    // A preview is data only. Starting still requires a ticket bound to the concrete VM owner.
    const binding = TaskVolumeOwner.prototype.experimentalMappingPreview.call(volume);
    return singleGuidVolumeConfig(binding.volumePath);
}

export class LiveSandboxRuntime {
    #taskId; #vm; #instanceId; #views; #unbound; #disposed = false;
    constructor(taskId) { need(UUID.test(taskId), "Task ID required"); this.#taskId = taskId; this.#unbound = Object.freeze({ ...UNBOUND, taskId }); }
    get retainsOwner() { return this.#vm !== undefined; }
    bind(vm) {
        need(!this.#disposed && this.#vm === undefined && vm instanceof SandboxLifecycle && vm.taskId === this.#taskId
            && UUID.test(vm.id) && vm.state === "prepared" && vm.startAttempted === false && vm.calls.length === 0
            && !vm.active && !vm.execution && !vm.connection, "Bind exactly one fresh VM owner");
        this.#vm = vm; this.#instanceId = vm.id;
        const common = { owner: vm, taskId: this.#taskId, instanceId: vm.id };
        this.#views = Object.freeze({
            notStarted: Object.freeze({ ...common, state: "not-started", neverDispatched: true, callsClosed: true }),
            active: Object.freeze({ ...common, state: "active", neverDispatched: false, callsClosed: false }),
            unknown: Object.freeze({ ...common, state: "unknown", neverDispatched: false, callsClosed: false }),
            closed: Object.freeze({ ...common, state: "closed", instanceAbsent: true, neverDispatched: false, callsClosed: true }),
        }); // Four views once per binding, never once per progress update.
    }
    read = () => {
        if (this.#disposed) return DISPOSED;
        const vm = this.#vm; if (!vm) return this.#unbound;
        const views = this.#views;
        if (vm.taskId !== this.#taskId || vm.id !== this.#instanceId || !Array.isArray(vm.calls) || vm.calls.length > 96) return views.unknown;
        if (vm.active || vm.execution || vm.connection) return views.active;
        let hasStart = false, hasNonList = false;
        for (const call of vm.calls) {
            if (!call || !CALL_KINDS.has(call.kind)
                || !call.result || typeof call.result.closedUtc !== "string" || typeof call.outcome !== "string" || !call.outcome.endsWith("settled")) return views.unknown;
            if (call.kind === "start") hasStart = true;
            if (call.kind !== "list") hasNonList = true;
        }
        if (vm.startAttempted === false && !hasNonList && NEVER_STARTED_STATES.has(vm.state)) return views.notStarted;
        if (vm.state !== "closed" || vm.startAttempted !== true || vm.startSettled !== true || vm.registered !== true || !hasStart) return views.unknown;
        const last = vm.calls.at(-1);
        if (last?.kind !== "list") return views.unknown;
        try { return parseRunning(last.result).has(this.#instanceId) ? views.unknown : views.closed; }
        catch { return views.unknown; }
    };
    dispose() {
        const current = this.read();
        need(current.callsClosed === true && (current.state === "closed" || current.state === "not-started"), "VM runtime still owns unresolved work");
        this.#disposed = true; this.#vm = undefined; this.#views = undefined; this.#instanceId = undefined; this.#unbound = undefined;
    }
}
