import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { inspectWindowsMutations } from "../packages/coding-agent/src/core/shell-policy/windows-mutations.ts";
import type { ShellMutationScan } from "../packages/coding-agent/src/core/shell-policy/mutation-effects.ts";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { setImmediate as tick } from "node:timers/promises";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { alphaSession } from "./helpers/alpha-session.ts";
import { analyzeNativeShell } from "../packages/coding-agent/src/core/shell-policy/native-analysis.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createBashToolDefinition } from "../packages/coding-agent/src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../packages/coding-agent/src/core/tools/powershell.ts";
import { getShellCwdBinding } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";
import { getShellConfig } from "../packages/coding-agent/src/utils/shell.ts";

const owned = createOwnedTaskFixture("host-shell-permissions-"), oldTemps = [process.env.TMP, process.env.TEMP, process.env.TMPDIR];
process.env.TMP = owned.root; process.env.TEMP = owned.root; process.env.TMPDIR = owned.root;
assert.equal(await fs.realpath(tmpdir()), await fs.realpath(owned.root));
test.after(() => {
  for (const [index, key] of ["TMP", "TEMP", "TMPDIR"].entries()) {
    if (oldTemps[index] === undefined) delete process.env[key]; else process.env[key] = oldTemps[index];
  }
  owned.cleanup();
});

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(owned.root, "case-"))), workspace = join(root, "workspace"), outside = join(root, "outside"), added = join(root, "added");
  for (const path of [workspace, outside, added]) await fs.mkdir(path);
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(workspace);
  runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
  const owner = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "trusted-host", { rules: [{ tool: "*", decision: "allow" }] }, "host-write", [added]);
  const definitions = { bash: createBashToolDefinition(workspace), powershell: createPowerShellToolDefinition(workspace) };
  const dialogs: string[] = [], notices: string[] = [];
  const ctx: any = { cwd: workspace, hasUI: true, sessionManager: manager, signal: runtime.executionBoundary.signal,
    ui: { select: async (_title: string, choices: string[], opts: any) => { dialogs.push(opts.details); return choices[0]; }, notify: (message: string) => { notices.push(message); } } };
  let sequence = 0;
  function event(toolName: "bash" | "powershell", input: object): any { return { type: "tool_call", toolCallId: String(++sequence), toolName, input }; }
  async function call(toolName: "bash" | "powershell", input: { command: string; cwd?: string; timeout?: number }) {
    const request = event(toolName, input), grant = await owner.authorize(request, ctx);
    try {
      grant.consume(input, request.toolCallId, toolName);
      return await definitions[toolName].execute(request.toolCallId, input, ctx.signal, undefined, ctx);
    } finally { grant.release(); }
  }
  t.after(async () => { owner.dispose(); await runtime.executionBoundary.dispose(); });
  return { root, workspace, outside, added, owner, ctx, call, event, dialogs, notices };
}

function scan(command: string, cwd = process.cwd(), shell: "cmd" | "powershell" = "powershell") {
  const result: ShellMutationScan = { effects: [], recognized: false, uncertain: false };
  inspectWindowsMutations(command, cwd, shell, result); return result;
}

test("Windows command grammars preserve drive paths, command tails and location changes", { skip: process.platform !== "win32" }, () => {
  const outside = String.raw`D:\outside\file.txt`;
  for (const command of [String.raw`Remove-Item D:\outside\file.txt -Recurse -Force`, String.raw`ri D:\outside\file.txt`,
    String.raw`Set-Location D:\outside; Remove-Item file.txt`, String.raw`cmd /c del /q D:\outside\file.txt`,
    String.raw`cmd /c "rd /s /q D:\outside\file.txt"`, String.raw`[System.IO.File]::Delete('D:\outside\file.txt')`]) {
    const result = scan(command);
    assert.equal(result.recognized, true, command); assert.equal(result.uncertain, false, command);
    assert.deepEqual(result.effects, [{ kind: "delete", path: outside, destination: undefined }], command);
  }
  assert.deepEqual(scan(String.raw`robocopy D:\source D:\outside /MIR`).effects,
    [{ kind: "delete-contents", path: String.raw`D:\outside`, destination: undefined }]);
});

