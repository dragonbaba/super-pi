import * as fs from "node:fs";
import * as path from "node:path";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.js";

const SP_PACKAGE_NAME = "@super-pi/coding-agent";

export function discoverPiRuntimeFromEntry(entryPath = process.argv[1]) {
  if (typeof entryPath !== "string" || entryPath.trim() === "") return {};
  let current = path.resolve(entryPath);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    const manifestPath = path.join(current, "package.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest?.name === SP_PACKAGE_NAME) {
        return {
          version: typeof manifest.version === "string" ? manifest.version : undefined,
          configDirName: ".sp",
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return {};
    }
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

// Local packages cannot always resolve Pi as a peer from their own directory.
// Prefer Pi's export when available, then securely identify the active CLI by
// walking from process.argv[1] to a package manifest with Pi's exact name.
let configDirName = ".sp";
let runtimeVersion;
try {
  const pi = await import("@super-pi/coding-agent");
  if (typeof pi.CONFIG_DIR_NAME === "string" && pi.CONFIG_DIR_NAME.length > 0) {
    configDirName = pi.CONFIG_DIR_NAME;
  }
  runtimeVersion = pi.VERSION;
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
if (typeof runtimeVersion !== "string" || runtimeVersion.trim() === "") {
  const discovered = discoverPiRuntimeFromEntry();
  runtimeVersion = discovered.version;
  if (discovered.configDirName) configDirName = discovered.configDirName;
}

export const CONFIG_DIR_NAME = configDirName;
export const SP_RUNTIME_VERSION = runtimeVersion;
export const SUPPORTED_SP_LINE = "0.84.x";

export function checkRuntimeCompatibility(version) {
  if (typeof version !== "string" || version.trim() === "") {
    return { compatible: false, reason: `Pi runtime version is unavailable; @super-pi/project-context is disabled (requires ${SUPPORTED_SP_LINE}).` };
  }
  const normalized = version.trim();
  if (!SUPPORTED_SP_VERSION_PATTERN.test(normalized)) {
    return { compatible: false, version: normalized, reason: `Pi ${normalized} is unsupported; @super-pi/project-context is disabled (requires ${SUPPORTED_SP_LINE}).` };
  }
  return { compatible: true, version: normalized };
}
