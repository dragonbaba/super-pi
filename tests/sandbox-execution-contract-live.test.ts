import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { sessionDirectories } from "../packages/coding-agent/src/core/session-execution-profile.ts";

const enabled = process.platform === "win32" && process.env.SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE === "1";
// Resolve emitted modules only for the opt-in release test; clean source checks need no dist declarations.
const distRoot = "../packages/coding-agent/dist/core/";
const SandboxTools: typeof WorkspaceSandboxTools = process.env.SUPERPI_SANDBOX_USE_DIST === "1" ? (await import(distRoot + "sandbox/workspace-tools.js")).WorkspaceSandboxTools : WorkspaceSandboxTools;
const Policy: typeof SessionExecutionPolicy = process.env.SUPERPI_SANDBOX_USE_DIST === "1" ? (await import(distRoot + "execution-policy.js")).SessionExecutionPolicy : SessionExecutionPolicy;
const createRuntime: typeof createExtensionRuntime = process.env.SUPERPI_SANDBOX_USE_DIST === "1" ? (await import(distRoot + "extensions/loader.js")).createExtensionRuntime : createExtensionRuntime;
const normalizeDirectories: typeof sessionDirectories = process.env.SUPERPI_SANDBOX_USE_DIST === "1" ? (await import(distRoot + "session-execution-profile.js")).sessionDirectories : sessionDirectories;
function bashQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

test("live additional workspace accepts native identity from a different case spelling", { skip: !enabled, timeout: 180000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "directory-identity-live-")));
  const project = path.join(root, "project"), assets = path.join(root, "Assets Space"), artifacts = path.join(root, "owner");
  for (const directory of [project, assets, artifacts]) await fs.mkdir(directory);
  await fs.writeFile(path.join(assets, "input.txt"), "native identity");
  const directories = normalizeDirectories(project, [assets.toUpperCase()]);
  assert.deepEqual(directories, [await fs.realpath(assets)]);
  const runtime = createRuntime(); runtime.appendEntry = () => {};
  const policy = runtime.nativePermissions = new Policy(runtime, "sandbox", {}, "sandbox-write", directories);
  const owner = new SandboxTools(project, artifacts, "sandbox-write", () => runtime, { directories, network: "disabled" });
  const definitions: Record<string, any> = {}; owner.install(definitions);
  for (const definition of Object.values(definitions)) policy.registerDefinition(definition);
  const ctx: any = { cwd: project, hasUI: false, signal: runtime.executionBoundary.signal,
    sessionManager: { getSessionId: () => "directory-identity-live", getLeafEntry: () => undefined } };
  try {
    for (const spelling of [assets, assets.toUpperCase()]) {
      const input = { path: path.join(spelling, "input.txt") };
      const authorization = await policy.authorize({ type: "tool_call", toolName: "read", toolCallId: "read", input }, ctx, definitions.read);
      try {
        authorization.consume(input, "read", "read");
        const result = await definitions.read.execute("read", input, ctx.signal, undefined, ctx);
        assert.notEqual(result.isError, true); assert.match(result.content[0].text, /native identity/);
      } finally { authorization.release(); }
    }
    console.log("DIRECTORY_IDENTITY_LIVE " + JSON.stringify({ caseAlias: true, canonicalControl: true, reads: 2 }));
  } finally {
    await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose();
    assert.equal(owner.diagnostics.ownedArtifacts, 0);
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
  }
});