test("PowerShell distinguishes variables, literal paths, previews, pipelines and opaque programs", () => {
  const cwd = process.cwd(), ordinary = join(cwd, "ordinary.txt");
  assert.deepEqual(scan("Remove-Item -LiteralPath 'ordinary.txt'").effects, [{ kind: "delete", path: ordinary, destination: undefined }]);
  for (const command of ['Remove-Item "$X"', "Get-ChildItem | Remove-Item", 'Set-Location "$X"; rm ordinary.txt', "Push-Location ../outside; rm ordinary.txt"]) {
    const result = scan(command); assert.equal(result.recognized, true); assert.equal(result.uncertain, true); assert.equal(result.effects.length, 0);
  }
  assert.equal(scan("Remove-Item -LiteralPath 'ordinary[1].txt'").uncertain, false);
  assert.equal(scan("Remove-Item -Path 'ordinary[1].txt'").uncertain, true);
  for (const command of ["Remove-Item ordinary.txt -WhatIf", "robocopy source dest /MIR /L", "python clean.py", "npm run clean", "Get-Content ordinary.txt"]) {
    const result = scan(command); assert.equal(result.effects.length, 0, command); assert.equal(result.uncertain, false, command);
  }
  assert.equal(scan('Remove-Item ordinary.txt -WhatIf:$false').effects.length, 1);
  assert.equal(scan("Remove-Item `\r\nordinary.txt").effects[0]!.path, ordinary);
  assert.equal(scan("Remove-Item ordinary.txt 2>$null").effects.length, 1);
  const literalDollar = scan("Set-Content -LiteralPath '$null' -Value data");
  assert.equal(literalDollar.effects[0]!.path, join(cwd, "$null"));
  const conditional = scan("if ($true) { Remove-Item ordinary.txt }");
  assert.equal(conditional.recognized, true); assert.equal(conditional.uncertain, true);
  assert.equal(scan("Write-Output 'if ($true) { Remove-Item ordinary.txt }'").recognized, false);
});

test("PowerShell emits separate copy/move operands and write destinations with bounded uncertainty", () => {
  const cwd = process.cwd();
  assert.deepEqual(scan("Copy-Item -Path source.txt -Destination ../out.txt -Force").effects,
    [{ kind: "copy", path: join(cwd, "source.txt"), destination: resolve(cwd, "../out.txt") }]);
  assert.deepEqual(scan("Move-Item source.txt ../out.txt").effects,
    [{ kind: "move", path: join(cwd, "source.txt"), destination: resolve(cwd, "../out.txt") }]);
  for (const command of ["Set-Content -LiteralPath ../out.txt -Value data", "'data' | Out-File ../out.txt", "Write-Output data > ../out.txt"]) {
    assert.equal(scan(command).effects[0]!.kind, "write"); assert.equal(scan(command).effects[0]!.path, resolve(cwd, "../out.txt"));
  }
  const array = scan("Remove-Item -LiteralPath 'one.txt','two.txt'"); assert.equal(array.effects.length, 2); assert.equal(array.uncertain, false);
  const limit = scan("Remove-Item " + Array.from({ length: 17 }, (_, index) => `file-${index}`).join(" "));
  assert.equal(limit.effects.length, 16); assert.equal(limit.uncertain, true);
});

