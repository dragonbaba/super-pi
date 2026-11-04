import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SandboxToolchains } from "../scripts/acceptance/windows-sandbox-toolchains.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
test("Framework PowerShell gate is independent of the parent console BOM", { skip: process.platform !== "win32" }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "superpi-task-gate-"));
    const rootId = fs.lstatSync(root, { bigint: true });
    const executable = path.join(root, "gate-check.exe");
    let executableId;
    try {
        const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", [
            "/nologo", "/target:exe", "/platform:x64", "/main:TaskGateCheck", "/out:" + executable,
            path.join(repository, "scripts/acceptance/windows-sandbox-task-worker.cs"),
            path.join(repository, "tests/fixtures/windows-sandbox-task-gate-check.cs"),
        ], { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 8192 });
        if (fs.existsSync(executable)) executableId = fs.lstatSync(executable, { bigint: true });
        assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
        const toolchains = new SandboxToolchains({ cwd: repository });
        const result = spawnSync(executable, [toolchains.hostShell], { encoding: "utf8", timeout: 20000, windowsHide: true, maxBuffer: 8192 });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.deepEqual(JSON.parse(result.stdout), { cases: 4, started: 4, closed: 4, headless: true });
    } finally {
        if (executableId) {
            const current = fs.lstatSync(executable, { bigint: true });
            assert.equal(current.dev, executableId.dev); assert.equal(current.ino, executableId.ino);
            fs.unlinkSync(executable);
        }
        const current = fs.lstatSync(root, { bigint: true });
        assert.equal(current.dev, rootId.dev); assert.equal(current.ino, rootId.ino);
        fs.rmdirSync(root);
    }
});
