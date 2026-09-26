import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, readFile, chmod, lstat, rm, mkdir, link, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { selectCommitMetadata } from "../packages/extensions/mutation-guard-write/file-commit-metadata.ts";
import { commitPreparedFile, FileCommitError } from "../packages/extensions/mutation-guard-write/file-commit.ts";
import { capturePathIdentity } from "../packages/extensions/mutation-guard-write/native-file-core.ts";
import { disposeNativeFileWorker, nativeFileDiagnostics, nativeFileRequest } from "../packages/extensions/mutation-guard-write/native-file-client.ts";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
const execute = promisify(execFile);
const sourceDirectory = fileURLToPath(new URL("../packages/extensions/mutation-guard-write/", import.meta.url));

async function planFor(target: string, before: string) {
  const identity = await capturePathIdentity(target);
  return { target: identity, parent: await capturePathIdentity(dirname(target)), metadata: await selectCommitMetadata(identity),
    previousSha256: createHash("sha256").update(before).digest("hex") };
}

const supported = process.arch === "x64" && (process.platform === "win32" || process.platform === "linux");
async function fixture(t: any, long = false) {
  const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "sp-n2-native-"));
  t.diagnostic(`ownedFixture=${root}`);
  t.after(async () => { await disposeNativeFileWorker(); assert.equal(dirname(root), temporary); await rm(root, { recursive: true, force: true }); });
  const directory = long ? join(root, "中文目录".repeat(20), "wide".repeat(30)) : root;
  await mkdir(directory, { recursive: true });
  const target = join(directory, "测试.txt"), before = "before\r\n", after = Buffer.from("\ufeffafter\r\n中文\r\n");
  await writeFile(target, before);
  return { root, target, before, after };
}

test("N2 importing commit metadata does not load a native worker", () => { assert.equal(nativeFileDiagnostics().loaded, false); });

for (const long of [false, true]) test(`N2 actual native normal-file replacement preserves observed metadata, long=${long}`, { skip: !supported }, async t => {
  const f = await fixture(t, long);
  if (process.platform === "win32") await writeFile(f.target + ":n2-fixture", "named stream retained");
  else await chmod(f.target, 0o751);
  const original = await lstat(f.target, { bigint: true });
  const target = await capturePathIdentity(f.target), parent = await capturePathIdentity(dirname(f.target));
  const metadata = await selectCommitMetadata(target);
  assert.equal(metadata.strategy, "staged_replace", metadata.reason);
  const receipt = await commitPreparedFile({ target, parent, metadata, previousSha256: createHash("sha256").update(f.before).digest("hex") }, f.after, { assertPathAllowed: async () => target.canonical });
  assert.equal(receipt.outcome, "committed"); assert.equal(receipt.fileSynced, true);
  assert.deepEqual(await readFile(f.target), f.after);
  const current = await lstat(f.target, { bigint: true });
  assert.notEqual(current.ino, original.ino);
  if (process.platform === "win32") assert.equal(await readFile(f.target + ":n2-fixture", "utf8"), "named stream retained");
  else { assert.equal(current.mode, original.mode); assert.equal(current.uid, original.uid); assert.equal(current.gid, original.gid); }
  assert.equal((await nativeFileRequest("stats")).activeHandles, 0);
  assert.equal(nativeFileDiagnostics().pending, 0);
});

test("N2 hardlinks select compatibility before writing and preserve both names", { skip: !supported }, async t => {
  const f = await fixture(t), alias = join(f.root, "linked"); await link(f.target, alias);
  const plan = await planFor(f.target, f.before);
  assert.equal(plan.metadata.strategy, "protected_in_place"); assert.match(plan.metadata.reason!, /hardlinks/);
  const receipt = await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  assert.equal(receipt.outcome, "committed"); assert.deepEqual(await readFile(alias), f.after);
  assert.equal((await lstat(alias, { bigint: true })).ino.toString(), plan.target.inode);
});

