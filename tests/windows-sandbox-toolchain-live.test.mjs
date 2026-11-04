// Explicit local acceptance only; CI never creates a VM merely by collecting this file.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceSandboxBackend } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { SandboxTaskBinding } from "../packages/coding-agent/src/core/sandbox/task-binding.ts";
import { parseSandboxTaskRequest } from "../packages/coding-agent/src/core/sandbox/task-request.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { executeWindowsTask } from "../scripts/acceptance/windows-sandbox-task-runtime.mjs";

const enabled = process.platform === "win32" && process.env.SUPERPI_SANDBOX_TOOLCHAIN_ACCEPTANCE === "1";
const inventory = String.raw`$checks=@(@('node','--version'),@('npm','--version'),@('npx','--version'),@('python','--version'),@('pip','--version'),@('git','--version'),@('gh','--version'),@('go','version'),@('java','--version'),@('javac','--version'),@('dotnet','--version'),@('rustc','--version'),@('cargo','--version'),@('bun','--version'),@('rg','--version'),@('uv','--version'),@('adb','version')); $rows=foreach($check in $checks){$name=$check[0]; $resolved=Get-Command $name -ErrorAction Stop; $global:LASTEXITCODE=0; $output=(& $name $check[1] 2>&1 | Out-String).Trim(); [pscustomobject]@{name=$name;exit=$LASTEXITCODE;output=$output}}; [pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;home=$env:USERPROFILE;tmp=$env:TMP;hostProjectVisible=(Test-Path 'D:\RMProjects\Pi');tools=$rows;toolchains=(Get-Content 'C:\SuperPiTools\toolchains.json' -Raw | ConvertFrom-Json)} | ConvertTo-Json -Depth 6 -Compress`;
const dependencies = String.raw`
$root=Join-Path $env:TEMP 'dependency-check'; New-Item -ItemType Directory -Path $root | Out-Null; Set-Location $root
node -e "require('node:fs'); require('node:crypto'); console.log('node-ok')"; if($LASTEXITCODE){throw 'Node modules'}
python -c "import ssl, sqlite3; print('python-ok')"; if($LASTEXITCODE){throw 'Python modules'}
git init --quiet repository; if($LASTEXITCODE){throw 'Git helpers'}
'public class Hello { public static void main(String[] args) { System.out.print("java-ok"); } }' | Set-Content Hello.java -Encoding utf8
javac Hello.java; if($LASTEXITCODE){throw 'Java compiler'}; java -cp . Hello; if($LASTEXITCODE){throw 'Java runtime'}
'fn main() { println!("rust-ok"); }' | Set-Content hello.rs -Encoding utf8
rustc --emit=metadata hello.rs; if($LASTEXITCODE){throw 'Rust standard library'}
$env:GO111MODULE='off'; $env:GOCACHE=Join-Path $root 'go-cache'
@'
package main
func main() { println("go-ok") }
'@ | Set-Content hello.go -Encoding utf8
go build -o hello-go.exe hello.go; if($LASTEXITCODE){throw 'Go compiler'}; & .\hello-go.exe; if($LASTEXITCODE){throw 'Go executable'}
dotnet --list-sdks; if($LASTEXITCODE){throw '.NET SDK'}
Write-Output 'dependencies-ok'
`;

