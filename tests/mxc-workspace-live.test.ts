import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { windowsShellJobDiagnostics } from "../packages/coding-agent/src/utils/windows-shell-job.ts";

const enabled = process.platform === "win32" && process.env.SUPERPI_MXC_LIVE === "1";
const distRoot = "../packages/coding-agent/dist/core/";
const SandboxTools: typeof WorkspaceSandboxTools = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
  ? (await import(distRoot + "sandbox/workspace-tools.js")).WorkspaceSandboxTools : WorkspaceSandboxTools;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

for (const mode of ["read-only", "sandbox-write"] as const) test(`live MXC ${mode}: PowerShell, files, protection and release`, { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mxc-live-")));
  const project = path.join(root, "项目 space"), additional = path.join(root, "Additional Space"), parent = path.join(root, "runtime");
  for (const directory of [project, additional, parent, path.join(project, ".git"), path.join(project, ".sp")]) await fs.mkdir(directory);
  await fs.writeFile(path.join(project, "input.txt"), "first\nsecond");
  await fs.writeFile(path.join(additional, "asset.txt"), "additional");
  for (const directory of [".git", ".sp"]) await fs.writeFile(path.join(project, directory, "protected"), "kept");
  const outside = path.join(root, "outside.txt"); await fs.writeFile(outside, "private");
  const runtime = createExtensionRuntime(); runtime.appendEntry = () => {};
  const policy = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "sandbox", {}, mode, [additional]);
  const owner = new SandboxTools(project, parent, mode, () => runtime, { directories: [additional.toUpperCase()], network: "disabled" });
  const definitions = owner.install({});
  for (const definition of Object.values(definitions)) policy.registerDefinition(definition);
  const ctx: any = { cwd: project, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: SessionManager.inMemory(project) };
  let id = 0;
  async function invoke(name: string, input: any) {
    const call = "live-" + ++id, authorization = await policy.authorize({ type: "tool_call", toolName: name, toolCallId: call, input }, ctx, definitions[name]);
    try { authorization.consume(input, call, name); return await definitions[name]!.execute(call, input, ctx.signal, undefined, ctx) as any; }
    finally { authorization.release(); }
  }
  try {
    assert.equal(definitions.bash, undefined);
    const read = await invoke("read", { path: "input.txt", offset: 2, limit: 1 });
    assert.notEqual(read.isError, true, JSON.stringify(read)); assert.match(read.content[0].text, /^second/);
    const asset = await invoke("read", { path: path.join(additional.toUpperCase(), "asset.txt") });
    assert.notEqual(asset.isError, true, JSON.stringify(asset)); assert.match(asset.content[0].text, /additional/);
    const command = await invoke("powershell", { command: "[Console]::Write($PSVersionTable.PSVersion.Major); node --version; npm --version" });
    assert.equal(command.details.execution.exitCode, 0, JSON.stringify(command)); assert.match(command.details.execution.stdout, /^7v/);
    assert.equal(command.details.execution.stderr, "");
    const longScript = await invoke("powershell", { command: "#" + "中文".repeat(6500) + "\n[Console]::Write('long script 中文')" });
    assert.equal(longScript.details.execution.exitCode, 0, JSON.stringify(longScript));
    assert.equal(longScript.details.execution.stdout, "long script 中文");
    const failure = await invoke("powershell", { command: "[Console]::Write('retained'); exit 23" });
    assert.equal(failure.isError, false); assert.equal(failure.details.shellExecution.exitCode, 23); assert.match(failure.details.execution.stdout, /retained/);
    const protectedRun = await invoke("powershell", { command: "$ErrorActionPreference='Stop'; foreach($p in @('.git/protected','.sp/protected')) { try {[IO.File]::WriteAllText((Join-Path $PWD $p),'changed'); throw 'UNEXPECTED_WRITE'} catch {if($_.Exception.Message -eq 'UNEXPECTED_WRITE'){throw}; 'DENIED'} }; try {[IO.File]::ReadAllText(" + quote(outside) + "); throw 'UNEXPECTED_READ'} catch {if($_.Exception.Message -eq 'UNEXPECTED_READ'){throw}; 'DENIED'}" });
    assert.equal(protectedRun.details.execution.exitCode, 0, JSON.stringify(protectedRun));
    assert.equal((protectedRun.details.execution.stdout.match(/DENIED/g) ?? []).length, 3);
    for (const directory of [".git", ".sp"]) assert.equal(await fs.readFile(path.join(project, directory, "protected"), "utf8"), "kept");
    if (mode === "sandbox-write") {
      const created = await invoke("write", { path: ".venv/local.txt", content: "installed" }); assert.notEqual(created.isError, true, JSON.stringify(created));
      const current = await invoke("read", { path: "input.txt" });
      const edited = await invoke("edit", { path: "input.txt", snapshot: current.details.snapshot, edits: [{ oldText: "first", newText: "changed" }] });
      assert.notEqual(edited.isError, true, JSON.stringify(edited)); assert.equal(await fs.readFile(path.join(project, "input.txt"), "utf8"), "changed\nsecond");
      const other = await invoke("powershell", { cwd: additional, command: "[IO.File]::WriteAllText((Join-Path $PWD 'output.txt'),'direct')" });
      assert.equal(other.details.execution.exitCode, 0, JSON.stringify(other)); assert.equal(await fs.readFile(path.join(additional, "output.txt"), "utf8"), "direct");
    } else {
      const blocked = await invoke("powershell", { command: "$ErrorActionPreference='Stop'; try { [IO.File]::WriteAllText((Join-Path $PWD 'input.txt'),'changed'); throw 'UNEXPECTED_WRITE' } catch {if($_.Exception.Message -eq 'UNEXPECTED_WRITE'){throw}; 'DENIED'}" });
      assert.equal(blocked.details.execution.exitCode, 0); assert.match(blocked.details.execution.stdout, /DENIED/);
      assert.equal(await fs.readFile(path.join(project, "input.txt"), "utf8"), "first\nsecond");
    }
  } finally {
    await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose();
    assert.equal(owner.diagnostics.process.active, false); assert.equal(owner.diagnostics.process.retainedStreams, 0);
    assert.equal(owner.diagnostics.root, undefined); assert.equal(windowsShellJobDiagnostics().handles, 0);
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
  }
});
