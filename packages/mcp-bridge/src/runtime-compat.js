import * as fs from "node:fs";
import * as path from "node:path";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.js";

const SP_PACKAGE_NAME = "@super-pi/coding-agent";
export const SUPPORTED_SP_LINE = "0.84.x";

export function discoverPiVersion(entryPath = process.argv[1]) {
  if (typeof entryPath !== "string" || entryPath.trim() === "") return undefined;
  let current = path.resolve(entryPath);
  try { if (!fs.statSync(current).isDirectory()) current = path.dirname(current); }
  catch { current = path.dirname(current); }
  while (true) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (manifest?.name === SP_PACKAGE_NAME) return typeof manifest.version === "string" ? manifest.version : undefined;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function checkRuntimeCompatibility(version) {
  if (typeof version !== "string" || !SUPPORTED_SP_VERSION_PATTERN.test(version.trim())) {
    return { compatible: false, reason: `Pi runtime is unsupported or unavailable; @super-pi/mcp-bridge is disabled (requires ${SUPPORTED_SP_LINE}).` };
  }
  return { compatible: true, version: version.trim() };
}
