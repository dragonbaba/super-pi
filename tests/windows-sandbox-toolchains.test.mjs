import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SandboxToolchains } from "../scripts/acceptance/windows-sandbox-toolchains.mjs";

function fixture(extra = []) {
    const files = new Map(); let serial = 0;
    function put(name, kind = "directory", target) { files.set(path.win32.normalize(name).toLowerCase(), { name: path.win32.normalize(name), kind, target, ino: BigInt(++serial) }); }
    for (const name of ["D:\\pwsh", "D:\\node", ...extra]) put(name);
    for (const name of ["D:\\pwsh\\pwsh.exe", "D:\\pwsh\\pwsh.dll", "D:\\pwsh\\pwsh.runtimeconfig.json", "D:\\node\\node.exe"]) put(name, "file");
    function item(name) { const value = files.get(path.win32.normalize(name).toLowerCase()); if (!value) throw Object.assign(new Error("missing: " + name), { code: "ENOENT" }); return value; }
    function stat(name) { const value = item(name); return { dev: 1n, ino: value.ino, isFile: () => value.kind === "file", isDirectory: () => value.kind === "directory", isSymbolicLink: () => value.kind === "link" }; }
    const io = { statSync: stat, lstatSync: stat, realpathSync(name) { const value = item(name); return value.target ?? value.name; },
        readdirSync(name) { const rows = []; for (const value of files.values()) if (value.name.toLowerCase() !== name.toLowerCase() && path.win32.dirname(value.name).toLowerCase() === name.toLowerCase()) rows.push({ name: path.win32.basename(value.name), isSymbolicLink: () => value.kind === "link", isDirectory: () => value.kind === "directory" }); return rows; } };
    function create(settings = {}, environment = {}) { return new SandboxToolchains({ cwd: "D:\\work", home: "C:\\Users\\fixture", executable: "D:\\node\\node.exe", io, settings,
        environment: { PATH: "D:\\pwsh;D:\\node", SystemRoot: "C:\\Windows", ...environment } }); }
    return { create, put, files, io };
}
function env(plan) {
    const [shell, ...lines] = Buffer.from(plan.encodedEnvironment, "base64").toString("utf8").split("\n");
    const values = {}; for (const line of lines) { const at = line.indexOf("="); values[line.slice(0, at)] = line.slice(at + 1); }
    return { shell, ...values };
}
const config = "<Configuration><Networking>Disable</Networking><MappedFolders></MappedFolders></Configuration>";

test("PATH discovery includes complete installations, preserves order, deduplicates case and never mounts the Windows directory", async () => {
    const f = fixture(["D:\\Git", "D:\\Git\\cmd", "D:\\Go", "D:\\Go\\bin", "C:\\Python", "C:\\Python\\Scripts"]);
    f.put("D:\\Go\\bin\\go.exe", "file");
    const plan = f.create({}, { PATH: 'D:\\pwsh;"D:\\Git\\cmd";D:/Go/bin;d:/git/cmd/;C:\\Python\\Scripts;C:\\Python;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;D:\\missing;;relative', API_KEY: "never-copy", PYTHONPATH: "C:\\secrets" });
    await plan.validateTrees(); const values = env(plan), xml = plan.appendConfig(config);
    assert.equal(values.shell, "C:\\SuperPiToolchains\\D\\pwsh\\pwsh.exe");
    assert.match(values.PATH, /^C:\\SuperPiToolchains\\D\\pwsh;C:\\SuperPiToolchains\\D\\node;C:\\SuperPiToolchains\\D\\Git\\cmd;C:\\SuperPiToolchains\\D\\Go\\bin;C:\\Python\\Scripts;C:\\Python;/);
    assert.equal(values.GOROOT, "C:\\SuperPiToolchains\\D\\Go");
    assert.equal(values.SUPERPI_TOOLCHAIN_DRIVES, "D");
    assert.equal(values.API_KEY, undefined); assert.equal(values.PYTHONPATH, undefined);
    assert.doesNotMatch(values.PATH, /WindowsPowerShell|relative|missing/i);
    assert.match(xml, /<HostFolder>D:\\Git<\/HostFolder>/); assert.match(xml, /<SandboxFolder>C:\\Python<\/SandboxFolder>/);
    assert.equal((xml.match(/<ReadOnly>true<\/ReadOnly>/g) ?? []).length, 5);
    assert.ok(plan.diagnostics.some(row => row.path === "D:\\missing"));
});

