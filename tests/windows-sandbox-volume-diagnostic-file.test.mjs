import test from "node:test";
import assert from "node:assert/strict";
import { DiagnosticReceiptFile, DIAGNOSTIC_FILE_LIMITS } from "../scripts/acceptance/windows-sandbox-volume-diagnostic-file.mjs";
import { DiagnosticResultChannel } from "../scripts/acceptance/windows-sandbox-volume-diagnostic-channel.mjs";
const context = { taskId: "11111111-1111-4111-8111-111111111111", instanceId: "22222222-2222-4222-8222-222222222222",
    rootId: "12345678:0000000000000001", imageId: "12345678:0000000000000002", imageBytes: 134218240,
    volumePath: "\\\\?\\Volume{33333333-3333-4333-8333-333333333333}\\" };
const root = "D:\\RMProjects\\Pi\\.artifacts\\fixed-receipt-model", file = root + "\\fault-diagnostic.json";
const raw = () => Buffer.from(JSON.stringify({ protocol: "super-pi-manager-loss-diagnostic-v1", ...context, diskId: context.taskId,
    virtualBytes: 134217728, subtype: 2, isLoaded: false, guid: { opened: false, error: 2 },
    handles: [["root", "65", 1, true, false, null, false, null], ["image", "66", 1, true, false, null, false, null],
        ["vhd-info", "67", 1, true, false, null, false, null]] }) + "\n");
