// Host-private manager receipt and guest payload are deliberately separate evidence sources.
import { decodeCapacityReport } from "./windows-sandbox-volume-capacity-protocol.mjs";
const ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/;
const FIELDS = "closeErrors,closeUnknown,closed,exchangeId,fillAllocation,fillId,fillLength,installed,opened,peak,probeId,probeSha256,protocol,readCompleted,resultBase64,retainedHandles,sentinelId,sentinelMatched,slotId,stage,taskId,volumePath";
const need = (value, message) => { if (!value) throw new Error(message); };
export function validateCapacityReceipt(value, stage, taskId, facts, probeSha256, installation) {
    need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === FIELDS, "Capacity private receipt schema");
    need(["install", "read"].includes(stage) && value.protocol === "super-pi-volume-capacity-v1" && value.stage === stage
        && value.taskId === taskId && value.volumePath === facts.volumePath && value.exchangeId === facts.exchangeId
        && value.probeSha256 === probeSha256 && /^[0-9a-f]{64}$/.test(probeSha256), "Capacity receipt association");
    for (const key of ["installed", "readCompleted", "sentinelMatched", "closeUnknown"]) need(typeof value[key] === "boolean", "Capacity receipt flags");
    for (const key of ["opened", "closed", "peak", "fillLength", "fillAllocation"]) need(Number.isSafeInteger(value[key]) && value[key] >= 0, "Capacity receipt counters");
    need(value.opened <= (stage === "install" ? 5 : 9) && value.closed <= value.opened && value.peak <= 3 && value.peak <= value.opened
        && value.fillLength <= 134217728 && value.fillAllocation <= 134217728, "Capacity receipt bounds");
    for (const key of ["probeId", "slotId", "fillId", "sentinelId"]) {
        const id = value[key], parent = key === "sentinelId" ? facts.imageId : facts.exchangeId;
        need(id === null || typeof id === "string" && id.length === 25 && ID.test(id) && id.slice(0, 9) === parent.slice(0, 9), "Capacity receipt file identity");
    }
    need(Array.isArray(value.closeErrors) && value.closeErrors.length === 9 && Array.isArray(value.retainedHandles) && value.retainedHandles.length === 9, "Fixed capacity handle slots");
    let retained = 0;
    for (let i = 0; i < 9; i++) {
        const code = value.closeErrors[i], handle = value.retainedHandles[i];
        need(code === null || Number.isInteger(code) && code >= 0 && code <= 0xffffffff, "Capacity close error shape");
        need(handle === null || typeof handle === "string" && /^[0-9A-F]{1,16}$/.test(handle) && !/^0+$/.test(handle), "Capacity retained handle shape");
        need(code === null || handle !== null, "Close failure lost its handle");
        if (handle !== null) retained++;
        if (stage === "install") need(i < 5 || code === null && handle === null, "Install carries future handle facts");
    }
    need(value.opened - value.closed === retained && (!retained || value.closeUnknown), "Capacity unresolved ownership mismatch");
    need(value.resultBase64 === null || typeof value.resultBase64 === "string" && value.resultBase64.length === 684
        && /^[A-Za-z0-9+/]{683}=$/.test(value.resultBase64) && Buffer.from(value.resultBase64, "base64").toString("base64") === value.resultBase64, "Fixed capacity report encoding");
    if (stage === "install") need(!value.readCompleted && !value.sentinelMatched && value.resultBase64 === null && value.fillId === null
        && value.fillLength === 0 && value.fillAllocation === 0, "Install claims future read");
    if (value.installed) need(value.probeId !== null && value.slotId !== null && value.sentinelId !== null && value.opened >= 5, "Install lacks fixed identities");
    if (stage === "install" && value.installed) need(value.opened === 5 && value.closed === 5 && value.peak === 3 && !value.closeUnknown, "Install handles unresolved");
    if (stage === "read") {
        need(installation?.installed === true && value.installed && installation.taskId === taskId && installation.probeSha256 === probeSha256, "Read lacks host installation");
        for (const key of ["probeId", "slotId", "sentinelId"]) need(value[key] === installation[key], "Installed identity changed during read");
        need(value.opened >= 5 && value.closed >= 5, "Read lost installation handles");
    }
    if (value.readCompleted) need(stage === "read" && value.opened === 9 && value.closed === 9 && value.peak === 3 && !value.closeUnknown
        && value.sentinelMatched && value.fillId !== null && value.resultBase64 !== null
        && value.fillLength >= 1048576 && value.fillAllocation >= value.fillLength, "Capacity read lacks complete host evidence");
    return Object.freeze({ ...value, closeErrors: Object.freeze([...value.closeErrors]), retainedHandles: Object.freeze([...value.retainedHandles]) });
}
export function capacityEvidence(receipt, delivery) {
    need(receipt?.stage === "read" && receipt.readCompleted === true, "Completed host read required");
    const bytes = Buffer.from(receipt.resultBase64, "base64"); let guest;
    try { guest = decodeCapacityReport(bytes, receipt.taskId); } finally { bytes.fill(0); }
    const metadataConsistent = receipt.fillLength >= guest.successfulBytes && receipt.fillLength <= guest.requestedBytes
        && receipt.fillAllocation >= receipt.fillLength && receipt.fillAllocation <= 134217728;
    return Object.freeze({ guest, metadataConsistent, qualified: guest.qualifiedWriteCandidate && metadataConsistent
        && delivery?.source === "guest-report" && delivery.interfaceSource === "platform-interface"
        && delivery.exitCode === 0 && delivery.state === "delivered" && delivery.deliveryComplete === true });
    // Still requires the host's bound volume, VM/CLI absence, unchanged sentinel and complete task cleanup before acceptance.
}
