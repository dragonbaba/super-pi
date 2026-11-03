// Offline, bounded candidate inspection only. No runtime/VM entry point or commit API.
// The caller supplies trusted host records. This is NOT a production exit-proof adapter,
// a complete Windows reparse-tag detector, a disk quota, or guest-output authentication.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const CANDIDATE_PROTOCOL = "super-pi-offline-candidates-v1";
export const CANDIDATE_LIMITS = Object.freeze({ entries: 16, fileBytes: 4096, totalBytes: 16384, manifestBytes: 4096 });
// Shared data rules only; exporting these does not admit a new filesystem root or runtime.
export { candidatePath as validateCandidateRelativePath, manifest as parseCandidateManifest };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
function requireThat(value, code) { if (!value) throw new Refusal(code); }
function fields(value, names) {
	requireThat(value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).sort().join(",") === names, "schema");
}
function candidatePath(value) {
	requireThat(typeof value === "string" && value.length > 0 && value.length <= 120, "path");
	const parts = value.split("/");
	requireThat(parts.length <= 4, "path");
	for (const part of parts) requireThat(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part)
		&& !part.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "path");
	return value;
}
function identity(stat) { return Object.freeze({ dev: stat.dev, ino: stat.ino }); }
function sameId(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a, b) {
	return sameId(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n && b.isFile();
}
function directory(name) {
	const stat = fs.lstatSync(name, { bigint: true });
	requireThat(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(name) === name, "directory");
	return stat;
}
function snapshotContext(input) {
	fields(input, "allowed,budget,instanceId,lifecycle,observations,root,rootIdentity,snapshotId,taskId");
	for (const key of ["taskId", "snapshotId", "instanceId"]) requireThat(typeof input[key] === "string" && UUID.test(input[key]), "host-context");
	requireThat(process.platform === "win32" && typeof input.root === "string" && input.root.length <= 240
		&& /^[A-Za-z]:\\/.test(input.root) && path.resolve(input.root) === input.root, "host-root");
	fields(input.rootIdentity, "dev,ino");
	requireThat(typeof input.rootIdentity.dev === "bigint" && typeof input.rootIdentity.ino === "bigint" && input.rootIdentity.ino > 0n, "host-identity");
	fields(input.budget, "entries,fileBytes,manifestBytes,totalBytes");
	const budget = {};
	for (const key of Object.keys(CANDIDATE_LIMITS)) {
		const value = input.budget[key];
		requireThat(Number.isSafeInteger(value) && value > 0 && value <= CANDIDATE_LIMITS[key], "host-budget");
		budget[key] = value;
	}
	requireThat(Array.isArray(input.allowed) && input.allowed.length <= budget.entries, "host-allowlist");
	const allowed = [];
	for (const item of input.allowed) {
		fields(item, "operation,path,revision"); candidatePath(item.path);
		requireThat(item.operation === "add" ? item.revision === null : item.operation === "modify"
			&& typeof item.revision === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(item.revision), "host-baseline");
		const lower = item.path.toLowerCase();
		for (const previous of allowed) {
			const other = previous.path.toLowerCase();
			requireThat(lower !== other && !lower.startsWith(other + "/") && !other.startsWith(lower + "/"), "host-target-conflict");
		}
		allowed.push(Object.freeze({ path: item.path, operation: item.operation, revision: item.revision }));
	}
	fields(input.lifecycle, "callsClosed,cancelled,instanceAbsent,platformFailed,state,timedOut");
	requireThat(["closed", "active", "unknown"].includes(input.lifecycle.state), "host-lifecycle");
	for (const key of ["callsClosed", "cancelled", "instanceAbsent", "platformFailed", "timedOut"])
		requireThat(typeof input.lifecycle[key] === "boolean", "host-lifecycle");
	fields(input.observations, "cliClose,platformReceipt");
	fields(input.observations.cliClose, "exitCode,signal");
	requireThat(validExit(input.observations.cliClose.exitCode)
		&& (input.observations.cliClose.signal === null || input.observations.cliClose.signal === "SIGTERM"), "host-observation");
	let platformReceipt = null;
	if (input.observations.platformReceipt !== null) {
		fields(input.observations.platformReceipt, "exitCode");
		requireThat(validExit(input.observations.platformReceipt.exitCode), "host-observation");
		platformReceipt = Object.freeze({ source: "platform-interface", exitCode: input.observations.platformReceipt.exitCode });
	}
	return Object.freeze({ taskId: input.taskId, instanceId: input.instanceId, snapshotId: input.snapshotId,
		root: input.root, rootIdentity: identity(input.rootIdentity), allowed: Object.freeze(allowed), budget: Object.freeze(budget),
		lifecycle: Object.freeze({ ...input.lifecycle }), observations: Object.freeze({
			cliClose: Object.freeze({ source: "host-cli-process", ...input.observations.cliClose }), platformReceipt }) });
}
function validExit(value) { return value === null || Number.isInteger(value) && value >= -2147483648 && value <= 4294967295; }
function eligible(context, lease) {
	requireThat(!lease.revoked && !lease.disposed, "owner-revoked");
	const life = context.lifecycle;
	requireThat(life.state === "closed" && life.callsClosed && life.instanceAbsent && !life.cancelled && !life.timedOut
		&& !life.platformFailed && context.observations.cliClose.exitCode === 0 && context.observations.cliClose.signal === null
		&& (context.observations.platformReceipt === null || context.observations.platformReceipt.exitCode === 0), "owner-not-settled");
}

// Explicit handles only: lstat/realpath's internal OS handles are outside these counters.
function boundedRead(context, relative, maximum, lease, metrics, uncertainHandles) {
	eligible(context, lease);
	const components = relative.split("/"), parents = [];
	let current = context.root;
	parents.push({ name: current, stat: directory(current) });
	requireThat(sameId(parents[0].stat, context.rootIdentity), "root-identity");
	for (let i = 0; i < components.length - 1; i++) {
		current = path.join(current, components[i]); parents.push({ name: current, stat: directory(current) });
	}
	const file = path.join(current, components.at(-1));
	const before = fs.lstatSync(file, { bigint: true });
	requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && fs.realpathSync(file) === file, "file-kind");
	requireThat(before.size >= 0n && before.size <= BigInt(maximum), "byte-budget");
	const fd = fs.openSync(file, "r");
	metrics.opened++; metrics.activeHandles++; metrics.peakHandles = Math.max(metrics.peakHandles, metrics.activeHandles);
	let bytes, complete = false;
	try {
		requireThat(sameFile(before, fs.fstatSync(fd, { bigint: true })), "file-changed");
		for (const parent of parents) requireThat(sameId(directory(parent.name), parent.stat), "parent-changed");
		eligible(context, lease);
		bytes = Buffer.alloc(Number(before.size)); metrics.readBuffers++; metrics.allocatedBytes += bytes.length;
		let offset = 0;
		while (offset < bytes.length) {
			const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
			requireThat(count > 0, "file-truncated"); offset += count; metrics.readBytes += count;
		}
		requireThat(sameFile(before, fs.fstatSync(fd, { bigint: true })) && sameFile(before, fs.lstatSync(file, { bigint: true }))
			&& fs.realpathSync(file) === file, "file-changed");
		for (const parent of parents) requireThat(sameId(directory(parent.name), parent.stat), "parent-changed");
		eligible(context, lease); complete = true;
		return { bytes, identity: identity(before) };
	} finally {
		if (!complete) bytes?.fill(0);
		try { fs.closeSync(fd); metrics.closed++; metrics.activeHandles--; }
		catch (error) { bytes?.fill(0); uncertainHandles.push(fd); throw new Refusal("close-unknown"); }
	}
}
function manifest(bytes, context) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const value = JSON.parse(text);
	// A small canonical JSON protocol rejects duplicate keys without a second parser.
	requireThat(JSON.stringify(value) === text, "manifest-encoding");
	fields(value, "candidates,protocol,report,snapshotId,taskId");
	requireThat(value.protocol === CANDIDATE_PROTOCOL && value.taskId === context.taskId && value.snapshotId === context.snapshotId, "association");
	fields(value.report, "exitCode"); requireThat(validExit(value.report.exitCode), "guest-report");
	requireThat(Array.isArray(value.candidates) && value.candidates.length <= context.budget.entries, "entry-budget");
	const seen = new Set();
	for (const item of value.candidates) {
		fields(item, "operation,path"); candidatePath(item.path);
		requireThat(!seen.has(item.path.toLowerCase()), "duplicate-target"); seen.add(item.path.toLowerCase());
		const permitted = context.allowed.find(allowed => allowed.path === item.path);
		requireThat(permitted && permitted.operation === item.operation, "target-or-operation");
	}
	return value;
}
class CheckedCandidates {
	#records; #buffers; #binding; #observations; #lease; #metrics;
	constructor(records, buffers, context, report, lease, metrics) {
		this.#records = Object.freeze(records); this.#buffers = buffers; this.#lease = lease; this.#metrics = metrics;
		this.#binding = Object.freeze({ taskId: context.taskId, instanceId: context.instanceId, snapshotId: context.snapshotId });
		this.#observations = Object.freeze({ ...context.observations,
			guestReport: Object.freeze({ source: "guest-report", exitCode: report.exitCode }) });
	}
	get status() { return this.#buffers === undefined ? "disposed" : "candidate-checked"; }
	#usable() { requireThat(this.#buffers !== undefined && !this.#lease.revoked && !this.#lease.disposed, "candidate-unavailable"); }
	get binding() { this.#usable(); return this.#binding; }
	get records() { this.#usable(); return this.#records; }
	get observations() { this.#usable(); return this.#observations; }
	copyBytes(index) {
		this.#usable(); requireThat(Number.isInteger(index) && index >= 0 && index < this.#buffers.length, "candidate-index");
		// Caller owns this bounded copy; dispose cannot erase copies retained externally.
		return Buffer.from(this.#buffers[index]);
	}
	dispose() {
		if (this.#buffers === undefined) return;
		for (const bytes of this.#buffers) bytes.fill(0);
		this.#buffers = undefined; this.#records = undefined; this.#binding = undefined; this.#observations = undefined;
		this.#metrics.retainedBytes = 0; this.#metrics.retainedCandidates = 0;
	}
}

// Only synthetic fixtures currently instantiate this owner. Frozen state is not OS
// isolation. A future runtime adapter must supply real, fresh host lifecycle evidence.
export class OfflineCandidateOwner {
	#context; #lease = { revoked: false, disposed: false }; #attempted = false; #checked;
	#uncertainHandles = [];
	#metrics = { opened: 0, closed: 0, activeHandles: 0, peakHandles: 0, readBuffers: 0, allocatedBytes: 0,
		readBytes: 0, retainedBytes: 0, retainedCandidates: 0 };
	constructor(input) { this.#context = snapshotContext(input); }
	get diagnostics() { return Object.freeze({ ...this.#metrics, uncertainHandles: Object.freeze(this.#uncertainHandles.slice()) }); }
	revoke() { this.#lease.revoked = true; this.#checked?.dispose(); }
	dispose() { this.revoke(); this.#lease.disposed = true; this.#context = undefined; this.#checked = undefined; }
	check() {
		const buffers = [], records = [];
		try {
			requireThat(!this.#attempted, "owner-already-checked"); this.#attempted = true;
			requireThat(this.#context !== undefined, "owner-disposed");
			const context = this.#context; eligible(context, this.#lease);
			const raw = boundedRead(context, "candidates.json", context.budget.manifestBytes, this.#lease, this.#metrics, this.#uncertainHandles);
			let data;
			try { data = manifest(raw.bytes, context); } finally { raw.bytes.fill(0); }
			for (const candidate of data.candidates) {
				const read = boundedRead(context, "payload/" + candidate.path,
					Math.min(context.budget.fileBytes, context.budget.totalBytes - this.#metrics.retainedBytes),
					this.#lease, this.#metrics, this.#uncertainHandles);
				buffers.push(read.bytes); this.#metrics.retainedBytes += read.bytes.length; this.#metrics.retainedCandidates++;
				const baseline = context.allowed.find(allowed => allowed.path === candidate.path);
				records.push(Object.freeze({ path: baseline.path, operation: baseline.operation, sourceRevision: baseline.revision,
					bytes: read.bytes.length, sha256: createHash("sha256").update(read.bytes).digest("hex"), identity: read.identity }));
			}
			eligible(context, this.#lease);
			this.#checked = new CheckedCandidates(records, buffers, context, data.report, this.#lease, this.#metrics);
			return this.#checked;
		} catch (error) {
			for (const bytes of buffers) bytes.fill(0);
			if (!this.#checked) { this.#metrics.retainedBytes = 0; this.#metrics.retainedCandidates = 0; }
			const reason = error instanceof Refusal ? error.code : error instanceof SyntaxError || error instanceof TypeError ? "manifest-invalid" : "io-failure";
			return Object.freeze({ status: "rejected", reason, cleanup: this.#uncertainHandles.length ? "unknown" : "complete" });
		}
	}
}
