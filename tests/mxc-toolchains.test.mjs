import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SandboxToolchains } from "../packages/coding-agent/src/core/sandbox/mxc-toolchains.mjs";

function fixture(extra = []) {
    const files = new Map(); let serial = 0;
    function put(name, kind = "directory", target) { files.set(path.win32.normalize(name).toLowerCase(), { name: path.win32.normalize(name), kind, target, ino: BigInt(++serial) }); }
    for (const name of ["D:\\pwsh", "D:\\node", "D:\\work", "C:\\Users\\fixture", ...extra]) put(name);
    for (const name of ["D:\\pwsh\\pwsh.exe", "D:\\pwsh\\pwsh.dll", "D:\\pwsh\\pwsh.runtimeconfig.json", "D:\\node\\node.exe"]) put(name, "file");
    function item(name) { const value = files.get(path.win32.normalize(name).toLowerCase()); if (!value) throw Object.assign(new Error("missing: " + name), { code: "ENOENT" }); return value; }
    function stat(name) { const value = item(name); return { dev: 1n, ino: value.ino, isFile: () => value.kind === "file", isDirectory: () => value.kind === "directory", isSymbolicLink: () => value.kind === "link" }; }
    const io = { statSync: stat, lstatSync: stat, realpathSync(name) { const value = item(name); return value.target ? item(value.target).name : value.name; },
        readdirSync(name) { const rows = []; for (const value of files.values()) if (value.name.toLowerCase() !== name.toLowerCase() && path.win32.dirname(value.name).toLowerCase() === name.toLowerCase()) rows.push({ name: path.win32.basename(value.name), isSymbolicLink: () => value.kind === "link", isDirectory: () => value.kind === "directory" }); return rows; } };
    function create(settings = {}, environment = {}) { return new SandboxToolchains({ cwd: "D:\\work", home: "C:\\Users\\fixture", executable: "D:\\node\\node.exe", io, settings,
        environment: { PATH: "D:\\pwsh;D:\\node", SystemRoot: "C:\\Windows", ...environment } }); }
    return { create, put, files, io };
}

