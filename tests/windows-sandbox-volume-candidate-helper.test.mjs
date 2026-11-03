import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { CapturedCandidateOwner } from "../scripts/acceptance/windows-sandbox-volume-candidate-contract.mjs";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("candidate helper commands preserve receipts, failures and bounded handle responsibility", { timeout: 40000, ...PINNED_SANDBOX_TEST_OPTIONS }, t => {
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "volume-candidate-helper-check-" + randomUUID()); fs.mkdirSync(root);
    const identity = fs.lstatSync(root, { bigint: true }), assembly = path.join(root, "candidate-helper-check.dll");
    const runs = []; let closed = true;
    t.after(() => {
        let files = null, inspectionError;
        if (closed) {
            try {
                const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
                assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
                const names = fs.readdirSync(root); assert.ok(names.length <= 1 && names.every(name => name === "candidate-helper-check.dll"));
                files = names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
                    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.ok(stat.size <= 131072n);
                    return { file, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }; });
            } catch (error) { inspectionError = error; }
        }
        const evidence = Buffer.from(JSON.stringify({ kind: "candidate-helper-offline-evidence", root, identity: { dev: String(identity.dev), ino: String(identity.ino) },
            processesClosed: closed, inspectionError: inspectionError ? String(inspectionError.message).slice(0, 256) : null, files, runs }) + "\n");
        assert.ok(evidence.length <= 16384);
        for (let offset = 0; offset < evidence.length;) { const n = fs.writeSync(1, evidence, offset, evidence.length - offset); assert.ok(n > 0); offset += n; }
        assert.equal(closed, true, "Unclosed check process; retain recorded root"); if (inspectionError) throw inspectionError;
        let removed = 0;
        try {
            for (const item of files) { const stat = fs.lstatSync(item.file, { bigint: true });
                assert.equal(String(stat.dev), item.dev); assert.equal(String(stat.ino), item.ino); assert.equal(String(stat.size), item.size);
                assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.equal(fs.realpathSync(item.file), item.file);
                fs.unlinkSync(item.file); removed++; }
            const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
            assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root);
            fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        } catch (error) {
            fs.writeSync(1, JSON.stringify({ kind: "candidate-helper-offline-cleanup", rootRemoved: false, retained: true, filesRemoved: removed, error: String(error.message).slice(0, 128) }) + "\n");
            throw error;
        }
        fs.writeSync(1, JSON.stringify({ kind: "candidate-helper-offline-cleanup", rootRemoved: true, filesRemoved: removed }) + "\n");
    });
    function run(role, executable, args) {
        const record = { role, requestedUtc: new Date().toISOString(), phase: "requested-unknown", pid: null, status: null, signal: null,
            error: null, exception: null, stdoutBytes: null, stderrBytes: null, stdoutBase64: null, stderrBase64: null, truncated: null };
        runs.push(record); closed = false;
        let result;
        try { result = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 8192 }); }
        catch (error) {
            record.phase = "call-threw-unknown"; record.error = String(error.code ?? error.name).slice(0, 64);
            record.exception = String(error.message).slice(0, 256); throw error;
        }
        closed = Number.isInteger(result.status) || typeof result.signal === "string";
        Object.assign(record, { phase: closed ? "closed" : "unresolved", pid: result.pid ?? null, status: result.status, signal: result.signal,
            error: result.error?.code ?? null, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0,
            stdoutBase64: result.stdout?.subarray(0, 8192).toString("base64") ?? "", stderrBase64: result.stderr?.subarray(0, 1024).toString("base64") ?? "",
            truncated: (result.stdout?.length ?? 0) > 8192 || (result.stderr?.length ?? 0) > 1024 });
        assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.signal, null);
        assert.equal(result.stderr.length, 0); assert.ok(result.stdout.length <= 8192); return result.stdout;
    }
    verifyPowerShell7();
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    run("compile", compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-native.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-candidate-manifest.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-candidate-batch.cs"),
        path.join(workspace, "tests/fixtures/windows-sandbox-volume-candidate-helper-check.cs")]);
    assert.ok(fs.statSync(assembly).size <= 131072);
    const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
    const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "AABBCCDD:0000000000000001";
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const samples = [0, 1, 16].map(count => {
        const allowed = Array.from({ length: count }, (_, i) => ({ path: "p" + i + ".txt", operation: "add", revision: null }));
        const raw = Buffer.from(JSON.stringify({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
            candidates: allowed.map(({ path, operation }) => ({ path, operation })), report: { exitCode: 23 } }));
        const payload = Buffer.from(Array.from({ length: count }, (_, i) => i)), manifestSha = hash(raw);
        const request = Buffer.from(JSON.stringify({ protocol: "super-pi-candidate-read-request-v1", taskId, manifestSha256: manifestSha,
            paths: allowed.map(item => item.path) }));
        const wire = { count, manifestBytes: raw.length, manifestSha, requestSha: hash(request), payloadSha: hash(payload) };
        request.fill(0); return { wire, allowed, raw, payload };
    });
    try {
        const output = run("pure-helper-check", POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-File",
            path.join(workspace, "tests/fixtures/windows-sandbox-volume-candidate-helper-check.ps1"),
            "-HelperPath", path.join(workspace, "scripts/acceptance/windows-sandbox-volume-helper.ps1"),
            "-NativeAssembly", assembly, "-SamplesBase64", Buffer.from(JSON.stringify(samples.map(s => s.wire))).toString("base64")]);
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output).replace(/^\uFEFF/, ""));
        assert.equal(result.cases, 29); assert.equal(result.guardCalls, 16);
        assert.equal(result.nativeAdapterCalls, 0); assert.equal(result.helperMainExecuted, false);
        assert.ok(result.maximumSuccessReceipt > 2000 && result.maximumSuccessReceipt <= 4096);
        assert.ok(result.worstErrorBytes > 2000 && result.worstErrorBytes <= 4096);
        assert.ok(result.maximumDiagnostic > 0 && result.maximumDiagnostic <= 1024);
        assert.equal(result.results.length, 3);
        for (const row of result.results) {
            const s = samples.find(s => s.wire.count === row.count);
            assert.ok(s); const owner = new CapturedCandidateOwner({ taskId, snapshotId,
                instanceId: "33333333-4444-5555-6666-777777777777", volumePath, exchangeId,
                budget: { ...CANDIDATE_LIMITS }, allowed: s.allowed });
            try {
                owner.acceptManifest(s.raw, Buffer.from(row.manifest), "11223344:0000000000000001");
                const request = owner.copyRequestBytes();
                try { assert.equal(hash(request), s.wire.requestSha); } finally { request.fill(0); }
                owner.acceptBatch(s.payload, Buffer.from(row.batch), "11223344:0000000000000002");
                assert.equal(owner.status, "candidate-data-checked"); assert.equal(owner.records.length, row.count);
                assert.equal(owner.guestReport.exitCode, 23);
                for (let i = 0; i < row.count; i++) {
                    const bytes = owner.copyBytes(i);
                    try { assert.deepEqual(bytes, Buffer.from([i])); } finally { bytes.fill(0); }
                }
            } finally { owner.dispose(); }
            assert.equal(owner.diagnostics.retainedContext, false);
            assert.equal(owner.diagnostics.retainedPayloadBytes, 0);
            assert.equal(owner.diagnostics.retainedRequestBytes, 0);
        }
    } finally { for (const s of samples) { s.raw.fill(0); s.payload.fill(0); } }
});
