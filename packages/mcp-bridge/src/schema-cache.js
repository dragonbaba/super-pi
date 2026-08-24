import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "./config.js";
import { MAX_SCHEMA_BYTES, canonicalJsonShape, sanitizeText, validateJsonShape } from "./security.js";

const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
  constructor(cachePath = path.join(agentDir(), "cache", "mcp-schemas-v1.json")) {
    this.path = cachePath;
    this.entries = new Map();
    this.load();
  }

  load() {
    let info;
    try { info = fs.lstatSync(this.path); }
    catch { return; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.path, "utf8")); }
    catch { return; }
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return;
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

  get(config, workspace) {
    return this.entries.get(configFingerprint(config, workspace)) ?? null;
  }

  put(config, workspace, tools, serverInfo) {
    const normalized = tools.map(normalizeCachedTool);
    if (normalized.some((tool) => tool === null)) return false;
    const fingerprint = configFingerprint(config, workspace);
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
    if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_BYTES) return false;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        const existing = fs.lstatSync(this.path);
        if (!existing.isFile() || existing.isSymbolicLink()) return false;
        if (fs.readFileSync(this.path, "utf8") === payload) return true;
      } catch (error) {
        if (error?.code !== "ENOENT") return false;
      }
      const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { fs.renameSync(temporary, this.path); }
      catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
      return true;
    } catch {
      return false;
    }
  }
}
