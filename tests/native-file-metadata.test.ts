import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, readFile, chmod, lstat, rm, mkdir, link, cp, readdir, open } from "node:fs/promises";
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
import { protectWindowsFixture } from "./helpers/native-metadata-fixture.ts";
import { Worker } from "node:worker_threads";
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
  await protectWindowsFixture(target);
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

test("N2 Windows legacy explicit DACL preselects object preservation and keeps exact ACE semantics", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), initial = await capturePathIdentity(f.target);
  const first = await nativeFileRequest("inspect", { path: f.target, expected: initial });
  await execute(process.execPath, [fileURLToPath(new URL("./fixtures/native-legacy-dacl.mjs", import.meta.url)), f.target, first.security], { windowsHide: true });
  const target = await capturePathIdentity(f.target), original = await nativeFileRequest("inspect", { path: f.target, expected: target });
  assert.equal(Buffer.from(original.security, "base64").readUInt16LE(2) & 0x1400, 0);
  const plan = await planFor(f.target, f.before);
  assert.equal(plan.metadata.strategy, "protected_in_place"); assert.match(plan.metadata.reason!, /Legacy unprotected Windows DACL/);
  const receipt = await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  assert.equal(receipt.outcome, "committed"); assert.deepEqual(await readFile(f.target), f.after);
  const after = await capturePathIdentity(f.target), actual = await nativeFileRequest("inspect", { path: f.target, expected: after });
  assert.equal(after.inode, target.inode); assert.equal(actual.securityFingerprint, original.securityFingerprint);
  assert.equal(actual.creationTime, original.creationTime); assert.equal(actual.attributes, original.attributes);
});

test("N2 Windows modern inherited DACL keeps staged replacement and metadata", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await execute(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';$a=[IO.File]::GetAccessControl($env:N2_FIXTURE);$a.SetAccessRuleProtection($false,$true);[IO.File]::SetAccessControl($env:N2_FIXTURE,$a)"], { windowsHide: true, env: { ...process.env, N2_FIXTURE: f.target } });
  const target = await capturePathIdentity(f.target), original = await nativeFileRequest("inspect", { path: f.target, expected: target });
  assert.ok(Buffer.from(original.security, "base64").readUInt16LE(2) & 0x400);
  const plan = await planFor(f.target, f.before); assert.equal(plan.metadata.strategy, "staged_replace");
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  assert.deepEqual(await readFile(f.target), f.after);
  assert.notEqual((await capturePathIdentity(f.target)).inode, target.inode);
});

test("N2 Windows control-only DACL drift is observed before any content effects", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), plan = await planFor(f.target, f.before);
  const before = await nativeFileRequest("inspect", { path: f.target, expected: plan.target });
  await execute(process.execPath, [fileURLToPath(new URL("./fixtures/native-legacy-dacl.mjs", import.meta.url)), f.target, before.security, "control-only"], { windowsHide: true });
  const after = await nativeFileRequest("inspect", { path: f.target, expected: plan.target });
  const left = Buffer.from(before.security, "base64"), right = Buffer.from(after.security, "base64");
  assert.equal(left.readUInt16LE(2) ^ right.readUInt16LE(2), 0x400);
  left.writeUInt16LE(right.readUInt16LE(2), 2); assert.deepEqual(left, right, "ACE bytes/owner/group unchanged");
  assert.notEqual(before.securityFingerprint, after.securityFingerprint);
  await assert.rejects(commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical }), /changed/);
  assert.equal(await readFile(f.target, "utf8"), f.before);
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

test("N2 Linux refuses special bits even on hardlinks before any content effects", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t); await link(f.target, join(f.root, "alias")); await chmod(f.target, 0o4755);
  await assert.rejects(planFor(f.target, f.before), /Special mode bits/);
  assert.equal(Number((await lstat(f.target)).mode) & 0o7777, 0o4755);
  assert.equal(await readFile(f.target, "utf8"), f.before);
  assert.equal((await readdir(f.root)).some(name => name.startsWith(".pi-file-commit-")), false);
});

