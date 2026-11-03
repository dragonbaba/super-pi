// One reviewed IPv4 TCP/HTTP comparison. No production import, proxy, retries or alternate destinations.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { acquireAcceptanceRoot, FixedCli, SandboxLifecycle, successful } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { windowsSandboxConfig, sha256 } from "./windows-sandbox-package.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";

export const NETWORK_PROTOCOL = "super-pi-wsb-network-v1";
const SOURCE = fileURLToPath(new URL("./windows-sandbox-network.cs", import.meta.url));
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
// Windows SDK IF_TYPE_PROP_VIRTUAL (53) is observed but unnamed in .NET; never treat it as loopback.
const TYPES = new Set([6, 9, 15, 20, 21, 23, 24, 26, 28, 37, 48, 53, 62, 63, 69, 71, 94, 95, 96, 97, 114, 117, 131, 143, 144, 237, 243, 244]);
const STATES = new Set([1, 2, 3, 5, 6, 7]); // Unknown is deliberately not evidence.
const OUTCOMES = new Set(["not-started", "connect-timeout", "connected", "expected-response", "unexpected-response", "connected-io-error", "connect-error", "probe-error"]);
function need(value, message) { if (!value) throw new Error(message); }
export function publicIPv4(value) {
	if (typeof value !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
	const b = value.split(".").map(Number);
	return b.every(x => x <= 255) && b.join(".") === value && b[0] > 0 && b[0] < 224 && b[0] !== 10 && b[0] !== 127
		&& !(b[0] === 100 && b[1] >= 64 && b[1] <= 127) && !(b[0] === 169 && b[1] === 254)
		&& !(b[0] === 172 && b[1] >= 16 && b[1] <= 31) && !(b[0] === 192 && [0, 168].includes(b[1]))
		&& !(b[0] === 198 && ([18, 19].includes(b[1]) || b[1] === 51 && b[2] === 100)) && !(b[0] === 203 && b[1] === 0 && b[2] === 113);
}
export function networkConfig(input, output, phase) {
	need(["enabled", "disabled"].includes(phase), "Invalid fixed network phase");
	const disabled = windowsSandboxConfig(input, output).replaceAll("SuperPiProbe", "SuperPiNetwork");
	return phase === "enabled" ? disabled.replace("<Networking>Disable</Networking>", "<Networking>Enable</Networking>") : disabled;
}
function adapters(value) {
	need(Array.isArray(value) && value.length <= 32, "Incomplete interface inventory"); const ids = new Set();
	for (const nic of value) {
		need(nic && typeof nic.id === "string" && nic.id.length > 0 && nic.id.length <= 128 && !ids.has(nic.id)
			&& TYPES.has(nic.type) && STATES.has(nic.status), "Unknown interface identity/type/state");
		for (const key of ["ipv4", "ipv6", "gateways4", "gateways6"]) need(Number.isInteger(nic[key]) && nic[key] >= 0 && nic[key] <= 32, "Invalid interface address count");
		need(nic.ipv4 + nic.ipv6 <= 32 && nic.gateways4 + nic.gateways6 <= 32, "Interface address bound"); ids.add(nic.id);
	}
}
export function validateNetworkReceipt(value, request) {
	need(value && value.protocol === NETWORK_PROTOCOL && value.taskId === request.taskId && value.phase === request.phase
		&& value.address === request.address && publicIPv4(value.address) && value.port === 80 && OUTCOMES.has(value.outcome), "Network receipt identity mismatch");
	for (const flag of ["system", "connected", "connectSettled", "socketClosed", "eof", "matched", "interfacesComplete"]) need(typeof value[flag] === "boolean", "Missing network evidence flag");
	need(Number.isInteger(value.pid) && value.pid > 0 && Number.isInteger(value.sessionId) && value.sessionId >= 0, "Missing probe process identity");
	if (["enabled", "disabled"].includes(request.phase)) need(value.system === true, "Fixed network probe must use System execution context");
	need(Number.isInteger(value.connectAttempts) && value.connectAttempts >= 0 && value.connectAttempts <= 1
		&& Number.isInteger(value.responseBytes) && value.responseBytes >= 0 && value.responseBytes <= 4097
		&& Number.isInteger(value.sentBytes) && value.sentBytes >= 0 && value.sentBytes <= 128
		&& Number.isInteger(value.receiveCalls) && value.receiveCalls >= 0 && value.receiveCalls <= 4098
		&& Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0, "Invalid network counters");
	for (const key of ["error", "cleanupError"]) need(value[key] === null || typeof value[key] === "string" && value[key].length <= 128, "Invalid network error");
	need(value.socketError === null || Number.isInteger(value.socketError), "Invalid socket error");
	need(!value.connected || value.connectAttempts === 1, "Connection without attempt");
	need(value.outcome !== "connect-error" || value.socketError !== null && value.connectAttempts === 1 && !value.connected, "Invalid connection error evidence");
	need(value.connected || value.responseBytes === 0 && value.sentBytes === 0 && !value.matched, "Unconnected probe claims data");
	need(!value.matched || value.connected && value.eof && value.outcome === "expected-response" && value.responseBytes > 22 && value.socketError === null, "Unproven expected response");
	// Partial inventory is retained as inconclusive; it must not hide a real successful TCP connection.
	if (value.interfacesComplete) { adapters(value.before); adapters(value.after); }
	else { need(value.before === null || Array.isArray(value.before) && value.before.length <= 32, "Invalid partial inventory"); need(value.after === null || Array.isArray(value.after) && value.after.length <= 32, "Invalid partial inventory"); }
	return value;
}
function stableInterfaces(value) { return value.interfacesComplete && JSON.stringify(value.before) === JSON.stringify(value.after); }
export function positiveProbe(value) {
	return !!value && value.connected && value.connectSettled && value.socketClosed && value.matched && value.eof && !value.error && !value.cleanupError
		&& value.outcome === "expected-response" && stableInterfaces(value) && value.before.some(nic => nic.type !== 24 && nic.status === 1 && nic.ipv4 > 0);
}
export function disabledProbe(value) {
	if (value?.connected === true) return "isolation-failure";
	if (!value || value.connectAttempts !== 1 || !value.connectSettled || !value.socketClosed || value.cleanupError || !stableInterfaces(value)
		|| value.before.some(nic => nic.type !== 24 && nic.status === 1) || value.outcome !== "connect-error"
		|| value.error !== "SocketException" || ![10051, 10065].includes(value.socketError)) return "inconclusive";
	return "blocked-as-expected"; // Only a candidate until all positive controls and cleanup are confirmed.
}
export function networkVerdict(record) {
	const disabled = record.phases.find(phase => phase.phase === "disabled");
	if (disabledProbe(disabled?.receipt) === "isolation-failure") return "isolation-failure"; // Sticky even if final health fails.
	if (record.error || record.cleanupError || record.helperPendingPid !== null || !record.artifactsRemoved || record.phases.length !== 2 || record.health.length !== 3
		|| record.health.map(item => item.phase).join(",") !== "health-before,health-middle,health-after"
		|| record.health.some(item => !positiveProbe(item)) || !positiveProbe(record.phases[0].receipt)
		|| record.phases[0].phase !== "enabled" || disabledProbe(disabled?.receipt) !== "blocked-as-expected"
		|| record.phases[0].lifecycle?.instanceId === disabled?.lifecycle?.instanceId
		|| record.phases.some(item => !item.closed || item.wrapperExitCode !== 0 || item.lifecycle?.state !== "closed" || !item.lifecycle.stopAttempted
			|| !item.lifecycle.calls.some(call => call.kind === "exec") || item.lifecycle.calls.some(call => !successful(call.result)))) return "inconclusive";
	return "limited-pass";
}
function readReceipt(file) {
	const before = fs.lstatSync(file, { bigint: true });
	need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= 8192n && fs.realpathSync(file) === file, "Invalid result file");
	const fd = fs.openSync(file, "r");
	try {
		const opened = fs.fstatSync(fd, { bigint: true }); need(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "Result changed before read");
		const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
		while (offset < buffer.length) { const count = fs.readSync(fd, buffer, offset, buffer.length - offset); need(count > 0, "Short result"); offset += count; }
		need(fs.fstatSync(fd, { bigint: true }).size === before.size, "Result changed while reading"); return JSON.parse(buffer.toString("utf8"));
	} finally { fs.closeSync(fd); }
}
export async function runNetworkAcceptance() {
	const resource = acquireAcceptanceRoot(), owners = [];
	const report = { protocol: NETWORK_PROTOCOL, taskId: randomUUID(), sourceSha256: null, compilerSha256: COMPILER_HASH, probeSha256: null,
		address: null, dns: null, health: [], phases: [], helperCalls: [], helperPendingPid: null, error: null, cleanupError: null, artifactsRemoved: false, artifactRoot: resource.root };
	const save = () => resource.journal(report);
	const helpers = new OwnedHelperRunner(resource.root, () => { report.helperCalls = helpers.calls; report.helperPendingPid = helpers.active?.pid ?? null; save(); });
	const controller = new AbortController(), cancel = () => controller.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	const executable = path.join(resource.root, "network-probe.exe");
	function request(taskId, phase) { return { protocol: NETWORK_PROTOCOL, taskId, phase, address: report.address }; }
	function checkCancelled() { need(!controller.signal.aborted, "Network acceptance cancelled before next operation"); }
	async function helper(exe, args, ms) { checkCancelled(); return helpers.run(exe, args, ms, controller.signal); }
	async function health(phase) {
		checkCancelled();
		const expected = request(report.taskId, phase); fs.writeFileSync(path.join(resource.root, phase + ".json"), JSON.stringify(expected), { flag: "wx" });
		const result = await helper(executable, [phase], 15000);
		const receipt = validateNetworkReceipt(JSON.parse(result.stdout), expected); report.health.push(receipt); save();
		need(positiveProbe(receipt), "Host target health failed: " + phase);
	}
	async function phase(mode) {
		checkCancelled();
		const entry = { phase: mode, taskId: randomUUID(), closed: false, wrapperExitCode: null, receipt: null, lifecycle: null };
		report.phases.push(entry); const root = path.join(resource.root, mode), input = path.join(root, "input"), output = path.join(root, "output");
		fs.mkdirSync(root); fs.mkdirSync(input); fs.mkdirSync(output);
		fs.copyFileSync(executable, path.join(input, "probe.exe"), fs.constants.COPYFILE_EXCL);
		need(sha256(path.join(input, "probe.exe")) === report.probeSha256, "Copied probe digest changed");
		const expected = request(entry.taskId, mode); fs.writeFileSync(path.join(input, "request.json"), JSON.stringify(expected), { flag: "wx" });
		const owner = new SandboxLifecycle({ cli: new FixedCli(), config: networkConfig(input, output, mode), taskId: entry.taskId,
			workload: { kind: "network-only", runId: report.taskId, phase: mode, address: report.address, input, output, probeSha256: report.probeSha256 },
			journal(value) { entry.lifecycle = value; save(); } }); owners.push(owner);
		try { await owner.start(controller.signal); entry.wrapperExitCode = parseFixedEntryExit(await owner.executeNetworkProbe(controller.signal)); }
		finally { entry.closed = await owner.cleanup(); save(); }
		need(entry.closed, "Instance cleanup unresolved"); need(entry.wrapperExitCode === 0, "Network probe entry failed");
		entry.receipt = validateNetworkReceipt(readReceipt(path.join(output, "result.json")), expected); save();
		if (mode === "enabled") need(positiveProbe(entry.receipt), "Enabled guest positive control failed");
	}
	try {
		need(process.platform === "win32" && sha256(COMPILER) === COMPILER_HASH, "Pinned Windows compiler changed");
		report.sourceSha256 = sha256(SOURCE); save();
		await helper(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable, SOURCE], 30000);
		report.probeSha256 = sha256(executable); save();
		const resolved = JSON.parse((await helper(executable, ["resolve"], 5000)).stdout);
		need(resolved?.host === "www.msftconnecttest.com" && Array.isArray(resolved.addresses) && resolved.addresses.length > 0 && resolved.addresses.length <= 32
			&& resolved.addresses.every(publicIPv4) && new Set(resolved.addresses).size === resolved.addresses.length, "Invalid fixed target resolution");
		report.dns = resolved; report.address = resolved.addresses[0]; save();
		await health("health-before"); await phase("enabled"); await health("health-middle"); await phase("disabled"); await health("health-after");
	} catch (error) { report.error = String(error.message); }
	finally {
		process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
		if (owners.some(owner => !["closed", "closed-before-start"].includes(owner.state) || owner.active || owner.execution || owner.connection) || helpers.active) { report.cleanupError = "Owned execution remains unresolved"; save(); }
		else { try { resource.remove({ state: "closed-before-start" }); report.artifactsRemoved = true; } catch (error) { report.cleanupError = String(error.message); } }
	}
	report.verdict = networkVerdict(report); report.passed = report.verdict === "limited-pass";
	process.stdout.write(JSON.stringify(report) + "\n"); return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	need(process.argv.length === 2, "No arguments accepted"); if (!(await runNetworkAcceptance()).passed) process.exitCode = 1;
}
