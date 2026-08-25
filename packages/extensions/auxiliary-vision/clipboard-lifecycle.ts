import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { detectImageMime } from "./core.ts";
import {
	SP_CLIPBOARD_FILE_NAME_PATTERN,
	SP_CLIPBOARD_LEASE_NAME_PATTERN,
} from "./regex.ts";

export const CLIPBOARD_LIFECYCLE_SYMBOL = Symbol.for("pi.clipboard-artifact-lifecycle.v1");
export const CLIPBOARD_PER_OWNER_MAX_COUNT = 8;
export const CLIPBOARD_PER_OWNER_MAX_BYTES = 40 * 1024 * 1024;
export const CLIPBOARD_GLOBAL_MAX_COUNT = 32;
export const CLIPBOARD_GLOBAL_MAX_BYTES = 128 * 1024 * 1024;
export const CLIPBOARD_OWNER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLIPBOARD_STALE_LEASE_MIN_AGE_MS = 5 * 60 * 1000;
export const CLIPBOARD_LEGACY_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_LEASE_BYTES = 256 * 1024;
const MAX_LEASE_FILES = 64;
const MAX_LEASE_SCAN = 256;
const MAX_TEMP_SCAN = 4096;
const IMAGE_HEADER_BYTES = 16;

type ClipboardState = "editor" | "submitted" | "materialized";

export type ClipboardFileIdentity = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
};

export type MaterializedClipboardArtifact = ClipboardFileIdentity & {
	path: string;
	mimeType: string;
};

export type ClipboardCreatedInput = {
	path: string;
	mimeType: string;
	sessionId?: string;
};

type ClipboardRecord = ClipboardFileIdentity & {
	path: string;
	mimeType: string;
	createdAtMs: number;
	state: ClipboardState;
	sessionId: string | null;
};

type ClipboardLeaseManifest = {
	version: 1;
	ownerId: string;
	pid: number;
	processStartedAtMs: number;
	startupIdentity: string;
	updatedAtMs: number;
	files: ClipboardRecord[];
};

export type ClipboardLifecycleApi = {
	ownerId: string;
	created(input: ClipboardCreatedInput): boolean;
	editorChanged(text: string): void;
	submitted(text: string): void;
	materialized(artifacts: readonly MaterializedClipboardArtifact[]): void;
	confirmMaterialized(): void;
	shutdown(): void;
};

type LifecycleOptions = {
	tempDir?: string;
	now?: () => number;
	pid?: number;
	processStartedAtMs?: number;
	processAlive?: (pid: number) => boolean;
};

type GlobalLifecycleState = typeof globalThis & {
	[CLIPBOARD_LIFECYCLE_SYMBOL]?: ClipboardLifecycleApi;
};

function normalizedPath(filePath: string): string {
	const value = resolve(filePath);
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function identityFromStats(state: Stats): ClipboardFileIdentity {
	return { dev: state.dev, ino: state.ino, size: state.size, mtimeMs: state.mtimeMs };
}

function sameIdentity(left: ClipboardFileIdentity, right: Stats): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs;
}

function sameFileIdentity(left: ClipboardFileIdentity, right: ClipboardFileIdentity): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs;
}

function extensionMatchesMime(filePath: string, mimeType: string): boolean {
	const extension = extname(filePath).toLowerCase();
	if (mimeType === "image/png") return extension === ".png";
	if (mimeType === "image/jpeg") return extension === ".jpg" || extension === ".jpeg";
	if (mimeType === "image/gif") return extension === ".gif";
	return mimeType === "image/webp" && extension === ".webp";
}

