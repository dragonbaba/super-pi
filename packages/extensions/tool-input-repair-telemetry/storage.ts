import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGGREGATE_SCHEMA_VERSION,
  ANALYTICS_VERSION,
  emptyAggregate,
  MAX_BUCKETS,
  MAX_RETENTION_DAYS,
  MAX_SEEN_EVENTS,
  mergeRepairMetrics,
  type AggregateStore,
  type RepairMetric,
} from "./aggregate.ts";
import { DIMENSION_RE, EVENT_HASH_RE } from "./regex.ts";

const STORE_FILE_NAME = "tool-repairs-v1.json";
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const LOCK_ATTEMPTS = 80;
const LOCK_RETRY_MS = 25;
export const LOCK_STALE_MS = 5_000;
export const LOCK_OWNER_FILE_NAME = "owner.json";
const MAX_LOCK_OWNER_BYTES = 4 * 1024;
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1_000);
const PROCESS_STARTUP_IDENTITY = `${process.pid}:${PROCESS_STARTED_AT_MS}:${randomUUID()}`;

interface LockOwner {
  schemaVersion: 1;
  owner: string;
  pid: number;
  acquiredAt: string;
  acquiredAtMs: number;
  processStartedAtMs: number;
  startupIdentity: string;
}

interface LockLease {
  directory: string;
  owner: LockOwner;
}

export function defaultStoreDirectory(): string {
  if (process.env.SP_TOOL_REPAIRS_DIR) return resolve(process.env.SP_TOOL_REPAIRS_DIR);
  const agentDirectory = process.env.SP_AGENT_DIR
    ? resolve(process.env.SP_AGENT_DIR)
    : join(homedir(), ".sp", "agent");
  return join(agentDirectory, "state", "tool-repairs");
}

export async function readAggregateStore(directory = defaultStoreDirectory()): Promise<AggregateStore> {
  const path = join(directory, STORE_FILE_NAME);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_STORE_BYTES) throw new Error("Tool repair aggregate is not a bounded regular file.");
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return validateStore(parsed);
  } catch (error) {
    if (isCode(error, "ENOENT")) return emptyAggregate();
    throw error;
  }
}

export async function mergeAndPersist(
  metrics: readonly RepairMetric[],
  eventHashes: readonly string[],
  directory = defaultStoreDirectory(),
): Promise<AggregateStore> {
  if (metrics.length !== eventHashes.length) throw new Error("Metric/hash cardinality mismatch.");
  await ensureRegularDirectory(directory);
  const lockDirectory = join(directory, `${STORE_FILE_NAME}.lock`);
  let lease: LockLease | undefined;
  try {
    lease = await acquireLockLease(lockDirectory);
    const current = await readAggregateStore(directory);
    const next = mergeRepairMetrics(current, metrics, eventHashes);
    await writeAggregate(directory, next);
    return next;
  } finally {
    if (lease) await releaseLockLease(lease);
  }
}

