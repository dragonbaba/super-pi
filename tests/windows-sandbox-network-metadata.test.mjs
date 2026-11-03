import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { validateInterfaceMetadata } from "../scripts/acceptance/windows-sandbox-network-metadata.mjs";
import { sha256 } from "../scripts/acceptance/windows-sandbox-package.mjs";

function receipt() { return { protocol: "super-pi-wsb-network-metadata-v1", taskId: "fixture", pid: 123, errorType: "InvalidOperationException", hresult: -2146233079, nativeErrorCode: null,
    trace: { stage: "type", reason: "unknown-interface-kind-or-state", count: 2, index: 0, type: 999, status: null, unicastCount: null, gatewayCount: null, completedCount: 0, complete: false } }; }
test("metadata retains rejected values, distinguishes unobserved fields and rejects fabricated completion", () => {
    assert.equal(validateInterfaceMetadata(receipt(), "fixture", 123).trace.type, 999);
    const over = receipt(); Object.assign(over.trace, { stage: "count", reason: "interface-count-bound", count: 33, index: null, type: null });
    assert.equal(validateInterfaceMetadata(over, "fixture", 123).trace.count, 33);
    for (const mutate of [r => r.pid++, r => r.taskId = "other", r => r.trace.complete = true, r => r.trace.index = 32,
        r => r.trace.reason = "arbitrary", r => r.trace.stage = "DNS", r => r.trace.count = -1, r => r.trace.extra = "address", r => r.errorType = "message with data", r => r.hresult = null,
        r => r.trace.stage = "enumerate", r => r.trace.reason = "interface-count-bound", r => r.trace.completedCount = 1]) {
        const r = receipt(); mutate(r); assert.throws(() => validateInterfaceMetadata(r, "fixture", 123));
    }
});
test("native metadata fixtures exercise shared rejection and stop-reading behavior without system enumeration", { skip: process.platform !== "win32" }, t => {
    const repository = fileURLToPath(new URL("../", import.meta.url)), compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(sha256(compiler), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    const parent = fs.realpathSync(path.join(repository, ".artifacts")), root = path.join(parent, "wsb-network-metadata-check-" + randomUUID());
    fs.mkdirSync(root); const identity = fs.lstatSync(root, { bigint: true }), executable = path.join(root, "check.exe"); let binary;
    try {
        const sources = ["scripts/acceptance/windows-sandbox-network.cs", "scripts/acceptance/windows-sandbox-network-metadata.cs", "tests/fixtures/windows-sandbox-network-metadata-check.cs"].map(file => path.join(repository, file));
        const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/main:NetworkMetadataChecks", "/out:" + executable, ...sources],
            { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 });
        if (fs.existsSync(executable)) binary = fs.lstatSync(executable, { bigint: true });
        assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
        const checked = spawnSync(executable, [], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 });
        assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        const r = JSON.parse(checked.stdout); assert.equal(r.passed, true); t.diagnostic(JSON.stringify({ root, compilerPid: compiled.pid, checkPid: checked.pid, ...r }));
    } finally {
        const actual = fs.lstatSync(root, { bigint: true }); assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
        assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
        if (binary) { const current = fs.lstatSync(executable, { bigint: true }); assert.ok(current.isFile() && !current.isSymbolicLink() && current.dev === binary.dev && current.ino === binary.ino); fs.unlinkSync(executable); }
        fs.rmdirSync(root); assert.equal(fs.existsSync(root), false); t.diagnostic("Owned metadata fixture artifacts removed.");
    }
});
