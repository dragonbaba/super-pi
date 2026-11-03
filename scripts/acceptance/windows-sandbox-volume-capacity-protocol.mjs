// Cold acceptance codec only. Guest claims never grant authority or prove host storage isolation.
export const CAPACITY_REPORT_BYTES = 512;
const BLOCK = 1048576, MAX_CALLS = 144, DEADLINE = 20000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function need(value, message) { if (!value) throw new Error(message); }
function taskText(taskId) {
    need(typeof taskId === "string" && UUID.test(taskId) && taskId !== "00000000-0000-0000-0000-000000000000", "Nonempty task identity required");
    return taskId.replaceAll("-", "");
}
export function initialCapacitySlot(taskId) {
    const bytes = Buffer.alloc(CAPACITY_REPORT_BYTES); bytes.write("SPCI0001", 0, "ascii"); bytes.write(taskText(taskId), 8, "ascii"); return bytes;
}
export function decodeCapacityReport(bytes, taskId) {
    need(Buffer.isBuffer(bytes) && bytes.length === CAPACITY_REPORT_BYTES, "Fixed report length required");
    need(bytes.subarray(0, 8).equals(Buffer.from("SPCF0001")) && bytes.subarray(8, 40).equals(Buffer.from(taskText(taskId))), "Final report/task mismatch");
    for (let i = 200; i < bytes.length; i++) need(bytes[i] === 0, "Reserved report bytes changed");
    const u32 = offset => bytes.readUInt32LE(offset);
    const bool = offset => { const value = u32(offset); need(value <= 1, "Noncanonical boolean"); return value === 1; };
    function call(offset, write) {
        const attempted = bool(offset), success = bool(offset + 4), error = u32(offset + 8), requested = u32(offset + 12), transferred = u32(offset + 16);
        if (!attempted) need(!success && error === 0 && requested === 0 && transferred === 0, "Unreturned call carries facts");
        else {
            need(!success || error === 0, "Successful call carries a stale error");
            need(write ? requested === BLOCK && transferred <= requested : requested === 0 && transferred === 0, "Call byte shape mismatch");
        }
        return Object.freeze({ returned: attempted, success: attempted ? success : null, errorCode: attempted && !success ? error : null,
            requestedBytes: attempted ? requested : null, transferredBytes: attempted ? transferred : null });
    }
    function exception(offset) {
        const present = bool(offset), hresult = bytes.readInt32LE(offset + 4), win32 = bool(offset + 8), native = u32(offset + 12);
        need(present || hresult === 0 && !win32 && native === 0, "Absent exception carries facts");
        need(win32 || native === 0, "Non-Win32 exception carries native error");
        return present ? Object.freeze({ hresult, nativeErrorCode: win32 ? native : null }) : null;
    }
    const phase = u32(40), stop = u32(44), attempts = u32(48), successfulCalls = u32(52), requestedBytes = u32(56), successfulBytes = u32(60), time = bytes.readBigUInt64LE(64);
    need(phase >= 1 && phase <= 3 && stop >= 1 && stop <= 7 && attempts <= MAX_CALLS && successfulCalls <= attempts, "Unknown phase/stop/count");
    need(requestedBytes === attempts * BLOCK && successfulBytes === successfulCalls * BLOCK && time <= BigInt(Number.MAX_SAFE_INTEGER), "Counter/time mismatch");
    need(u32(180) === BLOCK && u32(184) === MAX_CALLS && u32(188) === DEADLINE && bool(192), "Probe bounds/initial slot mismatch");
    const dataCreated = bool(196), lastReturnedWrite = call(72, true), flush = call(92, false), close = call(112, false);
    const operationException = exception(132), flushException = exception(148), closeException = exception(164);
    need(dataCreated === (phase !== 1), "Data creation phase mismatch");
    if (phase !== 3) need(attempts === 0 && stop === 7 && operationException !== null && !lastReturnedWrite.returned && !flush.returned, "Pre-fill phase carries fill facts");
    if (phase === 1) need(!close.returned && closeException === null, "Uncreated file was closed");
    need(attempts > 0 || !lastReturnedWrite.returned, "Write without attempt");
    need(stop !== 7 || operationException !== null, "Exception stop lacks exception");
    need(operationException === null || stop === 7, "Operation exception/stop mismatch");
    need(flushException === null || !flush.returned, "Flush both returned and threw");
    need(closeException === null || !close.returned, "Close both returned and threw");
    const diskFullWrite = phase === 3 && stop === 1 && successfulCalls > 0 && attempts === successfulCalls + 1
        && lastReturnedWrite.returned && lastReturnedWrite.success === false && [112, 39].includes(lastReturnedWrite.errorCode)
        && operationException === null && time < BigInt(DEADLINE);
    const dataFinalized = flush.success === true && close.success === true && flushException === null && closeException === null;
    return Object.freeze({ source: "guest-report", taskId, phase, stop, attempts, successfulCalls, requestedBytes, successfulBytes,
        lastLoopCheckMilliseconds: Number(time), dataCreated, lastReturnedWrite, flush, close, operationException, flushException, closeException,
        diskFullWrite, dataFinalized, qualifiedWriteCandidate: diskFullWrite && dataFinalized });
}
// Only the exact reviewed exits are decoded. Neither a crash nor an arbitrary bit pattern is a delivery state.
const MASKS = new Map([[65, 1], [66, 2], [68, 4], [69, 5], [70, 6], [72, 8], [73, 9], [74, 10], [76, 12], [77, 13], [78, 14]]);
export function decodeCapacityDelivery(exitCode) {
    let state = "unknown", write = "unknown", flush = "unknown", close = "unknown";
    if (exitCode === 0) { state = "delivered"; write = flush = close = "success"; }
    else if (MASKS.has(exitCode)) {
        const mask = MASKS.get(exitCode); state = "delivery-failed";
        write = mask & 1 ? "failed-or-unknown" : mask & 2 ? "short" : "success";
        flush = mask & 4 ? "failed-or-unknown" : "success"; close = mask & 8 ? "failed-or-unknown" : "success";
    } else if ([96, 97, 98, 99].includes(exitCode)) state = "undelivered";
    return Object.freeze({ source: "guest-report", interfaceSource: "platform-interface", exitCode: Number.isInteger(exitCode) ? exitCode : null, state,
        write, flush, close, writeErrorCode: null, flushErrorCode: null, closeErrorCode: null, deliveryComplete: state === "delivered" });
}
