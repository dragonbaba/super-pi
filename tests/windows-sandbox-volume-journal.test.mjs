import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, POWERSHELL7_SHA256, POWERSHELL7_SETTINGS_SHA256, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("volume journal publishes both states with a real null backup path", PINNED_SANDBOX_TEST_OPTIONS, () => {
    verifyPowerShell7();
    const helper = fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-helper.ps1", import.meta.url));
    assert.ok(fs.statSync(helper).size <= 65536);
    const helperSha256 = createHash("sha256").update(fs.readFileSync(helper)).digest("hex");
    const fixture = fileURLToPath(new URL("./fixtures/windows-sandbox-volume-journal-check.ps1", import.meta.url));
    const parent = fs.realpathSync(fileURLToPath(new URL("../.artifacts", import.meta.url)));
    const root = fs.mkdtempSync(path.join(parent, "volume-journal-check-"));
    const identity = fs.lstatSync(root, { bigint: true });
    const allowed = new Set(["volume-helper.json", "volume-helper.next.json", "control.json", "control-next.json"]);
    let checked, files, evidence, receipt;
    try {
        checked = spawnSync(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-File", fixture,
            "-HelperPath", helper, "-HelperSha256", helperSha256, "-FixtureRoot", root],
        { windowsHide: true, timeout: 15000, maxBuffer: 16384 });
        const raw = (buffer, limit) => ({ observedBytes: buffer?.length ?? 0, capturedBytes: Math.min(buffer?.length ?? 0, limit),
            rawBase64: buffer?.subarray(0, limit).toString("base64") ?? "", truncated: (buffer?.length ?? 0) > limit });
        evidence = { observedAt: new Date().toISOString(), pid: checked.pid, status: checked.status, signal: checked.signal,
            processError: checked.error?.code ?? null, powershellSha256: POWERSHELL7_SHA256, settingsSha256: POWERSHELL7_SETTINGS_SHA256,
            helperSha256, stdout: raw(checked.stdout, 8192), stderr: raw(checked.stderr, 1024),
            parseError: null, root, rootId: { dev: String(identity.dev), ino: String(identity.ino) } };
        try {
            assert.ok(checked.stdout?.length <= 8192, "Receipt size");
            receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(checked.stdout));
            evidence.summary = { firstMoved: receipt.firstMoved, error: receipt.error, controlFailed: receipt.controlFailed,
                stdoutRecords: receipt.stdoutRecords, publishedPhase: receipt.published?.phase, nextExists: receipt.nextExists,
                controlError: receipt.controlError, controlMatched: receipt.controlMatched, controlSourceAbsent: receipt.controlSourceAbsent };
        } catch (error) { evidence.parseError = { name: error.name, message: error.message.slice(0, 256) }; }
    } finally {
        const actual = fs.lstatSync(root, { bigint: true });
        assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
        assert.ok(actual.isDirectory() && !actual.isSymbolicLink()); assert.equal(fs.realpathSync(root), root);
        assert.equal(path.dirname(root), parent);
        const names = fs.readdirSync(root); assert.ok(names.length <= 4 && names.every(name => allowed.has(name)));
        files = names.map(name => {
            const stat = fs.lstatSync(path.join(root, name), { bigint: true });
            assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.dev === identity.dev && stat.size <= 8192n);
            return { name, dev: String(stat.dev), ino: String(stat.ino), bytes: Number(stat.size) };
        });
        // Deliver the bounded evidence and registered identities before removing any diagnostic leaf.
        assert.ok(evidence, "Do not remove evidence after an unobserved invocation failure");
        const delivery = Buffer.from("# " + JSON.stringify({ ...evidence, files }) + "\n");
        assert.ok(delivery.length <= 16384);
        assert.equal(fs.writeSync(1, delivery), delivery.length, "Evidence delivery incomplete; retain files");
        for (const file of files) {
            const target = path.join(root, file.name), current = fs.lstatSync(target, { bigint: true });
            assert.equal(String(current.dev), file.dev); assert.equal(String(current.ino), file.ino);
            assert.equal(current.nlink, 1n); assert.ok(current.isFile() && !current.isSymbolicLink());
            fs.unlinkSync(target);
        }
        fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        console.log(JSON.stringify({ diagnosticCleaned: true, files: files.length, realStorageOperations: 0 }));
    }
    assert.equal(checked.error, undefined); assert.equal(checked.status, 0); assert.equal(checked.signal, null);
    assert.equal(checked.stderr.length, 0); assert.equal(evidence.parseError, null); assert.ok(evidence.stdout.observedBytes <= 8192);
    const r = receipt;
    assert.equal(r.realStorageOperations, 0); assert.equal(r.helperTopLevelExecuted, false);
    assert.equal(r.firstMoved, true); assert.equal(r.first.phase, "creating");
    assert.equal(r.controlError, null); assert.equal(r.controlMatched, true); assert.equal(r.controlSourceAbsent, true);
    assert.equal(r.error, null); assert.equal(r.controlFailed, false);
    assert.equal(r.stdoutRecords, 2); assert.equal(r.published.phase, "created"); assert.equal(r.nextExists, false);
    assert.deepEqual(r.stdout.map(line => JSON.parse(line)), [r.first, r.published]);
});