async function acquireLockLease(lockDirectory: string): Promise<LockLease> {
  const owner: LockOwner = {
    schemaVersion: 1,
    owner: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    acquiredAtMs: Date.now(),
    processStartedAtMs: PROCESS_STARTED_AT_MS,
    startupIdentity: PROCESS_STARTUP_IDENTITY,
  };
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lockDirectory);
      try {
        await writeFile(
          join(lockDirectory, LOCK_OWNER_FILE_NAME),
          `${JSON.stringify(owner)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        await rmdir(lockDirectory).catch(() => undefined);
        throw error;
      }
      return { directory: lockDirectory, owner };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (await recoverStaleLock(lockDirectory)) continue;
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error("Timed out waiting for the tool repair aggregate lock.");
}

async function recoverStaleLock(lockDirectory: string): Promise<boolean> {
  let directoryInfo;
  try {
    directoryInfo = await lstat(lockDirectory);
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Tool repair aggregate lock must be a regular directory.");
  }
  const names = await readdir(lockDirectory);
  for (const name of names) {
    if (name !== LOCK_OWNER_FILE_NAME) {
      throw new Error("Tool repair aggregate lock contains an unexpected entry; refusing stale recovery.");
    }
  }

  const owner = await readLockOwner(lockDirectory);
  const now = Date.now();
  const age = owner ? now - owner.acquiredAtMs : now - directoryInfo.mtimeMs;
  if (!Number.isFinite(age) || age < LOCK_STALE_MS) return false;
  if (owner) {
    const samePidFromOlderStartup = owner.pid === process.pid
      && owner.startupIdentity !== PROCESS_STARTUP_IDENTITY
      && owner.processStartedAtMs < PROCESS_STARTED_AT_MS;
    if (!samePidFromOlderStartup && processIsAlive(owner.pid)) return false;
  }

  const quarantine = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockDirectory, quarantine);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) return true;
    throw error;
  }
  try {
    const quarantineNames = await readdir(quarantine);
    for (const name of quarantineNames) {
      if (name !== LOCK_OWNER_FILE_NAME) {
        throw new Error("Recovered tool repair lock changed shape; refusing recursive cleanup.");
      }
    }
    await rm(join(quarantine, LOCK_OWNER_FILE_NAME), { force: true });
    await rmdir(quarantine);
    return true;
  } catch (error) {
    try {
      await rename(quarantine, lockDirectory);
    } catch {
      // Preserve the exact quarantine for operator inspection if restoration races.
    }
    throw error;
  }
}

async function releaseLockLease(lease: LockLease): Promise<void> {
  const owner = await readLockOwner(lease.directory);
  if (!owner
    || owner.owner !== lease.owner.owner
    || owner.startupIdentity !== lease.owner.startupIdentity
    || owner.pid !== lease.owner.pid) {
    throw new Error("Tool repair aggregate lock ownership changed before release.");
  }
  await rm(join(lease.directory, LOCK_OWNER_FILE_NAME));
  await rmdir(lease.directory);
}

async function readLockOwner(lockDirectory: string): Promise<LockOwner | undefined> {
  const path = join(lockDirectory, LOCK_OWNER_FILE_NAME);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LOCK_OWNER_BYTES) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const owner = value as Partial<LockOwner>;
    if (owner.schemaVersion !== 1
      || typeof owner.owner !== "string" || owner.owner.length < 8 || owner.owner.length > 128
      || !Number.isSafeInteger(owner.pid) || owner.pid! < 1
      || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))
      || !Number.isFinite(owner.acquiredAtMs)
      || !Number.isFinite(owner.processStartedAtMs)
      || typeof owner.startupIdentity !== "string" || owner.startupIdentity.length < 8 || owner.startupIdentity.length > 256) {
      return undefined;
    }
    return owner as LockOwner;
  } catch (error) {
    if (isCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

async function ensureRegularDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Tool repair aggregate directory must be a regular directory.");
  }
}

async function writeAggregate(directory: string, store: AggregateStore): Promise<void> {
  const target = join(directory, STORE_FILE_NAME);
  const temporary = join(directory, `.${STORE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(store)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
    throw new Error("Tool repair aggregate exceeded its storage bound.");
  }
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateStore(value: unknown): AggregateStore {
  if (!value || typeof value !== "object") throw new Error("Invalid tool repair aggregate object.");
  const store = value as Partial<AggregateStore>;
  if (store.schemaVersion !== AGGREGATE_SCHEMA_VERSION
    || !validDimension(store.analyticsVersion)
    || !Number.isSafeInteger(store.retentionDays) || store.retentionDays! < 1
    || !Number.isSafeInteger(store.maxBuckets) || store.maxBuckets! < 1
    || !Array.isArray(store.buckets)
    || store.buckets.length > MAX_BUCKETS
    || !Array.isArray(store.seenEventHashes)
    || store.seenEventHashes.length > MAX_SEEN_EVENTS
    || typeof store.updatedAt !== "string"
    || !Number.isFinite(Date.parse(store.updatedAt))) {
    throw new Error("Unsupported or unbounded tool repair aggregate schema.");
  }
  for (const bucket of store.buckets) {
    if (!bucket || typeof bucket !== "object"
      || !validDimension(bucket.day)
      || !validDimension(bucket.model)
      || !validDimension(bucket.tool)
      || !validDimension(bucket.category)
      || !validDimension(bucket.outcome)
      || !validDimension(bucket.version)
      || !Number.isSafeInteger(bucket.count)
      || bucket.count < 1) throw new Error("Invalid tool repair aggregate bucket.");
  }
  if (store.seenEventHashes.some((hash) => typeof hash !== "string" || !EVENT_HASH_RE.test(hash))) {
    throw new Error("Invalid tool repair aggregate event hash.");
  }
  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    updatedAt: store.updatedAt,
    retentionDays: MAX_RETENTION_DAYS,
    maxBuckets: MAX_BUCKETS,
    buckets: store.buckets,
    seenEventHashes: store.seenEventHashes,
  };
}

function validDimension(value: unknown): value is string {
  return typeof value === "string" && DIMENSION_RE.test(value);
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
