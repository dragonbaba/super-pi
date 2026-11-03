// Explicit acceptance composition. The caller supplies the ORIGINAL host execution
// context and host task binding; candidate metadata never grants tool authority.
import { CapturedWriteBatch } from "./windows-sandbox-candidate-write-batch.mjs";
const BINDING_FIELDS = Object.freeze(["taskId", "snapshotId", "instanceId", "volumePath", "exchangeId"]);

/** One conversion and one nested file_batch call. No retries, fallback or direct I/O. */
export async function applyCapturedWrites(candidate, executionContext, expectedBinding) {
    if (!executionContext || typeof executionContext.callTool !== "function") throw new Error("Original host tool execution context required");
    // Snapshot host data before conversion; this association is not a permission.
    const binding = {};
    for (const key of BINDING_FIELDS) {
        if (typeof expectedBinding?.[key] !== "string") throw new Error("Host candidate binding required");
        binding[key] = expectedBinding[key];
    }
    const conversion = new CapturedWriteBatch();
    try {
        conversion.prepare(candidate);
        const request = conversion.take();
        for (const key of BINDING_FIELDS) if (request.binding[key] !== binding[key]) throw new Error("Candidate belongs to a different host task");
        // Agent's original nested dispatcher performs live-tool selection, schema
        // validation, native preparation, actual permission and token consumption.
        // The trusted host caller must supply that dispatcher, not a callback that
        // fabricates receipts. This helper itself establishes no authority.
        return await executionContext.callTool("file_batch", request.input);
    } finally { conversion.dispose(); }
}