test("N2 read-only metadata is refused before staging without permission overrides", { skip: !supported }, async t => {
  const f = await fixture(t); await chmod(f.target, 0o444);
  try { await assert.rejects(planFor(f.target, f.before), /Read-only|EACCES|EPERM/); assert.equal(await readFile(f.target, "utf8"), f.before); }
  finally { await chmod(f.target, 0o600); }
});

test("N2 Windows custom protected DACL survives actual replacement", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const powershell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const readSddl = "[IO.File]::GetAccessControl($env:N2_FIXTURE).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access,Owner,Group')";
  const { stdout: before } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $a=[IO.File]::GetAccessControl($env:N2_FIXTURE); $a.SetAccessRuleProtection($true,$true); [IO.File]::SetAccessControl($env:N2_FIXTURE,$a); " + readSddl], { windowsHide: true, env: { ...process.env, N2_FIXTURE: f.target } });
  const plan = await planFor(f.target, f.before); assert.equal(plan.metadata.strategy, "staged_replace");
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  const { stdout: after } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", readSddl], { windowsHide: true, env: { ...process.env, N2_FIXTURE: f.target } });
  assert.equal(after.trim(), before.trim()); assert.deepEqual(await readFile(f.target), f.after);
});

test("N2 occupied Windows file returns verified no-change and never retries in place", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const f = await fixture(t), plan = await planFor(f.target, f.before);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-file-occupancy.mjs", import.meta.url)), f.target], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}: ${stderr}`))); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited.catch(() => {}); });
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error(stderr))); });
  try {
    await assert.rejects(commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical }), (error: unknown) => {
      assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.outcome, "not_committed"); assert.match(error.message, /Win32 32/); return true;
    });
    assert.equal(await readFile(f.target, "utf8"), f.before);
    assert.equal((await capturePathIdentity(f.target)).inode, plan.target.inode);
  } finally { if (child.connected) child.send("release"); await exited; }
  assert.equal((await nativeFileRequest("stats")).activeHandles, 0);
});

test("N2 Linux xattrs select object-preserving compatibility; inspection errors never mean absence", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  await execute("python3", ["-c", "import os,sys; os.setxattr(sys.argv[1], 'user.n2', b'keep')", f.target]);
  const plan = await planFor(f.target, f.before);
  assert.equal(plan.metadata.strategy, "protected_in_place"); assert.match(plan.metadata.reason!, /extended attributes/);
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  const { stdout } = await execute("python3", ["-c", "import os,sys; print(os.getxattr(sys.argv[1], 'user.n2').decode())", f.target]);
  assert.equal(stdout.trim(), "keep"); assert.deepEqual(await readFile(f.target), f.after);
  await assert.rejects(nativeFileRequest("inspect", { fd: -1 }), /flistxattr failed.*errno 9/);
});

test("N2 missing installed platform binary leaves reads available and selects explicit compatibility", { skip: !supported }, async t => {
  const f = await fixture(t), isolated = join(f.root, "isolated"), dependencies = join(isolated, "node_modules");
  await mkdir(dependencies, { recursive: true });
  await cp(resolve("node_modules/koffi"), join(dependencies, "koffi"), { recursive: true });
  // No @koromix platform subpackage is copied; this exercises the real loader diagnostic.
  for (const name of ["file-commit-metadata.ts", "native-file-client.ts", "native-file-worker.mjs"]) await cp(join(sourceDirectory, name), join(isolated, name));
  await writeFile(join(isolated, "package.json"), '{"type":"module"}');
  const module = await import(pathToFileURL(join(isolated, "file-commit-metadata.ts")).href);
  const client = await import(pathToFileURL(join(isolated, "native-file-client.ts")).href);
  try {
    assert.equal(client.nativeFileDiagnostics().loaded, false); assert.equal(await readFile(f.target, "utf8"), f.before);
    const selected = await module.selectCommitMetadata(await capturePathIdentity(f.target));
    assert.equal(selected.strategy, "protected_in_place"); assert.match(selected.reason, /Native staged capability unavailable:.*Cannot find the native Koffi module/);
    assert.equal(await readFile(f.target, "utf8"), f.before); assert.equal(client.nativeFileDiagnostics().pending, 0);
  } finally { await client.disposeNativeFileWorker(); }
});