test("MXC tool discovery preserves native PATH priority without scanning installation trees", () => {
    const f = fixture(["D:\\Git", "D:\\Git\\cmd", "D:\\Go", "D:\\Go\\bin", "C:\\Python", "C:\\Python\\Scripts"]);
    f.put("D:\\Go\\bin\\go.exe", "file");
    f.io.readdirSync = () => { throw new Error("Unexpected tree scan"); };
    const plan = f.create({}, { PATH: 'D:\\pwsh;"D:\\Git\\cmd";D:/Go/bin;d:/git/cmd/;C:\\Python;C:\\Python\\Scripts;C:\\Windows\\System32;D:\\missing;;relative', API_KEY: "fixture-secret", PYTHONPATH: "C:\\secrets" });
    plan.assertCurrent(); const values = plan.environment;
    assert.equal(plan.hostShell, "D:\\pwsh\\pwsh.exe");
    assert.match(values.PATH, /^D:\\pwsh;D:\\node;D:\\Git\\cmd;D:\\Go\\bin;C:\\Python;C:\\Python\\Scripts;/);
    assert.equal(values.GOROOT, "D:\\Go"); assert.equal(values.API_KEY, undefined); assert.equal(values.PYTHONPATH, undefined);
    assert.equal(values.SUPERPI_BASH, undefined);
    assert.deepEqual(plan.mountRoots, ["D:\\pwsh", "D:\\node", "D:\\Git", "D:\\Go", "C:\\Python"]);
});
test("MXC tool grants exclude home, workspace, system roots and excluded aliases", () => {
    const f = fixture(["D:\\extra", "D:\\private-sdk", "D:\\private-sdk\\bin", "D:\\", "D:\\work\\bin"]);
    f.put("C:\\sdk-alias", "link", "D:\\private-sdk");
    for (const excluded of ["C:\\sdk-alias", "C:\\sdk-alias\\future-cache"]) {
        const plan = f.create({ include: ["D:\\extra"], exclude: [excluded] }, { PATH: "D:\\pwsh;D:\\private-sdk\\bin;D:\\;C:\\Users\\fixture;D:\\work\\bin" });
        assert.deepEqual(plan.mountRoots, ["D:\\pwsh", "D:\\node", "D:\\extra"]);
        assert.throws(() => f.create({ exclude: [excluded], include: ["D:\\private-sdk"] }), /excluded/);
    }
    assert.throws(() => f.create({ include: ["D:\\work"] }), /Unsafe/);
    assert.throws(() => f.create({ exclude: ["D:\\pwsh"] }), /excluded/);
    const realpath = f.io.realpathSync;
    f.io.realpathSync = name => { if (name === "C:\\sdk-alias") throw Object.assign(new Error("inaccessible exclusion"), { code: "EACCES" }); return realpath(name); };
    assert.throws(() => f.create({ exclude: ["C:\\sdk-alias"] }), /inaccessible exclusion/);
});
test("profile SDKs and redirected Cargo homes do not grant credential directories", () => {
    const root = "C:\\Users\\fixture\\sdk\\go", cargo = "D:\\cargo-home";
    const f = fixture([root, root + "\\bin", cargo, cargo + "\\bin", cargo + "\\registry"]);
    f.put(root + "\\bin\\go.exe", "file"); f.put("D:\\cargo-alias", "link", cargo);
    for (const CARGO_HOME of [cargo, "D:\\cargo-alias"]) {
        const plan = f.create({}, { CARGO_HOME, PATH: "D:\\pwsh;" + root + "\\bin;" + cargo + "\\bin;" + cargo + ";" + cargo + "\\registry" });
        assert.equal(plan.environment.GOROOT, root); assert.ok(plan.mountRoots.includes(cargo + "\\bin"));
        assert.ok(!plan.mountRoots.includes(cargo)); assert.ok(!plan.mountRoots.includes(cargo + "\\registry"));
    }
});
test("WinGet aliases discover complete installations and skip stale targets", () => {
    const links = "C:\\Users\\fixture\\WinGet\\Links", f = fixture([links, "D:\\gh"]);
    f.put(links + "\\removed.exe", "link", "D:\\removed\\removed.exe");
    f.put(links + "\\gh.exe", "link", "D:\\gh\\gh.exe"); f.put("D:\\gh\\gh.exe", "file");
    const plan = f.create({}, { PATH: "D:\\pwsh;" + links }); plan.assertCurrent();
    assert.ok(plan.mountRoots.includes("D:\\gh")); assert.ok(!plan.mountRoots.includes(links));
    assert.ok(plan.diagnostics.some(row => row.path === links + "\\removed.exe"));
});
test("explicit executable directories retain priority over supplemental directories and root variables", () => {
    const f = fixture(["D:\\GoA", "D:\\GoA\\bin", "D:\\GoB", "D:\\GoB\\bin"]);
    f.put("D:\\GoA\\bin\\go.exe", "file"); f.put("D:\\GoB\\bin\\go.exe", "file");
    const environment = { PATH: "D:\\pwsh;D:\\GoA;D:\\GoB\\bin" };
    assert.equal(f.create({}, environment).environment.GOROOT, "D:\\GoB");
    assert.equal(f.create({}, { ...environment, GOROOT: "D:\\GoA" }).environment.GOROOT, "D:\\GoA");
});
test("MXC requires complete PowerShell 7 and rechecks installation identities", () => {
    const f = fixture(), plan = f.create(); plan.assertCurrent(); f.put("D:\\node");
    assert.throws(() => plan.assertCurrent(), /identity changed/);
    f.files.delete("d:\\pwsh\\pwsh.dll"); assert.throws(() => f.create(), /Complete PowerShell 7/);
    f.files.delete("d:\\pwsh\\pwsh.exe");
    f.put("D:\\pwsh\\powershell.exe", "file"); f.put("D:\\pwsh\\cmd.exe", "file");
    assert.throws(() => f.create(), /PowerShell 7/);
});
