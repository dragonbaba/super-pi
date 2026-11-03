import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { publicIPv4, networkConfig, validateNetworkReceipt, positiveProbe, disabledProbe, networkVerdict, NETWORK_PROTOCOL } from "../scripts/acceptance/windows-sandbox-network.mjs";
import { CapturedProcess, SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { sha256 } from "../scripts/acceptance/windows-sandbox-package.mjs";

const taskId = "11111111-2222-3333-4444-555555555555";
const nic = { id: "adapter", type: 6, status: 1, ipv4: 1, ipv6: 1, gateways4: 1, gateways6: 0 };
function receipt(phase = "enabled") {
	return { protocol: NETWORK_PROTOCOL, taskId, phase, address: "1.1.1.1", port: 80, pid: 123, sessionId: 0, system: true,
		connected: true, connectSettled: true, socketClosed: true, eof: true, matched: true, interfacesComplete: true, before: [{ ...nic }], after: [{ ...nic }],
		connectAttempts: 1, responseBytes: 100, sentBytes: 121, receiveCalls: 2, elapsedMs: 30, error: null, cleanupError: null, socketError: null, outcome: "expected-response" };
}
function blocked() { return { ...receipt("disabled"), connected: false, eof: false, matched: false, responseBytes: 0, sentBytes: 0, receiveCalls: 0,
	error: "SocketException", socketError: 10051, outcome: "connect-error", before: [], after: [] }; }
function ok(stdout = "") { return { exitCode: 0, signal: null, launchError: null, truncated: false, stdout, stderr: "" }; }
function runRecord() {
	return { error: null, cleanupError: null, helperPendingPid: null, artifactsRemoved: true, health: ["health-before", "health-middle", "health-after"].map(receipt),
		phases: ["enabled", "disabled"].map(phase => ({ phase, closed: true, wrapperExitCode: 0, receipt: phase === "enabled" ? receipt() : blocked(),
			lifecycle: { instanceId: phase, state: "closed", stopAttempted: true, calls: [{ kind: "exec", result: ok() }] } })) };
}
test("fixed network receipts, config and public IPv4 selection reject ambiguous evidence", () => {
	assert.equal(publicIPv4("1.1.1.1"), true);
	for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.31.2.1", "198.18.0.1", "::1", "1.1.1.01", "1.1.1.256", "example.com"]) assert.equal(publicIPv4(ip), false);
	const disabled = networkConfig("D:\\owned\\input", "D:\\owned\\output", "disabled"), enabled = networkConfig("D:\\owned\\input", "D:\\owned\\output", "enabled");
	assert.equal(enabled.replace("<Networking>Enable</Networking>", "<Networking>Disable</Networking>"), disabled);
	assert.match(enabled, /<ClipboardRedirection>Disable/); assert.throws(() => networkConfig("D:\\owned\\input", "D:\\owned\\output", "other"));
	assert.equal(validateNetworkReceipt(receipt(), receipt()).matched, true);
	const virtualNic = { ...nic, type: 53 }, virtualReceipt = { ...receipt(), before: [virtualNic], after: [virtualNic] };
	assert.equal(validateNetworkReceipt(virtualReceipt, receipt()).before[0].type, 53);
	assert.equal(positiveProbe(virtualReceipt), true);
	const disabledVirtual = { ...blocked(), before: [virtualNic], after: [virtualNic] };
	assert.equal(disabledProbe(validateNetworkReceipt(disabledVirtual, blocked())), "inconclusive");
	assert.equal(disabledProbe({ ...virtualReceipt, phase: "disabled" }), "isolation-failure");
	const downVirtual = { ...virtualNic, status: 2 };
	assert.equal(disabledProbe(validateNetworkReceipt({ ...blocked(), before: [downVirtual], after: [downVirtual] }, blocked())), "blocked-as-expected");
	assert.throws(() => validateNetworkReceipt({ ...receipt(), before: [{ ...virtualNic, status: 4 }] }, receipt()));
	assert.throws(() => validateNetworkReceipt({ ...receipt(), before: [{ ...nic, type: 1 }] }, receipt()));
	for (const changes of [{ address: "8.8.8.8" }, { phase: "disabled" }, { protocol: "wrong" }, { connectAttempts: 2 }, { port: 443 },
		{ system: false }, { connected: false }, { eof: false }, { before: null }, { cleanupError: true }, { responseBytes: 5000 },
		{ before: [{ ...nic, type: 999 }] }, { before: [{ ...nic, status: 4 }] }, { before: [nic, nic] }]) {
		assert.throws(() => validateNetworkReceipt({ ...receipt(), ...changes }, receipt()));
	}
	assert.equal(disabledProbe(validateNetworkReceipt(blocked(), blocked())), "blocked-as-expected");
	for (const changes of [{ socketError: 10049 }, { socketError: 10060 }, { socketError: 10061 }, { socketError: 10054 }, { error: "InvalidOperationException" },
		{ connectSettled: false }, { socketClosed: false }, { interfacesComplete: false }, { before: [nic], after: [nic] }, { before: [], after: [{ ...nic, status: 2 }] }]) {
		assert.equal(disabledProbe({ ...blocked(), ...changes }), "inconclusive");
	}
});
test("network verdict needs all controls and physical cleanup; successful disabled TCP remains a failure", () => {
	assert.equal(networkVerdict(runRecord()), "limited-pass");
	for (let index = 0; index < 3; index++) { const r = runRecord(); r.health[index].matched = false; assert.equal(networkVerdict(r), "inconclusive"); }
	for (const mutate of [r => r.phases[0].receipt.matched = false, r => r.phases[1].closed = false, r => r.phases[1].wrapperExitCode = 1,
		r => r.phases[1].lifecycle.stopAttempted = false, r => r.phases[1].lifecycle.calls = [], r => r.artifactsRemoved = false,
		r => r.helperPendingPid = 42, r => r.cleanupError = "pending", r => r.phases[1].receipt.socketError = 10060,
		r => r.phases[1].lifecycle.instanceId = r.phases[0].lifecycle.instanceId]) {
		const r = runRecord(); mutate(r); assert.equal(networkVerdict(r), "inconclusive");
	}
	const failure = runRecord(); failure.phases[1].receipt = { ...receipt("disabled"), matched: false, eof: false, outcome: "connected-io-error", error: "IOException" };
	failure.error = "Final host health failed"; failure.health.pop(); failure.artifactsRemoved = false;
	assert.equal(networkVerdict(failure), "isolation-failure");
	const incomplete = { ...receipt("disabled"), before: null, after: null, interfacesComplete: false, error: "receipt-output-bound" };
	assert.equal(disabledProbe(validateNetworkReceipt(incomplete, receipt("disabled"))), "isolation-failure");
	assert.equal(positiveProbe(incomplete), false); // A later metadata error cannot erase a completed connection or certify a control.
	assert.equal(positiveProbe({ ...receipt(), before: [], after: [] }), false);
});
class Call extends EventEmitter { pid = 123; wait = CapturedProcess.prototype.wait; constructor(result) { super(); this.result = result; } finish() { this.result = ok(); this.emit("settled"); } }
test("network fixed entry is bound to owned System execution and drains pending exec after stop", async () => {
	let id, running = false; const execution = new Call(), calls = [];
	const cli = { launch(args) {
		calls.push(args[0]);
		if (args[0] === "start") { id = args[2]; running = true; return new Call(ok()); }
		if (args[0] === "list") return new Call(ok(JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: id }] : [] })));
		if (args[0] === "stop") { running = false; execution.finish(); return new Call(ok()); }
		assert.deepEqual(args, ["exec", "--id", id, "-c", '"C:\\SuperPiNetwork\\Input\\probe.exe"', "-d", "C:\\SuperPiNetwork\\Input", "-r", "System", "--raw"]); return execution;
	} };
	const owner = new SandboxLifecycle({ cli, config: "fixture", journal() {}, limits: { callMs: 20, startMs: 20, execMs: 1, settleMs: 20, exitMs: 20, pollMs: 1 } });
	await assert.rejects(owner.executeNetworkProbe(), /owned registration/); await owner.start();
	await assert.rejects(owner.executeNetworkProbe(), /timeout/); assert.ok(owner.execution);
	assert.equal(await owner.cleanup(), true); assert.equal(owner.execution, undefined); assert.equal(execution.listenerCount("settled"), 0);
	assert.equal(calls.filter(kind => kind === "exec").length, 1); assert.equal(calls.filter(kind => kind === "stop").length, 1);
});
test("native fixed network parsing checks compile and run without DNS, sockets or clipboard calls", { skip: process.platform !== "win32" }, t => {
	const repository = fileURLToPath(new URL("../", import.meta.url)), compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
	assert.equal(sha256(compiler), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
	const parent = fs.realpathSync(path.join(repository, ".artifacts")), root = path.join(parent, "wsb-network-check-" + randomUUID());
	fs.mkdirSync(root); const identity = fs.lstatSync(root, { bigint: true }), executable = path.join(root, "check.exe"); let binaryIdentity;
	try {
		const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/main:NetworkProbeChecks", "/out:" + executable,
			path.join(repository, "scripts", "acceptance", "windows-sandbox-network.cs"), path.join(repository, "tests", "fixtures", "windows-sandbox-network-check.cs")],
			{ cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 });
		if (fs.existsSync(executable)) binaryIdentity = fs.lstatSync(executable, { bigint: true });
		assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
		const checked = spawnSync(executable, [], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 });
		assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		const receipt = JSON.parse(checked.stdout); assert.equal(receipt.passed, true);
		t.diagnostic(JSON.stringify({ root, compilerPid: compiled.pid, checkPid: checked.pid, ...receipt }));
	} finally {
		const actual = fs.lstatSync(root, { bigint: true }); assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
		assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
		if (binaryIdentity) { const current = fs.lstatSync(executable, { bigint: true }); assert.ok(current.isFile() && !current.isSymbolicLink() && current.dev === binaryIdentity.dev && current.ino === binaryIdentity.ino); fs.unlinkSync(executable); }
		fs.rmdirSync(root); assert.equal(fs.existsSync(root), false); t.diagnostic("Owned native parser artifacts removed.");
	}
});
