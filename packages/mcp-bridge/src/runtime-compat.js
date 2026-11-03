import { createRequire } from "node:module";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.js";

export const SUPPORTED_SP_LINE = "1.x or 0.84.x";
const requireHost = createRequire(import.meta.url);

export function hasTypedSourceAdapter() {
  try { requireHost.resolve("@super-pi/coding-agent/internal/tool-result-source"); return true; }
  catch { return false; }
}

export function checkRuntimeCompatibility(version, adapterAvailable = hasTypedSourceAdapter()) {
  if (typeof version !== "string" || !SUPPORTED_SP_VERSION_PATTERN.test(version.trim())) {
    return { compatible: false, reason: `Pi runtime is unsupported or unavailable; @super-pi/mcp-bridge is disabled (requires ${SUPPORTED_SP_LINE}).` };
  }
  if (!adapterAvailable) return { compatible: false, reason: "MCP bridge is disabled: this host lacks the internal typed-source adapter; upgrade Super Pi." };
  return { compatible: true, version: version.trim() };
}
