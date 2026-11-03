// Deliberate startup evidence only. Never sends stdin, invokes storage commands, or kills the manager.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { acquireAcceptanceRoot, CapturedProcess } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { summarizeHelperCalls } from "./windows-sandbox-volume-native-acceptance.mjs";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "./windows-sandbox-volume.mjs";

const ROOT = "D:\\RMProjects\\Pi\\.artifacts\\windows-sandbox-acceptance-owner";
const PS = POWERSHELL7_PATH;
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const NATIVE = fileURLToPath(new URL("./windows-sandbox-volume-native.cs", import.meta.url));
const HELPER = fileURLToPath(new URL("./windows-sandbox-volume-helper.ps1", import.meta.url));
const CSC_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const NATIVE_HASH = "a01944e8e62f5f34bbbfc685158fbf0d70f40260b81a1b8dae362d9e977949cc";
export const STARTUP_LIMITS = Object.freeze({ stdout: 2048, stderr: 1024, journal: 8192, output: 8192, deadline: 15000, native: 131072 });
const need = (ok, message) => { if (!ok) throw new Error(message); };
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const exactKeys = (value, keys) => need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys, "Startup receipt schema");

export function parseStartupReceipt(result, taskId) {
 need(result.stdoutSeen > 0 && result.stdoutSeen <= STARTUP_LIMITS.stdout, "No complete startup receipt");
 const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.stdoutRawBase64, "base64"));
 const value = JSON.parse(text);
 exactKeys(value, "completed,error,ok,protocol,step,taskId");
 need(value.protocol === "super-pi-volume-startup-v1" && value.taskId === taskId && typeof value.ok === "boolean", "Startup association");
 const steps = ["arguments", "assembly-check", "assembly-load", "output-encoding", "native-constructor", "complete"];
 const index = steps.indexOf(value.step);
 need(index >= 0 && value.completed === (index === 0 ? "none" : steps[index - 1]), "Startup step/completion association");
 if (value.ok) need(value.step === "complete" && value.error === null && result.exitCode === 0 && result.signal === null, "Startup success incomplete");
 else {
  exactKeys(value.error, "exception,hresult,message,messageTruncated,nativeCode");
  need(typeof value.error.exception === "string" && value.error.exception.length <= 160
   && typeof value.error.message === "string" && value.error.message.length <= 256 && typeof value.error.messageTruncated === "boolean"
   && Number.isInteger(value.error.hresult) && value.error.hresult >= -2147483648 && value.error.hresult <= 2147483647
   && (value.error.nativeCode === null || Number.isInteger(value.error.nativeCode) && value.error.nativeCode >= 0 && value.error.nativeCode <= 4294967295), "Startup error bound");
 }
 return value;
}

// Private diagnostic transport. Stable callbacks, one 2KiB/1KiB pair; strings only at physical close.
export class StartupCapture extends EventEmitter {
 child; pid; result;
 out = Buffer.alloc(STARTUP_LIMITS.stdout); err = Buffer.alloc(STARTUP_LIMITS.stderr);
 outLength = 0; errLength = 0; outSeen = 0; errSeen = 0; launchError = null;
 onOut = chunk => { this.outSeen = Math.min(Number.MAX_SAFE_INTEGER, this.outSeen + chunk.length); this.outLength += chunk.copy(this.out, this.outLength, 0, Math.min(chunk.length, this.out.length - this.outLength)); };
 onErr = chunk => { this.errSeen = Math.min(Number.MAX_SAFE_INTEGER, this.errSeen + chunk.length); this.errLength += chunk.copy(this.err, this.errLength, 0, Math.min(chunk.length, this.err.length - this.errLength)); };
 onError = error => { this.launchError = String(error.code ?? error.message).slice(0, 128); };
 onClose = (exitCode, signal) => {
  const result = { pid: this.pid, exitCode, signal, closedUtc: new Date().toISOString(), launchError: this.launchError,
   stdoutSeen: this.outSeen, stdoutCaptured: this.outLength, stdoutRawBase64: this.out.toString("base64", 0, this.outLength),
   stderr: { encoding: "uninterpreted", seenBytes: this.errSeen, capturedBytes: this.errLength,
    rawBase64: this.err.toString("base64", 0, this.errLength), truncated: this.errSeen > this.errLength },
   stdoutTruncated: this.outSeen > this.outLength, buffersReleased: true };
  this.child.stdout.off("data", this.onOut); this.child.stderr.off("data", this.onErr);
  this.child.off("error", this.onError); this.child.off("close", this.onClose);
  this.out = undefined; this.err = undefined; this.child = undefined; this.result = result;
  this.emit("settled");
 };
 constructor(child) {
  super(); this.child = child; this.pid = child.pid ?? null;
  child.stdout.on("data", this.onOut); child.stderr.on("data", this.onErr);
  child.on("error", this.onError); child.on("close", this.onClose);
 }
 wait = CapturedProcess.prototype.wait; // Existing bounded lifecycle wait; no manager termination path.
}