test("live unified workspace: both shells, additional directory, byte artifacts, conflicts and release", { skip: !enabled, timeout: 300000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "execution-contract-live-")));
  const project = path.join(root, "项目 space 'quote'"), assets = path.join(root, "素材 space"), artifacts = path.join(root, "owner");
  for (const directory of [project, assets, artifacts]) await fs.mkdir(directory);
  await fs.writeFile(path.join(project, "baseline.txt"), "baseline");
  await fs.writeFile(path.join(assets, "input.txt"), "input");
  const runtime = createRuntime(); let journals = 0;
  runtime.appendEntry = () => { journals++; };
  const policy = runtime.nativePermissions = new Policy(runtime, "sandbox", {}, "sandbox-write", [assets]);
  const owner = new SandboxTools(project, artifacts, "sandbox-write", () => runtime, { directories: [assets], network: "disabled" });
  const definitions: Record<string, any> = {}; owner.install(definitions);
  for (const definition of Object.values(definitions)) policy.registerDefinition(definition);
  const ctx: any = { cwd: project, hasUI: false, signal: runtime.executionBoundary.signal,
    sessionManager: { getSessionId: () => "live-contract", getLeafEntry: () => undefined } };
  let call = 0;
  async function invoke(name: string, args: Record<string, unknown>) {
    const id = "live-" + ++call, authorization = await policy.authorize({ type: "tool_call", toolName: name, toolCallId: id, input: args } as any, ctx, definitions[name]);
    try {
      authorization.consume(args, id, name, ctx.signal);
      const result = await definitions[name].execute(id, args, ctx.signal, undefined, ctx);
      assert.notEqual(result.isError, true, JSON.stringify(result)); return result;
    } finally { authorization.release(); }
  }
  try {
    assert.match((await invoke("read", { path: path.join(assets, "input.txt") })).content[0].text, /input/);
    const ps = await invoke("powershell", { command: "[pscustomobject]@{cwd=$PWD.Path;ps=$PSVersionTable.PSVersion.Major;magick=[bool](Get-Command magick -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress" });
    const environment = JSON.parse(ps.content[0].text); assert.equal(environment.cwd, project); assert.equal(environment.ps, 7);
    if (process.env.SUPERPI_EXPECT_MAGICK === "1") assert.equal(environment.magick, true, "Persistent PATH installation must be discoverable after refresh");
    // Exercise the actual supervisor with a C: cwd and a guest-only extra drive
    // absent from toolchains. All fixture data lives inside the owned VM.
    const driveProbe = String.raw`
$drive = @('Z','Y','W','V' | Where-Object { -not (Test-Path ($_+':\')) })[0]
if (!$drive) { throw 'No unused guest fixture drive' }
$extra = 'C:\SuperPiToolchains\'+$drive+'\workspace'
New-Item -ItemType Directory -Path 'C:\SuperPiDrivePrimary',$extra -Force | Out-Null
[IO.File]::WriteAllText(($extra+'\input.txt'),'additional-drive')
$commands = @{powershell="[IO.File]::ReadAllText('"+$drive+":\workspace\input.txt')";bash='cat /'+$drive.ToLower()+'/workspace/input.txt'}
$observed = @{}
foreach ($shell in @('powershell','bash')) {
  [IO.File]::WriteAllText('C:\SuperPiExchange\command.txt',$commands[$shell],[Text.UTF8Encoding]::new($false))
  & 'C:\SuperPiTools\command.exe' 'C:\SuperPiExchange' 'C:\SuperPiWorkspace' '30000' 'C:\SuperPiDrivePrimary' $shell $drive
  if ($LASTEXITCODE -ne 0) { throw 'Nested drive supervisor failed' }
  $result = Get-Content -LiteralPath 'C:\SuperPiExchange\command-result.json' -Raw | ConvertFrom-Json
  if (!$result.closed -or $result.exitCode -ne 0) { throw 'Additional drive shell failed' }
  $observed[$shell] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($result.stdoutBase64)).Trim()
}
$observed | ConvertTo-Json -Compress
`;
    const driveResult = await invoke("powershell", { command: driveProbe, timeout: 120 });
    assert.deepEqual(JSON.parse(driveResult.content[0].text), { powershell: "additional-drive", bash: "additional-drive" });
    const source = "const fs=require('node:fs');fs.mkdirSync('export');const png=Buffer.from('89504e470d0a1a0a00000000','hex');for(let i=0;i<48;i++)fs.writeFileSync('export/'+i+'.png',png);fs.writeFileSync('large.bin',Buffer.alloc(2*1024*1024,0x93));fs.writeFileSync(" + JSON.stringify(path.join(assets, "output.bin")) + ",png);console.log(JSON.stringify({cwd:process.cwd(),input:fs.readFileSync(" + JSON.stringify(path.join(assets, "input.txt")) + ",'utf8')}))";
    const result = await invoke("bash", { command: "node -e " + bashQuote(source), timeout: 120 });
    assert.equal(JSON.parse(result.content[0].text).cwd, project);
    assert.equal(result.details.writeback.length, 50);
    assert.equal((await fs.readdir(path.join(project, "export"))).length, 48);
    assert.equal(createHash("sha256").update(await fs.readFile(path.join(project, "large.bin"))).digest("hex"), createHash("sha256").update(Buffer.alloc(2 * 1024 * 1024, 0x93)).digest("hex"));
    assert.equal((await fs.readFile(path.join(assets, "output.bin"))).toString("hex"), "89504e470d0a1a0a00000000");
    await invoke("bash", { command: "node -e " + bashQuote("require('fs').writeFileSync('large.bin',Buffer.alloc(2*1024*1024,0x94))") });
    assert.equal((await fs.readFile(path.join(project, "large.bin")))[0], 0x94);
    await invoke("file_batch", { operations: [{ operation: "write", path: "primary-batch.txt", content: "primary" }, { operation: "write", path: path.join(assets, "secondary-batch.txt"), content: "secondary" }] });
    assert.equal(await fs.readFile(path.join(assets, "secondary-batch.txt"), "utf8"), "secondary");
    await invoke("move", { path: path.join(assets, "output.bin"), destination: path.join(assets, "moved.bin") });
    assert.equal((await fs.readFile(path.join(assets, "moved.bin"))).toString("hex"), "89504e470d0a1a0a00000000");
    await invoke("bash", { command: "rm large.bin" });
    await assert.rejects(fs.stat(path.join(project, "large.bin")), { code: "ENOENT" });
    await fs.writeFile(path.join(project, "baseline.txt"), "external editor");
    await assert.rejects(invoke("bash", { command: "printf changed > baseline.txt" }), /Original source identity changed/);
    assert.equal(await fs.readFile(path.join(project, "baseline.txt"), "utf8"), "external editor");
    console.log("EXECUTION_CONTRACT_LIVE " + JSON.stringify({ filesPublished: 50, largeBytes: 2 * 1024 * 1024, secondaryWrite: true, conflictPreserved: true, additionalDriveWithoutToolchain: true, environment, journals }));
  } finally {
    await owner.close(); policy.dispose(); await runtime.executionBoundary.dispose();
    assert.equal(owner.diagnostics.ownedArtifacts, 0); assert.equal(owner.diagnostics.sourceFiles, 0);
    assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
  }
});

