import assert from "node:assert/strict";
import test from "node:test";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { SessionSandbox, type SandboxBackend } from "../packages/coding-agent/src/core/sandbox/session-sandbox.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";

for (const refusal of ["none", "powershell", "file_batch"] as const) {
    test(`CodeMode sandbox uses original sibling dispatch and releases owners: ${refusal}`, async () => {
        const boundary = new SessionExecutionBoundary(), abort = new AbortController(), events = createEventBus();
        const runtime: any = { executionBoundary: boundary, assertActive() {},
            trackEventBusSubscription(unsubscribe: () => void) { return unsubscribe; }, appendEntry() {} };
        const files = runtime.nativeFiles = new SessionFiles(runtime, events);
        const ctx: any = { cwd: "D:\\RMProjects\\Pi", signal: abort.signal, sessionManager: { getSessionId: () => "codemode-sandbox" } };
        let launches = 0, finishes = 0;
        const backend: SandboxBackend = async borrow => {
            borrow.assertInputsCurrent(); launches++;
            return { result: { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false,
                stderrTruncated: false, stdoutSeen: 2, stderrSeen: 0, elapsedMs: 1 },
                input: { operations: [{ operation: "write", path: "new.txt", content: "ok" }] },
                async finish() { finishes++; }, diagnostics: { released: true } };
        };
        const owner = new SessionSandbox(() => runtime, "D:\\sandbox-fixture", backend);
        const codemode = new CodemodeController(() => {}); codemode.setCommandSandbox(owner);
        const definitions: any[] = [owner.definition(), { name: "file_batch", label: "batch", description: "test batch",
            parameters: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "written" }], isError: false }) }];
        const tools = definitions.map(definition => wrapToolDefinition(definition, () => ctx));
        const calls: string[] = [];
        const dispatch = new NestedToolDispatch("sandbox-parent", () => tools, async (call, tool, signal) => {
            calls.push(call.name);
            const blocked = call.name === refusal;
            const result = blocked ? { content: [{ type: "text" as const, text: "explicit refusal" }], isError: true }
                : await tool!.execute(call.id, structuredClone(call.arguments), signal);
            return { ...result, role: "toolResult", toolCallId: call.id, toolName: call.name,
                isError: result.isError === true, timestamp: 1, executionStatus: blocked ? "not_executed" : undefined };
        }, abort.signal);
        codemode.setTools(tools);
        try {
            await assert.rejects(owner.definition().execute("forged", { command: "x" }, abort.signal, undefined, ctx), /original CodeMode/i);
            const result = await codemode.definition.execute("sandbox-parent", { code:
                "const r=await tools.powershell({command:'Write-Output ok',writes:[{path:'new.txt',operation:'add',snapshot:null}]}); text(r);" },
                abort.signal, undefined, ctx, dispatch);
            assert.equal(result.isError, refusal !== "none");
            assert.deepEqual(calls, refusal === "powershell" ? ["powershell"] : ["powershell", "file_batch"]);
            assert.equal(launches, refusal === "powershell" ? 0 : 1); assert.equal(finishes, launches);
            assert.equal(owner.diagnostics.active, false); assert.equal(owner.diagnostics.pending, false);
            assert.equal(owner.diagnostics.retained, false);
        } finally { await codemode.close(); await dispatch.close(); await files.dispose(); await boundary.dispose(); events.clear(); }
    });
}
