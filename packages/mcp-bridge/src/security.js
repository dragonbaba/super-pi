import { createHash } from "node:crypto";
import { serializeMcpStructured } from "@super-pi/coding-agent/internal/tool-result-source";
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
  const bytes = Buffer.byteLength(clean, "utf8");
  if (bytes <= maxBytes) return clean;
  const notice = `\n\n[MCP output truncated: ${bytes} bytes total]`;
  const available = maxBytes - Buffer.byteLength(notice);
  if (available < 0) return "";
  let low = 0;
  let high = Math.min(clean.length, available);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(clean.substring(0, mid), "utf8") <= available) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && clean.charCodeAt(low - 1) >= 0xd800 && clean.charCodeAt(low - 1) <= 0xdbff) low--;
  return clean.substring(0, low) + notice;
}

export function boundedJson(value, maxBytes = MAX_TEXT_BYTES) {
  return truncateUtf8(serializeMcpStructured(value), maxBytes);
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
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding && value.length % 4 !== 0) return null;
  const characters = value.length - padding;
  const remainder = characters % 4;
  if ((padding === 2 && remainder !== 2) || (padding === 1 && remainder !== 3)) return null;
  const last = characters ? base64Digit(value.charCodeAt(characters - 1)) : 0;
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) return null;
  return Math.floor(characters * 3 / 4);
}

function base64Digit(code) {
  return code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71 : code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : 63;
}

/** Inspect one header byte after base64 validation, with no decoded allocation. */
export function base64Byte(value, position) {
  const group = Math.floor(position / 3) * 4;
  const slot = position % 3;
  const left = base64Digit(value.charCodeAt(group + slot));
  const right = base64Digit(value.charCodeAt(group + slot + 1));
  return slot === 0 ? (left << 2) | (right >> 4) : slot === 1 ? ((left & 15) << 4) | (right >> 2) : ((left & 3) << 6) | right;
}