test("live production workspace uses PowerShell 7, PATH installations, isolated caches and text errors", { skip: !enabled, timeout: 300000 }, async () => {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, "sandbox-toolchain-live-"));
    const identity = await fs.lstat(root, { bigint: true });
    const workspace = path.join(root, "workspace"), artifacts = path.join(root, "artifacts");
    await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, "fixture.txt"), "fixture\n");
    const Backend = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
        ? (await import("../packages/coding-agent/dist/core/sandbox/workspace-backend.js")).WorkspaceSandboxBackend : WorkspaceSandboxBackend;
    const backend = new Backend(workspace, artifacts, "sandbox-write");
    try {
        const reply = await backend.invoke("powershell", { command: inventory, timeout: 120 });
        const report = JSON.parse(reply.text);
        assert.match(report.version, /^7\./); assert.equal(report.edition, "Core"); assert.equal(report.hostProjectVisible, false);
        assert.equal(report.home, "C:\\SuperPiCommand\\home"); assert.equal(report.tmp, "C:\\SuperPiCommand");
        assert.equal(report.tools.length, 17);
        for (const row of report.tools) assert.equal(row.exit, 0, row.name + ": " + row.output);
        assert.equal(report.toolchains.statistics.checked, true);
        console.log("TOOLCHAIN_LIVE_INVENTORY " + JSON.stringify(report));
        const dependencyReply = await backend.invoke("powershell", { command: dependencies, timeout: 120 });
        assert.match(dependencyReply.text, /dependencies-ok/); assert.match(dependencyReply.text, /java-ok/); assert.match(dependencyReply.text, /go-ok/);
        assert.equal(backend.diagnostics.starts, 1); assert.equal(backend.diagnostics.calls, 2);
        await assert.rejects(backend.invoke("powershell", { command: "throw 'expected-pwsh7-error'", timeout: 30 }), error => {
            assert.match(error.message, /expected-pwsh7-error/); assert.doesNotMatch(error.message, /CLIXML|_x000D_|<Objs|\x1b\[/); return true;
        });
        assert.equal(backend.diagnostics.vm, false); assert.equal(backend.diagnostics.ownedArtifacts, 0);
        console.log("TOOLCHAIN_LIVE_ACCEPTANCE " + JSON.stringify({ version: report.version, tools: 17, dependencies: true, textErrors: true, starts: 1, calls: 3, cleanup: backend.diagnostics }));
    } finally {
        await backend.close();
        // Exact fixture identities and children only; a retained backend stops cleanup here.
        const current = await fs.lstat(root, { bigint: true });
        assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(await fs.realpath(root), root);
        await fs.unlink(path.join(workspace, "fixture.txt")); await fs.rmdir(workspace);
        await fs.rmdir(artifacts); await fs.rmdir(root);
    }
});

test("live legacy task keeps original session binding and volume ownership with PowerShell 7 toolchains", { skip: !enabled, timeout: 300000 }, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "sandbox-toolchain-legacy-"));
    const identity = await fs.lstat(root, { bigint: true });
    const workspace = path.join(root, "workspace"), artifacts = path.join(root, "artifacts"); await fs.mkdir(workspace);
    const boundary = new SessionExecutionBoundary(), events = createEventBus();
    const runtime = { executionBoundary: boundary, assertActive() {}, trackEventBusSubscription(unsubscribe) { return unsubscribe; }, appendEntry() {} };
    const files = runtime.nativeFiles = new SessionFiles(runtime, events);
    const ctx = { cwd: workspace, signal: boundary.signal, sessionManager: { getSessionId() { return "live-legacy-toolchain"; } } };
    const tool = { name: "powershell", execute() { throw new Error("Unexpected dispatcher reentry"); } };
    const execution = { parentToolCallId: "live-toolchain-parent", callTool() { throw new Error("No writeback requested"); }, findTool() { return tool; } };
    const request = parseSandboxTaskRequest({ version: 1, profile: "windows-powershell-foreground-v1", cwd: ".", timeoutMs: 30000, inputs: [], writes: [],
        command: "$PSVersionTable.PSVersion.ToString(); node --version; npm --version; python --version; git --version" });
    const binding = new SandboxTaskBinding(request, files, ctx, execution, execution.parentToolCallId, boundary.signal, runtime);
    try {
        await binding.run(async borrow => {
            const run = await executeWindowsTask(borrow, artifacts);
            try {
                assert.equal(run.result.exitCode, 0); assert.equal(run.result.timedOut, false);
                assert.match(run.result.stdout, /^7\./); assert.match(run.result.stdout, /v26\.13\.0/);
                assert.match(run.result.stdout, /Python 3\./); assert.match(run.result.stdout, /git version/);
                assert.doesNotMatch(run.result.stderr, /CLIXML|_x000D_/);
            } finally { await run.finish(); }
            assert.equal(run.diagnostics.rootRemoved, true); assert.equal(run.diagnostics.pendingProcesses, 0);
            console.log("TOOLCHAIN_LEGACY_ACCEPTANCE " + JSON.stringify(run.diagnostics));
        });
    } finally {
        binding.dispose(); await files.dispose(); await boundary.dispose(); events.clear();
        const current = await fs.lstat(root, { bigint: true }); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
        assert.equal(await fs.realpath(root), root); await fs.rmdir(workspace); await fs.rmdir(artifacts); await fs.rmdir(root);
    }
});