test("native Bash composition keeps real operands, command option groups, git scopes and opacity separate", () => {
  const cwd = process.cwd();
  for (const command of ["rm -rf ../outside", "/bin/rm -rf ../outside", "bash -lc 'rm -rf ../outside'", "python -c 'import shutil; shutil.rmtree(\"../outside\")'", "node -e 'require(\"fs\").rmSync(\"../outside\",{recursive:true})'"]) {
    const result = analyzeNativeShell(command, cwd, "bash", 1);
    assert.equal(result.recognized, true, command); assert.equal(result.uncertain, false, command);
    assert.equal(result.effects[0]?.path, resolve(cwd, "../outside"), command);
  }
  assert.equal(analyzeNativeShell("mv -f one two", cwd, "bash", 1).uncertain, false);
  for (const command of ['rm -rf "$X"', 'rm -rf ~someuser', 'cd "$X"; rm file', "find . -type f -exec rm '{}' \\;", "find . -exec sh -c 'rm ../outside' \\;", "find . -exec python -c 'import os; os.unlink(\"../outside\")' \\;", "printf '%s' x | xargs rm"]) {
    const result = analyzeNativeShell(command, cwd, "bash", 1); assert.equal(result.recognized, true, command); assert.equal(result.uncertain, true, command);
  }
  for (const shell of ["bash", "powershell"] as const) {
    const overflow = analyzeNativeShell("echo x;".repeat(65) + "rm ../outside", cwd, shell, 1); assert.equal(overflow.recognized, true); assert.equal(overflow.uncertain, true);
    for (const command of ["git status", "git clean -nd", "npm run clean", "python clean.py", "echo ordinary"]) assert.equal(analyzeNativeShell(command, cwd, shell, 1).recognized, false, command);
    const clean = analyzeNativeShell("git -C ../outside clean -fd", cwd, shell, 1);
    assert.deepEqual(clean.effects, [{ kind: "git-clean", path: resolve(cwd, "../outside"), destination: undefined }]);
    assert.equal(analyzeNativeShell("git clean -fd -- .sp", cwd, shell, 1).effects[0]!.path, join(cwd, ".sp"));
    assert.equal(analyzeNativeShell("git reset --hard", cwd, shell, 1).effects[0]!.kind, "git-reset");
  }
});

test("real Windows unquoted paths, cmd tails, aliases and child temporary environment match the reviewed targets", { skip: process.platform !== "win32", timeout: 20000 }, async t => {
  const f = await fixture(t), target = join(f.outside, "owned.txt");
  for (const command of [`Remove-Item ${target} -Force`, `Set-Location '${f.outside}'; ri owned.txt`, `cmd /c del /q ${target}`]) {
    await fs.writeFile(target, "owned");
    assert.equal((await f.call("powershell", { command, timeout: 10 })).isError, undefined);
    assert.ok(f.dialogs.at(-1)!.includes(target)); await assert.rejects(fs.stat(target), { code: "ENOENT" });
  }
  const temp = await f.call("powershell", { command: "[System.IO.Path]::GetTempPath()", timeout: 10 });
  const output = temp.content.map(block => block.type === "text" ? block.text : "").join("\n");
  assert.ok(output.includes(owned.root), output);
  const array = await f.call("powershell", { command: "Set-Content -LiteralPath 'one.txt','two.txt' -Value data; Get-Content one.txt 2>&1", timeout: 10 });
  assert.equal(array.isError, undefined);
  for (const file of ["one.txt", "two.txt"]) assert.equal((await fs.readFile(join(f.workspace, file), "utf8")).trim(), "data");
  t.diagnostic(JSON.stringify({ windowsCommandForms: 3, childTempInsideOwnedRoot: true }));
});

test("host shell policy refuses sensitive deletes and external overwrites while copy sources remain readable", async t => {
  const f = await fixture(t); await fs.mkdir(join(f.workspace, ".git")); await fs.writeFile(join(f.workspace, ".git", "config"), "owned");
  await fs.writeFile(join(f.outside, "keep.txt"), "keep");
  for (const command of ["rm -rf .", "rm -rf .git", "git clean -fd -- .sp", `rm -rf '${homedir().replaceAll("\\", "/")}'`]) {
    const input = { command };
    await assert.rejects(f.owner.authorize(f.event("bash", input), f.ctx), /操作未执行.*明确告知用户/s, command);
    assert.equal(getShellCwdBinding(input)!.isReleased, true);
  }
  for (const [shell, command] of [["bash", "printf changed > ../outside/keep.txt"], ["bash", "cp .git/config ../outside/keep.txt"],
    ["powershell", "Set-Content ../outside/keep.txt -Value changed"], ["powershell", "Copy-Item .git/config ../outside -Force"]] as const) {
    // Copying to a directory overwrites only the same basename, not all directory contents.
    if (command.includes("Copy-Item")) await fs.writeFile(join(f.outside, "config"), "keep");
    await assert.rejects(f.owner.authorize(f.event(shell, { command }), f.ctx), /EXTERNAL_FILE_WRITE_BLOCKED/);
  }
  for (const command of ["cp .git/config ordinary.txt", "git clean -fd", "git reset --hard", "mkdir ../outside/new-directory", "python cleanup.py"]) {
    (await f.owner.authorize(f.event("bash", { command }), f.ctx)).release();
  }
  assert.equal(f.dialogs.length, 0); assert.equal(await fs.readFile(join(f.outside, "keep.txt"), "utf8"), "keep");
});

