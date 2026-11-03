import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner, VOLUME_LIMITS } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { singleGuidVolumeConfig } from "../scripts/acceptance/windows-sandbox-volume-config.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\";
function facts(released = false) {
    return { protocol: "super-pi-volume-v1", taskId, diskId: taskId, sequence: 1, kind: "reply", phase: released ? "released" : "prepared-not-share-admitted",
        error: null, imageCreated: true, imageId: "AABBCCDD:0000000000000001", physicalPath: "\\\\.\\PhysicalDrive77", volumePath,
        exchangeId: "AABBCCDD:0000000000000002", capacity: VOLUME_LIMITS.capacity, imageBudget: VOLUME_LIMITS.imageBytes,
        shareAdmission: false, detached: released, managementClosed: released, closeUnknown: false };
}
class Driver {
    pid = 123; physicallyClosed = false; pending = false; calls = []; mutate;
    setUnsafeHandler(handler) { this.unsafe = handler; }
    async command(command, observe) {
        this.calls.push(command); const value = facts(command === "release" || command === "exit");
        this.mutate?.(command, value); observe(value); return value;
    }
    async waitClosed() { this.physicallyClosed = true; return true; }
}
class Cli {
    calls = []; ids = new Set(); nextPid = 2000; onList; unknownStart = false;
    launch(args) {
        this.calls.push(args); const kind = args[0], pid = ++this.nextPid;
        if (kind === "start" && this.unknownStart) return { pid, result: undefined, async wait() { return "timeout"; } };
        if (kind === "start") this.ids.add(args[2]);
        else if (kind === "stop") this.ids.delete(args[2]);
        else { assert.equal(kind, "list"); this.onList?.(); }
        const stdout = kind === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...this.ids].map(Id => ({ Id })) }) : "{}";
        const result = { pid, exitCode: 0, signal: null, launchError: null, truncated: false, stdout, stderr: "", closedUtc: "2026-11-01T00:00:00.000Z" };
        return { pid, result, async wait() { return "settled"; } };
    }
}
async function fixture() {
    const runtime = new LiveSandboxRuntime(taskId), driver = new Driver(), cli = new Cli();
    const state = { revokes: 0, cancels: 0, records: [], failJournal: false, onJournal: undefined };
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read,
        journal(value) { if (state.failJournal && value.experimentalMappingState === "dispatch-checked") throw Error("Injected journal failure"); state.records.push(value); state.onJournal?.(value); },
        revokeCandidates() { state.revokes++; }, cancelExecution() { state.cancels++; } });
    await volume.prepare();
    const vm = new SandboxLifecycle({ cli, taskId, config: experimentalGuidConfig(volume), journal() {} }); runtime.bind(vm);
    return { runtime, driver, cli, state, volume, vm };
}

test("GUID preview has exactly one mapping and cannot admit or alias a share", async () => {
    for (const alias of ["C:\\exchange", "\\\\host\\share\\", volumePath + "exchange", volumePath + "..\\", volumePath + "\n", volumePath.replace("aaaaaaaa", "--------"), volumePath.replace("Volume", "volume")])
        assert.throws(() => singleGuidVolumeConfig(alias));
    const f = await fixture(), xml = f.vm.config;
    assert.equal((xml.match(/<MappedFolder>/g) ?? []).length, 1); assert.ok(xml.includes(`<HostFolder>${volumePath}exchange</HostFolder>`));
    for (const field of ["Networking", "ClipboardRedirection", "AudioInput", "VideoInput", "PrinterRedirection", "vGPU"]) assert.ok(xml.includes(`<${field}>Disable</${field}>`));
    assert.ok(xml.includes("<MemoryInMB>2048</MemoryInMB>")); assert.equal(f.volume.shareAdmission, false); assert.equal(f.volume.experimentalShareAdmission, false);
    assert.throws(() => experimentalGuidConfig({ facts: facts(), shareAdmission: true }));
    await assert.rejects(f.volume.startExperimentalMapping({}, f.vm)); assert.equal(f.cli.calls.length, 0);
    f.vm.config += "<MappedFolder>extra</MappedFolder>"; f.vm.configSha256 = createHash("sha256").update(f.vm.config).digest("hex");
    await assert.rejects(f.volume.issueExperimentalMapping(f.vm), /sole bound/); assert.equal(f.volume.experimentalShareAdmission, false);
    assert.equal(f.volume.experimentalMappingReferencesHeld, false); assert.equal(f.state.cancels, 1);
    await f.volume.release(); f.runtime.dispose(); assert.equal(f.runtime.retainsOwner, false);
});