function rootIdentity(root) {
 const value = fs.lstatSync(root, { bigint: true });
 need(value.isDirectory() && !value.isSymbolicLink() && fs.realpathSync(root) === root, "Private root identity");
 return { dev: String(value.dev), ino: String(value.ino) };
}
function fileIdentity(root, name) {
 need(["lifecycle.json", "volume-native.dll"].includes(name), "Unknown diagnostic leaf");
 const file = path.join(root, name), value = fs.lstatSync(file, { bigint: true });
 need(value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && fs.realpathSync(file) === file
  && value.size <= BigInt(name === "lifecycle.json" ? STARTUP_LIMITS.journal : STARTUP_LIMITS.native), "Diagnostic file identity/budget");
 return { dev: String(value.dev), ino: String(value.ino), bytes: Number(value.size), sha256: hash(file) };
}
export function validateCleanupSnapshot(expectedRoot, actualRoot, expectedFiles, actualFiles) {
 need(JSON.stringify(actualRoot) === JSON.stringify(expectedRoot), "Owned root changed");
 need(Object.keys(actualFiles).sort().join(",") === Object.keys(expectedFiles).sort().join(","), "Unexpected diagnostic files");
 for (const name of Object.keys(expectedFiles)) need(JSON.stringify(actualFiles[name]) === JSON.stringify(expectedFiles[name]), "Diagnostic file changed");
}
export function cleanupAllowed(report, helpers, capture) {
 return !helpers.active && (!capture || !!capture.result) && !report.cancelled && !report.journalFailed && !report.outputFailed
  && !report.retained && report.evidenceEmitted === true;
}
export function encodeStartupEvidence(report, files = {}) {
 const text = JSON.stringify({ kind: "startup-evidence", report, artifactIdentities: files }) + "\n";
 need(Buffer.byteLength(text) <= STARTUP_LIMITS.output - 512, "Startup evidence output budget");
 return text;
}
export function encodeStartupCleanup(report) {
 const text = JSON.stringify({ kind: "startup-cleanup", artifactsRemoved: report.artifactsRemoved, retained: report.retained,
  startupSucceeded: report.startupSucceeded, cleanupError: report.cleanupError?.slice(0, 64) ?? null }) + "\n";
 need(Buffer.byteLength(text) <= 512, "Startup footer budget"); return text;
}
export class StartupOutput {
 pending; failed = false; onDrained;
 onError = error => {
  if (!this.failed) {
   this.failed = true; this.report.outputFailed = true; this.report.retained = !this.report.artifactsRemoved;
   this.report.cleanupError ??= String(error.message).slice(0, 256);
   try { this.persistFailure(); } catch {}
  }
  this.pending?.reject(error); // Logical failure does not prove that the write callback has returned.
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
  need(!this.failed && !this.pending, "Startup output blocked");
  return new Promise((resolve, reject) => {
   this.pending = { resolve, reject };
   try { this.stream.write(text, this.onWritten); }
   catch (error) { this.onError(error); this.pending = undefined; this.onDrained?.(); }
  });
 }
 dispose() { need(!this.pending, "Startup output still pending"); this.stream.off("error", this.onError); this.onDrained = undefined; }
}
export class StartupLifetime {
 calls = []; finished = false; released = false; scheduled = false;
 cancel = () => {
  if (this.report.cancelled || this.report.artifactsRemoved) return;
  this.report.cancelled = true; this.report.retained = !this.report.artifactsRemoved; this.controller.abort();
  try { this.save(); } catch {}
 };
 maybeRelease = () => {
  if (!this.finished || this.released || this.scheduled || this.output.pending || this.calls.some(call => !call.result)) return;
  this.scheduled = true; setImmediate(this.release); // Let write error events settle before removing the observer.
 };
 release = () => {
  this.scheduled = false;
  if (this.released || !this.finished || this.output.pending || this.calls.some(call => !call.result)) return;
  this.bus.off("SIGINT", this.cancel); this.bus.off("SIGTERM", this.cancel); this.output.dispose();
  for (const call of this.calls) call.off("settled", this.maybeRelease);
  this.calls.length = 0; this.released = true;
 };
 constructor(bus, report, controller, save, output) {
  this.bus = bus; this.report = report; this.controller = controller; this.save = save; this.output = output;
  output.onDrained = this.maybeRelease;
  bus.on("SIGINT", this.cancel); bus.on("SIGTERM", this.cancel);
 }
 track(call) { need(this.calls.length < 2 && !this.finished, "Startup call budget"); this.calls.push(call); if (!call.result) call.once("settled", this.maybeRelease); }
 finish() { this.finished = true; this.maybeRelease(); }
}

