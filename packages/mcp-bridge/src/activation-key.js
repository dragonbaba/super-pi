import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { agentDir } from "./config.js";

const KEY_BYTES = 32;

function readKey(keyPath) {
  try {
    const info = lstatSync(keyPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== KEY_BYTES) return undefined;
    const key = readFileSync(keyPath);
    return key.length === KEY_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Machine-local HMAC key for persisted MCP identities, so copied session/cache
 * files are not offline verifiers for secrets in the MCP configuration. The key is
 * published by hard link, so concurrent creators never observe a partial file.
 * Undefined means activation intent and schema caching are disabled.
 */
export function loadActivationKey(keyPath = path.join(agentDir(), "mcp-activation.key")) {
  const existing = readKey(keyPath);
  if (existing) return existing;
  try {
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const temporary = `${keyPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
    try {
      linkSync(temporary, keyPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  } catch {
    return undefined;
  }
  return readKey(keyPath);
}
