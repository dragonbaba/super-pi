// Controlled event source through the production print-mode sender; no model/network access.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { runPrintMode } from "../../packages/coding-agent/src/modes/print-mode.ts";
import { parseArgs } from "../../packages/coding-agent/src/cli/args.ts";

const parsed = parseArgs(process.argv.slice(2)), task = process.argv.at(-1) ?? "";
writeFileSync(join(process.cwd(), `stream-${process.pid}.json`), JSON.stringify({ pid: process.pid, started: new Date().toISOString(), tmpdir: tmpdir(), task }));
if (process.env.SP_SUBAGENT_CONTROL === "1") {
    const ready = once(process, "message");
    process.send(JSON.stringify({ id: 1, kind: "ready" }));
    const [raw] = await ready; if (!JSON.parse(raw).ok) throw new Error("Fixture control handshake failed");
}
let listener, backpressure, filter;
const assistant = { role: "assistant", content: [{ type: "text", text: "FINAL_REPORT" }], api: "test", provider: "test", model: "fixture",
    stopReason: task.includes("stderr") ? "error" : "stop", timestamp: 0,
    errorMessage: task.includes("explicit") ? "EXPLICIT_FAILURE" : undefined,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } } };
async function emit(event) {
    listener?.(event);
    if (!filter || filter(event)) await backpressure?.(event);
}
const session = {
    state: { messages: [assistant] }, sessionManager: { getHeader() { return { type: "session", id: "fixture" }; } },
    agent: { subscribe(callback, options) { backpressure = callback; filter = options?.filter; return () => { backpressure = undefined; }; } },
    bindExtensions() {}, subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    async prompt() {
        await emit({ type: "agent_start" }); await emit({ type: "turn_start" });
        const messages = [];
        const count = task.includes("long") ? 163 : task.includes("oversize") ? 1 : 0;
        for (let index = 0; index < count; index++) {
            const content = [{ type: "text", text: "x".repeat(task.includes("oversize") ? 8 * 1024 * 1024 : 50 * 1024) }];
            const message = { role: "toolResult", toolCallId: String(index), toolName: "read", content, isError: false, timestamp: 0 };
            messages.push(message);
            await emit({ type: "tool_execution_start", toolCallId: String(index), toolName: "read", args: {} });
            await emit({ type: "tool_execution_end", toolCallId: String(index), toolName: "read", result: { content }, isError: false });
            await emit({ type: "message_start", message }); await emit({ type: "message_end", message });
        }
        await emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: "unused", partial: assistant } });
        await emit({ type: "message_end", message: assistant });
        await emit({ type: "turn_end", message: assistant, toolResults: messages });
        await emit({ type: "agent_end", messages: [...messages, assistant], willRetry: false });
        await emit({ type: "agent_settled", aborted: false });
        if (task.includes("stderr")) {
            const bytes = Buffer.from(task.includes("short") ? "short failure" : "PREFIX\n" + "日志🙂".repeat(12000) + "\n尾部🙂FINAL_ERROR_MARKER\n");
            const offsets = task.includes("short") ? [0, bytes.length] : [0, bytes.length - 30, bytes.length - 23, bytes.length - 21, bytes.length];
            for (let index = 1; index < offsets.length; index++) {
                if (!process.stderr.write(bytes.subarray(offsets[index - 1], offsets[index]))) await once(process.stderr, "drain");
                await tick();
            }
        }
    },
};
try {
    const code = await runPrintMode({ session, setRebindSession() {}, async dispose() {} },
        { mode: parsed.mode ?? "json", subagentStream: parsed.subagentStream, initialMessage: "fixture" });
    process.exitCode = code || (task.includes("stderr") ? 1 : 0);
} finally { if (process.connected) process.disconnect(); }
