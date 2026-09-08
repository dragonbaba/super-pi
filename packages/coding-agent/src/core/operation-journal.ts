/** Experimental, session-local durable facts for the trusted local write adapter only. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { writeSessionEntriesAtomically } from "./atomic-session-file.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_RECORD = 8192;
const MAX_OPERATIONS = 1024;
export interface OperationJournalOptions { enabled: boolean; /** Explicit host attestation: the exact previous writer has stopped. */ stoppedWriterToken?: string; }
export interface OperationWriteIntent { intentId: string; originBranch: string | null; path: string; content: string; }
export interface OperationWriteRecovery { originBranch: string | null; path: string; content: string; }
type State = "planned" | "started" | "completed" | "failed" | "unknown";
interface Header { version: 1; journal: string; session: string; cwd: string; }
export interface OperationReceipt { operationId: string; attemptId: string; bytes: number; digest: string; target: string; summary: "write acknowledged"; }
interface RecordV1 { version: 1; operationId: string; branch: string | null; binding: string; parent: string; initialTarget: string; state: State; attempt: number; receipt: OperationReceipt | null; }
export interface OperationCompletion { operationId: string; receipt: OperationReceipt; historical: boolean; }

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function exactKeys(value: unknown, keys: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) throw new Error("Corrupt operation record fields");
}
function boundedRead(path: string, cap: number): unknown {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap) throw new Error("Corrupt or oversized journal file");
		const bytes = Buffer.alloc(cap + 1);
		let length = 0;
		while (length <= cap) { const n = readSync(fd, bytes, length, cap + 1 - length, null); if (!n) break; length += n; }
		if (length > cap) throw new Error("Oversized journal file");
		const envelope = JSON.parse(bytes.toString("utf8", 0, length));
		exactKeys(envelope, "body,checksum");
		if (typeof envelope.body !== "string" || envelope.checksum !== hash(envelope.body)) throw new Error("Corrupt journal checksum");
		return JSON.parse(envelope.body);
	} finally { closeSync(fd); }
}
function encodeBounded(value: unknown, cap: number): { body: string; checksum: string } {
	const body = JSON.stringify(value);
	const envelope = { body, checksum: hash(body) };
	if (Buffer.byteLength(JSON.stringify(envelope)) + 1 > cap) throw new Error("Operation record capacity");
	return envelope;
}
function publish(path: string, value: unknown, replace: boolean, cap: number): void {
	const envelope = encodeBounded(value, cap);
	// Same acknowledged file-fsync/atomic-install chain as SessionManager. Keep failed staging evidence.
	writeSessionEntriesAtomically(path, [envelope], replace, true);
}
function requireLocalFilesystem(path: string): void {
	const fsType = Number(statfsSync(path).type);
	if (!(fsType === 0xef53 || fsType === 0x58465342 || fsType === 0x9123683e || fsType === 0x01021994)) throw new Error("Unsupported local filesystem identity");
}
function directoryIdentity(path: string): string {
	if (process.platform !== "linux") throw new Error("Unsupported protected-write platform: native Linux required");
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute.slice(current.length).split("/")) {
		if (!part) continue;
		current = join(current, part);
		const st = lstatSync(current, { bigint: true });
		if (!st.isDirectory() || st.isSymbolicLink() || st.ino === 0n) throw new Error("Unsupported directory identity");
	}
	if (realpathSync(absolute) !== absolute) throw new Error("Unsupported local filesystem identity");
	requireLocalFilesystem(absolute);
	const st = lstatSync(absolute, { bigint: true });
	return `${absolute}:${st.dev}:${st.ino}`;
}
// Metadata only: ordinary transcript appends do not change this authority identity.
function sessionAnchor(path: string) {
	if (typeof path !== "string" || Buffer.byteLength(path) > 1024) throw new Error("Unsupported session anchor");
	const stat = lstatSync(path, { bigint: true });
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n) throw new Error("Unsupported session anchor");
	return stat;
}

/** @internal Bounded admission identity; never file contents or timestamps. */
export function operationSessionIdentity(path: string): string {
	const stat = sessionAnchor(path);
	return `${stat.dev}:${stat.ino}`;
}

/** Experimental read-only inspection. Throws on missing, corrupt or unsupported input.
 * A token observes ownership; it does not prove termination or authorize lock stealing.
 */
export function inspectOperationWriter(sessionFile: string): string {
	return OperationJournal.inspectWriter(sessionFile);
}

