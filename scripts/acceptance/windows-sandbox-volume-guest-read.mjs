// Private host receipt checks only; no file I/O, guest execution or production integration.
const FILE_ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/;
const FIELDS = "bytes,closeUnknown,closed,directoryCloseError,directoryRetained,exchangeId,fileCloseError,fileId,fileRetained,matched,opened,peak,protocol,requestedBytes,taskId,volumePath";
function need(value, message) { if (!value) throw new Error(message); }
export function validateGuestReadReceipt(value, taskId, facts) {
    need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === FIELDS, "Guest read receipt schema");
    need(value.protocol === "super-pi-volume-guest-read-v1" && value.taskId === taskId && value.volumePath === facts.volumePath
        && value.exchangeId === facts.exchangeId && value.requestedBytes === 32, "Guest read receipt association");
    need(value.fileId === null || typeof value.fileId === "string" && value.fileId.length === 25 && FILE_ID.test(value.fileId)
        && value.fileId.slice(0, 9) === facts.exchangeId.slice(0, 9), "Guest file receipt identity");
    for (const key of ["closeUnknown", "matched", "fileRetained", "directoryRetained"]) need(typeof value[key] === "boolean", "Guest read receipt flag");
    for (const key of ["opened", "closed", "peak", "bytes"]) need(Number.isSafeInteger(value[key]) && value[key] >= 0, "Guest read receipt counter");
    need(value.opened <= 2 && value.closed <= value.opened && value.peak === value.opened && value.bytes <= 32
        && (value.bytes === 0 || value.opened === 2), "Guest read receipt bounds");
    for (const key of ["fileCloseError", "directoryCloseError"]) need(value[key] === null
        || Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 0xffffffff, "Guest close error code");
    need(value.fileRetained === (value.fileCloseError !== null) && value.directoryRetained === (value.directoryCloseError !== null)
        && (!value.fileRetained || value.opened === 2) && (!value.directoryRetained || value.opened >= 1)
        && value.opened - value.closed === Number(value.fileRetained) + Number(value.directoryRetained)
        && (!value.fileRetained && !value.directoryRetained || value.closeUnknown), "Guest unresolved handle receipt");
    need(!value.matched || value.fileId !== null && value.bytes === 32 && value.opened === 2 && value.closed === 2 && !value.closeUnknown,
        "Guest match lacks complete close/read evidence");
    return Object.freeze({ ...value });
}