async function readyChannel() {
    const source = raw(), call = { pid: 4321, child: undefined, out: undefined, err: undefined,
        result: { pid: 4321, exitCode: 0, signal: null, launchError: null, closedUtc: "2026-11-02T00:00:00.000Z",
            stdout: source.toString("utf8"), stdoutSeen: source.length, stderr: "", stderrSeen: 0, truncated: false },
        wait() { return Promise.resolve("settled"); } };
    const channel = new DiagnosticResultChannel(context, call); await channel.waitOnce(new AbortController().signal);
    source.fill(0); return channel;
}
async function fixture(change, configure) {
    const channel = await readyChannel();
    const model = { calls: [], guardCalls: 0, closeCalls: 0, size: 0, written: undefined, borrowed: undefined, fd: 87,
        rootIno: 1n, leafIno: 4n, links: 1n, revoked: false, owner: undefined, hook: change, maximumWrite: 4096, writeReturn: undefined };
    const stat = directory => ({ dev: 0x12345678n, ino: directory ? model.rootIno : model.leafIno,
        nlink: directory ? 1n : model.links, size: BigInt(directory ? 0 : model.size), mtimeNs: 1n, ctimeNs: 2n,
        isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false });
    const io = {};
    const touch = (name, receiver) => { assert.equal(receiver, io); model.calls.push(name); model.hook?.(name, model); };
    io.lstatSync = function(p) { touch("lstat", this); assert.ok(p === root || p === file); return stat(p === root); };
    io.realpathSync = function(p) { touch("realpath", this); assert.ok(p === root || p === file); return p; };
    io.openSync = function(p, flags, mode) { touch("open", this); assert.equal(p, file); assert.equal(flags, "wx"); assert.equal(mode, 0o600); return model.fd; };
    io.fstatSync = function(fd) { touch("fstat", this); assert.equal(fd, model.fd); return stat(false); };
    io.writeSync = function(fd, bytes, offset, length, position) {
        touch("write", this); assert.equal(fd, model.fd); assert.equal(offset, model.size); assert.equal(length, bytes.length - offset); assert.equal(position, offset);
        model.borrowed = bytes;
        if (model.writeReturn !== undefined) return model.writeReturn;
        const count = Math.min(length, model.maximumWrite);
        model.written ??= Buffer.alloc(bytes.length); bytes.copy(model.written, offset, offset, offset + count);
        model.size += count; return count;
    };
    io.fsyncSync = function(fd) { touch("flush", this); assert.equal(fd, model.fd); };
    io.closeSync = function(fd) { model.closeCalls++; touch("close", this); assert.equal(fd, model.fd); };
    if (configure) configure(io, model);
    const input = { root, ...context };
    const owner = new DiagnosticReceiptFile(input, () => { model.guardCalls++; model.hook?.("guard", model); return !model.revoked; }, io);
    model.owner = owner; owner.adopt(channel); channel.dispose();
    return { owner, model, io, input, channel, finish() {
        if (!owner.snapshot.unknown) {
            if (["ready", "written"].includes(owner.snapshot.state)) { assert.throws(() => owner.dispose()); owner.abandon(); }
            owner.dispose(); const s = owner.snapshot; assert.equal(s.state, "disposed");
            assert.equal(s.receivedBytes, s.clearedBytes); assert.equal(s.allocatedBytes, 0); assert.equal(s.retainedBytes, 0);
            assert.equal(s.contextHeld || s.filesystemHeld || s.guardHeld || s.channelHeld, false);
            assert.equal(s.record.operationError, undefined); assert.equal(s.record.closeError, undefined);
            if (model.borrowed) assert.ok(model.borrowed.every(b => b === 0));
        } else {
            assert.throws(() => owner.dispose()); owner.abandon(); assert.throws(() => owner.dispose());
            assert.equal(owner.snapshot.filesystemHeld, true); assert.equal(owner.snapshot.record.fd, model.fd);
            assert.ok(owner.snapshot.retainedBytes > 0);
            // Only fake memory exists. This is not a production close/recovery or owner-release claim.
            model.borrowed?.fill(0);
        }
        model.written?.fill(0); model.owner = undefined; model.hook = undefined;
    } };
}
test("exclusive receipt uses original bytes methods and context with separate handle and transfer counters", async () => {
    assert.deepEqual(DIAGNOSTIC_FILE_LIMITS, { bytes: 4096, writes: 4, filesystemCalls: 16, descriptors: 1 });
    const f = await fixture(); f.input.rootId = "bad"; f.io.writeSync = () => { throw Error("replacement must not run"); };
    f.owner.writeOnce(); const value = f.owner.evidence(), s = f.owner.snapshot, expected = raw();
    assert.equal(Object.hasOwn(value, "raw"), false); assert.equal(Object.hasOwn(value, "lease"), false);
    assert.deepEqual(f.model.borrowed, expected); assert.deepEqual(f.model.written, expected);
    assert.equal(value.file.id, "12345678:0000000000000004"); assert.equal(value.file.bytes, expected.length);
    const decoded = Buffer.from(JSON.parse(value.wire.line).base64, "base64");
    assert.deepEqual(decoded, f.model.borrowed); decoded.fill(0); expected.fill(0);
    assert.deepEqual([s.calls,s.openCalls,s.writeCalls,s.flushCalls,s.record.closeAttempts,s.peakDescriptors,s.activeDescriptors], [12,1,1,1,1,1,0]);
    assert.equal(s.record.writeCount, value.file.bytes); assert.equal(s.record.flushed && s.record.closed, true);
    assert.equal(s.receivedBytes, value.file.bytes); assert.equal(s.clearedBytes, 0); assert.equal(s.allocatedBytes, 0);
    assert.throws(() => f.owner.writeOnce()); assert.throws(() => f.owner.adopt(f.channel)); f.finish(); f.owner.dispose();
});
test("operation and close failures preserve original falsy values independently without retry", async () => {
    for (const point of ["open", "fstat", "write", "flush", "close"]) for (const value of [undefined, 0, Error("original")]) {
        const f = await fixture(name => { if (name === point) throw value; });
        let caught = false, original; try { f.owner.writeOnce(); } catch (error) { caught = true; original = error; }
        assert.equal(caught, true); assert.equal(original, value); const s = f.owner.snapshot;
        assert.equal(s.record.operationFailed, point !== "close"); assert.equal(s.record.closeFailed, point === "close");
        assert.equal(s.record.operationError, point === "close" ? undefined : value); assert.equal(s.record.closeError, point === "close" ? value : undefined);
        assert.equal(f.model.closeCalls, point === "open" ? 0 : 1); assert.equal(s.unknown, point === "close");
        assert.throws(() => f.owner.evidence()); assert.throws(() => f.owner.writeOnce()); f.finish();
    }
    const operation = Error("write"), close = Error("close");
    const f = await fixture(name => { if (name === "write") throw operation; if (name === "close") throw close; });
    assert.throws(() => f.owner.writeOnce(), error => error instanceof AggregateError && error.errors[0] === operation && error.errors[1] === close);
    assert.equal(f.owner.snapshot.record.fd, 87); f.finish(); assert.equal(f.model.closeCalls, 1);
});
test("short writes progress at most four calls and invalid progress cannot authorize evidence", async () => {
    const partial = await fixture(undefined, (_io,m) => { m.maximumWrite = Math.ceil(raw().length / 3); m.fd = 0; });
    partial.owner.writeOnce(); const s = partial.owner.snapshot;
    assert.equal(s.writeCalls, 3); assert.equal(s.calls, 14); assert.equal(s.record.fd, 0);
    assert.equal(s.record.closeAttempts, 1); assert.equal(s.record.closed, true); partial.finish();
    for (const value of [0,-1,4097,1.5,"1"]) {
        const f = await fixture(undefined, (_io,m) => { m.writeReturn = value; });
        assert.throws(() => f.owner.writeOnce()); assert.equal(f.owner.snapshot.writeCalls, 1);
        assert.equal(f.owner.snapshot.flushCalls, 0); assert.equal(f.model.closeCalls, 1); f.finish();
    }
    const exhausted = await fixture(undefined, (_io,m) => { m.maximumWrite = 1; });
    assert.throws(() => exhausted.owner.writeOnce()); assert.equal(exhausted.owner.snapshot.writeCalls, 4);
    assert.equal(exhausted.owner.snapshot.record.writeCount, 4); assert.equal(exhausted.owner.snapshot.flushCalls, 0); exhausted.finish();
    const zeroUnknown = await fixture(name => { if(name === "close") throw undefined; }, (_io,m) => {m.fd=0;});
    let caught=false;try{zeroUnknown.owner.writeOnce();}catch{caught=true;}
    assert.equal(caught,true);assert.equal(zeroUnknown.owner.snapshot.record.fd,0);zeroUnknown.finish();assert.equal(zeroUnknown.model.closeCalls,1);
});
test("changed root file identity link size path and bytes permanently reject success", async () => {
    for (const mode of ["root", "id", "link", "size", "path", "bytes"]) {
        const f = await fixture((name, m) => {
            if (name === "flush") {
                if (mode === "root") m.rootIno = 9n;
                if (mode === "id") m.leafIno = 9n;
                if (mode === "link") m.links = 2n;
                if (mode === "size") m.size++;
                if (mode === "bytes") m.borrowed[0] ^= 1;
            }
        }, io => {
            if (mode === "path") { const realpath = io.realpathSync; io.realpathSync = function(p) { const value = realpath.call(this,p); return p===file ? value+"-changed" : value; }; }
        });
        assert.throws(() => f.owner.writeOnce()); assert.throws(() => f.owner.evidence());
        assert.equal(f.owner.snapshot.record.operationFailed, true); assert.equal(f.owner.snapshot.record.closed, true);
        assert.equal(f.model.closeCalls, 1); assert.ok(f.owner.snapshot.calls <= 16); f.finish();
    }
    const f = await fixture(); f.owner.writeOnce(); f.model.borrowed[0]^=1;
    assert.throws(()=>f.owner.evidence()); assert.equal(f.owner.snapshot.state,"blocked"); f.finish();
});
test("revocation and reentry cannot duplicate work or clear bytes during I/O or fixed evidence generation", async () => {
    for (const mode of ["before","after-open","reentry","evidence-reentry"]) {
        let reentries=0;
        const f=await fixture((name,m)=>{
            if ((mode==="reentry" && name==="open") || (mode==="evidence-reentry" && name==="guard" && m.owner?.snapshot.state==="written")) {
                assert.throws(()=>m.owner.writeOnce());assert.throws(()=>m.owner.adopt({}));assert.throws(()=>m.owner.dispose());
                assert.throws(()=>m.owner.abandon());assert.throws(()=>m.owner.evidence());reentries++;
            }
            if(mode==="after-open"&&name==="open")m.revoked=true;
        });
        if(mode==="before")f.model.revoked=true;
        if(mode==="reentry"||mode==="evidence-reentry"){f.owner.writeOnce();if(mode==="evidence-reentry")f.owner.evidence();assert.equal(reentries,1);}
        else assert.throws(()=>f.owner.writeOnce());
        assert.equal(f.model.closeCalls,mode==="before"?0:1);assert.equal(f.model.calls.filter(x=>x==="open").length,mode==="before"?0:1);
        f.finish();
    }
    const f=await fixture(undefined,(_io,m)=>{m.fd=-1;});
    assert.throws(()=>f.owner.writeOnce());assert.equal(f.owner.snapshot.unknown,true);assert.equal(f.model.closeCalls,0);f.finish();
});
test("cross-context adoption holds then clears received bytes and original channel is mandatory", async () => {
    let api=0;
    const io=Object.fromEntries(["lstatSync","realpathSync","openSync","fstatSync","writeSync","fsyncSync","closeSync"]
        .map(name=>[name,()=>{api++;throw Error("No I/O");}]));
    for(const [key,value]of [["taskId","44444444-4444-4444-8444-444444444444"],["instanceId","44444444-4444-4444-8444-444444444444"],
        ["rootId","12345678:0000000000000003"],["imageId","12345678:0000000000000003"],["imageBytes",134218241],
        ["volumePath","\\\\?\\Volume{44444444-4444-4444-8444-444444444444}\\"]]){
        const channel=await readyChannel(),owner=new DiagnosticReceiptFile({root,...context,[key]:value},()=>true,io);
        assert.throws(()=>owner.adopt(channel));assert.equal(channel.snapshot.state,"transferred");
        assert.equal(owner.snapshot.receivedBytes,raw().length);assert.equal(owner.snapshot.clearedBytes,0);
        assert.equal(api,0);owner.dispose();assert.equal(owner.snapshot.receivedBytes,owner.snapshot.clearedBytes);
        assert.equal(owner.snapshot.contextHeld||owner.snapshot.filesystemHeld||owner.snapshot.channelHeld,false);channel.dispose();
    }
    const owner=new DiagnosticReceiptFile({root,...context},()=>true,io);
    assert.throws(()=>owner.adopt({takeSuccess(){throw Error("Do not call");}}));assert.equal(owner.snapshot.receivedBytes,0);
    assert.equal(api,0);assert.throws(()=>owner.adopt({}));owner.dispose();
});

