import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FastModeConfig {
  enabled: boolean;
}

export const DEFAULT_FAST_MODE_CONFIG: FastModeConfig = { enabled: false };

export function resolveAgentDir(): string {
  const configured = process.env.SP_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".super-pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return join(homedir(), configured.slice(2));
  return configured;
}

export function fastModeConfigPath(agentDir = resolveAgentDir()): string {
  return join(agentDir, "pi-openai-fast.json");
}

export function parseFastModeConfig(value: unknown): FastModeConfig {
  if (!value || typeof value !== "object") return DEFAULT_FAST_MODE_CONFIG;
  const enabled = (value as { enabled?: unknown }).enabled;
  return { enabled: enabled === true };
}

export function loadFastModeConfig(path = fastModeConfigPath()): FastModeConfig {
  try {
    return parseFastModeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return DEFAULT_FAST_MODE_CONFIG;
    const message = error instanceof Error ? error.message : "unknown read error";
    throw new Error(`Could not load Fast mode config ${path}: ${message}`, { cause: error });
  }
}

export function saveFastModeConfig(config: FastModeConfig, path = fastModeConfigPath()): void {
  const tempPath = join(dirname(path), `.${randomUUID()}.pi-openai-fast.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    const completedFd = fd;
    fd = undefined;
    closeSync(completedFd);
    renameSync(tempPath, path);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
