// Deliberate single-disk native acceptance. No WSB API, sharing, capacity fill, or workspace writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { acquireAcceptanceRoot, CapturedProcess } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { launchVolumeHelper, TaskVolumeOwner, VOLUME_LIMITS, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";
const ROOT = "D:\\RMProjects\\Pi\\.artifacts\\windows-sandbox-acceptance-owner";
const PS = POWERSHELL7_PATH;
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const CSC_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const SOURCE = fileURLToPath(new URL("./windows-sandbox-volume-native.cs", import.meta.url));
const need = (ok, message) => { if (!ok) throw new Error(message); };
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// Read-only metadata; fixed program, paths and command set. No storage method invocation.
export const PREFLIGHT = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PowerShell 7 x64 is required; no fallback'}
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
try{$admin=([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}finally{$id.Dispose()}
$priv=@(& 'C:\Windows\System32\whoami.exe' /priv /fo csv | ConvertFrom-Csv -Header Name,Description,State | Where-Object Name -eq 'SeManageVolumePrivilege')
if($LASTEXITCODE -ne 0 -or -not $admin -or $priv.Count -ne 1){throw 'Required token privilege unavailable'}
Import-Module Storage -SkipEditionCheck -ErrorAction Stop
$required=@{'Get-DiskImage'=@('ImagePath');'Get-Disk'=@('Number','Partition','Path');'Initialize-Disk'=@('InputObject','PartitionStyle','PassThru');'New-Partition'=@('InputObject','Offset','Size','MbrType','AssignDriveLetter');'Get-Partition'=@('DiskNumber');'Format-Volume'=@('Partition','FileSystem','AllocationUnitSize','NewFileSystemLabel');'Get-Volume'=@('Partition')}
foreach($name in $required.Keys){$c=Get-Command -Name $name -Module Storage -ErrorAction Stop; if([string]$c.Version -cne '2.0.0.0'){throw 'Storage module changed'}; foreach($p in $required[$name]){if(-not $c.Parameters.ContainsKey($p)){throw 'Required Storage parameter missing'}}}
foreach($p in @('D:\','D:\RMProjects','D:\RMProjects\Pi','D:\RMProjects\Pi\.artifacts','D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner')){$a=[IO.File]::GetAttributes($p);if(([int]$a -band 19456) -ne 0 -or ([int]$a -band 16) -eq 0){throw 'Parent attributes changed'}}
$drive=[IO.DriveInfo]::new('D:\'); if($drive.DriveFormat -cne 'NTFS' -or $drive.DriveType -ne 'Fixed' -or $drive.AvailableFreeSpace -lt 168820736){throw 'Host storage precondition'}
@{protocol='super-pi-native-preflight-v1';powershell=[string]$PSVersionTable.PSVersion;x64=$true;administratorToken=$admin;privilege=$priv[0].Name;privilegeState=$priv[0].State;storageVersion='2.0.0.0';commands=7;format=$drive.DriveFormat;availableBytes=$drive.AvailableFreeSpace;requiredBytes=168820736}|ConvertTo-Json -Compress
`;

export function validateNativeProbe(receipt, taskId, facts) {
 need(receipt && Object.keys(receipt).sort().join(",") === "bytes,closeUnknown,closed,exchangeId,fileId,matched,opened,protocol,taskId,volumePath", "Probe receipt schema");
 need(receipt.protocol === "super-pi-volume-probe-v1" && receipt.taskId === taskId && receipt.volumePath === facts.volumePath
  && receipt.exchangeId === facts.exchangeId && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(receipt.fileId), "Probe association");
 need(receipt.bytes === 32 && receipt.matched === true && receipt.opened === 2 && receipt.closed === 2 && receipt.closeUnknown === false, "Probe incomplete/close unknown");
 return receipt;
}
export async function exerciseNativeOwner(owner, signal, readProbe, record) {
 let failure;
 try {
  need(!signal.aborted, "Cancelled before volume prepare");
  record.prepared = await owner.prepare();
  need(!signal.aborted, "Cancelled after volume prepare"); await owner.verify();
  need(!signal.aborted, "Cancelled before native probe"); await owner.probeOnce();
  try { record.probe = validateNativeProbe(readProbe(), record.taskId, record.prepared); }
  catch (error) { owner.onUnsafe(); throw error; } // A missing/invalid/close-unknown receipt cannot authorize release.
 } catch (error) { failure = error; record.error = String(error.message).slice(0, 512); }
 try { record.released = await owner.release(); }
 catch (error) { record.cleanupError = String(error.message).slice(0, 512); }
 if (signal.aborted) record.cancelled = true;
 record.volumeState = owner.state; return !failure && !record.cancelled && record.released && !!record.probe;
}

export function nativeJournal(resource, report, unsafe) {
 return () => {
  if (report.journalFailed) throw new Error("Native journal permanently blocked");
  try {
   need(Buffer.byteLength(JSON.stringify(report, null, 2)) <= 8192, "Native owner record budget"); resource.journal(report);
  } catch (error) {
   report.journalFailed = true; report.cleanupError ??= "Native journal failed";
   unsafe(); throw error; // Mark first: an unsafe callback may attempt another save.
  }
 };
}
export function summarizeHelperCalls(calls) {
 need(calls.length <= 2, "Native helper count budget");
 return calls.map(call => ({ executable: call.executable, pid: call.pid, outcome: call.outcome, killRequested: call.killRequested,
  result: call.result ? { exitCode: call.result.exitCode, signal: call.result.signal,
   launchError: call.result.launchError?.slice(0, 128) ?? null, truncated: call.result.truncated,
   stdoutSeen: call.result.stdoutSeen, stderrSeen: call.result.stderrSeen,
   stdoutPreview: call.result.stdout.slice(0, 256), stderrPreview: call.result.stderr.slice(0, 256),
   previewTruncated: call.result.stdout.length > 256 || call.result.stderr.length > 256 } : null }));
}
export function summarizeOperationError(value, command) {
 need(value && Object.keys(value).sort().join(",") === "classification,command,exception,hresult,message,nativeCode,phase", "Operation error schema");
 need(value.command === command && ["storage-operation-failed", "storage-identity-failed"].includes(value.classification), "Operation error association");
 for (const [key, maximum] of [["phase", 64], ["exception", 128], ["message", 512]])
  need(typeof value[key] === "string" && value[key].length <= maximum, "Operation error text bound");
 need(Number.isInteger(value.hresult) && value.hresult >= -2147483648 && value.hresult <= 2147483647
  && (value.nativeCode === null || Number.isInteger(value.nativeCode) && value.nativeCode >= 0 && value.nativeCode <= 4294967295), "Operation error code");
 return { ...value, message: value.message.slice(0, 256), messageTruncated: value.message.length > 256 };
}
function encodeReport(report) {
 const text = JSON.stringify(report); need(Buffer.byteLength(text) + 1 <= 7680, "Final native report budget"); return text;
}
export class NativeOutput {
 pending; failed = false; onDrained;
 onError = error => {
  if (!this.failed) {
   this.failed = true; this.report.outputFailed = true; this.report.passed = false; this.report.retained = !this.report.artifactsRemoved;
   this.report.cleanupError ??= String(error.message).slice(0, 256);
   try { this.persistFailure(); } catch {}
  }
  this.pending?.reject(error); // A stream error does not complete the outstanding write callback.
 };
 onWritten = error => {
  if (error) this.onError(error);
  const pending = this.pending; this.pending = undefined;
  if (!this.failed) pending?.resolve();
  this.onDrained?.();
 };
 constructor(stream, report, persistFailure) {
  this.stream = stream; this.report = report; this.persistFailure = persistFailure;
  stream.on("error", this.onError);
 }
 write(text) {
  need(!this.failed && !this.pending, "Native output blocked");
  return new Promise((resolve, reject) => {
   this.pending = { resolve, reject };
   try { this.stream.write(text, this.onWritten); }
   catch (error) { this.onError(error); this.pending = undefined; this.onDrained?.(); }
  });
 }
 dispose() {
  need(!this.pending, "Native output still pending"); this.stream.off("error", this.onError);
  this.onDrained = undefined; this.persistFailure = undefined; this.stream = undefined; this.report = undefined;
 }
}
const physicallyClosed = call => call.physicallyClosed === true || !!call.result;
export class NativeLifetime {
 calls = []; completing = false; finished = false; released = false; scheduled = false;
 cancel = () => {
  if (this.report.cancelled || this.report.artifactsRemoved) return;
  this.report.cancelled = true; this.report.passed = false;
  try { this.cancelExecution(); } catch (error) { this.report.cleanupError ??= String(error.message).slice(0, 256); this.report.retained = true; }
  try { this.save(); } catch {}
 };
 snapshot() {
  this.report.physicalCalls = this.calls.map(call => ({ pid: call.pid ?? null, closed: physicallyClosed(call),
   exitCode: call.result?.exitCode ?? call.diagnostics?.exitCode ?? null, signal: call.result?.signal ?? call.diagnostics?.signal ?? null }));
 }
 onSettled = () => {
  if (this.completing && !this.report.artifactsRemoved) {
   this.snapshot(); try { this.save(); } catch {} // Late evidence only: never resumes cleanup or disk operations.
  }
  this.maybeRelease();
 };
 maybeRelease = () => {
  if (!this.finished || this.released || this.scheduled || this.output.pending || this.calls.some(call => !physicallyClosed(call))) return;
  this.scheduled = true; setImmediate(this.release);
 };
 release = () => {
  this.scheduled = false;
  if (this.released || !this.finished || this.output.pending || this.calls.some(call => !physicallyClosed(call))) return;
  this.bus.off("SIGINT", this.cancel); this.bus.off("SIGTERM", this.cancel); this.output.dispose();
  for (const call of this.calls) call.off("settled", this.onSettled);
  this.calls.length = 0; this.released = true;
  this.bus = undefined; this.report = undefined; this.save = undefined; this.output = undefined; this.cancelExecution = undefined;
 };
 constructor(bus, report, save, output, cancelExecution) {
  this.bus = bus; this.report = report; this.save = save; this.output = output; this.cancelExecution = cancelExecution;
  output.onDrained = this.maybeRelease; bus.on("SIGINT", this.cancel); bus.on("SIGTERM", this.cancel);
 }
 track(call) { need(this.calls.length < 3 && !this.finished, "Native call budget"); this.calls.push(call); if (!physicallyClosed(call)) call.once("settled", this.onSettled); }
 beginCompletion() { need(!this.completing, "Native completion already started"); this.completing = true; this.snapshot(); }
 finish() { this.snapshot(); this.finished = true; this.maybeRelease(); }
}
export function nativeCleanupAllowed(report, helpers, driver) {
 return report.evidenceEmitted === true && !report.retained && !report.outputFailed && !report.outputBoundFailed && !report.journalFailed
  && !report.cleanupError && !helpers.active && report.receiptUnknownHandles.length === 0
  && (!driver || report.released && driver.physicallyClosed && !driver.pending);
}
export function finishNativeAcceptance(_resource, report, helpers, driver, save) {
 report.reportedUtc = new Date().toISOString(); // A failure report can precede the manager's physical close.
 report.passed = false; // Cleanup is still pending; only the later footer can report the final result.
 try { encodeReport(report); }
 catch { report.outputBoundFailed = true; report.cleanupError ??= "Final native report exceeds budget"; report.passed = false; }
 if (!report.outputBoundFailed) { try { save(); } catch {} } // Sticky journal failure participates in the gate below.
 if (report.journalFailed || report.outputBoundFailed || report.cleanupError || helpers.active || report.receiptUnknownHandles.length
  || driver && (!report.released || !driver.physicallyClosed || driver.pending)) {
  report.cleanupError ??= "Owned native volume/manager remains unresolved"; report.passed = false;
 }
 if (report.cleanupError) report.retained = true;
 try { return encodeReport(report); }
 catch {
  // Keep output bounded and explicitly incomplete; never emit or delete to hide an oversized record.
  return encodeReport({ protocol: report.protocol, taskId: report.taskId, artifactRoot: report.artifactRoot,
   artifactsRemoved: report.artifactsRemoved, passed: false, error: "final-report-bound", ownerRetained: !report.artifactsRemoved,
   helperPid: driver?.pid ?? null, helperClosed: driver?.physicallyClosed ?? null,
   journalFailed: report.journalFailed, volumeState: report.volumeState });
 }
}
export function encodeNativeCleanup(report) {
 const text = JSON.stringify({ kind: "native-cleanup", taskId: report.taskId, artifactsRemoved: report.artifactsRemoved,
  retained: report.retained, passed: report.passed, cancelled: report.cancelled, outputFailed: report.outputFailed,
  cleanupError: report.cleanupError?.slice(0, 64) ?? null }) + "\n";
 need(Buffer.byteLength(text) <= 512, "Native cleanup footer budget"); return text;
}
export async function completeNativeAcceptance(resource, report, helpers, driver, save, output, lifetime) {
 lifetime.beginCompletion();
 const evidence = finishNativeAcceptance(resource, report, helpers, driver, save);
 try { await output.write(evidence + "\n"); report.evidenceEmitted = true; }
 catch (error) { output.onError(error); }
 if (nativeCleanupAllowed(report, helpers, driver)) {
  try { resource.remove({ state: "closed-before-start" }); report.artifactsRemoved = true; }
  catch (error) { report.cleanupError = String(error.message).slice(0, 256); report.retained = true; }
 } else report.retained = true;
 report.passed = report.sequencePassed === true && report.artifactsRemoved && !report.cancelled && !report.error && !report.cleanupError && !report.outputFailed;
 try {
  if (!report.artifactsRemoved && !report.journalFailed) save();
  if (!output.failed) await output.write(encodeNativeCleanup(report));
 } catch (error) { output.onError(error); }
 lifetime.finish(); return report;
}

export async function runNativeVolumeAcceptance() {
 verifyPowerShell7();
 need(process.platform === "win32" && hash(CSC) === CSC_HASH, "Pinned native acceptance tools changed");
 const resource = acquireAcceptanceRoot(), taskId = randomUUID();
 const report = { protocol: "super-pi-volume-native-acceptance-v1", taskId, startedUtc: new Date().toISOString(),
  artifactRoot: resource.root, preflight: null, sources: {}, nativeSha256: null, helperCalls: [], volume: null,
  prepared: null, probe: null, released: false, volumeState: null, cancelled: false, revoked: false,
  error: null, cleanupError: null, operationErrors: [], receiptUnknownHandles: [], artifactsRemoved: false,
  journalFailed: false, outputBoundFailed: false, outputFailed: false, evidenceEmitted: false, retained: false, physicalCalls: [],
  vmCalls: 0, shareAdmission: false, sequencePassed: false, passed: false };
 let owner, driver;
 const save = nativeJournal(resource, report, () => owner?.onUnsafe());
 const controller = new AbortController();
 const output = new NativeOutput(process.stdout, report, () => { if (!report.artifactsRemoved) { owner?.onUnsafe(); save(); } });
 const lifetime = new NativeLifetime(process, report, save, output, () => { controller.abort(); owner?.revoke(); });
 const helpers = new OwnedHelperRunner(resource.root, () => {
  try { report.helperCalls = summarizeHelperCalls(helpers.calls); }
  catch (error) { report.cleanupError ??= "Helper summary failed"; report.journalFailed = true; owner?.onUnsafe(); throw error; }
  save();
 }, (executable, args, cwd) => { const call = new CapturedProcess(executable, args, cwd); lifetime.track(call); return call; });
 function readReceipt(name) {
  const file = path.join(resource.root, name), before = fs.lstatSync(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= 4096n && fs.realpathSync(file) === file, "Private receipt shape");
  const fd = fs.openSync(file, "r");
  try {
   const opened = fs.fstatSync(fd, { bigint: true });
   need(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.nlink === 1n, "Private receipt changed");
   const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
   while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset); need(count > 0, "Short receipt"); offset += count; }
   need(fs.fstatSync(fd, { bigint: true }).size === before.size, "Private receipt length changed");
   return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
   try { fs.closeSync(fd); } catch (error) { report.receiptUnknownHandles.push(fd); throw error; }
  }
 }
 try {
  need(resource.root === ROOT, "Fixed native acceptance root changed"); save();
  for (const name of ["windows-sandbox-volume-native.cs", "windows-sandbox-volume-helper.ps1", "windows-sandbox-volume.mjs", "windows-sandbox-volume-native-acceptance.mjs"])
   report.sources[name] = hash(fileURLToPath(new URL(name, import.meta.url)));
  const preflight = await helpers.run(PS, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(PREFLIGHT, "utf16le").toString("base64")], 15000, controller.signal);
  report.preflight = JSON.parse(preflight.stdout.replace(/^\uFEFF/, ""));
  need(report.preflight.protocol === "super-pi-native-preflight-v1" && report.preflight.commands === 7, "Preflight receipt mismatch");
  const assembly = path.join(resource.root, "volume-native.dll");
  need(!controller.signal.aborted, "Cancelled before compile");
  await helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly, SOURCE], 15000, controller.signal);
  need(fs.statSync(assembly).size <= VOLUME_LIMITS.nativeBytes, "Native assembly budget"); report.nativeSha256 = hash(assembly); save();
  need(!controller.signal.aborted, "Cancelled before manager");
  driver = launchVolumeHelper({ root: resource.root, taskId, nativeSha256: report.nativeSha256 });
  lifetime.track(driver);
  owner = new TaskVolumeOwner({ driver, taskId,
   readRuntime: () => ({ state: "not-started", neverDispatched: true, callsClosed: true }), // No VM interface exists in this entry.
   journal: value => { report.volume = value; save(); }, revokeCandidates: () => { report.revoked = true; },
   cancelExecution: () => { controller.abort(); report.cancelled = true; } });
  report.sequencePassed = await exerciseNativeOwner(owner, controller.signal, () => readReceipt("volume-probe.json"), report);
 } catch (error) { report.error ??= String(error.message).slice(0, 512); }
 for (const command of ["prepare", "verify", "probe", "release", "exit"]) {
  try { report.operationErrors.push(summarizeOperationError(readReceipt("volume-error-" + command + ".json"), command)); }
  catch (error) { if (error.code !== "ENOENT") { report.cleanupError ??= String(error.message).slice(0, 512); report.passed = false; } }
 }
 if (report.operationErrors.length) { report.passed = false; report.error ??= "Manager reported an operation failure"; }
 return await completeNativeAcceptance(resource, report, helpers, driver, save, output, lifetime);
 // No process.exit(): an unresolved manager keeps its physical ownership and this process alive.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 need(process.argv.length === 3 && process.argv[2] === "--run-native-volume-once", "Explicit native-only invocation required");
 if (!(await runNativeVolumeAcceptance()).passed) process.exitCode = 1;
}