export function startupJournal(resource, report, files, inspectRoot, inspectFile) {
 return () => {
  if (report.journalFailed) throw Error("Startup journal permanently blocked");
  try {
   need(JSON.stringify(inspectRoot()) === JSON.stringify(report.rootIdentity), "Journal root changed");
   if (files["lifecycle.json"]) need(JSON.stringify(inspectFile("lifecycle.json")) === JSON.stringify(files["lifecycle.json"]), "Journal file changed");
   need(Buffer.byteLength(JSON.stringify(report, null, 2)) <= STARTUP_LIMITS.journal, "Startup journal budget");
   resource.journal(report); files["lifecycle.json"] = inspectFile("lifecycle.json");
  } catch (error) { report.journalFailed = true; report.retained = true; throw error; }
 };
}
export function attachStartupEvidence(capture, report, save) {
 capture.once("settled", () => {
  report.startupCapture = capture.result;
  try { report.startupReceipt = parseStartupReceipt(capture.result, report.taskId); }
  catch (error) { report.receiptError = String(error.message).slice(0, 256); }
  report.startupSucceeded = report.startupReceipt?.ok === true && capture.result.stderr.seenBytes === 0 && !capture.result.launchError;
  try { save(); } catch {} // Late close records evidence, never releases a retained owner.
 });
}

