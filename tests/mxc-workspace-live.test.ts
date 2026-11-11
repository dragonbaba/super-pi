import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FILE_LIMIT, TEXT_LIMIT } from "../packages/coding-agent/src/core/sandbox/mxc-file-limits.mjs";
import { windowsShellJobDiagnostics } from "../packages/coding-agent/src/utils/windows-shell-job.ts";

const enabled = process.platform === "win32" && process.env.SUPERPI_MXC_LIVE === "1";
const distRoot = "../packages/coding-agent/dist/core/";
const SandboxTools: typeof WorkspaceSandboxTools = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
  ? (await import(distRoot + "sandbox/workspace-tools.js")).WorkspaceSandboxTools : WorkspaceSandboxTools;
const jobDiagnostics = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
  ? (await import(distRoot + "../utils/windows-shell-job.js")).windowsShellJobDiagnostics : windowsShellJobDiagnostics;
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

for (const mode of ["read-only", "sandbox-write"] as const) test(`live MXC ${mode}: PowerShell, files, protection and release`, { skip: !enabled, timeout: 60000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mxc-live-")));
  const project = path.join(root, "项目 space"), additional = path.join(root, "Additional Space"), parent = path.join(root, "runtime");
  for (const directory of [project, additional, parent, path.join(project, ".git"), path.join(project, ".sp")]) await fs.mkdir(directory);
  await fs.writeFile(path.join(project, "input.txt"), "first\nsecond");
  await fs.mkdir(path.join(project, "search")); await fs.mkdir(path.join(project, "gaps"));
  await fs.writeFile(path.join(project, "search", "a.txt"), "needle needle\nneedle\n");
  await fs.writeFile(path.join(project, "search", "b.txt"), "needle\n");
  await fs.writeFile(path.join(project, "gaps", "large"), "x".repeat(FILE_LIMIT) + "needle");
  await fs.writeFile(path.join(project, "long.txt"), "x".repeat(TEXT_LIMIT - 1) + "😀tail");
  await fs.writeFile(path.join(project, "line-boundary.txt"), "x".repeat(TEXT_LIMIT) + "\r\nnext");
  await fs.writeFile(path.join(additional, "asset.txt"), "additional");
  for (const directory of [".git", ".sp"]) await fs.writeFile(path.join(project, directory, "protected"), "kept");
  const outside = path.join(root, "outside.txt"); await fs.writeFile(outside, "private");
  const runtime = createExtensionRuntime(); runtime.appendEntry = () => {};
  const policy = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "sandbox", {}, mode, [additional]);
  const owner = new SandboxTools(project, parent, mode, () => runtime, { directories: [additional.toUpperCase()], network: "disabled" });
  const definitions = owner.install({});
  for (const definition of Object.values(definitions)) policy.registerDefinition(definition);
  const ctx: any = { cwd: project, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: SessionManager.inMemory(project) };
  const initialJobCount = jobDiagnostics().created;
  let id = 0;
  async function invoke(name: string, input: any) {
    const call = "live-" + ++id, authorization = await policy.authorize({ type: "tool_call", toolName: name, toolCallId: call, input }, ctx, definitions[name]);
    try { authorization.consume(input, call, name); return await definitions[name]!.execute(call, input, ctx.signal, undefined, ctx) as any; }
    finally { authorization.release(); }
  }
  try {
    assert.equal(definitions.bash, undefined);
    const firstStart = performance.now();
    const read = await invoke("read", { path: "input.txt", offset: 2, limit: 1 });
    const firstReadMs = performance.now() - firstStart;
    assert.notEqual(read.isError, true, JSON.stringify(read)); assert.match(read.content[0].text, /^second/);
    assert.equal(read.details.read.windowComplete, true); assert.equal(read.details.read.hasMore, false);
    const warmStart = performance.now(), window = await invoke("read", { path: "input.txt", limit: 1 });
    const reusedReadMs = performance.now() - warmStart;
    assert.equal(window.details.read.windowComplete, true); assert.equal(window.details.read.hasMore, true); assert.equal(window.details.read.nextOffset, 2);
    const clipped = await invoke("read", { path: "long.txt", limit: 1 });
    assert.equal(clipped.details.read.lineTruncated, true); assert.equal(clipped.details.read.nextOffset, undefined);
    assert.match(clipped.content[0].text, /^\[Read window incomplete:/); assert.equal(clipped.content[0].text.isWellFormed(), true);
    const boundary = await invoke("read", { path: "line-boundary.txt", limit: 1 });
    assert.equal(boundary.details.read.windowComplete, true); assert.equal(boundary.details.read.nextOffset, 2);
    const continuation = await invoke("read", { path: "line-boundary.txt", offset: boundary.details.read.nextOffset });
    assert.match(continuation.content[0].text, /^next/); assert.equal(continuation.details.snapshot, boundary.details.snapshot);
    const eof = await invoke("read", { path: "input.txt", offset: Number.MAX_SAFE_INTEGER });
    assert.equal(eof.isError, false); assert.equal(eof.details.read.returnedLines, 0); assert.equal(eof.details.read.hasMore, false);
    const samples: { outputMode: string; milliseconds: number; resultBytes: number }[] = [];
    for (const outputMode of ["content", "files", "count"]) {
      const started = performance.now(), result = await invoke("grep", { path: "search", pattern: "needle", outputMode });
      samples.push({ outputMode, milliseconds: performance.now() - started, resultBytes: Buffer.byteLength(JSON.stringify(result)) });
      assert.equal(result.details.search.scanComplete, true); assert.equal(result.details.search.coverageComplete, true);
      assert.equal(result.details.search.outputMode, outputMode);
      const rows = result.content[0].text.split("\n");
      if (outputMode === "files") assert.deepEqual(new Set(rows), new Set([path.join("search", "a.txt"), path.join("search", "b.txt")]));
      if (outputMode === "count") assert.deepEqual(new Set(rows), new Set([path.join("search", "a.txt") + ":2", path.join("search", "b.txt") + ":1"]));
      if (outputMode === "content") assert.equal(rows.length, 3);
    }
    const gap = await invoke("grep", { path: "gaps", pattern: "needle" });
    assert.equal(gap.details.search.scanComplete, true); assert.equal(gap.details.search.coverageComplete, false);
    assert.equal(gap.details.search.skippedTooLarge, 1); assert.match(gap.content[0].text, /Unchecked content remains/);
    assert.match(gap.content[0].text, /Inspect known skipped paths/);
    assert.doesNotMatch(gap.content[0].text, /Narrow the search scope/);
    const asset = await invoke("read", { path: path.join(additional.toUpperCase(), "asset.txt") });
    assert.notEqual(asset.isError, true, JSON.stringify(asset)); assert.match(asset.content[0].text, /additional/);
    const command = await invoke("powershell", { command: "[Console]::Write($PSVersionTable.PSVersion.Major); node --version; npm --version" });
    assert.equal(command.details.execution.exitCode, 0, JSON.stringify(command)); assert.match(command.details.execution.stdout, /^7v/);
    assert.equal(command.details.execution.stderr, "");
    t.diagnostic(JSON.stringify({ mode, dist: process.env.SUPERPI_SANDBOX_USE_DIST === "1", windows: os.release(), node: process.version,
      mxcSdk: "1.0.1 (validated by backend)", powershellMajor: 7, firstReadMs, reusedReadMs, samples }));
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
      const continued = await invoke("edit", { path: ".venv/local.txt", snapshot: created.details.snapshot, edits: [{oldText:"installed",newText:"continued"}] });
      assert.notEqual(continued.isError,true,JSON.stringify(continued));assert.equal(await fs.readFile(path.join(project,".venv/local.txt"),"utf8"),"continued");
      const current = await invoke("read", { path: "input.txt" });
      const edited = await invoke("edit", { path: "input.txt", snapshot: current.details.snapshot, edits: [{ oldText: "first", newText: "changed" }] });
      assert.notEqual(edited.isError, true, JSON.stringify(edited)); assert.equal(await fs.readFile(path.join(project, "input.txt"), "utf8"), "changed\nsecond");
      const secondEdit=await invoke("edit",{path:"input.txt",snapshot:edited.details.snapshot,edits:[{oldText:"second",newText:"SECOND"}]});assert.notEqual(secondEdit.isError,true,JSON.stringify(secondEdit));
      const thirdEdit=await invoke("edit",{path:"input.txt",snapshot:secondEdit.details.snapshot,edits:[{oldText:"changed",newText:"final"}]});assert.notEqual(thirdEdit.isError,true,JSON.stringify(thirdEdit));
      assert.equal(await fs.readFile(path.join(project,"input.txt"),"utf8"),"final\nSECOND");
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
    assert.equal(owner.diagnostics.root, undefined); assert.equal(jobDiagnostics().handles, 0); assert.equal(jobDiagnostics().processHandles, 0);
    assert.ok(jobDiagnostics().created > initialJobCount, "Observe the same Job owner used by the selected backend");
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
  }
});