test("private ticket is tied to its VM, consumed once, and reverified immediately before start", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    assert.equal(f.volume.shareAdmission, false); assert.equal(f.volume.experimentalShareAdmission, true);
    await assert.rejects(f.volume.startExperimentalMapping({ ...ticket }, f.vm));
    const other = new SandboxLifecycle({ cli: f.cli, taskId, config: f.vm.config, journal() {} });
    await assert.rejects(f.volume.startExperimentalMapping(ticket, other));
    let checkedBeforeLaunch = false;
    f.cli.onList = () => { if (f.cli.calls.length === 1) assert.deepEqual(f.driver.calls, ["prepare", "verify"]); };
    f.driver.mutate = command => { if (command === "verify" && f.driver.calls.length === 3) {
        assert.equal(f.cli.calls.length, 1); assert.equal(f.vm.startAttempted, false); checkedBeforeLaunch = true;
    } };
    await f.volume.startExperimentalMapping(ticket, f.vm); assert.equal(checkedBeforeLaunch, true);
    assert.equal(f.volume.experimentalShareAdmission, false); assert.equal(f.volume.experimentalMappingReferencesHeld, false);
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm)); await assert.rejects(f.volume.issueExperimentalMapping(f.vm));
    assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 1);
    assert.equal(f.cli.calls.find(args => args[0] === "start")[4], f.vm.config);
    assert.equal(await f.vm.cleanup(), true); assert.equal(f.runtime.read().state, "closed");
    await f.volume.release(); assert.deepEqual(f.driver.calls, ["prepare", "verify", "verify", "release", "exit"]);
    f.runtime.dispose(); assert.equal(f.runtime.retainsOwner, false); assert.equal(f.runtime.read().state, "unknown");
});

test("identity, configuration and revocation changes before dispatch prevent every start", async () => {
    for (const mode of ["identity", "config", "revoke", "instance"]) {
        const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
        f.driver.mutate = (command, value) => {
            if (command !== "verify" || f.driver.calls.length !== 3) return;
            if (mode === "identity") value.exchangeId = "AABBCCDD:0000000000000003";
            if (mode === "config") f.vm.config = f.vm.config.replace("<Networking>Disable", "<Networking>Default");
            if (mode === "revoke") f.volume.revoke();
            if (mode === "instance") f.vm.id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        };
        await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm));
        assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 0);
        assert.equal(f.volume.experimentalShareAdmission, false); assert.equal(f.volume.experimentalMappingReferencesHeld, false);
        await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm));
    }
});

test("revocation after the async guard returns still prevents physical dispatch", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    let queued = false;
    f.state.onJournal = value => {
        if (!queued && value.experimentalMappingState === "dispatch-checked") {
            queued = true; queueMicrotask(() => f.volume.revoke());
        }
    };
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm), /before physical dispatch/);
    assert.equal(queued, true); assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 0);
    assert.equal(f.vm.startAttempted, false); assert.equal(f.runtime.read().state, "not-started");
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm));
    assert.equal(f.volume.experimentalMappingReferencesHeld, false);
    await f.volume.release(); f.runtime.dispose(); assert.equal(f.runtime.retainsOwner, false);
});

test("accepted release in the async guard gap and VM dispatch cannot both succeed", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    let release;
    f.state.onJournal = value => {
        if (!release && value.experimentalMappingState === "dispatch-checked") queueMicrotask(() => { release = f.volume.release(); });
    };
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm), /before physical dispatch/);
    assert.equal(await release, true); assert.equal(f.volume.state, "released");
    assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 0);
    assert.equal(f.vm.startAttempted, false); assert.equal(f.runtime.read().state, "not-started");
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm));
    assert.equal(f.volume.experimentalMappingReferencesHeld, false); f.runtime.dispose(); assert.equal(f.runtime.retainsOwner, false);
});

test("cleanup completed in the async guard gap prevents a later start", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    let cleanup;
    f.state.onJournal = value => {
        if (!cleanup && value.experimentalMappingState === "dispatch-checked") queueMicrotask(() => { cleanup = f.vm.cleanup(); });
    };
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm), /already cleaning or closed/);
    assert.equal(await cleanup, true); assert.equal(f.vm.state, "closed-before-start");
    assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 0); assert.equal(f.vm.startAttempted, false);
    assert.equal(await f.vm.cleanup(), true); assert.equal(f.runtime.read().state, "not-started");
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm));
    await f.volume.release(); f.runtime.dispose(); assert.equal(f.runtime.retainsOwner, false);

    const during = await fixture(), token = await during.volume.issueExperimentalMapping(during.vm);
    let cleaning = false;
    during.vm.journal = value => {
        if (!cleaning && value.state === "starting" && value.calls.at(-1)?.kind === "start") {
            cleaning = true; during.vm.cleanup();
        }
    };
    await assert.rejects(during.volume.startExperimentalMapping(token, during.vm), /before physical dispatch/);
    assert.equal(cleaning, true); assert.equal(during.cli.calls.filter(args => args[0] === "start").length, 0);
    assert.equal(during.vm.state, "blocked-cleanup"); assert.equal(during.vm.startAttempted, false);
    assert.equal(await during.vm.cleanup(), false); assert.equal(during.runtime.read().state, "unknown");
    await assert.rejects(during.volume.release()); assert.throws(() => during.runtime.dispose());
    assert.equal(during.volume.experimentalMappingReferencesHeld, false); assert.equal(during.runtime.retainsOwner, true);
});

