import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("fixed PS7 diagnostic functions preserve unknown owners and exact bounded encoding", { timeout: 40000 }, () => {
    const workspace = fileURLToPath(new URL("..", import.meta.url));
    verifyPowerShell7();
    const result = spawnSync(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-File",
        fileURLToPath(new URL("./fixtures/windows-sandbox-volume-diagnostic-wrapper-check.ps1", import.meta.url)),
        "-SourcePath", fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-diagnostic.ps1", import.meta.url))],
    { cwd: workspace, windowsHide: true, timeout: 15000, maxBuffer: 8192 });
    const evidence = { kind: "diagnostic-wrapper-offline", pid: result.pid ?? null, status: result.status, signal: result.signal,
        error: result.error?.code ?? null, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0,
        stdoutBase64: result.stdout?.subarray(0, 2048).toString("base64") ?? "",
        stderrBase64: result.stderr?.subarray(0, 1024).toString("base64") ?? "",
        truncated: (result.stdout?.length ?? 0) > 2048 || (result.stderr?.length ?? 0) > 1024 };
    console.log(JSON.stringify(evidence));
    assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.signal, null);
    assert.equal(evidence.truncated, false); assert.equal(result.stderr.length, 0);
    const report = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout));
    assert.equal(report.encodedAllocated, report.encodedCleared);
    assert.equal(report.encodedAllocated, 3 * Buffer.byteLength('{"protocol":"synthetic-flow-only"}\n'));
    assert.deepEqual(report, { scenarios: 12, originalRuns: 7, emitAttempts: 6, holdEntries: 4, replayRejected: 1,
        encodingWrites: 3, encodingFlushes: 2, encodedAllocated: 105, encodedCleared: 105,
        nativeCalls: 0, entryExecutions: 0, diskArtifacts: 0, byteProof: "original-function-memory-stream" });
});

