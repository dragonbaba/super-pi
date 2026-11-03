// Manual, reviewed clipboard-only acceptance. Host contents never leave the helper as data.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { acquireAcceptanceRoot, CapturedProcess, FixedCli, SandboxLifecycle, successful, CLI_LIMIT } from "./windows-sandbox-lifecycle.mjs";
import { windowsSandboxConfig, sha256 } from "./windows-sandbox-package.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";

const PROTOCOL = "super-pi-wsb-clipboard-guest-v1";
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_SHA256 = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const HOST_SOURCE = fileURLToPath(new URL("./windows-sandbox-clipboard-host.cs", import.meta.url));
const GUEST_SOURCE = fileURLToPath(new URL("./windows-sandbox-clipboard-guest.cs", import.meta.url));
const OBSERVE_MS = 1000;
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function emit(phase, data) { process.stdout.write(JSON.stringify({ phase, ...data }) + "\n"); }

export function validateSnapshot(snapshot) {
	if (!snapshot || snapshot.protocol !== "super-pi-wsb-clipboard-host-v3" || !Number.isInteger(snapshot.sequence) || snapshot.sequence <= 0
		|| snapshot.sequence > 4294967295 || typeof snapshot.owner !== "string" || !/^\d+$/.test(snapshot.owner) || !Array.isArray(snapshot.formats)
		|| snapshot.formats.length < 1 || snapshot.formats.length > 64) throw new Error("Invalid host clipboard snapshot");
	const context = snapshot.context;
	if (!context || !Number.isInteger(context.sessionId) || context.sessionId <= 0 || context.system !== false || context.visible !== true
		|| context.station !== "WinSta0" || context.desktop !== "Default" || context.inputDesktop !== context.desktop
		|| typeof context.userSidSha256 !== "string" || !/^[0-9a-f]{64}$/.test(context.userSidSha256)) throw new Error("Wrong host interactive context");
	let total = 0, nonempty = false; const seen = new Set();
	for (const format of snapshot.formats) {
		if (!format || !Number.isInteger(format.id) || seen.has(format.id) || !Number.isInteger(format.allocationBytes) || format.allocationBytes < 1
			|| format.allocationBytes > 8 * 1024 * 1024 || typeof format.storageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(format.storageSha256)) throw new Error("Invalid format storage descriptor");
		if (format.storageKind === "registered-hglobal-opaque") {
			if (format.id < 0xC000 || format.id > 0xFFFF || typeof format.name !== "string" || format.name.length < 1 || format.name.length >= 255
				|| format.name.includes("\0") || format.logicalBytes !== null) throw new Error("Invalid registered format identity");
		} else {
			if (![1, 7, 13, 16].includes(format.id) || format.name !== null || format.storageKind !== (format.id === 16 ? "standard-locale" : "standard-text")
				|| !Number.isInteger(format.logicalBytes) || format.logicalBytes < 1 || format.logicalBytes > format.allocationBytes) throw new Error("Invalid standard format identity or length");
			if (format.id === 16 && format.logicalBytes !== 4 || format.id === 13 && (format.logicalBytes % 2 || format.allocationBytes % 2)) throw new Error("Invalid format length semantics");
			if (format.id !== 16 && format.logicalBytes > (format.id === 13 ? 2 : 1)) nonempty = true;
		}
		seen.add(format.id); total += format.allocationBytes;
	}
	if (!nonempty || total !== snapshot.totalAllocationBytes || total > 16 * 1024 * 1024) throw new Error("Empty or oversized host snapshot");
	return snapshot;
}
export function parseHostSnapshot(output) {
	if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > CLI_LIMIT) throw new Error("Host receipt output bound exceeded");
	return validateSnapshot(JSON.parse(output));
}
export function sameSnapshot(baseline, current) {
	validateSnapshot(baseline); validateSnapshot(current);
	return baseline.sequence === current.sequence && baseline.owner === current.owner && JSON.stringify(baseline.formats) === JSON.stringify(current.formats)
		&& baseline.totalAllocationBytes === current.totalAllocationBytes && JSON.stringify(baseline.context) === JSON.stringify(current.context);
}
function captureHelper(executable, args, cwd) { return new CapturedProcess(executable, args, cwd); }
export class OwnedHelperRunner {
	active;
	calls = [];
	constructor(cwd, persist, launch = captureHelper) { this.cwd = cwd; this.persist = persist; this.launch = launch; }
	async run(executable, args, ms = 5000, signal) {
		if (this.active || this.calls.length >= 32) throw new Error("Previous helper unresolved or helper budget exhausted");
		const entry = { executable: path.basename(executable), pid: null, outcome: "launching", killRequested: false, result: null };
		this.calls.push(entry);
		const call = this.launch(executable, args, this.cwd); this.active = call; entry.pid = call.pid ?? null; this.persist();
		const outcome = await call.wait(ms, signal); entry.outcome = outcome;
		if (outcome !== "settled") {
			// Only this owned read-only/compile helper, never a user app or WSB CLI.
			entry.killRequested = true; call.child?.kill(); this.persist();
			if (await call.wait(3000) !== "settled") { entry.outcome += "/exit-unconfirmed"; this.persist(); throw new Error("Owned helper exit unconfirmed"); }
		}
		entry.result = call.result; this.active = undefined; this.persist();
		if (outcome !== "settled" || !successful(call.result)) throw new Error("Owned helper failed: " + (call.result?.stdout ?? outcome));
		return call.result;
	}
}
function boundedJson(file, maximum) {
	const before = fs.lstatSync(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum) || fs.realpathSync(file) !== file) throw new Error("Invalid bounded receipt file");
	const fd = fs.openSync(file, "r");
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) throw new Error("Receipt changed before reading");
		const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
		while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset); if (!count) throw new Error("Short receipt"); offset += count; }
		if (fs.fstatSync(fd, { bigint: true }).size !== opened.size) throw new Error("Receipt changed during read");
		return JSON.parse(bytes.toString("utf8"));
	} finally { fs.closeSync(fd); }
}
async function waitFile(file, ms, signal, operation) {
	const deadline = Date.now() + ms;
	while (!fs.existsSync(file)) {
		if (signal.aborted) throw new Error("Clipboard acceptance cancelled");
		if (operation?.result) throw new Error("Guest exited before expected phase");
		if (Date.now() >= deadline) throw new Error("Clipboard phase deadline exceeded");
		await pause(100);
	}
}
export function guestContext(value, taskId, phase) {
	if (value?.protocol !== PROTOCOL || value.taskId !== taskId || phase && value.phase !== phase) throw new Error("Guest receipt identity mismatch");
	if (phase !== "written") {
		const context = value.context;
		if (!context || !Number.isInteger(context.sessionId) || context.sessionId <= 0 || context.system !== false || context.visible !== true
			|| context.station !== "WinSta0" || context.desktop !== "Default" || typeof context.user !== "string" || typeof context.sid !== "string") throw new Error("Wrong guest interactive context");
	}
	return value;
}

