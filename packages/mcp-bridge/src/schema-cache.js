import { createHash, createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "./config.js";
import { loadActivationKey } from "./activation-key.js";
import { MAX_SCHEMA_BYTES, canonicalJsonShape, sanitizeText, validateJsonShape } from "./security.js";

const CACHE_VERSION = 2;
const EMPTY_CACHE_PAYLOAD = `${JSON.stringify({ version: CACHE_VERSION, entries: [] })}\n`;
const CACHE_FINGERPRINT_DOMAIN = "super-pi.mcp-schema-cache.v2\0";
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function defaultCachePath() {
  return path.join(agentDir(), "cache", "mcp-schemas-v1.json");
}

function readCache(cachePath) {
  try {
    const info = fs.lstatSync(cachePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) return undefined;
    const text = fs.readFileSync(cachePath, "utf8");
    try { return JSON.parse(text); }
    catch { return null; } // Readable but malformed: eligible for replacement.
  } catch {
    // Missing, unreadable, or unsafe files must not become replacement targets.
    return undefined;
  }
}

function isCurrentCacheEnvelope(data) {
  return data?.version === CACHE_VERSION && Array.isArray(data.entries);
}

function saveCache(cachePath, payload) {
  if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_BYTES) return false;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    try {
      const existing = fs.lstatSync(cachePath);
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
      if (fs.readFileSync(cachePath, "utf8") === payload) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    const temporary = `${cachePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.renameSync(temporary, cachePath); }
    catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    return true;
  } catch {
    return false;
  }
}

// Run before configuration parsing, without needing a key or runtime. The
// startup-local snapshot avoids rereading the cache if configuration succeeds.
export function prepareSchemaCache(cachePath = defaultCachePath()) {
  let data = readCache(cachePath);
  if (data !== undefined && !isCurrentCacheEnvelope(data)) {
    saveCache(cachePath, EMPTY_CACHE_PAYLOAD);
    data = undefined; // Never reuse legacy/invalid data, even if replacement failed.
  }
  return { path: cachePath, data };
}

export function configFingerprint(config, workspace) {
  const material = {
    workspace,
    source: config.source,
    transport: config.transport,
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    url: config.url,
    headers: config.headers,
    oauth: config.oauth,
    maxTools: config.maxTools,
  };
  return createHash("sha256").update(JSON.stringify(canonicalJsonShape(material))).digest("hex");
}

function isHexDigest(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

function normalizeCachedTool(tool) {
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > 512) return null;
  let inputSchema;
  try { inputSchema = validateJsonShape(tool.inputSchema ?? { type: "object", properties: {} }, MAX_SCHEMA_BYTES); }
  catch { return null; }
  if (!inputSchema || inputSchema.type !== "object" || Array.isArray(inputSchema)) return null;
  return {
    name: tool.name,
    description: sanitizeText(tool.description ?? `MCP tool ${tool.name}`, 1000),
    inputSchema: canonicalJsonShape(inputSchema),
  };
}

export class McpSchemaCache {
  constructor(cachePath = defaultCachePath(), snapshot) {
    this.path = cachePath;
    this.fingerprintKey = loadActivationKey();
    this.entries = new Map();
    this.load(snapshot);
  }

  load(snapshot) {
    const parsed = snapshot?.path === this.path ? snapshot.data : readCache(this.path);
    if (parsed !== undefined && !isCurrentCacheEnvelope(parsed)) {
      // Keep the existing path so upgrading replaces the unkeyed verifier,
      // including damaged payloads that no longer identify their format.
      this.entries.clear();
      this.save();
      return;
    }
    if (!this.fingerprintKey || parsed === undefined) return;
    const now = Date.now();
    for (const entry of parsed.entries.slice(0, MAX_CACHE_ENTRIES)) {
      if (!entry || !isHexDigest(entry.fingerprint) || !Number.isFinite(entry.updatedAt) || now - entry.updatedAt > MAX_CACHE_AGE_MS || !Array.isArray(entry.tools) || entry.tools.length > 128) continue;
      const tools = entry.tools.map(normalizeCachedTool);
      if (tools.some((tool) => tool === null)) continue;
      this.entries.set(entry.fingerprint, {
        fingerprint: entry.fingerprint,
        updatedAt: entry.updatedAt,
        serverInfo: entry.serverInfo && typeof entry.serverInfo === "object"
          ? { name: sanitizeText(entry.serverInfo.name, 80), version: sanitizeText(entry.serverInfo.version, 40) }
          : null,
        tools,
      });
    }
  }

  fingerprint(config, workspace) {
    if (!this.fingerprintKey) return undefined;
    return createHmac("sha256", this.fingerprintKey).update(CACHE_FINGERPRINT_DOMAIN).update(configFingerprint(config, workspace)).digest("hex");
  }

  get(config, workspace) {
    const fingerprint = this.fingerprint(config, workspace);
    return fingerprint === undefined ? null : this.entries.get(fingerprint) ?? null;
  }

  put(config, workspace, tools, serverInfo) {
    const fingerprint = this.fingerprint(config, workspace);
    if (fingerprint === undefined) return false;
    const normalized = tools.map(normalizeCachedTool);
    if (normalized.some((tool) => tool === null)) return false;
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, {
      fingerprint,
      updatedAt: Date.now(),
      serverInfo: serverInfo ? { name: sanitizeText(serverInfo.name, 80), version: sanitizeText(serverInfo.version, 40) } : null,
      tools: normalized,
    });
    while (this.entries.size > MAX_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value);
    let payload = this.serialize();
    while (Buffer.byteLength(payload, "utf8") > MAX_CACHE_BYTES && this.entries.size > 0) {
      this.entries.delete(this.entries.keys().next().value);
      payload = this.serialize();
    }
    return this.save(payload);
  }

  serialize() {
    return `${JSON.stringify({ version: CACHE_VERSION, entries: [...this.entries.values()] })}\n`;
  }

  save(payload = this.serialize()) {
    return saveCache(this.path, payload);
  }
}