test("N2 Linux default parent ACL preselects compatibility for an ACL-free existing target", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const script = "import os,sys,struct; acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in [(1,7,0xffffffff),(2,4,65534),(4,5,0xffffffff),(16,5,0xffffffff),(32,0,0xffffffff)]); os.setxattr(sys.argv[1],'system.posix_acl_default',acl); assert not os.listxattr(sys.argv[2]); print(acl.hex())";
  const { stdout: acl } = await execute("python3", ["-c", script, f.root, f.target]);
  const original = await lstat(f.target), plan = await planFor(f.target, f.before);
  assert.equal(plan.metadata.strategy, "protected_in_place"); assert.match(plan.metadata.reason!, /Parent default ACL/);
  assert.deepEqual(await readdir(f.root), ["测试.txt"]);
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  const actual = await lstat(f.target); assert.equal(actual.ino, original.ino); assert.equal(actual.mode, original.mode);
  const { stdout } = await execute("python3", ["-c", "import os,sys; assert not os.listxattr(sys.argv[2]); print(os.getxattr(sys.argv[1],'system.posix_acl_default').hex())", f.root, f.target]);
  assert.equal(stdout, acl); assert.deepEqual(await readFile(f.target), f.after);
});

test("N2 Linux value fingerprints frame names and lengths despite ambiguous decimal concatenations", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t), handle = await open(f.target, "r"); t.after(() => handle.close());
  // Both old unframed encodings are byte-identical: 1|2|30|aaaa...18bbbb... and 12|30aaaa...|18|bbbb...
  assert.equal("1" + "2" + "30" + "a".repeat(10) + "18" + "b".repeat(18), "12" + "30" + "a".repeat(10) + "18" + "b".repeat(18));
  await execute("python3", ["-c", "import os,sys; p=sys.argv[1]; os.setxattr(p,'user.a',b''); os.setxattr(p,'user.b',b''); a,b=os.listxattr(p); os.setxattr(p,a,b'2'); os.setxattr(p,b,b'a'*10+b'18'+b'b'*18)", f.target]);
  const before = await nativeFileRequest("inspect", { fd: handle.fd });
  await execute("python3", ["-c", "import os,sys; p=sys.argv[1]; a,b=os.listxattr(p); os.setxattr(p,a,b'30'+b'a'*10); os.setxattr(p,b,b'b'*18)", f.target]);
  const after = await nativeFileRequest("inspect", { fd: handle.fd });
  assert.equal(after.namesFingerprint, before.namesFingerprint); assert.notEqual(after.valuesFingerprint, before.valuesFingerprint);
});

test("N2 Windows non-default token ownership preselects preservation without staging (injected capability)", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), before = await lstat(f.target), emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, "emit", function(this: Worker, name: string, ...args: any[]) {
    if (name === "message" && args[0]?.value?.ownerAssignable !== undefined) args[0].value.ownerAssignable = false;
    return Reflect.apply(emit, this, [name, ...args]);
  });
  const plan = await planFor(f.target, f.before);
  assert.equal(plan.metadata.strategy, "protected_in_place"); assert.match(plan.metadata.reason!, /Owner\/group differ/);
  assert.deepEqual(await readdir(f.root), ["测试.txt"]);
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  assert.equal((await lstat(f.target)).ino, before.ino); assert.deepEqual(await readFile(f.target), f.after);
  assert.equal((await nativeFileRequest("stats")).activeHandles, 0);
});

