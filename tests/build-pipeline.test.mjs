import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUILD_PACKAGES, buildPlan, parseBuildArguments, runBuilds } from "../scripts/build.mjs";

function fixture(t, manifests) {
    const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, "build pipeline-"));
    const identity = fs.lstatSync(root, { bigint: true }), files = [], directories = [];
    for (const [name, manifest] of Object.entries(manifests)) {
        const directory = path.join(root, name); fs.mkdirSync(directory); directories.push(directory);
        const file = path.join(directory, "package.json");
        fs.writeFileSync(file, JSON.stringify({ name, scripts: { build: "node build.mjs" }, ...manifest })); files.push(file);
    }
    const npmCli = path.join(root, "npm cli.mjs"); fs.writeFileSync(npmCli, "// fixture CLI\n"); files.push(npmCli);
    t.after(() => {
        assert.equal(fs.realpathSync(root), root);
        const current = fs.lstatSync(root, { bigint: true }); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
        for (const file of files) fs.unlinkSync(file);
        for (const directory of directories) fs.rmdirSync(directory);
        fs.rmdirSync(root);
    });
    return { root, npmCli, directories: Object.keys(manifests) };
}

function children() {
    const active = new Map(), calls = [];
    function spawnChild(executable, args, options) {
        assert.equal(executable, process.execPath); assert.deepEqual(options.stdio, ["ignore", "inherit", "inherit"]);
        assert.equal(options.windowsHide, true);
        const name = path.basename(options.cwd), child = new EventEmitter();
        assert.ok(!active.has(name)); active.set(name, child); calls.push({ name, args, options }); return child;
    }
    function close(name, code = 0) { const child = active.get(name); assert.ok(child); active.delete(name); child.emit("close", code, null); }
    return { active, calls, spawnChild, close };
}

test("one root build covers the original packages and selects offline scripts without losing dependencies", () => {
    const offline = buildPlan(undefined, undefined, true), online = buildPlan();
    assert.equal(offline.length, 12); assert.equal(BUILD_PACKAGES.length, 12);
    assert.equal(offline.find(item => item.name === "@super-pi/ai").script, "build:offline");
    assert.equal(online.find(item => item.name === "@super-pi/ai").script, "build");
    const done = new Set();
    for (const item of offline) { for (const name of item.dependencies) assert.ok(done.has(name), item.name + " before " + name); done.add(item.name); }
    assert.ok(offline.find(item => item.name === "@super-pi/memory").dependencies.includes("@super-pi/coding-agent"));
    assert.ok(offline.find(item => item.name === "@super-pi/statusline").dependencies.includes("@super-pi/coding-agent"));
});

test("build planning orders runtime, development and peer edges and refuses cycles before execution", t => {
    const f = fixture(t, { final: { peerDependencies: { middle: "*" } }, middle: { devDependencies: { base: "*" } }, base: {} });
    assert.deepEqual(buildPlan(f.root, f.directories).map(item => item.name), ["base", "middle", "final"]);
    fs.writeFileSync(path.join(f.root, "base/package.json"), JSON.stringify({ name: "base", scripts: { build: "node build.mjs" }, dependencies: { final: "*" } }));
    assert.throws(() => buildPlan(f.root, f.directories), /Cyclic/);
});

test("bounded scheduling waits for dependencies while independent work overlaps", async t => {
    const f = fixture(t, { a: {}, b: {}, c: { dependencies: { a: "*" } }, d: { dependencies: { b: "*", c: "*" } } });
    const run = children(), environment = { MARKER: "keep", npm_config_offline: "false" };
    const pending = runBuilds(buildPlan(f.root, f.directories), { jobs: 2, offline: true, npmCli: f.npmCli, environment, spawnChild: run.spawnChild, output() {} });
    assert.deepEqual(run.calls.map(call => call.name), ["a", "b"]);
    run.close("a"); assert.deepEqual(run.calls.map(call => call.name), ["a", "b", "c"]);
    run.close("b"); assert.equal(run.calls.length, 3);
    run.close("c"); assert.equal(run.calls.at(-1).name, "d"); run.close("d");
    const result = await pending;
    assert.equal(result.exitCode, 0); assert.equal(result.completed, 4); assert.equal(result.peakRunning, 2); assert.equal(run.active.size, 0);
    for (const call of run.calls) {
        assert.deepEqual(call.args, [f.npmCli, "--offline", "run", "build"]);
        assert.equal(call.options.env.MARKER, "keep"); assert.equal(call.options.env.npm_config_offline, "true");
    }
    assert.equal(environment.npm_config_offline, "false");
});

test("first failure stops pending work and waits for the remaining active child", async t => {
    const f = fixture(t, { a: {}, b: {}, c: {} }), run = children();
    let settled = false;
    const pending = runBuilds(buildPlan(f.root, f.directories), { jobs: 2, npmCli: f.npmCli, spawnChild: run.spawnChild, output() {} });
    pending.then(() => { settled = true; });
    run.close("a", 7); await Promise.resolve(); assert.equal(settled, false); assert.equal(run.calls.length, 2);
    run.close("b"); const result = await pending;
    assert.equal(result.exitCode, 7); assert.equal(result.completed, 1); assert.equal(run.active.size, 0);
});

test("spawn errors stop scheduling immediately but settle only after the child close", async t => {
    const f = fixture(t, { a: {}, b: {}, c: {} }), run = children();
    const pending = runBuilds(buildPlan(f.root, f.directories), { jobs: 2, npmCli: f.npmCli, spawnChild: run.spawnChild, output() {} });
    run.active.get("a").emit("error", new Error("spawn failed")); run.close("b");
    assert.equal(run.calls.length, 2); assert.equal(run.active.size, 1);
    run.close("a", -1); assert.equal((await pending).exitCode, 1);
    const refused = await runBuilds(buildPlan(f.root, f.directories), { jobs: 2, npmCli: f.npmCli, spawnChild() { throw new Error("invalid launch"); }, output() {} });
    assert.equal(refused.exitCode, 1); assert.equal(refused.results.length, 1);
});

test("cancellation drains active builds, launches no new work, and supports an already-aborted command", async t => {
    const f = fixture(t, { a: {}, b: {}, c: {} }), run = children(), controller = new AbortController();
    const options = { jobs: 1, npmCli: f.npmCli, spawnChild: run.spawnChild, signal: controller.signal, output() {} };
    const pending = runBuilds(buildPlan(f.root, f.directories), options);
    controller.abort(130); assert.equal(run.calls.length, 1); run.close("a");
    assert.equal((await pending).exitCode, 130); assert.equal(run.active.size, 0);
    assert.equal((await runBuilds(buildPlan(f.root, f.directories), options)).exitCode, 130);
    assert.equal(run.calls.length, 1);
});

test("build options reject invalid concurrency and preserve a serial escape hatch", () => {
    assert.deepEqual(parseBuildArguments(["--offline", "--jobs", "1", "--list"]), { offline: true, jobs: 1, list: true, help: false });
    assert.ok(parseBuildArguments([]).jobs >= 1 && parseBuildArguments([]).jobs <= 2);
    for (const value of ["0", "-1", "1.5", "33", "no", undefined]) assert.throws(() => parseBuildArguments(["--jobs", value]), /integer/);
    assert.throws(() => parseBuildArguments(["--unknown"]), /Unknown/);
});