function readImageMime(filePath: string): string | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(filePath, "r");
		const header = Buffer.allocUnsafe(IMAGE_HEADER_BYTES);
		const count = readSync(descriptor, header, 0, header.length, 0);
		return detectImageMime(header.subarray(0, count));
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function newestRecordFirst(left: ClipboardRecord, right: ClipboardRecord): number {
	if (right.createdAtMs !== left.createdAtMs) return right.createdAtMs - left.createdAtMs;
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export class ClipboardArtifactLifecycle {
	readonly ownerId = randomUUID();
	readonly api: ClipboardLifecycleApi;
	private readonly tempDir: string;
	private readonly normalizedTempDir: string;
	private readonly leaseDir: string;
	private readonly leasePath: string;
	private readonly now: () => number;
	private readonly pid: number;
	private readonly processStartedAtMs: number;
	private readonly startupIdentity: string;
	private readonly processAlive: (pid: number) => boolean;
	private readonly reconcileEditorCallback: () => void;
	private readonly records = new Map<string, ClipboardRecord>();
	private pendingEditorText = "";
	private editorReconcileQueued = false;
	private closed = false;

	constructor(options: LifecycleOptions = {}) {
		this.tempDir = realpathSync(options.tempDir ?? tmpdir());
		this.normalizedTempDir = normalizedPath(this.tempDir);
		this.leaseDir = join(this.tempDir, "pi-clipboard-leases-v1");
		this.leasePath = join(this.leaseDir, `owner-${this.ownerId}.json`);
		this.now = options.now ?? Date.now;
		this.pid = options.pid ?? process.pid;
		this.processStartedAtMs = options.processStartedAtMs
			?? Math.round(Date.now() - process.uptime() * 1000);
		this.startupIdentity = `${this.pid}:${this.processStartedAtMs}`;
		this.processAlive = options.processAlive ?? processIsAlive;
		this.reconcileEditorCallback = this.reconcileEditor.bind(this);
		this.api = {
			ownerId: this.ownerId,
			created: this.created.bind(this),
			editorChanged: this.editorChanged.bind(this),
			submitted: this.submitted.bind(this),
			materialized: this.materialized.bind(this),
			confirmMaterialized: this.confirmMaterialized.bind(this),
			shutdown: this.shutdown.bind(this),
		};
		mkdirSync(this.leaseDir, { recursive: true, mode: 0o700 });
		this.coldStartSweep();
		try { rmdirSync(this.leaseDir); } catch { /* active or retained stale leases remain */ }
	}

	created(input: ClipboardCreatedInput): boolean {
		if (this.closed) return false;
		const verified = this.verifyClipboardFile(input.path, input.mimeType);
		if (!verified) return false;
		this.pruneExpiredOwnedEditorFiles();
		let ownerBytes = verified.size;
		for (const record of this.records.values()) ownerBytes += record.size;
		if (this.records.size >= CLIPBOARD_PER_OWNER_MAX_COUNT
			|| ownerBytes > CLIPBOARD_PER_OWNER_MAX_BYTES
			|| !this.globalCapacityAllows(verified.size)) return false;
		const record: ClipboardRecord = {
			...verified,
			path: resolve(input.path),
			mimeType: input.mimeType,
			createdAtMs: this.now(),
			state: "editor",
			sessionId: input.sessionId ?? null,
		};
		this.records.set(normalizedPath(record.path), record);
		this.persistManifest();
		return true;
	}

	editorChanged(text: string): void {
		if (this.closed) return;
		this.pendingEditorText = text;
		if (this.editorReconcileQueued) return;
		this.editorReconcileQueued = true;
		queueMicrotask(this.reconcileEditorCallback);
	}

	submitted(text: string): void {
		if (this.closed) return;
		let changed = false;
		for (const record of this.records.values()) {
			if (text.includes(record.path)) {
				record.state = "submitted";
				changed = true;
			} else if (record.state === "editor") {
				this.releaseRecord(record);
				changed = true;
			}
		}
		if (changed) this.persistManifest();
	}

	materialized(artifacts: readonly MaterializedClipboardArtifact[]): void {
		if (this.closed || artifacts.length === 0) return;
		let changed = false;
		for (const artifact of artifacts) {
			const key = normalizedPath(artifact.path);
			let record = this.records.get(key);
			if (!record) {
				if (this.pathHasAnotherActiveOwner(artifact.path)) continue;
				const verified = this.verifyClipboardFile(artifact.path, artifact.mimeType);
				if (!verified || !sameFileIdentity(artifact, verified)) continue;
				record = {
					...verified,
					path: resolve(artifact.path),
					mimeType: artifact.mimeType,
					createdAtMs: this.now(),
					state: "materialized",
					sessionId: null,
				};
				this.records.set(key, record);
			} else {
				const verified = this.verifyClipboardFile(record.path, artifact.mimeType);
				if (!verified || !sameFileIdentity(artifact, verified)) continue;
				record.dev = artifact.dev;
				record.ino = artifact.ino;
				record.size = artifact.size;
				record.mtimeMs = artifact.mtimeMs;
				record.state = "materialized";
			}
			changed = true;
		}
		if (changed) this.persistManifest();
	}

	confirmMaterialized(): void {
		if (this.closed) return;
		let changed = false;
		for (const record of this.records.values()) {
			if (record.state !== "materialized") continue;
			this.releaseRecord(record);
			changed = true;
		}
		if (changed) this.persistManifest();
	}

	shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		for (const record of this.records.values()) this.releaseRecord(record);
		this.records.clear();
		try { unlinkSync(this.leasePath); } catch { /* already removed */ }
		try { rmdirSync(this.leaseDir); } catch { /* other Pi owners remain */ }
	}

	private reconcileEditor(): void {
		this.editorReconcileQueued = false;
		if (this.closed) return;
		const text = this.pendingEditorText;
		let changed = false;
		for (const record of this.records.values()) {
			if (text.includes(record.path)) {
				if (record.state !== "editor") {
					record.state = "editor";
					changed = true;
				}
			} else if (record.state === "editor") {
				this.releaseRecord(record);
				changed = true;
			}
		}
		this.pruneExpiredOwnedEditorFiles();
		if (changed) this.persistManifest();
	}

	private releaseRecord(record: ClipboardRecord): void {
		this.records.delete(normalizedPath(record.path));
		try {
			const current = lstatSync(record.path);
			if (!current.isSymbolicLink() && current.isFile() && sameIdentity(record, current)) {
				unlinkSync(record.path);
			}
		} catch {
			// Missing or changed paths are not owned anymore and must not be touched.
		}
	}

	private verifyClipboardFile(filePath: string, expectedMime: string): ClipboardFileIdentity | null {
		const resolvedPath = resolve(filePath);
		if (normalizedPath(dirname(resolvedPath)) !== this.normalizedTempDir) return null;
		if (!SP_CLIPBOARD_FILE_NAME_PATTERN.test(basename(resolvedPath))) return null;
		let state: Stats;
		try {
			state = lstatSync(resolvedPath);
		} catch {
			return null;
		}
		if (state.isSymbolicLink() || !state.isFile()) return null;
		const detectedMime = readImageMime(resolvedPath);
		if (!detectedMime || detectedMime !== expectedMime || !extensionMatchesMime(resolvedPath, detectedMime)) return null;
		return identityFromStats(state);
	}

	private pruneExpiredOwnedEditorFiles(): void {
		const cutoff = this.now() - CLIPBOARD_OWNER_MAX_AGE_MS;
		let changed = false;
		for (const record of this.records.values()) {
			if (record.state !== "editor" || record.createdAtMs >= cutoff) continue;
			this.releaseRecord(record);
			changed = true;
		}
		if (changed) this.persistManifest();
	}

	private persistManifest(): void {
		if (this.closed) return;
		if (this.records.size === 0) {
			try { unlinkSync(this.leasePath); } catch { /* no lease was needed */ }
			try { rmdirSync(this.leaseDir); } catch { /* other Pi owners remain */ }
			return;
		}
		mkdirSync(this.leaseDir, { recursive: true, mode: 0o700 });
		const files: ClipboardRecord[] = [];
		for (const record of this.records.values()) files.push(record);
		files.sort(newestRecordFirst);
		const manifest: ClipboardLeaseManifest = {
			version: 1,
			ownerId: this.ownerId,
			pid: this.pid,
			processStartedAtMs: this.processStartedAtMs,
			startupIdentity: this.startupIdentity,
			updatedAtMs: this.now(),
			files,
		};
		const temporary = `${this.leasePath}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
			renameSync(temporary, this.leasePath);
		} finally {
			try { unlinkSync(temporary); } catch { /* rename succeeded or write failed */ }
		}
	}

	private readLease(filePath: string): ClipboardLeaseManifest | null {
		try {
			const state = lstatSync(filePath);
			if (state.isSymbolicLink() || !state.isFile() || state.size > MAX_LEASE_BYTES) return null;
			const value = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<ClipboardLeaseManifest>;
			if (value.version !== 1
				|| typeof value.ownerId !== "string"
				|| !Number.isSafeInteger(value.pid)
				|| typeof value.processStartedAtMs !== "number"
				|| typeof value.startupIdentity !== "string"
				|| typeof value.updatedAtMs !== "number"
				|| !Array.isArray(value.files)
				|| value.files.length > MAX_LEASE_FILES) return null;
			return value as ClipboardLeaseManifest;
		} catch {
			return null;
		}
	}

	private activeOwnedPaths(): Set<string> {
		const active = new Set<string>();
		let names: string[];
		try { names = readdirSync(this.leaseDir); } catch { return active; }
		let scanned = 0;
		for (const name of names) {
			if (scanned++ >= MAX_LEASE_SCAN) break;
			if (!SP_CLIPBOARD_LEASE_NAME_PATTERN.test(name)) continue;
			const manifest = this.readLease(join(this.leaseDir, name));
			if (!manifest || !this.processAlive(manifest.pid)) continue;
			for (const record of manifest.files) {
				if (typeof record.path === "string") active.add(normalizedPath(record.path));
			}
		}
		return active;
	}

	private pathHasAnotherActiveOwner(filePath: string): boolean {
		const key = normalizedPath(filePath);
		const active = this.activeOwnedPaths();
		return active.has(key) && !this.records.has(key);
	}

	private coldStartSweep(): void {
		let leaseNames: string[];
		try { leaseNames = readdirSync(this.leaseDir); } catch { leaseNames = []; }
		let scanned = 0;
		for (const name of leaseNames) {
			if (scanned++ >= MAX_LEASE_SCAN) break;
			if (!SP_CLIPBOARD_LEASE_NAME_PATTERN.test(name)) continue;
			const leasePath = join(this.leaseDir, name);
			const manifest = this.readLease(leasePath);
			if (!manifest || this.processAlive(manifest.pid)) continue;
			let retained = false;
			for (const record of manifest.files) {
				if (!this.removeStaleManifestRecord(record)) retained = true;
			}
			if (!retained) {
				try { unlinkSync(leasePath); } catch { /* another startup may have swept it */ }
			}
		}
		this.sweepLegacyOrphans();
	}

	private removeStaleManifestRecord(record: ClipboardRecord): boolean {
		if (typeof record.path !== "string"
			|| typeof record.mimeType !== "string"
			|| typeof record.createdAtMs !== "number"
			|| this.now() - record.createdAtMs < CLIPBOARD_STALE_LEASE_MIN_AGE_MS) return false;
		const verified = this.verifyClipboardFile(record.path, record.mimeType);
		if (!verified) return !existsSync(record.path);
		if (!sameFileIdentity(record, verified)) return false;
		try {
			unlinkSync(record.path);
			return true;
		} catch {
			return false;
		}
	}

	private sweepLegacyOrphans(): void {
		const active = this.activeOwnedPaths();
		let names: string[];
		try { names = readdirSync(this.tempDir); } catch { return; }
		let scanned = 0;
		for (const name of names) {
			if (scanned++ >= MAX_TEMP_SCAN) break;
			if (!SP_CLIPBOARD_FILE_NAME_PATTERN.test(name)) continue;
			const filePath = join(this.tempDir, name);
			if (active.has(normalizedPath(filePath))) continue;
			let state: Stats;
			try { state = lstatSync(filePath); } catch { continue; }
			if (state.isSymbolicLink() || !state.isFile()) continue;
			if (this.now() - state.mtimeMs < CLIPBOARD_LEGACY_MIN_AGE_MS) continue;
			const mimeType = readImageMime(filePath);
			if (!mimeType || !extensionMatchesMime(filePath, mimeType)) continue;
			try {
				const current = lstatSync(filePath);
				if (sameIdentity(identityFromStats(state), current)) unlinkSync(filePath);
			} catch {
				// Conservative best effort.
			}
		}
	}

	private globalCapacityAllows(nextBytes: number): boolean {
		let names: string[];
		try { names = readdirSync(this.tempDir); } catch { return false; }
		let count = 0;
		let bytes = 0;
		let scanned = 0;
		for (const name of names) {
			if (scanned++ >= MAX_TEMP_SCAN) return false;
			if (!SP_CLIPBOARD_FILE_NAME_PATTERN.test(name)) continue;
			try {
				const state = lstatSync(join(this.tempDir, name));
				if (state.isSymbolicLink() || !state.isFile()) continue;
				count++;
				bytes += state.size;
			} catch {
				// Concurrent cleanup reduces pressure.
			}
		}
		return count <= CLIPBOARD_GLOBAL_MAX_COUNT
			&& bytes <= CLIPBOARD_GLOBAL_MAX_BYTES
			&& nextBytes <= CLIPBOARD_GLOBAL_MAX_BYTES;
	}
}

export function installClipboardArtifactLifecycle(options: LifecycleOptions = {}): ClipboardArtifactLifecycle {
	const root = globalThis as GlobalLifecycleState;
	root[CLIPBOARD_LIFECYCLE_SYMBOL]?.shutdown();
	const lifecycle = new ClipboardArtifactLifecycle(options);
	root[CLIPBOARD_LIFECYCLE_SYMBOL] = lifecycle.api;
	return lifecycle;
}

export function uninstallClipboardArtifactLifecycle(lifecycle: ClipboardArtifactLifecycle): void {
	const root = globalThis as GlobalLifecycleState;
	lifecycle.shutdown();
	if (root[CLIPBOARD_LIFECYCLE_SYMBOL] === lifecycle.api) root[CLIPBOARD_LIFECYCLE_SYMBOL] = undefined;
}
