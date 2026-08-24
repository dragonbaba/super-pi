import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { LEASE_INSTANCE_ID_PATTERN, SESSION_ID_PATTERN } from "./regex.ts";
import { unknownSessionText } from "./ui-text.ts";

const LEASE_VERSION = 1;
const MAX_LEASE_BYTES = 16 * 1024;
const HEARTBEAT_MS = 30_000;
const RESERVATION_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_ORPHAN_MS = 5_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

type LeaseRecord = {
  version: number;
  pid: number;
  instanceId: string;
  sessionPaths: string[];
  sessionIds: string[];
  updatedAt: number;
};

type SessionPathGetter = () => string | undefined;
type SessionIdGetter = () => string | undefined;

function normalizedPath(filePath: string): string {
  const value = resolve(filePath);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function canonicalPath(filePath: string): string {
  try {
    const value = realpathSync.native(filePath);
    return process.platform === "win32" ? value.toLowerCase() : value;
  } catch {
    return normalizedPath(filePath);
  }
}

function sameFile(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && canonicalPath(left) === canonicalPath(right));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function safeLeaseName(pid: number, instanceId: string): string {
  return `${pid}-${instanceId}.json`;
}

function readLease(filePath: string): LeaseRecord | undefined {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEASE_BYTES) return undefined;
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<LeaseRecord> & { sessionPath?: unknown };
    const rawPaths = (Array.isArray(value.sessionPaths) ? value.sessionPaths : [value.sessionPath]).filter((item) => item !== undefined);
    const rawIds = Array.isArray(value.sessionIds) ? value.sessionIds : [];
    if (
      value.version !== LEASE_VERSION ||
      !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      typeof value.instanceId !== "string" || !LEASE_INSTANCE_ID_PATTERN.test(value.instanceId) ||
      rawPaths.length > 2 || rawIds.length > 2 || rawPaths.length + rawIds.length === 0 ||
      rawPaths.some((item) => typeof item !== "string" || item.length === 0 || item.length > 4096) ||
      rawIds.some((item) => typeof item !== "string" || !SESSION_ID_PATTERN.test(item)) ||
      !Number.isFinite(value.updatedAt)
    ) return undefined;
    return { ...value, sessionPaths: rawPaths as string[], sessionIds: rawIds } as LeaseRecord;
  } catch {
    return undefined;
  }
}

function removeLease(filePath: string): void {
  try { rmSync(filePath, { force: true }); } catch { /* deletion will recheck on the next operation */ }
}

function lockOwnerIsAlive(lockDir: string): boolean {
  const owner = readLease(join(lockDir, "owner.json"));
  if (owner) return processIsAlive(owner.pid);
  try { return Date.now() - lstatSync(lockDir).mtimeMs < LOCK_ORPHAN_MS; }
  catch { return false; }
}

