import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { win32 as path } from "node:path";
import { INPUT_LIMITS, OfflineInputSnapshotOwner } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";

const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const objectId = ino => ({ dev: 7n, ino: BigInt(ino) });
function entry(name, bytes, index, expose = true, operation = "modify") {
    const parts = name.split("/"), parents = [];
    for (let i = 1; i < parts.length; i++) parents.push({ path: parts.slice(0, i).join("/"), identity: objectId(100 + i) });
    return { path: name, expose, operation, classification: "ordinary", parents,
        revision: operation === "add" ? null : "snap_" + String(index).padStart(22, "0"),
        identity: operation === "add" ? null : { ...objectId(index + 10), size: BigInt(bytes.length), mtimeNs: 20n, ctimeNs: 30n },
        sha256: operation === "add" ? null : digest(bytes) };
}
function fixture(spec = [
    ["read.txt", "alpha", true, null], ["hidden.txt", "private", false, "modify"],
    ["new.txt", "", false, "add"], ["sub/modify.txt", "beta", true, "modify"],
]) {
    const data = spec.map(row => Buffer.isBuffer(row[1]) ? row[1] : Buffer.from(row[1]));
    const context = { taskId, snapshotId, epoch: 3, sessionId: "session_1",
        sourceRoot: { path: "D:\\synthetic-input", identity: objectId(1) }, budget: { ...INPUT_LIMITS },
        entries: spec.map((row, i) => entry(row[0], data[i], i, row[2], row[3])) };
    const parentIds = new Map();
    for (const item of context.entries) for (const parent of item.parents) {
        if (!parentIds.has(parent.path)) parentIds.set(parent.path, objectId(100 + parentIds.size));
        parent.identity = structuredClone(parentIds.get(parent.path));
    }
    const original = structuredClone(context), files = new Map(), directories = new Map(), receipts = new Map(), pinned = new Map();
    const calls = [], handles = new Map(), borrowed = [], state = { live: true, epoch: 3, taskId, snapshotId, sessionId: "session_1" };
    directories.set("", { canonicalPath: original.sourceRoot.path, identity: objectId(1), kind: "directory", reparseTag: 0 });
    for (let i = 0; i < original.entries.length; i++) {
        const item = original.entries[i];
        for (const parent of item.parents) directories.set(parent.path, { canonicalPath: path.join(original.sourceRoot.path, parent.path),
            identity: structuredClone(parent.identity), kind: "directory", reparseTag: 0 });
        if (item.operation === "add") continue;
        files.set(item.path, { bytes: Buffer.from(data[i]), canonicalPath: path.join(original.sourceRoot.path, item.path),
            identity: structuredClone(item.identity), kind: "file", nlink: 1, reparseTag: 0 });
        // The model's pin represents the original receipt object already owned by FileRevisions.
        const receipt = { id: item.revision, sessionId: original.sessionId, identity: structuredClone(item.identity),
            canonicalPath: path.join(original.sourceRoot.path, item.path), sha256: item.sha256 };
        receipts.set(item.revision, receipt); pinned.set(item.revision, receipt);
    }
    const hooks = {}, counts = {}, io = {
        current(binding) { return state.live && state.epoch === binding.epoch && state.sessionId === binding.sessionId
            && state.taskId === binding.taskId && state.snapshotId === binding.snapshotId
            && binding.sourceRoot.path === original.sourceRoot.path
            && binding.sourceRoot.identity.dev === original.sourceRoot.identity.dev
            && binding.sourceRoot.identity.ino === original.sourceRoot.identity.ino; },
        revision(item, binding) {
            const receipt = receipts.get(item.revision);
            if (!receipt || receipt !== pinned.get(item.revision) || receipt.sessionId !== binding.sessionId
                || receipt.canonicalPath !== path.join(binding.sourceRoot.path, item.path) || receipt.sha256 !== item.sha256) return false;
            return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => receipt.identity[key] === item.identity[key]);
        },
        directory(name) { return structuredClone(directories.get(name)); },
        file(name) {
            const found = files.get(name); if (!found) return null;
            const { bytes, ...observation } = found; return structuredClone(observation);
        },
        open(name) { const token = Object.freeze({ fd: counts.open, path: name }); handles.set(token, files.get(name)); return token; },
        read(token, output, offset, length) {
            if (!borrowed.includes(output)) borrowed.push(output);
            const source = handles.get(token).bytes, count = Math.min(length, source.length - offset, 2);
            if (count > 0) output.set(source.subarray(offset, offset + count), offset);
            return count;
        },
        stat(token) { const { bytes, ...observation } = handles.get(token); return structuredClone(observation); },
        close(token) { assert.ok(handles.has(token)); handles.delete(token); return true; },
    };
    for (const name of Object.keys(io)) {
        const originalMethod = io[name];
        io[name] = function (...args) {
            calls.push({ name, path: typeof args[0] === "string" ? args[0] : args[0]?.path });
            counts[name] = (counts[name] ?? 0) + 1;
            return hooks[name] ? hooks[name](originalMethod, args, counts[name]) : originalMethod(...args);
        };
    }
    return { context, original, files, directories, receipts, pinned, state, io, hooks, calls, counts, handles, borrowed,
        owner() { return new OfflineInputSnapshotOwner(context, io); } };
}
function released(owner, f) {
    const d = owner.diagnostics;
    assert.equal(d.retainedBytes, 0); assert.equal(d.retainedBuffers, 0); assert.equal(d.retainedRecords, 0);
    assert.equal(d.retainedIO, false); assert.equal(d.retainedContext, false); assert.equal(d.activeHandles, 0);
    assert.equal(d.allocatedBytes, d.clearedBytes); assert.equal(f.handles.size, 0);
    for (const bytes of f.borrowed) assert.ok(bytes.every(value => value === 0));
    assert.throws(() => owner.copyFile(0)); assert.throws(() => owner.records);
}

