import { WINDOWS_PATH_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SharingLifetime, sessionJournal, completeSharingSession } from "../scripts/acceptance/windows-sandbox-volume-session.mjs";
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/windows-sandbox-volume-capacity-record.json", import.meta.url), "utf8"));
test("actual capacity record preserves fixed byte budgets through output, exact cleanup and reference release", WINDOWS_PATH_TEST_OPTIONS, async t => {
    const report = structuredClone(fixture.journal), root = report.artifactRoot, rootId = report.rootId;
    assert.equal(Buffer.byteLength(JSON.stringify(report, null, 2)), 7730);
    assert.equal(Buffer.byteLength(JSON.stringify({ ...report, files: fixture.manifest }, null, 2)), 8536);
    assert.equal(Buffer.byteLength(JSON.stringify({ ...report, files: fixture.manifest }) + "\n"), 6680);
    const entries = new Map(fixture.manifest.map(item => [item.name, { ...item }])), removed = [];
    const stats = (identity, bytes, directory) => {
        const [dev, ino] = identity.split(":").map(BigInt);
        return { dev, ino, size: BigInt(bytes), nlink: 1n, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
    };
    let rootExists = true, peak = 0, disposed = 0, holdCount = 0, releasedHolds = 0;
    const io = { realpathSync(file) { assert.ok(rootExists); return file; },
        lstatSync(file) { assert.ok(rootExists); if (file === root) return stats(rootId, 0, true);
            const item = entries.get(path.basename(file)); assert.ok(item); return stats(item.id, item.bytes, false); },
        readdirSync(directory) { assert.equal(directory, root); return [...entries.keys()]; },
        unlinkSync(file) { const name = path.basename(file); assert.ok(entries.delete(name)); removed.push(name); },
        rmdirSync(directory) { assert.equal(directory, root); assert.equal(entries.size, 0); rootExists = false; } };
    const bus = new EventEmitter(), stream = new EventEmitter(), writes = [], boundOwner = {};
    const task = { binding: boundOwner, vm: { calls: Array(7).fill(null) }, quiescent: () => true, cancel() {}, unsafe() {},
        dispose() { this.binding = undefined; this.vm = undefined; disposed++; } };
    const save = sessionJournal({ journal(value) {
        const bytes = Buffer.byteLength(JSON.stringify(value, null, 2)); peak = Math.max(peak, bytes);
        assert.ok(bytes <= 8192); entries.get("lifecycle.json").bytes = bytes;
    } }, report, () => task.unsafe());
    stream.write = (text, done) => { writes.push({ text, done }); return false; };
    const lifetime = new SharingLifetime({ bus, stream, report, save, task, profile: "capacity",
        timers: { setInterval() { holdCount++; return 1; }, clearInterval() { releasedHolds++; } } });
    const calls = [];
    for (const [index, kind] of ["preflight", "compile", "compile", "manager", "list", "start", "list", "exec", "list", "stop", "list"].entries()) {
        const stdout = index === 0 ? "p".repeat(280) : kind === "exec" ? "e".repeat(343) : index === 10 ? fixture.journal.lastCli.stdoutPrefix : "";
        const call = new EventEmitter(); call.pid = index === 10 ? 32480 : 30000 + index;
        call.physicallyClosed = true; call.result = { exitCode: 0, signal: null, launchError: null, stdout, stderr: "", stdoutSeen: stdout.length, stderrSeen: 0, truncated: false };
        calls.push(call); lifetime.launch(kind, () => call, { owner: task, validate: owner => owner === task });
    }
    // Restore captured host facts after constructing the bounded fake physical registry.
    Object.assign(report, structuredClone(fixture.journal));
    const completing = completeSharingSession({ report, task, lifetime, save, root, rootId, io });
    assert.equal(writes.length, 1); assert.equal(removed.length, 0); assert.equal(task.binding, boundOwner);
    assert.equal(Buffer.byteLength(writes[0].text), 6680); writes[0].done();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(removed.length, 7); assert.equal(removed.at(-1), "lifecycle.json"); assert.equal(rootExists, false);
    assert.equal(disposed, 1); assert.equal(task.binding, undefined); assert.equal(lifetime.retainsTask, true);
    assert.equal(writes.length, 2); assert.ok(Buffer.byteLength(writes[1].text) <= 512); writes[1].done();
    await completing; await new Promise(resolve => setImmediate(resolve));
    assert.equal(report.passed, true); assert.equal(report.artifactsRemoved, true); assert.equal(report.taskReferencesReleased, true);
    assert.equal(lifetime.retainsTask, false); assert.equal(lifetime.trackedCount, 0);
    assert.equal(bus.listenerCount("SIGINT"), 0); assert.equal(bus.listenerCount("SIGTERM"), 0); assert.equal(stream.listenerCount("error"), 0);
    for (const call of calls) assert.equal(call.listenerCount("settled"), 0);
    assert.equal(holdCount, releasedHolds);
    t.diagnostic(JSON.stringify({ realOperations: 0, journalPeak: peak, mainBytes: Buffer.byteLength(writes[0].text),
        footerBytes: Buffer.byteLength(writes[1].text), removedFiles: removed.length, physicalObjects: calls.length, taskReferencesReleased: true }));
});