test("live readonly workspaces and failed shell execution retain truthful outcomes", { skip: !enabled, timeout: 300000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "execution-readonly-live-")));
  const project = path.join(root, "project"), additional = path.join(root, "additional"), artifacts = path.join(root, "owner");
  for (const directory of [project, additional, artifacts]) await fs.mkdir(directory);
  for (const directory of [project, additional]) await fs.writeFile(path.join(directory, "input.txt"), "original");
  const runtime = createRuntime(), owner = new SandboxTools(project, artifacts, "read-only", () => runtime, { directories: [additional] });
  runtime.nativePermissions = new Policy(runtime, "sandbox", {}, "read-only", [additional]);
  const definitions: Record<string, any> = {}; owner.install(definitions);
  for (const definition of Object.values(definitions)) runtime.nativePermissions.registerDefinition(definition);
  const ctx: any = { cwd: project, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: { getSessionId: () => "readonly-live", getLeafEntry: () => undefined } };
  try {
    const script = "const fs=require('fs'),paths=" + JSON.stringify([path.join(project, "input.txt"), path.join(additional, "input.txt")])
      + ";console.log(JSON.stringify(paths.map(p=>{try{fs.writeFileSync(p,'bad');return false}catch{return true}})))";
    const result = await definitions.bash.execute("readonly", { command: "node -e " + bashQuote(script) }, ctx.signal, undefined, ctx);
    assert.notEqual(result.isError, true, JSON.stringify(result)); assert.deepEqual(JSON.parse(result.content[0].text), [true, true]);
    const failed = await definitions.bash.execute("failure", { command: "printf retained-output; exit 23" }, ctx.signal, undefined, ctx);
    assert.equal(failed.isError, true); assert.equal(failed.details.phase, "execution");
    assert.equal(failed.details.shellExecution.started, true); assert.equal(failed.details.shellExecution.exitCode, 23);
    assert.equal(failed.details.shellExecution.observationError, undefined, "a real nonzero exit is not an observation failure");
    assert.match(failed.content[0].text, /retained-output/);
    await definitions.read.execute("warm", { path: "input.txt" }, ctx.signal, undefined, ctx);
    const timed = await definitions.bash.execute("timeout", { command: "printf timeout-entered; sleep 15", timeout: 3 }, ctx.signal, undefined, ctx);
    assert.equal(timed.isError, true); assert.equal(timed.details.shellExecution.termination, "timeout");
    assert.match(timed.content[0].text, /timeout-entered/);
    for (const directory of [project, additional]) assert.equal(await fs.readFile(path.join(directory, "input.txt"), "utf8"), "original");
    console.log("READONLY_EXECUTION_LIVE " + JSON.stringify({ bothDirectoriesProtected: true, failureExit: 23, stdoutRetained: true, timeoutAfterCommandEntry: true }));
  } finally {
    await owner.close(); runtime.nativePermissions.dispose(); await runtime.executionBoundary.dispose();
    assert.equal(owner.diagnostics.ownedArtifacts, 0); await fs.rm(root, { recursive: true });
  }
});