test("input 1: explicit exposure is independent of add/modify and private copies have fixed ownership", t => {
    const f = fixture(), owner = f.owner();
    f.context.entries[0].path = "replaced.txt"; f.context.entries[0].identity.ino = 999n; f.context.epoch = 99;
    const checked = owner.capture(); assert.equal(checked, owner); assert.equal(owner.status, "input-captured");
    assert.equal(owner.binding.epoch, 3); assert.equal(owner.records[0].operation, null);
    assert.deepEqual(f.calls.filter(call => call.name === "open").map(call => call.path), ["read.txt", "sub/modify.txt"]);
    assert.equal(owner.records[2].revision, null); assert.equal(owner.records[2].identity, null);
    assert.throws(() => owner.copyFile(1)); assert.throws(() => owner.copyFile(2)); assert.throws(() => owner.capture());
    f.files.get("read.txt").bytes.fill(120);
    const copy = owner.copyFile(0), second = owner.copyFile(3);
    assert.equal(copy.toString(), "alpha"); assert.equal(second.toString(), "beta");
    assert.equal(copy.byteOffset, 0); assert.equal(copy.buffer.byteLength, 5);
    assert.notEqual(copy.buffer, second.buffer); assert.notEqual(copy.buffer, f.borrowed[0].buffer);
    copy.fill(121); assert.throws(() => owner.copyFile(0)); assert.equal(second.toString(), "beta");
    assert.throws(() => { owner.records[0].path = "altered"; });
    assert.equal(owner.diagnostics.retainedIO, false); assert.equal(owner.diagnostics.retainedContext, false);
    const before = owner.diagnostics; owner.dispose(); owner.dispose(); released(owner, f);
    assert.equal(second.toString(), "beta"); copy.fill(0); second.fill(0);
    assert.equal(before.opened, 2); assert.equal(before.closed, 2); assert.equal(before.peakHandles, 1);
    assert.equal(before.allocatedBytes, 9); assert.equal(before.sourceBytes, 16); assert.equal(before.exportedBytes, 9);
    t.diagnostic(JSON.stringify({ normal: before, afterDispose: owner.diagnostics, actualFilesystemCalls: 0 }));
});

