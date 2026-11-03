import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export function resolveToolPath(cwd: string, path: string): string {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
