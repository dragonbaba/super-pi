import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { readShellExecution, type ShellExecutionFacts } from "../coding-agent/src/core/tools/shell-execution.ts";
import { CHECKPOINT_BYTES, decodeCheckpoint, type TaskCheckpoint } from "./subagent/checkpoints.ts";

export type TaskKind = "shell" | "subagent";
export type TaskState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export interface TaskObservation {
	readonly id: string;
	readonly agent: string;
	state: TaskState;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	cwd?: string;
	branchId?: string | null;
	shellExecution?: ShellExecutionFacts;
	recovered?: boolean;
	checkpointAvailable?: boolean;
}
export interface TaskHistorySession { file: string | undefined; id: string; cwd: string; }
export const TASK_RESULT_CHARS = 12_000;
export const TASK_HISTORY_BYTES = 128 * 1024 * 1024;
const FACT_BYTES = 128 * 1024;
const INTERRUPTED = "Previous runtime ended without a recorded completion. Process state and side effects are unknown. Inspect the workspace before submitting a fresh authorized request; nothing was replayed.";
const require = createRequire(import.meta.url);
const STATES = new Set<TaskState>(["queued", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
const RECORDS_SQL = "SELECT id, agent, state, created, started, completed, result, cwd, branch, facts, checkpoint FROM tasks ORDER BY seq";

export function taskHistoryPath(file: string, kind: TaskKind): string { return `${resolve(file)}.tasks-${kind}-v1.sqlite`; }
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.length <= limit; }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

function validate(record: TaskObservation): void {
	if (!text(record.id, 80) || !/^[a-f0-9-]{36}-\d+$/.test(record.id) || !text(record.agent, 256)
		|| !STATES.has(record.state) || !timestamp(record.createdAt)
		|| record.startedAt !== undefined && !timestamp(record.startedAt)
		|| record.completedAt !== undefined && !timestamp(record.completedAt)
		|| record.result !== undefined && !text(record.result, TASK_RESULT_CHARS)
		|| record.cwd !== undefined && !text(record.cwd, 32768)
		|| record.branchId !== undefined && record.branchId !== null && !text(record.branchId, 256)
		|| record.shellExecution !== undefined && !readShellExecution(record)
		|| (["completed", "failed", "cancelled", "interrupted"].includes(record.state) !== (record.completedAt !== undefined))) {
		throw new Error("Invalid task history record; preserved for inspection.");
	}
}

/** Lifecycle boundary: copy only schema fields, never backend extras or toJSON hooks. */
function projectShellExecution(facts: ShellExecutionFacts): ShellExecutionFacts {
	const output = facts.output;
	const projected: ShellExecutionFacts = {
		version: facts.version, producer: facts.producer, started: facts.started, executionStatus: facts.executionStatus,
		sideEffects: facts.sideEffects, retryGuidance: facts.retryGuidance, cwd: facts.cwd,
		exitCode: facts.exitCode, signal: facts.signal, termination: facts.termination,
		output: { complete: output.complete, tailTruncated: output.tailTruncated, log: output.log, cleanup: output.cleanup },
	};
	if (facts.inputError !== undefined) projected.inputError = facts.inputError;
	if (facts.observationError !== undefined) projected.observationError = facts.observationError;
	if (facts.secondaryObservationError !== undefined) projected.secondaryObservationError = facts.secondaryObservationError;
	if (facts.observationErrorsOmitted !== undefined) projected.observationErrorsOmitted = facts.observationErrorsOmitted;
	if (output.logError !== undefined) projected.output.logError = output.logError;
	if (output.cleanupError !== undefined) projected.output.cleanupError = output.cleanupError;
	// Validate the copied primitives as well, in case backend getters changed after initial validation.
	if (!readShellExecution({ shellExecution: projected })) throw new Error("Invalid task shell facts; nothing was serialized.");
	return projected;
}

function readRecord(row: Record<string, SQLOutputValue>): TaskObservation {
	const record: TaskObservation = { id: row.id as string, agent: row.agent as string, state: row.state as TaskState,
		createdAt: row.created as number, startedAt: row.started === null ? undefined : row.started as number,
		completedAt: row.completed === null ? undefined : row.completed as number,
		result: row.result === null ? undefined : row.result as string, cwd: row.cwd === null ? undefined : row.cwd as string,
		branchId: row.branch as string | null, shellExecution: row.facts === null ? undefined : JSON.parse(row.facts as string), recovered: true };
	validate(record);
	if (row.checkpoint !== null) {
		record.checkpointAvailable = decodeCheckpoint(row.checkpoint as string, record.id, record.agent, record.cwd).turns > 0;
	}
	return record;
}

/** A separate connection per kind; transactions arbitrate writers, never PID/time lock stealing. */
export class TaskHistory {
	readonly counters = { opens: 0, writes: 0, checkpointWrites: 0, recovered: 0, openHandles: 0, rows: 0 };
	private db: DatabaseSync | undefined;
	private saveStatement: StatementSync | undefined;
	private ownerStatement: StatementSync | undefined;
	private pruneStatement: StatementSync | undefined;
	private readonly token = randomUUID();
	private readonly session: TaskHistorySession;
	private readonly capacity: number;
	private readonly kind: TaskKind;
	readonly path: string | undefined;
	private identity: string | undefined;
	private parentIdentity: string | undefined;
	private sequence = 0;
	private closed = false;

	constructor(session: TaskHistorySession, kind: TaskKind, capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256) throw new Error("Task history capacity must be 1–256.");
		if (!text(session.id, 256) || !session.id || !text(session.cwd, 32768)) throw new Error("Invalid task history session.");
		this.session = { file: session.file, id: session.id, cwd: resolve(session.cwd) };
		this.kind = kind; this.capacity = capacity;
		this.path = session.file ? taskHistoryPath(session.file, kind) : undefined;
	}

	private fileIdentity(): string {
		const stat = lstatSync(this.path!, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(TASK_HISTORY_BYTES)) throw new Error("Task history must be a bounded regular file, without links.");
		return `${stat.dev}:${stat.ino}`;
	}
	private directoryIdentity(): string {
		const path = realpathSync(dirname(this.path!));
		const stat = lstatSync(path, { bigint: true });
		return `${path}:${stat.dev}:${stat.ino}`;
	}
	private assertOwner(): void {
		if (this.identity !== this.fileIdentity() || this.parentIdentity !== this.directoryIdentity()) throw new Error("Task history storage identity changed; reload after inspection.");
		if (this.ownerStatement!.get()?.token !== this.token) throw new Error("Task history writer changed; no further work can start.");
	}

	/** No database or SQLite module load for an empty new session. */
	load(): TaskObservation[] {
		if (!this.path || !existsSync(this.path)) return [];
		this.open();
		const records: TaskObservation[] = [];
		for (const row of this.db!.prepare(RECORDS_SQL).iterate()) {
			const record = readRecord(row);
			if (record.shellExecution !== undefined) record.shellExecution = projectShellExecution(record.shellExecution);
			records.push(record);
		}
		return records;
	}

	private open(): void {
		if (this.closed) throw new Error("Task history is closed.");
		if (this.db || !this.path) return;
		this.parentIdentity = this.directoryIdentity();
		try { closeSync(openSync(this.path, "wx", 0o600)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		this.identity = this.fileIdentity();
		const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
		const db = new Database(this.path, { timeout: 0, allowExtension: false });
		this.counters.opens++; this.counters.openHandles++;
		let committed = false;
		try {
			db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA page_size=4096; PRAGMA max_page_count=32768;");
			if (db.prepare("PRAGMA page_size").get()?.page_size !== 4096) throw new Error("Unsupported task history page size.");
			db.exec("BEGIN IMMEDIATE");
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version === 0) {
				if (db.prepare("SELECT name FROM sqlite_master LIMIT 1").get()) throw new Error("Unrecognized task history schema.");
				db.exec(`CREATE TABLE owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), session TEXT NOT NULL, cwd TEXT NOT NULL, kind TEXT NOT NULL, token TEXT, pid INTEGER, host TEXT) STRICT;
					CREATE TABLE tasks (id TEXT PRIMARY KEY, agent TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, completed INTEGER, result TEXT, cwd TEXT, branch TEXT, facts TEXT, seq INTEGER NOT NULL) STRICT;
					CREATE INDEX terminal_order ON tasks(completed, seq); PRAGMA user_version=1;`);
				db.prepare("INSERT INTO owner(singleton,session,cwd,kind) VALUES(1,?,?,?)").run(this.session.id, this.session.cwd, this.kind);
			} else if (version !== 1 && version !== 2) throw new Error(`Unsupported task history version: ${version}.`);
			const ownerBounds = db.prepare(`SELECT count(*) AS count, coalesce(max(length(CAST(session AS BLOB))),0) AS session,
				coalesce(max(length(CAST(cwd AS BLOB))),0) AS cwd, coalesce(max(length(CAST(kind AS BLOB))),0) AS kind,
				coalesce(max(length(CAST(token AS BLOB))),0) AS token, coalesce(max(length(CAST(host AS BLOB))),0) AS host FROM owner`).get()!;
			if (ownerBounds.count !== 1 || (ownerBounds.session as number) > 1024 || (ownerBounds.cwd as number) > 131072 || (ownerBounds.kind as number) > 8 || (ownerBounds.token as number) > 80 || (ownerBounds.host as number) > 1024) throw new Error("Task history owner exceeds its bounded schema.");
			const owner = db.prepare("SELECT session,cwd,kind,token,pid,host FROM owner WHERE singleton=1").get();
			if (!owner || owner.session !== this.session.id || owner.cwd !== this.session.cwd || owner.kind !== this.kind) throw new Error("Task history belongs to a different session/workspace.");
			if (owner.token !== null || owner.pid !== null || owner.host !== null) {
				if (!text(owner.token, 80) || !owner.token || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || owner.host !== hostname()) throw new Error("Task history writer cannot be reconciled on this host; preserve the file for inspection.");
				let stopped = false;
				try { process.kill(owner.pid as number, 0); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") stopped = true; }
				if (!stopped) throw new Error(`Task history is owned by a live or uninspectable runtime (PID ${owner.pid}); close it before resuming this session.`);
			}
			if (version === 0 || version === 1) db.exec("ALTER TABLE tasks ADD COLUMN checkpoint TEXT; PRAGMA user_version=2;");
			// Check lengths in SQLite before materializing rows from a local, possibly damaged file.
			const bounds = db.prepare(`SELECT count(*) AS count, coalesce(max(length(CAST(id AS BLOB))),0) AS id, coalesce(max(length(CAST(agent AS BLOB))),0) AS agent,
				coalesce(max(length(CAST(result AS BLOB))),0) AS result, coalesce(max(length(CAST(cwd AS BLOB))),0) AS cwd, coalesce(max(length(CAST(branch AS BLOB))),0) AS branch,
				coalesce(max(length(CAST(facts AS BLOB))),0) AS facts, coalesce(max(length(CAST(checkpoint AS BLOB))),0) AS checkpoint, coalesce(max(seq),0) AS seq FROM tasks`).get()!;
			if ((bounds.checkpoint as number) > CHECKPOINT_BYTES) throw new Error("Checkpoint exceeds 1 MiB; preserved for inspection.");
			if ((bounds.count as number) > 512 || (bounds.id as number) > 80 || (bounds.agent as number) > 1024 || (bounds.result as number) > TASK_RESULT_CHARS * 4 || (bounds.cwd as number) > 131072 || (bounds.branch as number) > 1024 || (bounds.facts as number) > FACT_BYTES || !timestamp(bounds.seq) || (bounds.seq as number) > Number.MAX_SAFE_INTEGER / 4) throw new Error("Task history exceeds its bounded schema.");
			if (db.prepare(`SELECT 1 FROM tasks WHERE state NOT IN ('queued','running','cancelling','completed','failed','cancelled','interrupted')
				OR (state IN ('completed','failed','cancelled','interrupted')) != (completed IS NOT NULL)
				OR created<0 OR started<0 OR completed<0 OR seq<0 LIMIT 1`).get()) throw new Error("Invalid task history state; preserved for inspection.");
			// Validate every bounded row before recovery/pruning can overwrite evidence, in this same transaction.
			for (const row of db.prepare(RECORDS_SQL).iterate()) readRecord(row);
			this.sequence = bounds.seq as number;
			const recovery = db.prepare("UPDATE tasks SET state='interrupted', completed=?, result=?, facts=NULL, seq=seq+? WHERE completed IS NULL").run(Date.now(), INTERRUPTED, this.sequence);
			this.counters.recovered += Number(recovery.changes);
			this.sequence = db.prepare("SELECT coalesce(max(seq),0) AS seq FROM tasks").get()!.seq as number;
			db.prepare("UPDATE owner SET token=?,pid=?,host=? WHERE singleton=1").run(this.token, process.pid, hostname());
			this.pruneStatement = db.prepare("DELETE FROM tasks WHERE completed IS NOT NULL AND id NOT IN (SELECT id FROM tasks WHERE completed IS NOT NULL ORDER BY seq DESC LIMIT ?)");
			this.pruneStatement.run(this.capacity);
			this.counters.rows = db.prepare("SELECT count(*) AS count FROM tasks").get()!.count as number;
			this.ownerStatement = db.prepare("SELECT token FROM owner WHERE singleton=1");
			this.saveStatement = db.prepare(`INSERT INTO tasks(id,agent,state,created,started,completed,result,cwd,branch,facts,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?)
				ON CONFLICT(id) DO UPDATE SET state=excluded.state, started=excluded.started, completed=excluded.completed, result=excluded.result, facts=excluded.facts, seq=excluded.seq`);
			db.exec("COMMIT");
			committed = true;
			this.assertOwner();
			this.db = db;
		} catch (error) {
			if (!committed) { try { db.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ } }
			this.saveStatement = undefined; this.ownerStatement = undefined; this.pruneStatement = undefined;
			this.db = undefined; db.close(); this.counters.openHandles--;
			throw error;
		}
	}

	save(record: TaskObservation): void {
		if (!this.path) return;
		validate(record);
		const facts = record.shellExecution === undefined ? null : JSON.stringify(projectShellExecution(record.shellExecution));
		if (facts !== null && Buffer.byteLength(facts) > FACT_BYTES) throw new Error(`Task shell facts exceed ${FACT_BYTES} bytes.`);
		this.open();
		const db = this.db!;
		this.assertOwner();
		db.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			this.assertOwner();
			this.saveStatement!.run(record.id, record.agent, record.state, record.createdAt, record.startedAt ?? null, record.completedAt ?? null,
				record.result ?? null, record.cwd ?? null, record.branchId ?? null, facts, ++this.sequence);
			this.pruneStatement!.run(this.capacity);
			const counts = db.prepare("SELECT count(*) AS total, count(*) FILTER (WHERE completed IS NULL) AS active FROM tasks").get()!;
			if ((counts.active as number) > this.capacity || (counts.total as number) > this.capacity * 2) throw new Error(`Task history capacity reached: ${this.capacity} active plus ${this.capacity} terminal records.`);
			db.exec("COMMIT");
			committed = true;
			this.counters.rows = counts.total as number; this.counters.writes++;
			this.assertOwner();
		} catch (error) {
			if (!committed) { try { db.exec("ROLLBACK"); } catch { /* Preserve the original storage failure. */ } }
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const db = this.db;
		if (!db) return;
		try {
			this.assertOwner();
			db.prepare("UPDATE owner SET token=NULL,pid=NULL,host=NULL WHERE singleton=1 AND token=?").run(this.token);
		} finally {
			this.saveStatement = undefined; this.ownerStatement = undefined; this.pruneStatement = undefined;
			this.db = undefined; db.close(); this.counters.openHandles--;
		}
	}

	readCheckpoint(record: TaskObservation): TaskCheckpoint {
		if (!this.path) throw new Error("Checkpoint continuation requires persistent task history.");
		this.open(); this.assertOwner();
		const row = this.db!.prepare("SELECT checkpoint FROM tasks WHERE id=? AND length(CAST(checkpoint AS BLOB))<=?").get(record.id, CHECKPOINT_BYTES);
		if (typeof row?.checkpoint !== "string") throw new Error("No saved checkpoint for this task.");
		return decodeCheckpoint(row.checkpoint, record.id, record.agent, record.cwd);
	}

	saveCheckpoint(checkpoint: TaskCheckpoint, encoded: string): void {
		if (!this.path) throw new Error("Checkpoints require a persistent session.");
		this.open(); this.assertOwner();
		const db = this.db!;
		db.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			this.assertOwner();
			const written = db.prepare("UPDATE tasks SET checkpoint=? WHERE id=? AND agent=? AND cwd=? AND completed IS NULL").run(encoded, checkpoint.id, checkpoint.agent, checkpoint.cwd);
			if (Number(written.changes) !== 1) throw new Error("Checkpoint task is no longer active or owned.");
			db.exec("COMMIT"); committed = true; this.counters.checkpointWrites++;
			this.assertOwner();
		} catch (error) {
			if (!committed) { try { db.exec("ROLLBACK"); } catch { /* Preserve the write failure. */ } }
			throw error;
		}
	}
}