function targetIdentity(path: string): string {
	try {
		const st = lstatSync(path, { bigint: true });
		if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.ino === 0n) throw new Error("Unsupported target identity");
		requireLocalFilesystem(path);
		return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

/** Linux O_PATH + bounded procfs metadata; never reads target content. */
function mountIdentity(path: string): string {
	const target = openSync(path, 0x200000 | constants.O_NOFOLLOW);
	try {
		const info = openSync(`/proc/self/fdinfo/${target}`, "r");
		try {
			const bytes = Buffer.alloc(1025);
			let length = 0;
			while (length < bytes.length) { const n = readSync(info, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
			const match = length <= 1024 ? /^mnt_id:\s*(\d+)$/m.exec(bytes.toString("utf8", 0, length)) : null;
			if (!match) throw new Error("Unsupported mount identity metadata");
			return match[1];
		} finally { closeSync(info); }
	} finally { closeSync(target); }
}

export class OperationJournal {
	readonly counters = { effects: 0, publications: 0, fsyncs: 0, attempts: 0, busyDenials: 0, replayDenials: 0,
		entries: 0, metadataBytes: 0, metadataHighWaterMark: 0, active: 0, activeHighWaterMark: 0, payloadBytesHashed: 0, recoveries: 0, ownershipFailures: 0 };
	private readonly directory: string;
	private readonly directoryBinding: string;
	private readonly header: Header;
	private readonly token = randomUUID();
	private count = 0;
	private disposed = false;
	private poisoned = false;
	private closed = false;

	constructor(sessionFile: string, session: string, cwd: string, stoppedWriterToken?: string, recoveryOnly = false) {
		const proposedHeader: Header = { version: 1, journal: randomUUID(), session, cwd: resolve(cwd) };
		const encodedHeader = encodeBounded(proposedHeader, 1024);
		sessionAnchor(sessionFile);
		directoryIdentity(dirname(sessionFile)); directoryIdentity(cwd);
		this.directory = `${sessionFile}.operations-v1`;
		if (recoveryOnly && !existsSync(join(this.directory, "header"))) throw new Error("Missing journal: recovery unavailable");
		if (!existsSync(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
		this.directoryBinding = directoryIdentity(this.directory);
		if ((lstatSync(this.directory).mode & 0o077) !== 0) throw new Error("Journal directory is not private");
		const headerPath = join(this.directory, "header");
		const lockPath = join(this.directory, "lock");
		if (existsSync(lockPath)) {
			const previous = boundedRead(lockPath, 1024);
			exactKeys(previous, "version,token");
			if (previous.version !== 1 || !stoppedWriterToken || previous.token !== stoppedWriterToken) throw new Error("Journal busy: explicit stopped-writer reconciliation required");
			// Caller has established that this exact writer stopped. No PID/time based stealing.
			unlinkSync(lockPath);
		}
		// Claim exclusion before allocating any journal staging file. Partial locks fail closed.
		const lockFd = openSync(lockPath, "wx", 0o600);
		try {
			const body = JSON.stringify({ version: 1, token: this.token });
			writeFileSync(lockFd, JSON.stringify({ body, checksum: hash(body) })); fsyncSync(lockFd);
			this.counters.publications++; this.counters.fsyncs++;
		} finally { closeSync(lockFd); }
		try {
			if (existsSync(headerPath)) {
				const header = boundedRead(headerPath, 1024);
				exactKeys(header, "version,journal,session,cwd");
				if (header.version !== 1 || typeof header.journal !== "string" || !UUID.test(header.journal) || header.session !== session || header.cwd !== resolve(cwd)) throw new Error("Corrupt or foreign journal header");
				this.header = header as unknown as Header;
			} else {
				const existing = opendirSync(this.directory);
				try { for (let entry = existing.readSync(); entry; entry = existing.readSync()) if (entry.name !== "lock") throw new Error("Missing header in nonempty journal"); }
				finally { existing.closeSync(); }
				this.header = proposedHeader;
				writeSessionEntriesAtomically(headerPath, [encodedHeader], false, true);
				this.counters.publications++; this.counters.fsyncs++;
			}
			const dir = opendirSync(this.directory);
			try {
				for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
					if (entry.name === "header" || entry.name === "lock") continue;
					if (!entry.isFile() || !UUID.test(entry.name) || ++this.count > MAX_OPERATIONS) throw new Error("Corrupt journal or capacity exceeded; preserve for reconciliation");
					this.read(entry.name);
				}
			} finally { dir.closeSync(); }
			this.counters.metadataBytes = Buffer.byteLength(JSON.stringify(this.header)) + Buffer.byteLength(this.directoryBinding) + Buffer.byteLength(this.directory) + this.token.length;
			this.counters.metadataHighWaterMark = this.counters.metadataBytes;
		} catch (error) { this.poisoned = true; throw error; }
	}

	/** Read-only ownership inspection for a host that can independently establish writer termination. */
	static inspectWriter(sessionFile: string): string {
		sessionAnchor(sessionFile);
		directoryIdentity(`${sessionFile}.operations-v1`);
		const lock = boundedRead(join(`${sessionFile}.operations-v1`, "lock"), 1024);
		exactKeys(lock, "version,token");
		if (lock.version !== 1 || typeof lock.token !== "string" || !UUID.test(lock.token)) throw new Error("Corrupt lock");
		return lock.token;
	}
	claim(): void {
		if (this.closed || this.disposed || this.poisoned) throw new Error("Operation journal unavailable");
		if (this.counters.active) { this.counters.busyDenials++; throw new Error("Operation journal busy"); }
		this.counters.active = 1; this.counters.activeHighWaterMark = 1;
	}
	release(): void { this.counters.active = 0; if (this.disposed) this.close(); }
	dispose(): void { this.disposed = true; if (!this.counters.active) this.close(); }
	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.counters.metadataBytes = 0;
		if (!this.poisoned) {
			try { this.validateOwner(); unlinkSync(join(this.directory, "lock")); }
			catch { this.poisoned = true; this.counters.ownershipFailures++; } // Preserve the marker, but release live callbacks.
		}
	}
	private validateOwner(): void {
		sessionAnchor(this.directory.slice(0, -".operations-v1".length));
		if (directoryIdentity(this.directory) !== this.directoryBinding) throw new Error("Journal directory identity changed");
		const lock = boundedRead(join(this.directory, "lock"), 1024);
		exactKeys(lock, "version,token");
		if (lock.version !== 1 || lock.token !== this.token) throw new Error("Journal ownership changed");
	}
	private rejectAuthorityTarget(absolute: string): void {
		const journal = lstatSync(this.directory, { bigint: true });
		const session = sessionAnchor(this.directory.slice(0, -".operations-v1".length));
		let current = absolute;
		let targetExists = false;
		for (;;) {
			try {
				const node = lstatSync(current, { bigint: true });
				if (node.dev === journal.dev && node.ino === journal.ino || current === absolute && node.dev === session.dev && node.ino === session.ino) throw new Error("Protected write aliases its own authority");
				if (current === absolute) targetExists = true;
			} catch (error) { if (current !== absolute || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const parent = dirname(current); if (parent === current) break; current = parent;
		}
		// A file bind mount can alias any old record without exposing its journal ancestor.
		// Refuse all file mountpoints, avoiding a resident inode index or history-wide scan.
		if (targetExists && mountIdentity(absolute) !== mountIdentity(dirname(absolute))) throw new Error("Unsupported file mount identity");
	}
	private read(intent: string): RecordV1 {
		const r = boundedRead(join(this.directory, intent), MAX_RECORD);
			exactKeys(r, "version,operationId,branch,binding,parent,initialTarget,state,attempt,receipt");
		if (r.version !== 1 || r.operationId !== `op1:${this.header.journal}:${intent}` ||
			!(r.branch === null || typeof r.branch === "string" && Buffer.byteLength(r.branch) <= 128) ||
			typeof r.binding !== "string" || !DIGEST.test(r.binding) ||
			typeof r.parent !== "string" || !DIGEST.test(r.parent) || typeof r.initialTarget !== "string" || r.initialTarget.length > 256 ||
			!["planned", "started", "completed", "failed", "unknown"].includes(String(r.state)) ||
			r.attempt !== (r.state === "planned" ? 0 : 1)) throw new Error("Corrupt operation identity/state");
		if (r.state === "completed") {
			exactKeys(r.receipt, "operationId,attemptId,bytes,digest,target,summary");
			const receipt = r.receipt;
			if (receipt.operationId !== r.operationId || receipt.attemptId !== `${r.operationId}:1` || receipt.summary !== "write acknowledged" ||
				!Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 0 || Number(receipt.bytes) > 262144 ||
				typeof receipt.digest !== "string" || !DIGEST.test(receipt.digest) || typeof receipt.target !== "string" || receipt.target.length > 256 ||
				Buffer.byteLength(JSON.stringify(receipt)) > 2048) throw new Error("Corrupt receipt");
		} else if (r.receipt !== null) throw new Error("Contradictory receipt");
		return r as unknown as RecordV1;
	}
	private save(intent: string, record: RecordV1, replace: boolean): void {
		try { this.validateOwner(); publish(join(this.directory, intent), record, replace, MAX_RECORD); this.counters.publications++; this.counters.fsyncs++; }
		catch (error) { this.poisoned = true; throw error; }
	}

	/** Must run inside the trusted write's existing mutation queue, while claim is held. */
	async execute(id: string, resume: boolean, branch: string | null, path: string, content: string, perform: () => Promise<void>, signal?: AbortSignal, sessionIdentity?: string): Promise<OperationCompletion> {
		if (sessionIdentity && operationSessionIdentity(this.directory.slice(0, -".operations-v1".length)) !== sessionIdentity) throw new Error("Operation session identity changed");
		if (!this.counters.active || this.disposed || this.poisoned) throw new Error("Operation owner unavailable");
		if (typeof path !== "string" || typeof content !== "string" || Buffer.byteLength(path) > 1024 || Buffer.byteLength(content) > 262144 ||
			!(branch === null || typeof branch === "string" && Buffer.byteLength(branch) <= 128)) throw new Error("Operation input capacity");
		const parts = id.split(":");
		const intent = resume ? parts[2] : id;
		if (!intent || !UUID.test(intent) || resume && (parts.length !== 3 || parts[0] !== "op1" || parts[1] !== this.header.journal)) throw new Error("Missing or foreign operation ID");
		const absolute = resolve(this.header.cwd, path);
		if (absolute === this.directory.slice(0, -".operations-v1".length) || absolute === this.directory || absolute.startsWith(`${this.directory}/`)) throw new Error("Protected write cannot modify its own authority");
		if (Buffer.byteLength(absolute) > 1024) throw new Error("Operation path capacity");
		const digest = hash(content); this.counters.payloadBytesHashed += Buffer.byteLength(content);
		// Stable intent uses addressed path; post-write inode is a historical receipt fact, not a resume key.
		const binding = hash(JSON.stringify(["local-write-v1", this.header.session, this.header.cwd, branch, absolute, digest]));
		const recordPath = join(this.directory, intent);
		let record: RecordV1;
		if (existsSync(recordPath)) {
			try { record = this.read(intent); } catch (error) { this.poisoned = true; throw error; }
			if (record.binding !== binding || record.branch !== branch) throw new Error("Operation binding conflict");
			if (record.state === "completed") {
				if (record.receipt!.digest !== digest || record.receipt!.bytes !== Buffer.byteLength(content)) throw new Error("Contradictory completed receipt");
				this.validateOwner(); this.counters.recoveries++; return { operationId: record.operationId, receipt: record.receipt!, historical: true };
			}
			if (record.state !== "planned") { this.counters.replayDenials++; throw new Error(`Operation ${record.state === "started" ? "unknown" : record.state}: replay forbidden`); }
		} else {
			if (resume) throw new Error("Missing operation receipt; recovery unavailable");
			if (this.count >= MAX_OPERATIONS) throw new Error("Operation journal capacity; durable records cannot be evicted");
			record = { version: 1, operationId: `op1:${this.header.journal}:${intent}`, branch, binding,
				parent: hash(directoryIdentity(dirname(absolute))), initialTarget: targetIdentity(absolute), state: "planned", attempt: 0, receipt: null };
			this.save(intent, record, false); this.count++;
		}
		const parent = directoryIdentity(dirname(absolute));
		const before = targetIdentity(absolute);
		if (hash(parent) !== record.parent || before !== record.initialTarget) throw new Error("Operation admitted path binding conflict");
		this.rejectAuthorityTarget(absolute);
		if (signal?.aborted) throw new Error("Operation aborted before started");
		record.state = "started"; record.attempt = 1; this.save(intent, record, true); this.counters.attempts++;
		let acknowledged = false;
		try {
			if (directoryIdentity(dirname(absolute)) !== parent || targetIdentity(absolute) !== before) throw new Error("Target binding changed");
			this.rejectAuthorityTarget(absolute);
			if (sessionIdentity && operationSessionIdentity(this.directory.slice(0, -".operations-v1".length)) !== sessionIdentity) throw new Error("Operation session identity changed");
			this.counters.effects++;
			await perform(); // Await settlement even if abort arrives. Never release the queue early.
			acknowledged = true;
			const receipt: OperationReceipt = { operationId: record.operationId, attemptId: `${record.operationId}:1`, bytes: Buffer.byteLength(content), digest, target: targetIdentity(absolute), summary: "write acknowledged" };
			record.state = "completed"; record.receipt = receipt;
			this.save(intent, record, true);
			return { operationId: record.operationId, receipt, historical: false };
		} catch (error) {
			if (this.poisoned || record.state === "completed") { this.poisoned = true; throw error; }
			record.state = acknowledged ? "unknown" : "failed"; record.receipt = null;
			this.save(intent, record, true);
			throw error;
		}
	}
}
