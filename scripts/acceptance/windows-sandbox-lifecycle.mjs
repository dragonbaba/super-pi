// Acceptance only. No production import, fallback to host execution, or arbitrary guest commands.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./windows-sandbox-package.mjs";
import { GUEST_INPUT } from "./windows-sandbox-guest.mjs";

export const CLI_PATH = "C:\\Program Files\\WindowsApps\\MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy\\wsb.exe";
export const CLI_VERSION = "0.8.107.0";
export const CLI_SHA256 = "247e092b5c5bd37820f225a7dd3ddf10ae37a67e2751a19c24b802c84769c441";
export const CLI_LIMIT = 16 * 1024;
const BLANK_PATH = fileURLToPath(new URL("./windows-sandbox-bootstrap.wsb", import.meta.url));
const BLANK_SHA256 = "f2f8033c30175ceb96c9adef26ab965c395819576aefd356c19c2fbfe08e47fd";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_CALLS = 96;
export const DEFAULT_LIMITS = Object.freeze({ callMs: 15_000, startMs: 120_000, execMs: 30_000, settleMs: 120_000, exitMs: 30_000, pollMs: 500 });

export function blankConfig() {
	if (sha256(BLANK_PATH) !== BLANK_SHA256) throw new Error("Reviewed blank configuration changed");
	return fs.readFileSync(BLANK_PATH, "utf8");
}