test("disposed runtime in the async guard gap prevents dispatch and retains unresolved volume responsibility", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    let queued = false;
    f.state.onJournal = value => {
        if (!queued && value.experimentalMappingState === "dispatch-checked") {
            queued = true; queueMicrotask(() => f.runtime.dispose());
        }
    };
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm), /before physical dispatch/);
    assert.equal(queued, true); assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 0);
    assert.equal(f.vm.startAttempted, false); assert.equal(f.runtime.retainsOwner, false); assert.equal(f.runtime.read().state, "unknown");
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm)); await assert.rejects(f.volume.release());
    assert.equal(f.volume.experimentalMappingReferencesHeld, false);
    assert.equal(f.driver.physicallyClosed, false); assert.deepEqual(f.driver.calls, ["prepare", "verify", "verify"]);
});

test("instance absence cannot release a volume while exec is physically pending", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    await f.volume.startExperimentalMapping(ticket, f.vm);
    f.vm.state = "closed"; assert.equal(f.runtime.read().state, "unknown"); // Last list still contains this VM.
    await assert.rejects(f.volume.release()); assert.throws(() => f.volume.beginCandidateRead());
    f.vm.state = "registered-not-guest-ready"; assert.equal(await f.vm.cleanup(), true);
    const exec = { kind: "exec", pid: 900, outcome: "timeout", result: null };
    f.vm.calls.splice(f.vm.calls.length - 1, 0, exec); f.vm.execution = { operation: {}, entry: exec };
    assert.equal(f.runtime.read().state, "active"); await assert.rejects(f.volume.release()); assert.throws(() => f.runtime.dispose());
    f.vm.execution = undefined; assert.equal(f.runtime.read().state, "unknown");
    exec.result = { ...f.vm.calls.at(-1).result, pid: 900 }; exec.outcome = "timeout/settled";
    assert.equal(f.runtime.read().state, "closed"); f.volume.beginCandidateRead();
    f.volume.endCandidateRead({ activeHandles: 1, uncertainHandles: [900] });
    await assert.rejects(f.volume.release()); assert.equal(f.volume.experimentalShareAdmission, false);
    assert.equal(f.state.cancels, 1); assert.equal(f.volume.experimentalMappingReferencesHeld, false);
});

test("last list must be successful untruncated strict JSON and prove the bound instance absent", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm);
    await f.volume.startExperimentalMapping(ticket, f.vm); assert.equal(await f.vm.cleanup(), true);
    const last = f.vm.calls.at(-1), original = last.result;
    for (const change of [{ exitCode: 1 }, { truncated: true }, { stdout: "invalid" }, { stdout: "{}" },
        { stdout: JSON.stringify({ WindowsSandboxEnvironments: [{ Id: f.vm.id }] }) }]) {
        last.result = { ...original, ...change }; assert.equal(f.runtime.read().state, "unknown");
        await assert.rejects(f.volume.release()); assert.throws(() => f.volume.beginCandidateRead());
    }
    last.result = original; assert.equal(f.runtime.read().state, "closed");
    await f.volume.release(); f.runtime.dispose(); assert.equal(f.runtime.retainsOwner, false);
});

test("unknown start retains runtime responsibility and cannot reuse a consumed ticket", async () => {
    const f = await fixture(), ticket = await f.volume.issueExperimentalMapping(f.vm); f.cli.unknownStart = true;
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm), /ownership retained/);
    assert.equal(f.vm.startAttempted, true); assert.equal(f.vm.startSettled, false); assert.equal(f.runtime.read().state, "active");
    await assert.rejects(f.volume.release()); assert.throws(() => f.runtime.dispose());
    await assert.rejects(f.volume.startExperimentalMapping(ticket, f.vm));
    assert.equal(f.volume.experimentalMappingReferencesHeld, false); assert.equal(f.runtime.retainsOwner, true);
    assert.equal(f.state.cancels, 1); assert.equal(f.cli.calls.filter(args => args[0] === "start").length, 1);
});

test("journal failure prevents dispatch; unused ticket references are released on normal release", async () => {
    const failed = await fixture(), token = await failed.volume.issueExperimentalMapping(failed.vm); failed.state.failJournal = true;
    await assert.rejects(failed.volume.startExperimentalMapping(token, failed.vm), /journal failure/);
    assert.equal(failed.cli.calls.filter(args => args[0] === "start").length, 0); assert.equal(failed.volume.experimentalMappingReferencesHeld, false);
    assert.equal(failed.state.cancels, 1); await assert.rejects(failed.volume.release());
    const clean = await fixture(); await clean.volume.issueExperimentalMapping(clean.vm);
    assert.equal(clean.volume.experimentalShareAdmission, true); await clean.volume.release(); clean.runtime.dispose();
    assert.equal(clean.volume.experimentalShareAdmission, false); assert.equal(clean.volume.experimentalMappingReferencesHeld, false);
    assert.equal(clean.runtime.retainsOwner, false); assert.equal(clean.cli.calls.length, 0);
});