test("input 2: explicit host schema, path/credential policy, independent authority and parent conflicts", () => {
    const paths = [".git/config", "sub/.sp/state", ".env", "a/../b", "a\\b", "C:x", "a:b", "/a", "//server/a",
        "a//b", "a.", "a ", "con.txt", "x/lpt9", "a~1", "日本語", "a".repeat(65), "a/b/c/d/e", "credentials.json", "x/id_rsa", "x/key.pem"];
    for (const name of paths) { const f = fixture([[name, "x", true, null]]); assert.throws(() => f.owner(), undefined, name); assert.equal(f.calls.length, 0); }
    for (const names of [["A.txt", "a.txt"], ["a", "a/b"], ["a/b", "a"]]) {
        const f = fixture(names.map(name => [name, "x", true, null])); assert.throws(() => f.owner());
    }
    const mutations = [
        h => h.entries[0].classification = "credential", h => h.entries[0].expose = "yes",
        h => h.entries[0].authorized = true, h => h.authorized = true,
        h => h.entries[0].operation = "delete", h => h.entries[0].operation = "move",
        h => h.entries[0].expose = false, h => h.entries[2].expose = true,
        h => h.entries[2].revision = h.entries[0].revision, h => h.entries[2].identity = h.entries[0].identity,
        h => h.entries[2].sha256 = h.entries[0].sha256, h => h.entries[0].revision = "guest_revision",
        h => h.entries[0].identity.ino = 0n, h => h.entries[0].identity.size = 1 << 30,
        h => h.entries[3].parents = [], h => h.entries[3].parents[0].path = "elsewhere",
        h => h.sourceRoot.path = "D:\\", h => h.sourceRoot.path = "\\\\server\\share",
    ];
    for (const mutate of mutations) { const f = fixture(); mutate(f.context); assert.throws(() => f.owner()); assert.equal(f.calls.length, 0); }
    const f = fixture([["a/x", "x", true, null], ["a/y", "y", true, null]]);
    f.context.entries[1].parents[0].identity.ino++; assert.throws(() => f.owner());
    const alias = fixture([["a/x", "x", true, null], ["A/y", "y", true, null]]);
    alias.context.entries[1].parents[0].identity = alias.context.entries[0].parents[0].identity;
    assert.throws(() => alias.owner());
    const sameFile = fixture(); sameFile.context.entries[1].identity = sameFile.context.entries[0].identity;
    assert.throws(() => sameFile.owner());
});

test("input 3: task/snapshot/root/session/epoch and original native receipt cannot be refreshed", () => {
    const changes = [
        f => f.state.taskId = snapshotId, f => f.state.snapshotId = taskId, f => f.state.sessionId = "other",
        f => f.state.epoch++, f => f.state.live = false,
        f => f.receipts.delete(f.original.entries[0].revision),
        f => { const id = f.original.entries[0].revision; f.receipts.set(id, structuredClone(f.receipts.get(id))); },
        f => f.receipts.get(f.original.entries[0].revision).sha256 = "a".repeat(64),
        f => f.receipts.get(f.original.entries[0].revision).identity.ino++,
        f => f.receipts.get(f.original.entries[0].revision).sessionId = "other",
        f => f.receipts.get(f.original.entries[0].revision).canonicalPath = "D:\\elsewhere.txt",
    ];
    for (const change of changes) {
        const f = fixture(), owner = f.owner(); change(f);
        assert.equal(owner.capture().status, "rejected"); assert.equal(f.counts.open ?? 0, 0); released(owner, f);
    }
    const f = fixture(), owner = f.owner(); f.hooks.current = (original, args, n) => n === 1 ? true : false;
    assert.equal(owner.capture().reason, "association-changed"); released(owner, f);
});

test("input 4: root/parent/file aliases, reparse, links and read/final changes reject the whole snapshot", () => {
    const mutations = [
        f => f.directories.get("").identity.ino++, f => f.directories.get("sub").identity.ino++,
        f => f.directories.get("sub").reparseTag = 0x80000000, f => f.directories.get("").canonicalPath += "x",
        f => f.files.get("read.txt").nlink = 2, f => f.files.get("read.txt").kind = "directory",
        f => f.files.get("read.txt").reparseTag = null, f => f.files.get("read.txt").canonicalPath += "x",
        f => f.files.get("read.txt").identity.size++, f => f.files.get("read.txt").identity.mtimeNs++,
        f => f.files.get("read.txt").identity.ctimeNs++, f => f.files.get("read.txt").identity.ino++,
        f => f.files.set("new.txt", structuredClone(f.files.get("read.txt"))),
    ];
    for (const mutate of mutations) {
        const f = fixture(), owner = f.owner(); mutate(f); assert.equal(owner.capture().status, "rejected");
        assert.equal(f.counts.open ?? 0, 0); released(owner, f);
    }
    for (const change of [f => f.files.get("read.txt").identity.ino++, f => f.files.get("read.txt").identity.size++,
        f => f.directories.get("").identity.ino++, f => f.files.get("read.txt").bytes.fill(120)]) {
        const f = fixture(), owner = f.owner();
        f.hooks.read = (original, args, n) => { if (n === 1) change(f); return original(...args); };
        assert.equal(owner.capture().status, "rejected"); released(owner, f);
    }
    // Only the final batch check sees this previously captured file change.
    const f = fixture(), owner = f.owner();
    f.hooks.close = (original, args, n) => { const value = original(...args); if (n === 2) f.files.get("read.txt").identity.ctimeNs++; return value; };
    assert.equal(owner.capture().status, "rejected"); assert.equal(owner.diagnostics.allocatedBytes, 9); released(owner, f);
    const mutated = fixture(), changedOwner = mutated.owner();
    mutated.hooks.close = (original, args, n) => { const result = original(...args); if (n === 2) mutated.borrowed[0][0] ^= 1; return result; };
    assert.equal(changedOwner.capture().reason, "final-hash"); released(changedOwner, mutated);
});