test("N2 Windows actual non-default current-user owner is preserved without privilege adjustment", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), identity = await capturePathIdentity(f.target);
  const initial = await nativeFileRequest("inspect", { path: f.target, expected: identity, capability: true });
  assert.equal(initial.ownerAssignable, true);
  const script = "$ErrorActionPreference='Stop';$p=$env:N2_FIXTURE;$a=[IO.File]::GetAccessControl($p);$u=[Security.Principal.WindowsIdentity]::GetCurrent().User;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u.Value){'same-default';exit};$a.SetOwner($u);[IO.File]::SetAccessControl($p,$a);'owner-changed'";
  const { stdout } = await execute(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, N2_FIXTURE: f.target } });
  if (stdout.trim() === "same-default") { t.skip("Token default owner already is TokenUser; no different assignable owner fixture without privileges."); return; }
  assert.equal(stdout.trim(), "owner-changed");
  const before = await nativeFileRequest("inspect", { path: f.target, expected: identity, capability: true });
  assert.equal(before.ownerAssignable, false);
  const plan = await planFor(f.target, f.before); assert.equal(plan.metadata.strategy, "protected_in_place");
  assert.match(plan.metadata.reason!, /Owner\/group differ/);
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  const after = await nativeFileRequest("inspect", { path: f.target, expected: identity });
  assert.equal(after.securityFingerprint, before.securityFingerprint); assert.deepEqual(await readFile(f.target), f.after);
});

test("N2 Linux hardlink capability observation is refused before compatibility selection (injected native observation)", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t); await link(f.target, join(f.root, "alias"));
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, "emit", function(this: Worker, name: string, ...args: any[]) {
    if (name === "message" && typeof args[0]?.value?.hasAttributes === "boolean") args[0].value.writeClearsAttributes = true;
    return Reflect.apply(emit, this, [name, ...args]);
  });
  await assert.rejects(planFor(f.target, f.before), /File capabilities may be cleared/);
  assert.equal(await readFile(f.target, "utf8"), f.before); assert.deepEqual(await readdir(f.root), ["alias", "测试.txt"]);
});

test("N2 Linux non-assignable group preselects object preservation (injected process groups)", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t), info = await lstat(f.target), foreign = info.gid === 12345 ? 12346 : 12345;
  const credentials = process as { geteuid(): number; getegid(): number; getgroups(): number[] };
  t.mock.method(credentials, "geteuid", () => info.uid === 0 ? foreign : info.uid);
  // A root-owned fixture first selects foreign-owner preservation; ordinary CI
  // owners exercise the group gate without changing process credentials.
  t.mock.method(credentials, "getegid", () => foreign); t.mock.method(credentials, "getgroups", () => [foreign]);
  const plan = await planFor(f.target, f.before); assert.equal(plan.metadata.strategy, "protected_in_place");
  assert.match(plan.metadata.reason!, info.uid === 0 ? /Foreign owner/ : /Target group cannot be assigned/);
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  assert.equal((await lstat(f.target)).gid, info.gid); assert.equal((await lstat(f.target)).ino, info.ino); assert.deepEqual(await readFile(f.target), f.after);
});

test("N2 Linux POSIX ACL bytes and mode survive preselected in-place commit", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const script = "import os,sys,struct; p=sys.argv[1]; acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in [(1,7,0xffffffff),(2,4,65534),(4,5,0xffffffff),(16,5,0xffffffff),(32,0,0xffffffff)]); os.setxattr(p,'system.posix_acl_access',acl); print(os.getxattr(p,'system.posix_acl_access').hex())";
  const { stdout: before } = await execute("python3", ["-c", script, f.target]);
  const mode = (await lstat(f.target)).mode, plan = await planFor(f.target, f.before);
  assert.equal(plan.metadata.strategy, "protected_in_place");
  await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
  const { stdout: after } = await execute("python3", ["-c", "import os,sys; print(os.getxattr(sys.argv[1],'system.posix_acl_access').hex())", f.target]);
  assert.equal(after, before); assert.equal((await lstat(f.target)).mode, mode); assert.deepEqual(await readFile(f.target), f.after);
});

test("N2 Linux writable file under non-writable parent preselects compatibility", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t); await chmod(f.root, 0o500);
  try {
    const plan = await planFor(f.target, f.before);
    assert.equal(plan.metadata.strategy, "protected_in_place"); assert.match(plan.metadata.reason!, /Parent directory/);
    const result = await commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical });
    assert.equal(result.outcome, "committed"); assert.deepEqual(await readFile(f.target), f.after);
    assert.equal((await capturePathIdentity(f.target)).inode, plan.target.inode);
  } finally { await chmod(f.root, 0o700); }
});

