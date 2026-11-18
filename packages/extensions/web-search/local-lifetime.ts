import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@super-pi/coding-agent";
import { getSessionLeaseDir, readSessionOccupancy, SessionLease, withSessionLeaseLock } from "@super-pi/coding-agent/internal/session-lease";
import { localInstallRoot } from "./local-config.ts";

export const SERVICE_BOOTSTRAP = fileURLToPath(new URL("./managed-service.py", import.meta.url));
const SERVICE_RECORD = /^searxng-[a-f0-9-]{36}\.(?:job|stopping)$/u;
const STOP_TIMEOUT_MS = 4_000;

let membership: { root: string; lease: SessionLease } | undefined;

// A CLI process retains the same seat across reloads, session switches, and forks.
// Refresh once without starting the SessionLease heartbeat.
export function holdLocalSearchProcess(): void {
  if (membership) return;
  const root = localInstallRoot();
  if (!root || !existsSync(join(root, "install.json"))) return;
  const id = randomUUID();
  const lease = new SessionLease(join(root, "superpi-runtime"), () => undefined, id, () => id);
  lease.refresh();
  membership = { root, lease };
  process.once("exit", releaseLocalSearchProcess);
}

export function reserveLocalSearchJob(root: string): string {
  holdLocalSearchProcess();
  if (membership?.root !== root) throw new Error("Could not reserve the managed SearXNG process.");
  const marker = join(membership.lease.leaseDir, `searxng-${randomUUID()}.job`);
  writeFileSync(marker, "", { flag: "wx" });
  return marker;
}

export function serviceEnvironment(root: string): NodeJS.ProcessEnv {
  const temp = join(root, "tmp");
  return { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp };
}

function releaseLocalSearchProcess(): void {
  const current = membership;
  membership = undefined;
  if (!current) return;
  try {
    const { root, lease } = current;
    lease.stop();
    if (!readdirSync(lease.leaseDir).some(isServiceRecord)) return;
    withSessionLeaseLock(lease.leaseDir, () => {
      if (readSessionOccupancy(lease.leaseDir).ids.size !== 0) return;
      if (!readdirSync(lease.leaseDir).some(isServiceRecord)) return;
      // An older CLI in the same profile may have joined before this lease existed.
      if (readSessionOccupancy(getSessionLeaseDir(getAgentDir())).ids.size !== 0) return;
      const python = join(root, "venv", "Scripts", "python.exe");
      const result = spawnSync(python, ["-X", "utf8", SERVICE_BOOTSTRAP, "stop", lease.leaseDir], {
        cwd: root, env: serviceEnvironment(root), windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: STOP_TIMEOUT_MS, maxBuffer: 4096,
      });
      if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr?.trim() || "Could not stop the managed search service.");
      }
    });
  } catch (error) {
    console.error("Managed SearXNG shutdown:", error instanceof Error ? error.message : error);
  }
}

function isServiceRecord(name: string): boolean {
  return SERVICE_RECORD.test(name);
}