export function withSessionLeaseLock<T>(leaseDir: string | undefined, operation: () => T): T {
  if (!leaseDir) return operation();
  mkdirSync(leaseDir, { recursive: true });
  const lockDir = join(leaseDir, ".mutation-lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      const owner: LeaseRecord = {
        version: LEASE_VERSION,
        pid: process.pid,
        instanceId: randomUUID(),
        sessionPaths: [canonicalPath(leaseDir)],
        sessionIds: [],
        updatedAt: Date.now(),
      };
      writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* preserve original error */ }
        throw new Error(`无法获取 Session 租约锁 ${lockDir}：${error instanceof Error ? error.message : unknownSessionText(error)}`);
      }
      if (!lockOwnerIsAlive(lockDir)) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* another contender may clean it */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待 Session 租约锁超时：${lockDir}`);
      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }
  try { return operation(); }
  finally { rmSync(lockDir, { recursive: true, force: true }); }
}

function liveLeaseRecords(
  leaseDir: string | undefined,
  isAlive: (pid: number) => boolean = processIsAlive,
): LeaseRecord[] {
  if (!leaseDir || !existsSync(leaseDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(leaseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(leaseDir, entry.name));
  } catch (error) {
    throw new Error(`无法检查 Session 占用租约 ${leaseDir}：${error instanceof Error ? error.message : unknownSessionText(error)}`);
  }
  const records: LeaseRecord[] = [];
  for (const filePath of entries) {
    const record = readLease(filePath);
    if (!record) continue;
    if (!isAlive(record.pid)) {
      removeLease(filePath);
      continue;
    }
    records.push(record);
  }
  return records;
}

export function assertSessionNotLeased(
  leaseDir: string | undefined,
  sessionPath: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): void {
  for (const record of liveLeaseRecords(leaseDir, isAlive)) {
    if (record.sessionPaths.some((leasedPath) => sameFile(leasedPath, sessionPath))) {
      throw new Error(`Session 正被 Pi 进程 ${record.pid} 占用，已取消删除：${sessionPath}`);
    }
  }
}

export function assertSessionIdNotLeased(
  leaseDir: string | undefined,
  sessionId: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): void {
  for (const record of liveLeaseRecords(leaseDir, isAlive)) {
    if (record.sessionIds.includes(sessionId)) {
      throw new Error(`Session ${sessionId} 正被 Pi 进程 ${record.pid} 占用，已取消清理`);
    }
  }
}

export function sessionIdIsLeased(leaseDir: string | undefined, sessionId: string): boolean {
  for (const record of liveLeaseRecords(leaseDir)) {
    if (record.sessionIds.includes(sessionId)) return true;
  }
  return false;
}

export class SessionLease {
  readonly leaseDir: string;
  readonly instanceId: string;
  readonly leasePath: string;
  private getSessionPath: SessionPathGetter;
  private getSessionId: SessionIdGetter;
  private reservedPath: string | undefined;
  private reservationTimer: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    leaseDir: string,
    getSessionPath: SessionPathGetter,
    instanceId = randomUUID(),
    getSessionId: SessionIdGetter = () => undefined,
  ) {
    this.leaseDir = leaseDir;
    this.instanceId = instanceId;
    this.leasePath = join(leaseDir, safeLeaseName(process.pid, instanceId));
    this.getSessionPath = getSessionPath;
    this.getSessionId = getSessionId;
  }

  setSessionPathGetter(getSessionPath: SessionPathGetter, getSessionId: SessionIdGetter = this.getSessionId): void {
    this.clearReservation();
    this.getSessionPath = getSessionPath;
    this.getSessionId = getSessionId;
    this.refresh();
  }

  reserveSessionPath(sessionPath: string): void {
    const stat = lstatSync(sessionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`目标 Session 不再是普通文件：${sessionPath}`);
    this.reservedPath = canonicalPath(sessionPath);
    if (this.reservationTimer) clearTimeout(this.reservationTimer);
    this.reservationTimer = setTimeout(() => {
      this.reservedPath = undefined;
      this.reservationTimer = undefined;
      try { this.refresh(); } catch { /* the next heartbeat retries */ }
    }, RESERVATION_MS);
    this.reservationTimer.unref?.();
    this.refresh();
  }

  private clearReservation(): void {
    this.reservedPath = undefined;
    if (this.reservationTimer) clearTimeout(this.reservationTimer);
    this.reservationTimer = undefined;
  }

  start(): void {
    mkdirSync(this.leaseDir, { recursive: true });
    this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { this.refresh(); } catch { /* retain the previous valid lease and retry */ }
      }, HEARTBEAT_MS);
      this.timer.unref?.();
    }
  }

  refresh(): void {
    withSessionLeaseLock(this.leaseDir, () => {
      const sessionPaths: string[] = [];
      for (const candidate of [this.getSessionPath(), this.reservedPath]) {
        if (!candidate) continue;
        const canonical = canonicalPath(candidate);
        if (!sessionPaths.includes(canonical)) sessionPaths.push(canonical);
      }
      const sessionId = this.getSessionId();
      const sessionIds = sessionId && SESSION_ID_PATTERN.test(sessionId) ? [sessionId] : [];
      if (sessionPaths.length === 0 && sessionIds.length === 0) {
        removeLease(this.leasePath);
        return;
      }
      const record: LeaseRecord = {
        version: LEASE_VERSION,
        pid: process.pid,
        instanceId: this.instanceId,
        sessionPaths,
        sessionIds,
        updatedAt: Date.now(),
      };
      const temporary = join(this.leaseDir, `.${basename(this.leasePath)}.${randomUUID()}.tmp`);
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
      try { renameSync(temporary, this.leasePath); }
      catch (error) {
        removeLease(temporary);
        throw error;
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearReservation();
    withSessionLeaseLock(this.leaseDir, () => removeLease(this.leasePath));
  }
}