export async function runClipboardAcceptance() {
	const resource = acquireAcceptanceRoot(), taskId = randomUUID();
	const input = path.join(resource.root, "input"), output = path.join(resource.root, "output");
	fs.mkdirSync(input); fs.mkdirSync(output);
	const helper = path.join(resource.root, "host-observer.exe"), probe = path.join(input, "probe.exe");
	const snapshots = []; let gui, receipt, ready, guestFailure, error, cleaning = false, closed = false, guiClosed = true, wrapperExitCode;
	const config = windowsSandboxConfig(input, output).replaceAll("SuperPiProbe", "SuperPiClipboard");
	const owner = new SandboxLifecycle({ cli: new FixedCli(), config, journal: resource.journal, taskId,
		workload: { kind: "clipboard-only", input, output, hostSourceSha256: sha256(HOST_SOURCE), guestSourceSha256: sha256(GUEST_SOURCE), observeMs: OBSERVE_MS } });
	const controller = new AbortController(), cancel = () => controller.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	const helpers = new OwnedHelperRunner(resource.root, () => { owner.workload.helperCalls = helpers.calls; owner.workload.helperPendingPid = helpers.active?.pid ?? null; owner.save(); });
	function helperRun(executable, args, ms = 5000) { return helpers.run(executable, args, ms, cleaning ? undefined : controller.signal); }
	async function snapshot(stage) {
		const result = parseHostSnapshot((await helperRun(helper, [])).stdout);
		snapshots.push({ stage, ...result }); return result;
	}
	async function windowStatus() { return JSON.parse((await helperRun(helper, ["window", gui.windowId, String(gui.processId), gui.creationTimeUtcTicks])).stdout); }
	let execution;
	try {
		if (sha256(COMPILER) !== COMPILER_SHA256) throw new Error("Pinned local compiler changed");
		owner.workload.compilerSha256 = COMPILER_SHA256; owner.save();
		await helperRun(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + helper, HOST_SOURCE], 30000);
		await helperRun(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + probe, GUEST_SOURCE], 30000);
		owner.workload.hostSha256 = sha256(helper); owner.workload.probeSha256 = sha256(probe); owner.save();
		fs.writeFileSync(path.join(input, "request.json"), JSON.stringify({ protocol: PROTOCOL, taskId }), { flag: "wx" });
		const baseline = await snapshot("baseline-1"); await pause(OBSERVE_MS);
		if (!sameSnapshot(baseline, await snapshot("baseline-2"))) throw new Error("Host baseline is not stable; no instance started");
		await owner.start(controller.signal); owner.connectClipboardSession(); guiClosed = false;
		emit("desktop-check-required", { taskId, instanceId: owner.id, root: resource.root, connectPid: owner.connection.entry.pid });
		const gate = path.join(resource.root, "desktop-ready.json");
		await waitFile(gate, 180000, controller.signal);
		gui = boundedJson(gate, 2048);
		if (gui.taskId !== taskId || gui.instanceId !== owner.id || !/^\d+$/.test(gui.windowId) || !Number.isInteger(gui.processId) || gui.processId <= 0
			|| !/^\d+$/.test(gui.creationTimeUtcTicks)) throw new Error("Invalid owned desktop identity");
		if (!(await windowStatus()).windowMatches) throw new Error("Owned interactive window not present");
		// Observe the promise immediately: guest executes concurrently with host phase checks.
		execution = owner.executeClipboardProbe(controller.signal).then(result => ({ result }), caught => ({ error: String(caught.message) }));
		await waitFile(path.join(output, "ready.complete"), 30000, controller.signal, owner.execution?.operation);
		ready = guestContext(boundedJson(path.join(output, "ready.json"), 4096), taskId, "ready");
		if (!sameSnapshot(baseline, await snapshot("connected-before-write"))) throw new Error("Host changed after connection; no guest write released");
		fs.writeFileSync(path.join(output, "ready.ack"), taskId, { flag: "wx" });
		await waitFile(path.join(output, "written.complete"), 30000, controller.signal, owner.execution?.operation);
		guestContext(boundedJson(path.join(output, "written.json"), 4096), taskId, "written");
		await pause(OBSERVE_MS);
		if (!(await windowStatus()).windowMatches) throw new Error("Interactive connection window disappeared during observation");
		if (!sameSnapshot(baseline, await snapshot("written-connected"))) throw new Error("Host clipboard differs after guest write");
		fs.writeFileSync(path.join(output, "written.ack"), taskId, { flag: "wx" });
		const executed = await execution;
		if (executed.error) throw new Error(executed.error);
		wrapperExitCode = parseFixedEntryExit(executed.result);
		if (wrapperExitCode !== 0) throw new Error("Guest clipboard probe failed");
	} catch (caught) { error = String(caught.message); }
	try {
		cleaning = true;
		closed = await owner.cleanup();
		if (closed && gui) {
			for (let attempt = 0; attempt < 10; attempt++) {
				const status = await windowStatus();
				if (!status.windowMatches && !status.processMatches) { guiClosed = true; break; }
				await pause(500);
			}
		}
		if (closed && guiClosed && owner.startAttempted && snapshots.length > 0) {
			await pause(OBSERVE_MS);
			if (!sameSnapshot(snapshots[0], await snapshot("after-exit"))) error ??= "Host clipboard differs after exit";
		}
		if (closed && !error) {
			receipt = guestContext(boundedJson(path.join(output, "result.json"), 4096), taskId);
			if (JSON.stringify(receipt.context) !== JSON.stringify(ready.context)) throw new Error("Guest context changed between phases");
			for (const flag of ["opened", "emptied", "set", "closed", "reopened", "readback", "readClosed", "destroyed"]) if (receipt[flag] !== true) throw new Error("Missing guest positive API proof: " + flag);
		}
		if (closed && fs.existsSync(path.join(output, "failure.json"))) {
			guestFailure = boundedJson(path.join(output, "failure.json"), 4096);
			if (guestFailure.protocol !== PROTOCOL || guestFailure.taskId !== taskId) throw new Error("Failure receipt identity mismatch");
		}
	} catch (caught) { error ??= String(caught.message); }
	finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
	const report = { taskId, instanceId: owner.id, error: error ?? null, cleanupError: owner.cleanupError ?? null, state: owner.state,
		workload: owner.workload, gui: gui ?? null, guiClosed, snapshots, guest: receipt ?? null, guestFailure: guestFailure ?? null, wrapperExitCode: wrapperExitCode ?? null,
		calls: owner.calls, helperCalls: helpers.calls, helperPendingPid: helpers.active?.pid ?? null, artifactRoot: resource.root, artifactsRemoved: false };
	if (closed && guiClosed && !helpers.active) { resource.remove(owner); report.artifactsRemoved = true; }
	report.passed = !error && closed && guiClosed && !helpers.active && wrapperExitCode === 0 && !!receipt && snapshots.length === 5
		&& owner.calls.every(call => successful(call.result));
	emit("result", report); return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("No arguments accepted");
	if (!(await runClipboardAcceptance()).passed) process.exitCode = 1;
}