test("input 5: file/total/entry/directory/metadata limits guard before read and allocation", t => {
    const exact = fixture(Array.from({ length: 16 }, (_, i) => ["f" + i + ".txt", Buffer.alloc(1024, i), true, "modify"]));
    const owner = exact.owner(); assert.equal(owner.capture(), owner);
    for (let i = 0; i < 16; i++) { const copy = owner.copyFile(i); assert.equal(copy.length, 1024); copy.fill(0); }
    const exactCounts = owner.diagnostics;
    assert.equal(exactCounts.sourceBytes, 16384); assert.equal(exactCounts.allocatedBytes, 16384);
    assert.equal(exactCounts.exportedBytes, 16384); assert.equal(exactCounts.opened, 16); owner.dispose(); released(owner, exact);
    for (const spec of [
        [["big.txt", Buffer.alloc(4097), true, "modify"]],
        Array.from({ length: 17 }, (_, i) => ["f" + i, "", true, null]),
        [...Array.from({ length: 4 }, (_, i) => ["f" + i, Buffer.alloc(4096), true, null]), ["hidden", "x", false, "modify"]],
    ]) { const f = fixture(spec); assert.throws(() => f.owner()); assert.equal(f.calls.length, 0); }
    for (const mutate of [h => h.budget.entries = 3, h => h.budget.directories = 1,
        h => h.budget.metadataBytes = 1023, h => h.budget.metadataBytes = 1024 + 512 + 16,
        h => h.budget.totalBytes = 15, h => h.budget.fileBytes = 6, h => h.budget.entries = 17]) {
        const f = fixture(); mutate(f.context); assert.throws(() => f.owner()); assert.equal(f.calls.length, 0);
    }
    const maxFile = fixture([["x", Buffer.alloc(4096), true, null]]), maxOwner = maxFile.owner();
    assert.equal(maxOwner.capture(), maxOwner); maxOwner.dispose(); released(maxOwner, maxFile);
    const empty = fixture([["empty", "", true, null]]), emptyOwner = empty.owner();
    assert.equal(emptyOwner.capture(), emptyOwner); assert.equal(empty.counts.read ?? 0, 0);
    assert.equal(emptyOwner.copyFile(0).length, 0); assert.throws(() => emptyOwner.copyFile(0)); emptyOwner.dispose(); released(emptyOwner, empty);
    const none = fixture([]), noOwner = none.owner(); assert.equal(noOwner.capture(), noOwner); noOwner.dispose(); released(noOwner, none);
    const maxDirs = fixture(Array.from({ length: 16 }, (_, i) => ["a" + i + "/b/c/f", "", true, null]));
    const dirOwner = maxDirs.owner(); assert.equal(dirOwner.capture(), dirOwner); assert.equal(dirOwner.diagnostics.directories, 49);
    dirOwner.dispose(); released(dirOwner, maxDirs); maxDirs.context.budget.directories = 48; assert.throws(() => maxDirs.owner());
    const metadata = fixture(), measured = metadata.owner(), charge = measured.diagnostics.metadataBytes; measured.dispose();
    metadata.context.budget.metadataBytes = charge;
    const charged = metadata.owner(); assert.equal(charged.capture(), charged); charged.dispose(); released(charged, metadata);
    metadata.context.budget.metadataBytes--; assert.throws(() => metadata.owner());
    t.diagnostic(JSON.stringify({ maximum: exactCounts, afterDispose: owner.diagnostics }));
});

