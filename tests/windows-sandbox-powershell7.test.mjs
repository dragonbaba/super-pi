import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, POWERSHELL7_SETTINGS, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { PREFLIGHT } from "../scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs";
const resolve = name => fileURLToPath(new URL(name, import.meta.url));
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("PowerShell 7 host boundary has an explicit path and cannot fall back through compatibility imports", () => {
 assert.equal(POWERSHELL7_PATH, "D:\\PowerShell\\7\\pwsh.exe");
 assert.deepEqual(POWERSHELL7_PREFIX, ["-NoLogo", "-NoProfile", "-NonInteractive", "-SettingsFile", POWERSHELL7_SETTINGS]);
 assert.equal(Object.isFrozen(POWERSHELL7_PREFIX), true);
 assert.deepEqual(JSON.parse(fs.readFileSync(POWERSHELL7_SETTINGS, "utf8")), { "Microsoft.PowerShell:ExecutionPolicy": "RemoteSigned",
  WindowsPowerShellCompatibilityModuleDenyList: ["PSScheduledJob", "BestPractices", "UpdateServices"], DisableImplicitWinCompat: true });
 for (const name of ["../scripts/acceptance/windows-sandbox-volume.mjs", "../scripts/acceptance/windows-sandbox-volume-startup.mjs",
  "../scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs", "./windows-sandbox-volume.test.mjs",
  "./windows-sandbox-volume-native-acceptance.test.mjs", "./windows-sandbox-volume-startup.test.mjs"]) {
  const source=fs.readFileSync(resolve(name),"utf8");
  assert.doesNotMatch(source,/powershell\.exe|UseWindowsPowerShell|PSVersion\.Major -ne 5/iu);
  assert.match(source,/\.\.\.POWERSHELL7_PREFIX/u); assert.match(source,/verifyPowerShell7\(\)/u);
 }
 for(const name of ["../scripts/acceptance/windows-sandbox-volume-helper.ps1", "./fixtures/windows-sandbox-volume-helper-check.ps1",
  "./fixtures/windows-sandbox-volume-probe-check.ps1", "./fixtures/windows-sandbox-volume-startup-parse.ps1"]){
  const source=fs.readFileSync(resolve(name),"utf8"); assert.match(source,/PSVersion\.Major -ne 7/u); assert.doesNotMatch(source,/UseWindowsPowerShell|powershell\.exe/iu);
 }
 assert.match(PREFLIGHT,/Import-Module Storage -SkipEditionCheck -ErrorAction Stop/u);
});
test("PowerShell 7 loads the current native type, hashes the DLL and imports Storage in process without disk operations", { timeout:30000, ...PINNED_SANDBOX_TEST_OPTIONS }, t => {
 verifyPowerShell7();
 const parent=fs.realpathSync(os.tmpdir()), root=fs.mkdtempSync(path.join(parent,"super-pi-powershell7-"));
 const identity=fs.lstatSync(root,{bigint:true}), owned=new Map();
 const remember=file=>{const s=fs.lstatSync(file,{bigint:true});assert.equal(s.isFile(),true);assert.equal(s.isSymbolicLink(),false);assert.equal(s.nlink,1n);owned.set(file,{dev:s.dev,ino:s.ino,size:s.size,digest:hash(file)});};
 t.after(()=>{
  const actual=fs.lstatSync(root,{bigint:true});assert.equal(actual.dev,identity.dev);assert.equal(actual.ino,identity.ino);
  assert.equal(actual.isSymbolicLink(),false);assert.equal(fs.realpathSync(root),root);assert.equal(path.dirname(root),parent);
  assert.deepEqual(fs.readdirSync(root).sort(),[...owned.keys()].map(file=>path.basename(file)).sort());
  for(const[file,expected]of owned){const s=fs.lstatSync(file,{bigint:true});assert.equal(s.isSymbolicLink(),false);assert.equal(s.nlink,1n);assert.equal(s.dev,expected.dev);assert.equal(s.ino,expected.ino);assert.equal(s.size,expected.size);assert.equal(hash(file),expected.digest);}
  for(const[file]of owned)fs.unlinkSync(file);fs.rmdirSync(root);assert.equal(fs.existsSync(root),false);
  t.diagnostic(JSON.stringify({temporaryRootRemoved:true,ownedFiles:owned.size}));
 });
 const assembly=path.join(root,"volume-native.dll"), preflight=path.join(root,"preflight.ps1");
 fs.writeFileSync(preflight,PREFLIGHT,{flag:"wx"});remember(preflight);
 const compiler="C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
 assert.equal(hash(compiler),"eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
 const native=resolve("../scripts/acceptance/windows-sandbox-volume-native.cs");
 const nativeSourceSha256=hash(native);
 const compiled=spawnSync(compiler,["/nologo","/target:library","/platform:x64","/out:"+assembly,native],{windowsHide:true,timeout:15000,maxBuffer:8192});
 assert.equal(hash(native),nativeSourceSha256,"Native source changed during compilation");
 t.diagnostic(JSON.stringify({stage:"compiler",nativeSourceSha256,pid:compiled.pid,status:compiled.status,signal:compiled.signal,error:compiled.error?.code??null,
  stdoutBytes:compiled.stdout?.length??0,stderrBytes:compiled.stderr?.length??0,stderrRawBase64:compiled.stderr?.subarray(0,1024).toString("base64")??"",stderrTruncated:(compiled.stderr?.length??0)>1024}));
 if(fs.existsSync(assembly))remember(assembly);
 assert.equal(compiled.error,undefined);assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);assert.equal(compiled.signal,null);
 assert.ok(fs.statSync(assembly).size<=131072);verifyPowerShell7();
 const checked=spawnSync(POWERSHELL7_PATH,[...POWERSHELL7_PREFIX,"-File",resolve("./fixtures/windows-sandbox-powershell7-check.ps1"),
  "-NativeAssembly",assembly,"-AssemblySha256",hash(assembly),"-Helper",resolve("../scripts/acceptance/windows-sandbox-volume-helper.ps1"),"-Preflight",preflight],
 {windowsHide:true,timeout:10000,maxBuffer:8192});
 t.diagnostic(JSON.stringify({stage:"pwsh7",pid:checked.pid,status:checked.status,signal:checked.signal,error:checked.error?.code??null,
  stdoutBytes:checked.stdout?.length??0,stderrBytes:checked.stderr?.length??0,stderrRawBase64:checked.stderr?.subarray(0,1024).toString("base64")??"",stderrTruncated:(checked.stderr?.length??0)>1024}));
 assert.equal(checked.error,undefined);assert.equal(checked.status,0,checked.stdout+checked.stderr);assert.equal(checked.signal,null);
 const report=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(checked.stdout).trim());assert.equal(report.protocol,"super-pi-powershell7-compat-v1");
 assert.equal(report.executable,POWERSHELL7_PATH);assert.equal(report.powershell,"7.6.9");assert.equal(report.edition,"Core");assert.equal(report.x64,true);
 assert.equal(report.hashMatches,true);assert.equal(report.abiSize,56);assert.equal(report.idOffset,8);assert.equal(report.capacityOffset,24);
 assert.equal(report.executionPolicy,"RemoteSigned");
 assert.equal(report.commands,7);assert.equal(report.compatSessions,0);assert.equal(report.proxyModules,0);assert.equal(report.parsed,2);
 assert.equal(report.nativeConstructed,false);assert.equal(report.storageCalls,0);
 t.diagnostic(JSON.stringify({compilerPid:compiled.pid,pwshPid:checked.pid,compilerExit:compiled.status,pwshExit:checked.status,...report}));
});
