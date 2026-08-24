import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isBunRuntime, loadBetterSqlite3 } from './sqlite-native.js';

type StatementLike = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;

export interface AtomicLockOptions {
  staleMs: number;
}

export interface AtomicLockLease {
  token: string;
  release: () => void;
}

export interface AtomicLockCoordinatorOptions {
  pid?: number;
  incarnation?: string;
  probeIncarnation?: (pid: number) => string | null;
}

function defaultProbeIncarnation(pid: number): string | null {
  return pid === process.pid ? getCurrentProcessIncarnation() : probeProcessIncarnation(pid);
}

let cachedDatabaseCtor: DatabaseCtor | null = null;

/**
 * Resolved on first use, never at import time — see the same note in db.ts.
 * Compiled Pi cannot resolve better-sqlite3 at all, so Bun must take bun:sqlite.
 */
function getDatabaseCtor(): DatabaseCtor {
  if (!cachedDatabaseCtor) {
    const require = createRequire(import.meta.url);
    if (isBunRuntime()) {
      const bunSqlite = require('bun:sqlite') as { Database: DatabaseCtor };
      cachedDatabaseCtor = bunSqlite.Database;
    } else {
      cachedDatabaseCtor = loadBetterSqlite3({ requireImpl: require }) as DatabaseCtor;
    }
  }
  return cachedDatabaseCtor;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function probeProcessIncarnation(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      return fields[19] || null;
    } catch {
      return null;
    }
  }

  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 250,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf-8', timeout: 500 },
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

let currentProcessIncarnation: string | null | undefined;

function getCurrentProcessIncarnation(): string | null {
  if (currentProcessIncarnation === undefined) {
    currentProcessIncarnation = probeProcessIncarnation(process.pid);
  }
  return currentProcessIncarnation;
}

export const LOCK_DB_WAL_AUTOCHECKPOINT_PAGES = 128;
export const LOCK_DB_JOURNAL_SIZE_LIMIT_BYTES = 1024 * 1024;
export const MAX_PENDING_LOCK_RELEASES = 256;
export const MAX_PENDING_LOCK_RELEASE_AGE_MS = 5 * 60 * 1000;
const RELEASE_ATTEMPTS = 3;

interface PendingRelease {
  dbPath: string;
  key: string;
  token: string;
  queuedAt: number;
}

const pendingReleases = new Map<string, PendingRelease>();
const sharedCoordinators = new Map<string, AtomicLockCoordinator>();

function hasColumn(columns: Array<{ name: string }>, expectedName: string): boolean {
  for (let index = 0; index < columns.length; index++) {
    if (columns[index]?.name === expectedName) return true;
  }
  return false;
}

class CoordinatorLockLease implements AtomicLockLease {
  private released = false;

  constructor(
    private readonly coordinator: AtomicLockCoordinator,
    private readonly key: string,
    readonly token: string,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.coordinator.release(this.key, this.token);
  }
}

export class AtomicLockCoordinator {
  private readonly pid: number;
  private readonly incarnation: string | null;
  private readonly probeIncarnation: (pid: number) => string | null;
  private cachedDb: DatabaseLike | null = null;

  constructor(private readonly dbPath: string, options: AtomicLockCoordinatorOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.probeIncarnation = options.probeIncarnation ?? defaultProbeIncarnation;
    this.incarnation = options.incarnation
      ?? this.probeIncarnation(this.pid)
      ?? null;
  }