test("input 6: short read, read/inspect/open failures and falsy exceptions preserve facts and clear buffers", () => {
    for (const count of [0, -1, 1.5, 10000, undefined]) {
        const f = fixture(), owner = f.owner(); f.hooks.read = () => count;
        assert.equal(owner.capture().reason, "short-read"); assert.equal(f.counts.close, 1); released(owner, f);
    }
    for (const method of ["current", "revision", "directory", "file", "open", "read", "stat"]) {
        for (const error of [undefined, null, 0, new Error(method)]) {
            const f = fixture(), owner = f.owner(); f.hooks[method] = () => { throw error; };
            assert.equal(owner.capture().status, "rejected"); assert.equal(owner.failure.operationFailed, true);
            assert.equal(owner.failure.operationError, error); released(owner, f); owner.dispose();
            assert.equal(owner.failure.operationError, undefined);
        }
    }
    const f = fixture(), owner = f.owner(); f.hooks.stat = (original, args, n) => n === 1 ? { ...original(...args), nlink: 2 } : original(...args);
    assert.equal(owner.capture().status, "rejected"); assert.equal(owner.diagnostics.allocatedBytes, 0); released(owner, f);
});

test("input 7: revoke/dispose/reentrancy are single-use and do not drop an active reader handle", () => {
    for (const method of ["current", "directory", "revision", "file", "open", "stat", "read", "close"]) {
        for (const action of ["revoke", "dispose"]) {
            const f = fixture(), owner = f.owner();
            f.hooks[method] = (original, args) => { const result = original(...args); owner[action](); return result; };
            assert.equal(owner.capture().status, "rejected", method + ":" + action); released(owner, f);
            assert.throws(() => owner.capture());
        }
    }
    const f = fixture(), owner = f.owner();
    f.hooks.read = (original, args) => { assert.throws(() => owner.capture(), /single-use/); return original(...args); };
    assert.equal(owner.capture(), owner); owner.revoke(); released(owner, f);
    const before = fixture(), revoked = before.owner(); revoked.revoke(); assert.throws(() => revoked.capture()); released(revoked, before);
});

test("input 8: unknown close retains original token/reader and errors across revoke/dispose without retry", t => {
    for (const operationError of [undefined, null, new Error("read")]) {
        const f = fixture(), owner = f.owner(), closeError = { reason: "model-close-unknown" }; let token;
        f.hooks.open = (original, args) => (token = original(...args));
        f.hooks.read = () => { throw operationError; };
        f.hooks.close = () => { throw closeError; };
        assert.deepEqual(owner.capture(), { status: "rejected", reason: "close-unknown", cleanup: "unknown" });
        owner.revoke(); owner.dispose(); owner.dispose();
        const d = owner.diagnostics;
        assert.equal(owner.status, "unknown"); assert.equal(d.retainedIO, true); assert.equal(d.retainedContext, true);
        assert.equal(d.activeHandles, 1); assert.equal(d.closed, 0); assert.equal(d.closeAttempts, 1);
        assert.equal(d.retainedBytes, 0); assert.equal(d.allocatedBytes, d.clearedBytes);
        assert.equal(owner.failure.retainedHandle, token); assert.equal(owner.failure.operationError, operationError);
        assert.equal(owner.failure.closeError, closeError); assert.equal(owner.failure.operationFailed, true);
        assert.equal(f.counts.close, 1); assert.equal(f.handles.size, 1); assert.throws(() => owner.capture());
        for (const bytes of f.borrowed) assert.ok(bytes.every(value => value === 0));
        // Model only: no OS fd exists, and this test does not pretend to resolve Unknown.
    }
    for (const result of [false, undefined, Promise.resolve(true)]) {
        const f = fixture(), owner = f.owner(); f.hooks.close = () => result;
        assert.equal(owner.capture().cleanup, "unknown"); assert.equal(owner.failure.operationFailed, false);
        assert.equal(owner.failure.closeFailed, true); owner.dispose(); assert.equal(f.counts.close, 1);
    }
    const f = fixture(), owner = f.owner(); f.hooks.close = () => { throw null; };
    owner.capture(); owner.dispose(); t.diagnostic(JSON.stringify({ unknown: owner.diagnostics, actualOSHandles: 0 }));
});
