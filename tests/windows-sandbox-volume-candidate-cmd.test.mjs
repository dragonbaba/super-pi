import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { candidateCommandBody, CANDIDATE_CMD_PATH, CANDIDATE_CMD_PREFIX, CANDIDATE_TEXT } from "../scripts/acceptance/windows-sandbox-volume-candidate-session.mjs";
import { nativePrivateIdentity } from "../scripts/acceptance/windows-sandbox-volume-candidate-private.mjs";
import { CANDIDATE_PROTOCOL, parseCandidateManifest, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
const CMD_SHA256 = "15cd209c995b7d3009c91ca40892d5b8f1fb162f3e5f10716642ea278e8e0d7b";
const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
const hash = value => createHash("sha256").update(value).digest("hex");

test("fixed CMD canonical writer has exact bytes and two failure controls in owned directories", { timeout: 40000 }, t => {
    assert.equal(process.platform, "win32"); assert.equal(process.version, "v26.13.0");
    assert.equal(hash(fs.readFileSync(CANDIDATE_CMD_PATH)), CMD_SHA256);
    const parent = fileURLToPath(new URL("../.artifacts", import.meta.url));
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "candidate-cmd-" + randomUUID()), directories = new Map(), files = new Map(), handles = [], runs = [];
    let created = false, processesClosed = true, factsComplete = true;
    const cases = ["normal", "prior-failure", "redirect-failure"];
    const directoryNames = ["", ...cases, "normal/payload", "redirect-failure/payload", "redirect-failure/candidates.json"];
    const fileNames = ["normal/payload/a.txt", "normal/candidates.json", "prior-failure/payload", "redirect-failure/payload/a.txt"];
    const description = error => ({ type: typeof error, name: error?.name ?? null, code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 128) });
    function target(name) {
        assert.ok(directoryNames.includes(name) || fileNames.includes(name));
        const file = name ? path.join(root, ...name.split("/")) : root;
        assert.ok(file === root || file.startsWith(root + path.sep)); assert.equal(path.resolve(file), file); return file;
    }
    function emit(value, maximum) {
        const bytes = Buffer.from(JSON.stringify(value) + "\n"); assert.ok(bytes.length <= maximum);
        try { for (let offset = 0; offset < bytes.length;) {
            const written = fs.writeSync(1, bytes, offset, bytes.length - offset); assert.ok(written > 0); offset += written;
        } } finally { bytes.fill(0); }
    }
    function observeDirectory(name, make = false) {
        const file = target(name); if (make) fs.mkdirSync(file);
        const stat = fs.lstatSync(file, { bigint: true });
        assert.equal(stat.isDirectory(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(fs.realpathSync(file), file);
        const id = nativePrivateIdentity(stat), previous = directories.get(name);
        if (previous) assert.equal(id, previous.id); else directories.set(name, { name, id }); return file;
    }
    function checkParents(name) {
        observeDirectory(""); const parts = name.split("/"); parts.pop();
        for (let i = 1; i <= parts.length; i++) observeDirectory(parts.slice(0, i).join("/"));
    }
    function observeFile(name) {
        checkParents(name); const file = target(name), stat = fs.lstatSync(file, { bigint: true });
        assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n);
        assert.equal(fs.realpathSync(file), file); assert.ok(stat.size >= 0n && stat.size <= (name.endsWith(".json") ? 4096n : 64n));
        const id = nativePrivateIdentity(stat), previous = files.get(name);
        if (previous) { assert.equal(id, previous.id); assert.equal(Number(stat.size), previous.bytes); }
        else files.set(name, { name, id, bytes: Number(stat.size), sha256: null, rawBase64: null, rawTruncated: null });
        return stat;
    }
    function fileIo(name, data) {
        checkParents(name); const file = target(name), record = { name, mode: data ? "write" : "read", fd: null, opened: false, closed: false,
            closeAttempts: 0, operationFailed: false, operationError: null, closeFailed: false, closeError: null };
        handles.push(record); let bytes, failed = false, failure, closeFailed = false, closeFailure;
        try {
            const before = data ? null : observeFile(name);
            record.fd = fs.openSync(file, data ? "wx" : "r", 0o600); record.opened = true;
            const opened = fs.fstatSync(record.fd, { bigint: true });
            assert.equal(opened.isFile(), true); assert.equal(opened.nlink, 1n);
            if (data) {
                assert.equal(opened.size, 0n); assert.equal(fs.writeSync(record.fd, data, 0, data.length, 0), data.length); fs.fsyncSync(record.fd);
            } else {
                assert.equal(nativePrivateIdentity(opened), nativePrivateIdentity(before)); assert.equal(opened.size, before.size);
                bytes = Buffer.alloc(Number(opened.size)); assert.equal(fs.readSync(record.fd, bytes, 0, bytes.length, 0), bytes.length);
                const after = fs.fstatSync(record.fd, { bigint: true });
                assert.equal(nativePrivateIdentity(after), nativePrivateIdentity(opened)); assert.equal(after.size, opened.size);
                assert.equal(after.mtimeNs, opened.mtimeNs); assert.equal(after.ctimeNs, opened.ctimeNs);
            }
        } catch (error) { failed = true; failure = error; record.operationFailed = true; record.operationError = description(error); }
        finally {
            if (record.opened) {
                record.closeAttempts = 1;
                try { fs.closeSync(record.fd); record.closed = true; }
                catch (error) { closeFailed = true; closeFailure = error; record.closeFailed = true; record.closeError = description(error); }
            }
        }
        if (failed || closeFailed) {
            factsComplete = false; bytes?.fill(0);
            if (failed && closeFailed) throw new AggregateError([failure, closeFailure], "CMD fixture file operation and close failed");
            throw failed ? failure : closeFailure;
        }
        try {
            observeFile(name);
            if (bytes) {
                const entry = files.get(name); entry.sha256 = hash(bytes); entry.rawBase64 = bytes.subarray(0, 512).toString("base64");
                entry.rawTruncated = bytes.length > 512; if (entry.rawTruncated) factsComplete = false;
            }
            return bytes;
        } catch (error) {
            factsComplete = false; bytes?.fill(0); record.operationFailed = true; record.operationError = description(error); throw error;
        }
    }
    function inspectTree() {
        for (const name of directoryNames) {
            const file = target(name); let stat;
            try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
            if (!stat.isDirectory()) throw Error("Unexpected directory type: " + name);
            observeDirectory(name);
            const expected = new Set([...directoryNames, ...fileNames].filter(child => child && path.posix.dirname(child) === (name || "."))
                .map(child => path.posix.basename(child)));
            for (const child of fs.readdirSync(file)) assert.ok(expected.has(child), "Unexpected child: " + name + "/" + child);
        }
        for (const name of fileNames) {
            try { fs.lstatSync(target(name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
            observeFile(name);
        }
    }
    t.after(() => {
        if (!created) return;
        let inspectionError = null;
        try { inspectTree(); } catch (error) { inspectionError = description(error); }
        if (inspectionError || [...files.values()].some(file => file.sha256 === null || file.rawTruncated !== false)) factsComplete = false;
        emit({ kind: "candidate-cmd-evidence", root, nodePid: process.pid, cmdSha256: CMD_SHA256, processesClosed, factsComplete,
            directories: [...directories.values()], files: [...files.values()], handles, runs, inspectionError }, 15360);
        assert.equal(processesClosed, true); assert.equal(factsComplete, true); assert.equal(inspectionError, null);
        for (const record of handles) assert.ok(!record.opened || record.closed, "Unknown Node fd; preserve root");
        let removedFiles = 0, removedDirectories = 0;
        try {
            for (const name of fileNames) if (files.has(name)) { observeFile(name); fs.unlinkSync(target(name)); removedFiles++; }
            for (const name of ["normal/payload", "redirect-failure/payload", "redirect-failure/candidates.json",
                "normal", "prior-failure", "redirect-failure", ""]) if (directories.has(name)) {
                observeDirectory(name); assert.equal(fs.readdirSync(target(name)).length, 0); fs.rmdirSync(target(name)); removedDirectories++;
            }
            assert.equal(fs.existsSync(root), false);
        } catch (error) { emit({ kind: "candidate-cmd-cleanup", rootRemoved: false, removedFiles, removedDirectories, error: description(error) }, 512); throw error; }
        emit({ kind: "candidate-cmd-cleanup", rootRemoved: true, removedFiles, removedDirectories }, 512);
    });
    fs.mkdirSync(root); created = true; observeDirectory("");
    emit({ kind: "candidate-cmd-start", root, id: directories.get("").id, nodePid: process.pid }, 512);
    for (const name of cases) observeDirectory(name, true);
    const sentinel = Buffer.from("Z");
    try { fileIo("prior-failure/payload", sentinel); } finally { sentinel.fill(0); }
    observeDirectory("redirect-failure/candidates.json", true);
    const body = candidateCommandBody(taskId, snapshotId);
    const expectedManifest = Buffer.from(JSON.stringify({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
        candidates: [{ path: "a.txt", operation: "add" }], report: { exitCode: 23 } }));
    try {
        assert.ok(expectedManifest.length <= 512);
        for (const name of cases) {
            const cwd = observeDirectory(name); assert.equal(hash(fs.readFileSync(CANDIDATE_CMD_PATH)), CMD_SHA256);
            const record = { case: name, requestedUtc: new Date().toISOString(), pid: null, status: null, signal: null, error: null,
                stdoutBytes: null, stderrBytes: null, stdoutBase64: null, stderrBase64: null, truncated: null, captureBytes: 1024 };
            runs.push(record); processesClosed = false; let result;
            try { result = spawnSync(CANDIDATE_CMD_PATH, [...CANDIDATE_CMD_PREFIX, body],
                { cwd, windowsHide: true, windowsVerbatimArguments: true, timeout: 10000, maxBuffer: 1024 }); }
            catch (error) { record.error = description(error); throw error; }
            processesClosed = Number.isInteger(result.status) || typeof result.signal === "string";
            const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0), stdoutCount = Math.min(stdout.length, 1024);
            const stderrCount = Math.min(stderr.length, 1024 - stdoutCount);
            Object.assign(record, { pid: result.pid ?? null, status: result.status, signal: result.signal, error: result.error ? description(result.error) : null,
                stdoutBytes: stdout.length, stderrBytes: stderr.length, stdoutBase64: stdout.subarray(0, stdoutCount).toString("base64"),
                stderrBase64: stderr.subarray(0, stderrCount).toString("base64"), truncated: stdout.length + stderr.length > 1024 });
            if (record.truncated || result.error) factsComplete = false;
            assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(record.truncated, false);
            observeDirectory(name);
            if (name === "normal") {
                assert.equal(result.status, 0); observeDirectory("normal/payload");
                let payload, manifest;
                try {
                    payload = fileIo("normal/payload/a.txt"); manifest = fileIo("normal/candidates.json");
                    assert.deepEqual(payload, Buffer.from(CANDIDATE_TEXT)); assert.deepEqual(manifest, expectedManifest);
                    const value = parseCandidateManifest(manifest, { taskId, snapshotId, budget: CANDIDATE_LIMITS,
                        allowed: [{ path: "a.txt", operation: "add", revision: null }] });
                    assert.equal(value.report.exitCode, 23);
                } finally { payload?.fill(0); manifest?.fill(0); }
            } else if (name === "prior-failure") {
                assert.notEqual(result.status, 0); assert.equal(fs.existsSync(target("prior-failure") + "\\candidates.json"), false);
                const bytes = fileIo("prior-failure/payload"); try { assert.equal(bytes.toString(), "Z"); } finally { bytes.fill(0); }
            } else {
                assert.notEqual(result.status, 0); observeDirectory("redirect-failure/candidates.json"); observeDirectory("redirect-failure/payload");
                const payload = fileIo("redirect-failure/payload/a.txt");
                try { assert.deepEqual(payload, Buffer.from(CANDIDATE_TEXT)); } finally { payload.fill(0); }
            }
        }
        assert.equal(runs.length, 3); assert.equal(files.size, 4); assert.equal(directories.size, 7);
    } finally { expectedManifest.fill(0); }
});