  tryAcquire(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    this.retryPendingReleases(key);
    const token = randomUUID();
    const now = Date.now();
    const db = this.open();
    let acquired = false;

    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare(`
          SELECT token, pid, incarnation, acquired_at
          FROM locks
          WHERE lock_key = ?
        `).get(key) as { token: string; pid: number; incarnation: string | null; acquired_at: number } | undefined;

        if (!owner) {
          db.prepare(`
            INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(key, token, this.pid, this.incarnation, now);
          acquired = true;
        } else {
          const observedIncarnation = this.probeIncarnation(owner.pid);
          const alive = observedIncarnation !== null || processIsAlive(owner.pid);
          const sameIncarnation = alive
            && owner.incarnation !== null
            && observedIncarnation !== null
            && owner.incarnation === observedIncarnation;
          const unknownIncarnation = alive && (owner.incarnation === null || observedIncarnation === null);
          // A lease is reclaimable once it has been held for longer than staleMs,
          // regardless of whether the owning process is still alive — it may be
          // making no progress (blocked I/O, wedged, suspended) rather than dead.
          // This is the sole backstop for that case: liveness/incarnation checks
          // alone cannot distinguish "alive and working" from "alive and stuck".
          // staleMs <= 0 disables time-based takeover (liveness checks only).
          const stale = options.staleMs > 0 && now - owner.acquired_at >= options.staleMs;
          if (stale || (!sameIncarnation && !unknownIncarnation)) {
            db.prepare(`
              UPDATE locks
              SET token = ?, pid = ?, incarnation = ?, acquired_at = ?
              WHERE lock_key = ? AND token = ?
            `).run(token, this.pid, this.incarnation, now, key, owner.token);
            acquired = true;
          }
        }

        db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction is still open on a connection we are about to hand
        // to the next caller, whose BEGIN IMMEDIATE would then fail forever.
        // Drop the handle so open() rebuilds it.
        this.discardCachedDb();
      }
      throw error;
    }

    if (!acquired) return null;
    return new CoordinatorLockLease(this, key, token);
  }

  /**
   * Fencing check for destructive operations that lack their own independent
   * compare-and-swap (e.g. a plain fs.renameSync with no content/inode
   * verification). A lease can be legitimately stolen from a stale-but-alive
   * holder (see tryAcquire); a holder resuming after being stuck must verify
   * it is still the current owner immediately before publishing, or abort.
   * This narrows — it cannot fully close — the check-then-act race, since
   * synchronous work between this call and the actual write is not atomic
   * with it.
   */
  isCurrentOwner(key: string, token: string): boolean {
    const db = this.open();
    const row = db.prepare('SELECT token FROM locks WHERE lock_key = ?').get(key) as { token: string } | undefined;
    return row?.token === token;
  }

  release(key: string, token: string): void {
    const pendingKey = this.pendingReleaseKey(key, token);
    if (this.attemptRelease(key, token)) {
      pendingReleases.delete(pendingKey);
      return;
    }
    this.queuePendingRelease(pendingKey, key, token);
  }

  private attemptRelease(key: string, token: string): boolean {
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
      try {
        this.deleteOwnedLock(key, token);
        return true;
      } catch {
      }
    }
    return false;
  }

  private deleteOwnedLock(key: string, token: string): void {
    const db = this.open();
    db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(key, token);
  }

  private queuePendingRelease(pendingKey: string, key: string, token: string): void {
    const now = Date.now();
    this.prunePendingReleases(now);
    pendingReleases.delete(pendingKey);
    while (pendingReleases.size >= MAX_PENDING_LOCK_RELEASES) {
      const oldest = pendingReleases.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingReleases.delete(oldest);
    }
    pendingReleases.set(pendingKey, { dbPath: path.resolve(this.dbPath), key, token, queuedAt: now });
  }

  private prunePendingReleases(now: number): void {
    for (const [pendingKey, pending] of pendingReleases) {
      if (now - pending.queuedAt > MAX_PENDING_LOCK_RELEASE_AGE_MS) pendingReleases.delete(pendingKey);
    }
  }

  private retryPendingReleases(key: string): void {
    const dbPath = path.resolve(this.dbPath);
    this.prunePendingReleases(Date.now());
    for (const [pendingKey, pending] of pendingReleases) {
      if (pending.dbPath !== dbPath || pending.key !== key) continue;
      if (this.attemptRelease(pending.key, pending.token)) pendingReleases.delete(pendingKey);
    }
  }

  private retryAllPendingReleases(): void {
    const dbPath = path.resolve(this.dbPath);
    this.prunePendingReleases(Date.now());
    for (const [pendingKey, pending] of pendingReleases) {
      if (pending.dbPath !== dbPath) continue;
      if (this.attemptRelease(pending.key, pending.token)) pendingReleases.delete(pendingKey);
    }
  }

  private pendingReleaseKey(key: string, token: string): string {
    return `${path.resolve(this.dbPath)}\0${key}\0${token}`;
  }

  close(): void {
    this.retryAllPendingReleases();
    this.discardCachedDb();
  }

  private discardCachedDb(): void {
    const db = this.cachedDb;
    this.cachedDb = null;
    if (db) {
      try { db.exec('PRAGMA busy_timeout = 0; PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* never wait on another live writer during shutdown */ }
      try { db.close(); } catch {}
    }
  }

  private open(): DatabaseLike {
    if (this.cachedDb) return this.cachedDb;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const existed = fs.existsSync(this.dbPath);
    const db = new (getDatabaseCtor())(this.dbPath);
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = ${LOCK_DB_WAL_AUTOCHECKPOINT_PAGES};
        PRAGMA journal_size_limit = ${LOCK_DB_JOURNAL_SIZE_LIMIT_BYTES};
        CREATE TABLE IF NOT EXISTS locks (
          lock_key TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          incarnation TEXT,
          acquired_at INTEGER NOT NULL
        );
      `);
      const columns = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
      if (!hasColumn(columns, 'incarnation')) {
        try {
          db.exec('ALTER TABLE locks ADD COLUMN incarnation TEXT');
        } catch (error) {
          const refreshed = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
          if (!hasColumn(refreshed, 'incarnation')) throw error;
        }
      }
      if (!existed) fs.chmodSync(this.dbPath, 0o600);
      this.cachedDb = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * Process-wide coordinator for `dbPath`.
   *
   * Each instance now pins its SQLite connection for its own lifetime, so a
   * caller that constructs a fresh coordinator per operation would leak one
   * open WAL connection per call. Every default-options caller must share.
   * The option-carrying constructor stays public for tests, which pass a
   * synthetic pid/incarnation that a dbPath-keyed cache would silently ignore.
   */
  static shared(dbPath: string): AtomicLockCoordinator {
    const key = path.resolve(dbPath);
    let coordinator = sharedCoordinators.get(key);
    if (!coordinator) {
      coordinator = new AtomicLockCoordinator(dbPath);
      sharedCoordinators.set(key, coordinator);
    }
    return coordinator;
  }

  /** Release a known shared coordinator during owner shutdown or isolated tests. */
  static closeShared(dbPath: string): void {
    const key = path.resolve(dbPath);
    const coordinator = sharedCoordinators.get(key);
    if (!coordinator) return;
    sharedCoordinators.delete(key);
    coordinator.close();
  }

  /** Release all shared coordinators rooted below an owner directory. */
  static closeSharedUnder(root: string): void {
    const resolvedRoot = path.resolve(root);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    for (const [key, coordinator] of sharedCoordinators) {
      if (key !== resolvedRoot && !key.startsWith(prefix)) continue;
      sharedCoordinators.delete(key);
      coordinator.close();
    }
  }

  /** Release the bounded process-wide coordinator set at extension shutdown. */
  static closeAllShared(): void {
    for (const coordinator of sharedCoordinators.values()) coordinator.close();
    sharedCoordinators.clear();
    pendingReleases.clear();
  }
}
