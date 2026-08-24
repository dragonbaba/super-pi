import { createHash } from "node:crypto";
import {
  ANSI_CSI_PATTERN,
  ANSI_ESCAPE_PATTERN,
  ANSI_OSC_PATTERN,
  ANSI_STRING_PATTERN,
  BASE64_PATTERN,
  CONTROL_PATTERN,
  EDGE_UNDERSCORE_PATTERN,
  TRAILING_REPLACEMENT_CHARACTER_PATTERN,
  UNSAFE_TOOL_NAME_PATTERN,
} from "./regex.js";

export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_SERVERS = 16;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_ACTIVATED_SCHEMA_BYTES = 48 * 1024;
export const MAX_TEXT_BYTES = 50 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CONTENT_ITEMS = 256;
export const MAX_TRANSPORT_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export function sanitizeText(value, maxLength = 1000) {
  let text = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "symbol"
        ? value.description ?? ""
        : `${value}`;
  text = text
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_STRING_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, "");
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  return text;
}

export function truncateUtf8(value, maxBytes = MAX_TEXT_BYTES) {
  const clean = sanitizeText(value, Number.MAX_SAFE_INTEGER);
  const encoded = Buffer.from(clean, "utf8");
  if (encoded.length <= maxBytes) return clean;
  const clipped = encoded.subarray(0, maxBytes).toString("utf8").replace(TRAILING_REPLACEMENT_CHARACTER_PATTERN, "");
  return `${clipped}\n\n[MCP output truncated: ${encoded.length} bytes total]`;
}

export function boundedJson(value, maxBytes = MAX_TEXT_BYTES) {
  let serialized;
  try { serialized = JSON.stringify(value, null, 2); }
  catch { serialized = "[unserializable MCP value]"; }
  return truncateUtf8(serialized, maxBytes);
}

export function validateJsonShape(value, maxBytes = MAX_SCHEMA_BYTES, maxDepth = 32) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("MCP tool schema exceeds the size limit");
  const stack = [{ value, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const item = stack.pop();
    if (item.depth > maxDepth) throw new Error("MCP tool schema exceeds the depth limit");
    if (!item.value || typeof item.value !== "object") continue;
    if (seen.has(item.value)) throw new Error("MCP tool schema contains a cycle");
    seen.add(item.value);
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
  }
  return JSON.parse(serialized);
}

/** Canonicalize an already validated JSON graph while preserving array order. */
export function canonicalJsonShape(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJsonShape);
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalJsonShape(value[key]);
  return result;
}

function slug(value, maxLength) {
  const text = typeof value === "string" ? value : `${value}`;
  return text.toLowerCase().replace(UNSAFE_TOOL_NAME_PATTERN, "_").replace(EDGE_UNDERSCORE_PATTERN, "").slice(0, maxLength) || "tool";
}

export function piToolName(serverId, remoteName) {
  const base = `mcp__${slug(serverId, 20)}__${slug(remoteName, 32)}`;
  if (base.length <= 58) return base;
  const hash = createHash("sha256").update(`${serverId}\0${remoteName}`).digest("hex").slice(0, 8);
  return `${base.slice(0, 49)}_${hash}`;
}

export function decodedBase64Bytes(value) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value) || value.length % 4 === 1) return null;
  return Math.floor(value.length * 3 / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