// One pair of fixed buffers per CLI invocation. Data callbacks never allocate
// promises, closures, arrays or strings; decoding happens once on physical close.
export class CapturedProcess extends EventEmitter {
	child;
	result;
	out = Buffer.alloc(CLI_LIMIT);
	err = Buffer.alloc(CLI_LIMIT);
	outLength = 0;
	errLength = 0;
	outSeen = 0;
	errSeen = 0;
	chunks = 0;
	launchError;
	pid;
	spawnRequestedUtc = new Date().toISOString();
	spawnObservedUtc;
	onOut = bytes => { this.chunks++; this.outSeen = Math.min(Number.MAX_SAFE_INTEGER, this.outSeen + bytes.length); this.outLength += bytes.copy(this.out, this.outLength, 0, Math.min(bytes.length, CLI_LIMIT - this.outLength)); };
	onErr = bytes => { this.chunks++; this.errSeen = Math.min(Number.MAX_SAFE_INTEGER, this.errSeen + bytes.length); this.errLength += bytes.copy(this.err, this.errLength, 0, Math.min(bytes.length, CLI_LIMIT - this.errLength)); };
	onSpawn = () => { this.pid = this.child.pid; this.spawnObservedUtc = new Date().toISOString(); };
	onError = error => { this.launchError = String(error.code ?? error.message).slice(0, 512); };
	onClose = (exitCode, signal) => {
		this.result = { exitCode, signal, launchError: this.launchError ?? null, pid: this.pid ?? null,
			spawnRequestedUtc: this.spawnRequestedUtc, spawnObservedUtc: this.spawnObservedUtc ?? null,
			closedUtc: new Date().toISOString(), stdout: this.out.toString("utf8", 0, this.outLength), stderr: this.err.toString("utf8", 0, this.errLength),
			stdoutSeen: this.outSeen, stderrSeen: this.errSeen, truncated: this.outSeen > CLI_LIMIT || this.errSeen > CLI_LIMIT, chunks: this.chunks };
		this.child.stdout.removeListener("data", this.onOut); this.child.stderr.removeListener("data", this.onErr);
		this.child.removeListener("spawn", this.onSpawn); this.child.removeListener("error", this.onError); this.child.removeListener("close", this.onClose);
		this.child = undefined; this.out = undefined; this.err = undefined;
		this.emit("settled");
	};
	constructor(executable, args, cwd) {
		super();
		this.child = spawn(executable, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		this.pid = this.child.pid;
		this.child.stdout.on("data", this.onOut); this.child.stderr.on("data", this.onErr);
		this.child.once("spawn", this.onSpawn); this.child.on("error", this.onError); this.child.once("close", this.onClose);
	}
	// Deadlines are logical. Killing a CLI client cannot prove its RPC/VM stopped.
	// These closures/timer belong to a lifecycle wait, never to output chunks.
	wait(ms, signal) {
		if (this.result) return Promise.resolve("settled");
		if (signal?.aborted) return Promise.resolve("cancelled");
		return new Promise(resolve => {
			let timer;
			const finish = reason => { clearTimeout(timer); this.removeListener("settled", settled); signal?.removeEventListener("abort", aborted); resolve(reason); };
			const settled = () => finish("settled"), aborted = () => finish("cancelled");
			this.once("settled", settled); signal?.addEventListener("abort", aborted, { once: true });
			timer = setTimeout(finish, ms, "timeout");
		});
	}
}

export function successful(result) { return result?.exitCode === 0 && result.signal === null && !result.launchError && !result.truncated; }
export function parseRunning(result) {
	if (!successful(result)) throw new Error("Running-list command failed, timed out, or exceeded its bound");
	const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
	if (!value || Object.keys(value).join(",") !== "WindowsSandboxEnvironments" || !Array.isArray(value.WindowsSandboxEnvironments)
		|| value.WindowsSandboxEnvironments.length > 128) throw new Error("Unknown running-list schema");
	const ids = new Set();
	for (const item of value.WindowsSandboxEnvironments) {
		if (!item || Object.keys(item).join(",") !== "Id" || typeof item.Id !== "string" || !UUID.test(item.Id) || ids.has(item.Id)) throw new Error("Invalid or duplicate instance ID");
		ids.add(item.Id);
	}
	return ids;
}

// Only a host adapter that has not called its process factory may use this rejection.
export class UndispatchedError extends Error {}

export class FixedCli {
	launch(args) {
		if (process.platform !== "win32" || sha256(CLI_PATH) !== CLI_SHA256) throw new Error("Pinned Windows Sandbox CLI unavailable or changed");
		return new CapturedProcess(CLI_PATH, args, path.dirname(CLI_PATH));
	}
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// One owner, at most one control call plus one pending fixed exec during cleanup.
// Tests inject a transport, not another executable or arbitrary guest command.
export class SandboxLifecycle {
	id = randomUUID();
	taskId = randomUUID();
	state = "prepared";
	startAttempted = false;
	startSettled = false;
	registered = false;
	stopAttempted = false;
	active;
	execution;
	connection;
	calls = [];
	cleanupPromise;
	constructor({ cli, config, journal, limits = DEFAULT_LIMITS, taskId, workload }) {
		if (taskId !== undefined && (typeof taskId !== "string" || !UUID.test(taskId))) throw new Error("Invalid task identity");
		if (taskId !== undefined) this.taskId = taskId;
		this.workload = workload;
		this.cli = cli; this.config = config; this.journal = journal; this.limits = limits;
		this.configSha256 = createHash("sha256").update(config).digest("hex");
		this.save();
	}
	save() {
		this.journal({ protocol: "super-pi-wsb-lifecycle-v1", taskId: this.taskId, instanceId: this.id,
			cli: { path: CLI_PATH, version: CLI_VERSION, sha256: CLI_SHA256 }, configSha256: this.configSha256,
			state: this.state, startAttempted: this.startAttempted, startSettled: this.startSettled,
			registered: this.registered, stopAttempted: this.stopAttempted, workload: this.workload ?? null,
			controlPending: !!this.active, executionPending: !!this.execution, connectionPending: !!this.connection,
			cleanupError: this.cleanupError ?? null, calls: this.calls });
	}
	async invoke(kind, args, ms, signal, dispatchGuard) {
		if (this.active || this.execution && (kind === "exec" || this.state !== "cleaning")
			|| this.calls.length >= MAX_CALLS) throw new Error("CLI ownership busy or call budget exhausted");
		const slot = kind === "exec" ? "execution" : "active";
		const entry = { kind, requestedUtc: new Date().toISOString(), pid: null, outcome: "launching", result: null };
		this.calls.push(entry); this.save();
		if (dispatchGuard !== undefined) {
			try {
				if (!["start", "exec"].includes(kind) || signal?.aborted || dispatchGuard(this) !== true) throw new Error("Dispatch permission revoked");
			} catch (error) {
				this.rejectUndispatched(kind, entry); throw error;
			}
		}
		let operation;
		try {
			// Adapters which persist a reservation must repeat this private guard immediately before their factory.
			operation = this.cli.launch(args, dispatchGuard === undefined ? undefined : { owner: this, validate: dispatchGuard, signal });
		} catch (error) {
			if (error instanceof UndispatchedError) this.rejectUndispatched(kind, entry);
			throw error;
		}
		entry.pid = operation.pid ?? null;
		this[slot] = { operation, entry };
		this.save();
		entry.outcome = await operation.wait(ms, signal);
		if (operation.result) {
			entry.result = operation.result; this[slot] = undefined;
			if (kind === "start") this.startSettled = true;
		}
		this.save();
		if (entry.outcome !== "settled") throw new Error(`CLI ${kind}: ${entry.outcome}; ownership retained`);
		return entry.result;
	}
	rejectUndispatched(kind, entry) {
		if (this.calls.at(-1) !== entry || entry.pid !== null || entry.result !== null) throw new Error("Cannot retract a physical call");
		this.calls.pop();
		if (kind === "start") {
			this.startAttempted = false;
			if (!this.cleanupPromise && this.state === "starting") this.state = "preflight";
		}
		this.save();
	}
	async list() { return parseRunning(await this.invoke("list", ["list", "--raw"], this.limits.callMs)); }
	async start(signal, beforeDispatch) {
		if (this.state !== "prepared") throw new Error("Owner cannot start twice");
		this.state = "preflight"; this.save();
		if ((await this.list()).size !== 0) throw new Error("Existing instances: refusing to take ownership");
		if (signal?.aborted) throw new Error("Cancelled before start");
		let dispatchBinding;
		if (beforeDispatch !== undefined) {
			if (typeof beforeDispatch !== "function") throw new Error("Invalid host dispatch guard");
			const binding = await beforeDispatch(this); // Cold start boundary, after list and immediately before dispatch.
			if (!binding || typeof binding.validate !== "function" || binding.instanceId !== this.id || binding.config !== this.config || binding.configSha256 !== this.configSha256
				|| createHash("sha256").update(binding.config).digest("hex") !== binding.configSha256) throw new Error("Dispatch binding changed");
			dispatchBinding = binding;
			if (signal?.aborted) throw new Error("Cancelled by dispatch guard");
			if (this.state !== "preflight" || this.cleanupPromise) throw new Error("Dispatch owner already cleaning or closed");
		}
		this.state = "starting"; this.startAttempted = true; this.save();
		const result = await this.invoke("start", ["start", "--id", dispatchBinding?.instanceId ?? this.id,
			"--config", dispatchBinding?.config ?? this.config, "--raw"], this.limits.startMs, signal, dispatchBinding?.validate);
		if (!successful(result)) throw new Error("Start command did not succeed; ownership retained");
		if (!(await this.list()).has(this.id)) throw new Error("Start completed without confirmed registration");
		this.registered = true; this.state = "registered-not-guest-ready"; this.save();
		if (signal?.aborted) throw new Error("Cancelled after start; cleanup required");
		return this.id;
	}
	async executeFixed(signal) {
		if (this.state !== "registered-not-guest-ready" || !this.registered || !this.startSettled) throw new Error("Fixed execution requires owned registration");
		if (signal?.aborted) throw new Error("Cancelled before fixed execution");
		this.state = "executing-fixed"; this.save();
		const command = `"${GUEST_INPUT}\\node.exe" "${GUEST_INPUT}\\guest.mjs"`;
		const result = await this.invoke("exec", ["exec", "--id", this.id, "-c", command, "-d", GUEST_INPUT, "-r", "System", "--raw"], this.limits.execMs, signal);
		if (!successful(result)) throw new Error("Fixed exec CLI failed; its exit code is not the task exit code");
		this.state = "fixed-entry-returned"; this.save();
		return result; // Opaque reply; wrapper and fixed child exit codes are separate facts.
	}
	async executeNetworkProbe(signal) {
		if (this.state !== "registered-not-guest-ready" || !this.registered || !this.startSettled) throw new Error("Network probe requires owned registration");
		if (signal?.aborted) throw new Error("Cancelled before network probe");
		this.state = "executing-network"; this.save();
		const result = await this.invoke("exec", ["exec", "--id", this.id, "-c", '"C:\\SuperPiNetwork\\Input\\probe.exe"',
			"-d", "C:\\SuperPiNetwork\\Input", "-r", "System", "--raw"], this.limits.execMs, signal);
		if (!successful(result)) throw new Error("Network probe CLI failed");
		this.state = "network-entry-returned"; this.save(); return result;
	}
	async executeCancellationProbe(signal) {
		if (this.state !== "registered-not-guest-ready" || !this.registered || !this.startSettled) throw new Error("Cancellation probe requires owned registration");
		if (signal?.aborted) throw new Error("Cancelled before cancellation probe");
		this.state = "executing-cancellation"; this.save();
		const result = await this.invoke("exec", ["exec", "--id", this.id, "-c", '"C:\\SuperPiCancel\\Input\\probe.exe"',
			"-d", "C:\\SuperPiCancel\\Input", "-r", "System", "--raw"], this.limits.execMs, signal);
		this.state = "cancellation-entry-returned"; this.save(); return result;
	}
	async executeFileProbe(signal) {
		if (this.state !== "registered-not-guest-ready" || !this.registered || !this.startSettled) throw new Error("File probe requires owned registration");
		if (signal?.aborted) throw new Error("Cancelled before file probe");
		this.state = "executing-files"; this.save();
		const result = await this.invoke("exec", ["exec", "--id", this.id, "-c", '"C:\\SuperPiFiles\\Input\\probe.exe"',
			"-d", "C:\\SuperPiFiles\\Input", "-r", "System", "--raw"], this.limits.execMs, signal);
		this.state = "file-entry-returned"; this.save(); return result;
	}
	connectClipboardSession() {
		if (this.state !== "registered-not-guest-ready" || this.connection || this.active || this.execution || this.calls.length >= MAX_CALLS) throw new Error("Connection requires idle owned registration");
		const entry = { kind: "connect", requestedUtc: new Date().toISOString(), pid: null, outcome: "launched", result: null };
		this.calls.push(entry); this.save();
		const operation = this.cli.launch(["connect", "--id", this.id, "--raw"]);
		entry.pid = operation.pid ?? null; this.connection = { operation, entry }; this.save();
	}
	async executeClipboardProbe(signal) {
		if (this.state !== "registered-not-guest-ready" || !this.connection || !this.registered || !this.startSettled) throw new Error("Clipboard probe requires owned interactive connection");
		if (signal?.aborted) throw new Error("Cancelled before clipboard probe");
		this.state = "executing-clipboard"; this.save();
		const result = await this.invoke("exec", ["exec", "--id", this.id, "-c", '"C:\\SuperPiClipboard\\Input\\probe.exe"',
			"-d", "C:\\SuperPiClipboard\\Input", "-r", "ExistingLogin", "--raw"], 90_000, signal);
		if (!successful(result)) throw new Error("Clipboard probe CLI failed");
		this.state = "clipboard-entry-returned"; this.save(); return result;
	}
	cleanup() {
		if (!this.cleanupPromise) this.cleanupPromise = this.clean();
		return this.cleanupPromise;
	}
	async clean() {
		try {
			this.state = "cleaning"; this.save();
			if (this.active) {
				const { operation, entry } = this.active;
				if (await operation.wait(this.limits.settleMs) !== "settled") throw new Error("CLI remains physically pending; retain owner and admission lock");
				entry.result = operation.result; entry.outcome += "/settled"; this.active = undefined;
				if (entry.kind === "start") this.startSettled = true;
				this.save();
			}
			if (!this.startAttempted) { this.state = "closed-before-start"; this.save(); return true; }
			if (!this.startSettled) throw new Error("Start dispatch outcome uncertain");
			const initial = await this.list();
			if (initial.has(this.id)) this.registered = true;
			if (!this.registered) throw new Error("Never observed owned instance; cannot exclude late registration");
			if (initial.has(this.id)) {
				this.stopAttempted = true; this.save();
				// Record opaque raw reply. A zero exit alone never proves VM exit.
				await this.invoke("stop", ["stop", "--id", this.id, "--raw"], this.limits.callMs);
			}
			const deadline = Date.now() + this.limits.exitMs;
			for (;;) {
				if (!(await this.list()).has(this.id)) {
					// Stop first: a pending exec may be waiting for its guest process.
					if (this.execution) {
						const { operation, entry } = this.execution;
						if (await operation.wait(this.limits.settleMs) !== "settled") throw new Error("Instance absent but exec physically pending; retain owner");
						entry.result = operation.result; entry.outcome += "/settled"; this.execution = undefined;
					}
					if (this.connection) {
						const { operation, entry } = this.connection;
						if (await operation.wait(this.limits.settleMs) !== "settled") throw new Error("Instance absent but connection CLI pending; retain owner");
						entry.result = operation.result; entry.outcome = "settled"; this.connection = undefined;
					}
					this.state = "closed"; this.save(); return true;
				}
				if (Date.now() >= deadline) throw new Error("Owned instance still listed after stop");
				await delay(this.limits.pollMs);
			}
		} catch (error) {
			this.state = "blocked-cleanup";
			this.cleanupError = String(error.message);
			this.save();
			return false;
		}
	}
}

// Fixed project-local admission lock: stale/uncertain owners are never stolen.
// Only this root's recorded file identity can be removed after confirmed close.
export function acquireAcceptanceRoot() {
	const workspace = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
	const parent = path.join(workspace, ".artifacts");
	fs.mkdirSync(parent, { recursive: true });
	if (fs.realpathSync(parent) !== parent || fs.lstatSync(parent).isSymbolicLink()) throw new Error("Artifact parent is redirected");
	const root = path.join(parent, "windows-sandbox-acceptance-owner");
	fs.mkdirSync(root); // EEXIST is a blocked owner, never automatic recovery.
	const identity = fs.lstatSync(root, { bigint: true });
	const recordPath = path.join(root, "lifecycle.json");
	const nextPath = path.join(root, "lifecycle.next.json");
	function journal(record) {
		// Host only; root itself is never shared with the guest.
		// A failed write leaves the previous owner identity intact and blocks reuse.
		fs.writeFileSync(nextPath, JSON.stringify(record, null, 2), { flag: "wx" });
		fs.renameSync(nextPath, recordPath);
	}
	function remove(owner) {
		if (owner.active || owner.execution || owner.connection || !["closed", "closed-before-start"].includes(owner.state)) throw new Error("Owner has not confirmed exit");
		const actual = fs.lstatSync(root, { bigint: true });
		if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== identity.dev || actual.ino !== identity.ino
			|| fs.realpathSync(root) !== root || path.dirname(root) !== parent) throw new Error("Owned artifact identity changed");
		fs.rmSync(root, { recursive: true });
		if (fs.existsSync(root)) throw new Error("Owned artifacts remain");
	}
	return { root, journal, remove };
}