test("global include/exclude exceptions cannot expose drive roots, home, or workspace contents", async () => {
    const f = fixture(["D:\\extra", "D:\\blocked", "D:\\", "C:\\Users\\fixture", "D:\\work", "D:\\work\\bin"]);
    const plan = f.create({ include: ["D:\\extra"], exclude: ["D:\\blocked"] }, { PATH: "D:\\pwsh;D:\\blocked;D:\\;C:\\Users\\fixture;D:\\work\\bin" });
    await plan.validateTrees(); const xml = plan.appendConfig(config);
    assert.match(xml, /<HostFolder>D:\\extra<\/HostFolder>/);
    assert.doesNotMatch(xml, /blocked|fixture|D:\\work|<HostFolder>D:\\<\/HostFolder>/);
    assert.throws(() => f.create({ include: ["D:\\work"] }), /Unsafe/);
    assert.throws(() => f.create({ exclude: ["D:\\pwsh"] }), /excluded/);
    assert.throws(() => f.create({ include: "D:\\extra" }), /Invalid include/);
    assert.throws(() => f.create({ surprise: true }), /Unknown/);
    f.put("C:\\SuperPiExchange"); f.put("C:\\Windows");
    assert.throws(() => f.create({ include: ["C:\\SuperPiExchange"] }), /Unsafe/);
    assert.throws(() => f.create({ include: ["C:\\Windows"] }, { SystemRoot: "D:\\Windows" }), /Unsafe/);
});

test("missing or redirected PowerShell fails closed, and mapped directory identity is rechecked before dispatch", async () => {
    const f = fixture();
    const plan = f.create(); await plan.validateTrees(); f.put("D:\\node");
    assert.throws(() => plan.appendConfig(config), /identity changed/);
    f.files.delete("d:\\pwsh\\pwsh.dll");
    assert.throws(() => f.create(), /Complete PowerShell 7/);
    f.files.delete("d:\\pwsh\\pwsh.exe");
    assert.throws(() => f.create(), /PowerShell 7/);
});

test("WinGet aliases discover their real installation and rustup gets its toolchains without the .cargo credential root", async () => {
    const f = fixture(["C:\\Users\\fixture\\WinGet\\Links", "C:\\tools\\uv", "C:\\Users\\fixture\\.cargo\\bin", "C:\\Users\\fixture\\.rustup"]);
    f.put("C:\\Users\\fixture\\WinGet\\Links\\uv.exe", "link", "C:\\tools\\uv\\uv.exe");
    f.put("C:\\tools\\uv\\uv.exe", "file"); f.put("C:\\Users\\fixture\\.cargo\\bin\\rustup.exe", "file");
    const plan = f.create({}, { PATH: "D:\\pwsh;C:\\Users\\fixture\\WinGet\\Links;C:\\Users\\fixture\\.cargo\\bin" });
    await plan.validateTrees(); const xml = plan.appendConfig(config), values = env(plan);
    assert.match(xml, /<HostFolder>C:\\tools\\uv<\/HostFolder>/); assert.doesNotMatch(xml, /<HostFolder>[^<]*\\Links<\/HostFolder>/);
    assert.match(xml, /<HostFolder>C:\\Users\\fixture\\.cargo\\bin<\/HostFolder>/);
    assert.doesNotMatch(xml, /<HostFolder>C:\\Users\\fixture\\.cargo<\/HostFolder>/);
    assert.equal(values.RUSTUP_HOME, "C:\\Users\\fixture\\.rustup");
});

test("external links skip automatic roots, fail required roots, and never map an unchecked tree", async () => {
    const f = fixture(["D:\\old-node"]);
    f.put("D:\\old-node\\project", "link", "D:\\work");
    const plan = f.create({}, { PATH: "D:\\pwsh;D:\\old-node" });
    assert.throws(() => plan.appendConfig(config), /must be checked/);
    await plan.validateTrees();
    assert.doesNotMatch(plan.appendConfig(config), /old-node/);
    assert.doesNotMatch(env(plan).PATH, /old-node/);
    assert.ok(plan.statistics.scannedEntries > 0);
    f.put("D:\\node\\project", "link", "D:\\work");
    await assert.rejects(f.create().validateTrees(), /leaves installation/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.create().validateTrees(controller.signal), /abort/i);
});

test("all sandbox guest shell entry points require PowerShell 7 and text errors, with no 5.1 launch path", () => {
    for (const name of ["scripts/acceptance/windows-sandbox-task-worker.cs", "scripts/acceptance/windows-sandbox-guest.mjs", "tests/fixtures/windows-sandbox-task-gate-check.cs"]) {
        const source = fs.readFileSync(new URL("../" + name, import.meta.url), "utf8");
        assert.doesNotMatch(source, /powershell\.exe|UseWindowsPowerShell|WindowsPowerShell\\+v1\.0/i, name);
        assert.match(source, /OutputFormat(?: Text|", "Text")/, name);
    }
    const source = fs.readFileSync(new URL("../scripts/acceptance/windows-sandbox-task-worker.cs", import.meta.url), "utf8");
    assert.match(source, /PSVersion\.Major -ne 7/); assert.match(source, /GateBootstrap \+ VersionGuard/g);
    assert.match(source, /DisableImplicitWinCompat/);
});