test("N2 final worker rejects staged metadata drift before replacement", { skip: !supported }, async t => {
  const f = await fixture(t), plan = await planFor(f.target, f.before), publish = plan.metadata.replace;
  const original = await lstat(f.target, { bigint: true });
  plan.metadata.replace = async (path, target, validation) => {
    if (process.platform === "linux") await chmod(path, Number(original.mode) ^ 0o020);
    else await nativeFileRequest("protect", { path, expected: validation.temporary });
    await publish(path, target, validation);
  };
  await assert.rejects(commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical }), (error: unknown) => {
    assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.outcome, "not_committed");
    assert.match(error.message, /Publication.*(mode|metadata).*changed/); return true;
  });
  assert.equal(await readFile(f.target, "utf8"), f.before); assert.equal((await lstat(f.target, { bigint: true })).mode, original.mode);
  for (const name of await readdir(f.root)) if (name.startsWith(".pi-file-commit-")) assert.equal((await lstat(join(f.root, name))).mode & 0o777, 0o600);
});

test("N2 candidate is private during writing and remains private after prepublication failure", { skip: !supported }, async t => {
  const f = await fixture(t), plan = await planFor(f.target, f.before), protect = plan.metadata.protectTemporary!;
  let checkedWrite = false;
  plan.metadata.protectTemporary = async (handle, path) => {
    await protect(handle, path);
    if (checkedWrite) return;
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...args) => {
      if (process.platform === "linux") assert.equal((await handle.stat()).mode & 0o777, 0o600);
      else {
        const stat = await handle.stat({ bigint: true });
        const metadata = await nativeFileRequest("inspect", { path, expected: { device: String(stat.dev), inode: String(stat.ino) } });
        const descriptor = Buffer.from(metadata.security, "base64"), acl = descriptor.readUInt32LE(16);
        assert.ok(descriptor.readUInt16LE(2) & 0x1000); assert.equal(descriptor.readUInt16LE(acl + 4), 1);
      }
      checkedWrite = true; await write(...args);
    };
  };
  await assert.rejects(commitPreparedFile(plan, f.after, { assertPathAllowed: async () => plan.target.canonical,
    beforeCommit: () => { throw new Error("fixture stale authority before metadata publication"); } }), /fixture stale authority/);
  assert.equal(checkedWrite, true); assert.equal(await readFile(f.target, "utf8"), f.before);
  for (const name of await readdir(f.root)) if (name.startsWith(".pi-file-commit-")) {
    assert.deepEqual(await readFile(join(f.root, name)), f.after);
    assert.equal((await lstat(join(f.root, name))).mode & 0o777, 0o600);
  }
});

test("N2 missing installed platform binary leaves reads available and explicitly refuses modification", { skip: !supported }, async t => {
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
    await assert.rejects(module.selectCommitMetadata(await capturePathIdentity(f.target)), /UNSUPPORTED_COMMIT.*Native metadata capability unavailable:.*Cannot find the native Koffi module/);
    assert.equal(await readFile(f.target, "utf8"), f.before); assert.equal(client.nativeFileDiagnostics().pending, 0);
  } finally { await client.disposeNativeFileWorker(); }
});

test("N2 module reloads share one worker and release all pending calls before disposal", { skip: !supported }, async () => {
  await disposeNativeFileWorker();
  const before = nativeFileDiagnostics().workerStarts;
  try {
    for (let i = 0; i < 10; i++) {
      const client = await import(pathToFileURL(join(sourceDirectory, "native-file-client.ts")).href + `?reload=${i}`);
      assert.equal((await client.nativeFileRequest("stats")).activeHandles, 0);
      assert.equal(client.nativeFileDiagnostics().workerStarts, before + 1);
      assert.equal(client.nativeFileDiagnostics().pending, 0);
    }
    const pending = nativeFileRequest("stats");
    await assert.rejects(disposeNativeFileWorker(), /in flight/);
    await pending;
  } finally { await disposeNativeFileWorker(); }
  assert.equal(nativeFileDiagnostics().loaded, false); assert.equal(nativeFileDiagnostics().pending, 0);
});