export async function runStartupDiagnostic() {
 verifyPowerShell7();
 need(process.platform === "win32" && hash(CSC) === CSC_HASH && hash(NATIVE) === NATIVE_HASH, "Pinned startup prerequisites changed");
 const helperHash = hash(HELPER), resource = acquireAcceptanceRoot();
 need(resource.root === ROOT, "Fixed startup root changed");
 const identity = rootIdentity(ROOT), files = {}, controller = new AbortController();
 const report = { protocol: "super-pi-volume-startup-diagnostic-v1", taskId: randomUUID(), artifactRoot: ROOT, rootIdentity: identity,
  startedUtc: new Date().toISOString(), sources: { helper: helperHash, native: NATIVE_HASH }, nativeSha256: null,
  compilerCalls: [], startupPid: null, startupOutcome: "not-started", startupCapture: null, startupReceipt: null, receiptError: null,
  cancelled: false, journalFailed: false, outputFailed: false, retained: false, evidenceEmitted: false, artifactsRemoved: false,
  startupSucceeded: false, error: null, cleanupError: null, storageCommandsSent: 0, vmCalls: 0, shareAdmission: false };
 const save = startupJournal(resource, report, files, () => rootIdentity(ROOT), name => fileIdentity(ROOT, name));
 const output = new StartupOutput(process.stdout, report, () => { if (!report.artifactsRemoved) save(); });
 const lifetime = new StartupLifetime(process, report, controller, save, output);
 const helpers = new OwnedHelperRunner(ROOT, () => { report.compilerCalls = summarizeHelperCalls(helpers.calls); save(); }, (executable, args, cwd) => {
  const call = new CapturedProcess(executable, args, cwd); lifetime.track(call); return call;
 });
 let capture;
 try {
  save(); need(!controller.signal.aborted, "Cancelled before compile");
  const assembly = path.join(ROOT, "volume-native.dll");
  await helpers.run(CSC, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly, NATIVE], 15000, controller.signal);
  files["volume-native.dll"] = fileIdentity(ROOT, "volume-native.dll"); report.nativeSha256 = files["volume-native.dll"].sha256; save();
  need(!controller.signal.aborted && !report.journalFailed && hash(HELPER) === helperHash && hash(NATIVE) === NATIVE_HASH, "Startup launch admission changed");
  const child = spawn(PS, [...POWERSHELL7_PREFIX, "-File", HELPER, "-Run", "-TaskId", report.taskId,
   "-Root", ROOT, "-NativeSha256", report.nativeSha256, "-StartupDiagnostic"], { cwd: ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  capture = new StartupCapture(child); report.startupPid = capture.pid; report.startupOutcome = "running";
  attachStartupEvidence(capture, report, save);
  lifetime.track(capture);
  save(); report.startupOutcome = await capture.wait(STARTUP_LIMITS.deadline, controller.signal);
  if (report.startupOutcome !== "settled") { report.retained = true; throw Error("Startup logical end; physical ownership retained"); }
  save();
 } catch (error) { report.error = String(error.message).slice(0, 256); }
 report.reportedUtc = new Date().toISOString();
 try { save(); await output.write(encodeStartupEvidence(report, files)); report.evidenceEmitted = true; }
 catch (error) { report.outputFailed = true; report.retained = true; report.cleanupError = String(error.message).slice(0, 256); }
 if (cleanupAllowed(report, helpers, capture)) {
  try {
   const actualFiles = {};
   need(path.dirname(fs.realpathSync(ROOT)) === path.resolve("D:\\RMProjects\\Pi\\.artifacts"), "Cleanup parent changed");
   for (const name of fs.readdirSync(ROOT)) actualFiles[name] = fileIdentity(ROOT, name);
   validateCleanupSnapshot(identity, rootIdentity(ROOT), files, actualFiles);
   for (const name of Object.keys(files)) {
    need(JSON.stringify(rootIdentity(ROOT)) === JSON.stringify(identity) && JSON.stringify(fileIdentity(ROOT, name)) === JSON.stringify(files[name]), "Deletion identity changed");
    fs.unlinkSync(path.join(ROOT, name));
   }
   need(JSON.stringify(rootIdentity(ROOT)) === JSON.stringify(identity), "Empty root changed");
   fs.rmdirSync(ROOT); need(!fs.existsSync(ROOT), "Diagnostic artifacts remain"); report.artifactsRemoved = true;
  } catch (error) { report.retained = true; report.cleanupError = String(error.message).slice(0, 256); }
 } else report.retained = true;
 try { if (!report.outputFailed) await output.write(encodeStartupCleanup(report)); }
 catch (error) { output.onError(error); } // Preserve artifactsRemoved if only the post-cleanup footer failed.
 lifetime.finish(); // Cancellation and stream-error observers remain until every started call physically closes.
 return report; // No process.exit, manager kill, broad scan, or recursive deletion.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 need(process.argv.length === 3 && process.argv[2] === "--diagnose-startup-once", "Explicit startup diagnostic required");
 const result = await runStartupDiagnostic();
 if (!result.startupSucceeded || !result.artifactsRemoved || result.outputFailed) process.exitCode = 1;
}
