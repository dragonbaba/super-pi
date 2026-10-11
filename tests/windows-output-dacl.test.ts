import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeBashWithOperations } from "../packages/coding-agent/src/core/bash-executor.ts";
import { OutputAccumulator } from "../packages/coding-agent/src/core/tools/output-accumulator.ts";
import { privateOutputFileSystem } from "../packages/coding-agent/src/utils/private-output-file.ts";
import { windowsPrivateOutputDiagnostics } from "../packages/coding-agent/src/utils/windows-private-output.ts";

function inspectAcl(path: string) {
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $acl = [System.IO.File]::GetAccessControl($env:PI_OUTPUT_ACL_TEST_PATH)
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights}
    })
    @{protected=$acl.AreAccessRulesProtected; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
      user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=$rules} | ConvertTo-Json -Depth 5 -Compress
  `], { encoding: "utf8", windowsHide: true, env: { ...process.env, PI_OUTPUT_ACL_TEST_PATH: path } }));
}

for (const kind of ["user-bash", "bash", "powershell"] as const) test(`Windows ${kind} output is private at creation even under a broadly readable parent`, { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-dacl-test-"));
  // Exact test directory only: deliberately enable broad inheritance to expose the baseline.
  execFileSync("icacls.exe", [root, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true });
  const created: string[] = [], create = fs.createWriteStream;
  t.mock.method(fs, "createWriteStream", (path: fs.PathLike, options: any) => {
    created.push(String(path));
    return create(path, options);
  });
  const originalTemp = process.env.TEMP, originalTmp = process.env.TMP;
  process.env.TEMP = root; process.env.TMP = root;
  syncBuiltinESMExports();
  let accumulator: OutputAccumulator | undefined;
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp;
    if (accumulator) await accumulator.discardTempFile();
    fs.rmSync(root, { recursive: true });
  });
  const payload = "private 中文😀\n".repeat(6000);
  if (kind === "user-bash") {
    const result = await executeBashWithOperations("fixture", process.cwd(), { async exec(_command, _cwd, { onData }) {
      onData(Buffer.from(payload)); return { exitCode: 0 };
    } });
    assert.equal(result.fullOutputPath, created[0]);
  } else {
    accumulator = new OutputAccumulator({ tempFilePrefix: `sp-${kind}` });
    accumulator.append(Buffer.from(payload)); accumulator.finish(); await accumulator.closeTempFile();
  }
  assert.equal(created.length, 1);
  assert.equal(fs.readFileSync(created[0], "utf8"), payload);
  for (const path of kind === "user-bash" ? created : [created[0], created[0] + ".sp-owned"]) {
    const acl = inspectAcl(path);
    t.diagnostic(JSON.stringify({ kind, protected: acl.protected, rules: acl.rules.length }));
    assert.equal(acl.protected, true);
    assert.equal(acl.owner, acl.user);
    assert.deepEqual(acl.rules, [{ sid: acl.user, inherited: false, type: "Allow", rights: 0x1f01ff }]);
  }
});

test("Windows descriptor is private before its first byte and Node owns binary writev/stat/close", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-dacl-fd-test-")), path = join(root, "empty.log");
  t.after(() => fs.rmSync(root, { recursive: true }));
  const fd = privateOutputFileSystem.openSync(path);
  try {
    assert.equal(fs.fstatSync(fd).size, 0);
    const acl = inspectAcl(path);
    assert.equal(acl.protected, true); assert.equal(acl.owner, acl.user);
    assert.deepEqual(acl.rules, [{ sid: acl.user, inherited: false, type: "Allow", rights: 0x1f01ff }]);
    const bytes = Buffer.from("first\n中文😀\0\x1a\r\nlast");
    fs.writevSync(fd, [bytes.subarray(0, 7), bytes.subarray(7)]);
    assert.deepEqual(fs.readFileSync(path), bytes);
  } finally { fs.closeSync(fd); }
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  const counters = windowsPrivateOutputDiagnostics();
  assert.equal(counters.nativeHandles, 0); assert.equal(counters.tokenHandles, 0);
  assert.ok(counters.descriptorBytes < 256);
});

test("Windows small output never loads the native opener", { skip: process.platform !== "win32" }, () => {
  const code = `import {executeBashWithOperations} from './packages/coding-agent/src/core/bash-executor.ts';
    import {windowsPrivateOutputDiagnostics} from './packages/coding-agent/src/utils/windows-private-output.ts';
    await executeBashWithOperations('fixture', process.cwd(), {async exec(c,w,{onData}) {onData(Buffer.from('small'));return {exitCode:0}}});
    console.log(JSON.stringify(windowsPrivateOutputDiagnostics()));`;
  const counters = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true }));
  assert.equal(counters.loaded, false); assert.equal(counters.opens, 0);
});

for (const fault of ["owner-create", "owner-write", "stream-construct"] as const) test(`tool spill setup ${fault} closes descriptors and removes its log/marker`, async t => {
  const open = privateOutputFileSystem.openSync, write = fs.writeFileSync, create = fs.createWriteStream;
  const paths: string[] = [], fds: number[] = [];
  const expected = new Error(`fixture ${fault}`);
  const accumulator = new OutputAccumulator({ tempFilePrefix: "sp-output-security-test" });
  t.mock.method(privateOutputFileSystem, "openSync", (path: string) => {
    if (path.endsWith(".sp-owned") && fault === "owner-create") throw expected;
    const fd = open(path); paths.push(path); fds.push(fd); return fd;
  });
  t.mock.method(fs, "writeFileSync", (...args: any[]) => {
    if (fault === "owner-write" && typeof args[0] === "number" && fds.includes(args[0])) throw expected;
    return Reflect.apply(write, fs, args);
  });
  t.mock.method(fs, "createWriteStream", (...args: any[]) => {
    if (fault === "stream-construct") throw expected;
    return Reflect.apply(create, fs, args);
  });
  syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await accumulator.discardTempFile(); for (const path of paths) fs.rmSync(path, { force: true }); });
  assert.throws(() => accumulator.append(Buffer.alloc(60000, 65)), error => error === expected);
  await accumulator.discardTempFile();
  for (const path of paths) assert.equal(fs.existsSync(path), false);
  for (const fd of fds) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
});