test("literal tilde in a HOME path stays a known critical target, including Windows short-name spellings", async t => {
  const f = await fixture(t), home = join(f.root, "home~1"); await fs.mkdir(home);
  const key = process.platform === "win32" ? "USERPROFILE" : "HOME", previous = process.env[key]; process.env[key] = home;
  try {
    const command = `rm -rf '${homedir().replaceAll("\\", "/")}'`;
    await assert.rejects(f.owner.authorize(f.event("bash", { command }), f.ctx), /HOME.*祖先/s);
    assert.equal(f.dialogs.length, 0); assert.equal((await fs.stat(home)).isDirectory(), true);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test("review: all write operands, shell redirections and absolute wrappers reach native authorization", async t => {
  const f = await fixture(t); await fs.mkdir(join(f.workspace, ".git")); await fs.writeFile(join(f.workspace, ".git", "config"), "keep");
  await fs.writeFile(join(f.outside, "existing.txt"), "keep");
  for (const [shell, command] of [
    ["powershell", "Set-Content -LiteralPath 'safe.txt','.git/config' -Value changed"],
    ["powershell", "Add-Content -Path 'safe.txt','../outside/existing.txt' -Value changed"],
    ["powershell", "git diff > .git/config"],
    ["powershell", "git status > ../outside/existing.txt"],
    ["bash", "/bin/bash -lc 'rm -rf .git'"],
  ] as const) await assert.rejects(f.owner.authorize(f.event(shell, { command }), f.ctx), /POLICY_BLOCKED|EXTERNAL_FILE_WRITE_BLOCKED/, command);
  for (const command of ["Get-ChildItem 2>&1", "git diff 2>&1", "cmd /c dir 2>&1", "Get-ChildItem 3>&1"]) {
    assert.equal(scan(command, f.workspace).recognized, false, command);
    (await f.owner.authorize(f.event("powershell", { command }), f.ctx)).release();
  }
  assert.deepEqual(scan("Set-Content safe.txt value1,value2", f.workspace).effects.map(effect => effect.path), [join(f.workspace, "safe.txt")]);
  assert.equal(scan("Write-Output x > '&1'", f.workspace).effects[0]?.path, join(f.workspace, "&1"));
  assert.equal(f.dialogs.length, 0); assert.equal(await fs.readFile(join(f.outside, "existing.txt"), "utf8"), "keep");
});

test("real shell approval targets match effects, cancellation retries, and selector refusal leaves files intact", { timeout: 30000 }, async t => {
  const f = await fixture(t), uiRoot = join(f.root, "ui"); await fs.mkdir(uiRoot);
  const ui = await alphaSession({ mode: "fullscreen", fixtureRoot: uiRoot }); assert.equal(await ui.mode.init(), true);
  f.ctx.ui = ui.internal.createExtensionUIContext(); let prompts = 0;
  ui.sink.physicalMarker = text => { if (text.includes("允许这次操作")) prompts++; };
  try {
    const shells = process.platform === "win32" ? ["bash", "powershell"] as const : ["bash"] as const;
    for (const shell of shells) {
      const previousRefusals = f.owner.listRefusals(f.ctx).length;
      const target = join(f.outside, shell + ".txt"); await fs.writeFile(target, "keep");
      const input = { command: shell === "bash" ? `rm -f '../outside/${shell}.txt'` : `Remove-Item -LiteralPath '${target}' -Force`, timeout: 10 };
      for (const action of ["cancel", "allow"] as const) {
        const pending = f.call(shell, input), cancelled = action === "cancel" ? assert.rejects(pending, /APPROVAL_CANCELLED/) : undefined;
        for (let index = 0; index < 1000 && !ui.internal.extensionSelector; index++) await tick();
        const selector = ui.internal.extensionSelector; assert.ok(selector);
        assert.equal(await fs.readFile(target, "utf8"), "keep");
        ui.internal.ui.renderNow(true); await ui.internal.ui.flushTerminalFrames();
        if (cancelled) { selector.handleInput("\x1b"); await cancelled; assert.equal(f.owner.listRefusals(f.ctx).length, previousRefusals); }
        else { selector.handleInput("\x1b[A"); selector.handleInput("\r"); const result = await pending; assert.equal(result.isError, undefined, JSON.stringify(result)); await assert.rejects(fs.stat(target), { code: "ENOENT" }); }
        assert.equal(getShellCwdBinding(input)!.isReleased, true);
      }
      await fs.writeFile(target, "keep"); const pending = f.call(shell, input), refused = assert.rejects(pending, /User declined/);
      for (let index = 0; index < 1000 && !ui.internal.extensionSelector; index++) await tick();
      const selector = ui.internal.extensionSelector; assert.ok(selector);
      ui.internal.ui.renderNow(true); await ui.internal.ui.flushTerminalFrames();
      selector.handleInput("\x1b[B"); selector.handleInput("\r"); await refused;
      assert.equal(await fs.readFile(target, "utf8"), "keep");
    }
    t.diagnostic(JSON.stringify({ realShells: shells, promptFrames: prompts, sensitiveExecutionCount: 0 }));
  } finally { ui.sink.physicalMarker = undefined; await ui.release(); }
});

test("actual cwd and symlink identity stay bound until spawn and unlink does not follow a directory link", { timeout: 20000 }, async t => {
  const f = await fixture(t), alias = join(f.workspace, "alias"); await fs.writeFile(join(f.outside, "keep.txt"), "keep");
  await fs.symlink(f.outside, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    (await f.owner.authorize(f.event("bash", { command: "rm -rf alias" }), f.ctx)).release(); assert.equal(f.dialogs.length, 0);
    (await f.owner.authorize(f.event("bash", { command: "rm -rf alias/" }), f.ctx)).release(); assert.equal(f.dialogs.length, 1);
    const input = { command: "rm -f keep.txt", cwd: alias }, request = f.event("bash", input), grant = await f.owner.authorize(request, f.ctx);
    try {
      await fs.unlink(alias); await fs.symlink(f.added, alias, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => grant.consume(input, request.toolCallId, "bash"), /SHELL_CWD_CHANGED/);
    } finally { grant.release(); }
    assert.equal(getShellCwdBinding(input)!.isReleased, true);
    await fs.unlink(alias); await fs.symlink(f.outside, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await f.call("bash", { command: "rm -rf alias", timeout: 10 })).isError, undefined);
    await assert.rejects(fs.lstat(alias), { code: "ENOENT" }); assert.equal(await fs.readFile(join(f.outside, "keep.txt"), "utf8"), "keep");
  } finally { try { await fs.unlink(alias); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  await fs.writeFile(join(f.added, "owned.txt"), "owned");
  assert.equal((await f.call("bash", { command: "rm -f owned.txt", cwd: f.added, timeout: 10 })).isError, undefined);
  assert.match(f.dialogs[1]!, /执行目录:.*outside/);
  const bash = getShellConfig().shell.replaceAll("\\", "/");
  await fs.writeFile(join(f.workspace, "wrapper-owned.txt"), "owned");
  assert.equal((await f.call("bash", { command: `'${bash}' -lc 'rm -f wrapper-owned.txt'`, timeout: 10 })).isError, undefined);
  await assert.rejects(fs.stat(join(f.workspace, "wrapper-owned.txt")), { code: "ENOENT" });
});
