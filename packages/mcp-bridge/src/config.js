import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ENV_HEADER_REFERENCE_PATTERN,
  ENV_NAME_PATTERN,
  HTTP_HEADER_NAME_PATTERN,
  SERVER_ID_PATTERN,
  SINGLE_LINE_CONTROL_PATTERN,
} from "./regex.js";
import { MAX_CONFIG_BYTES, MAX_SERVERS } from "./security.js";
const SAFE_ENV = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "PATH", "HOME", "USERPROFILE"];
const TRANSPORTS = new Set(["stdio", "http", "sse"]);

export function agentDir() {
  return process.env.SP_CODING_AGENT_DIR || path.join(os.homedir(), ".sp", "agent");
}

function ownObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value, name, max = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || SINGLE_LINE_CONTROL_PATTERN.test(value)) throw new Error(`${name} must be a bounded single-line string`);
  return value;
}

function boundedInt(value, fallback, min, max, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw new Error(`${name} is out of range`);
  return resolved;
}

function readConfigFile(filePath, required = false) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`MCP config must be a regular non-symlink file: ${filePath}`);
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`MCP config exceeds ${MAX_CONFIG_BYTES} bytes: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!ownObject(parsed) || parsed.version !== 1 || !ownObject(parsed.servers ?? {})) throw new Error(`Invalid MCP config structure: ${filePath}`);
  return parsed;
}

function expandWorkspace(value, workspace) {
  return value.replaceAll("${workspace}", workspace);
}

function resolveEnvironment(server, label) {
  const env = Object.create(null);
  for (const name of SAFE_ENV) if (typeof process.env[name] === "string") env[name] = process.env[name];
  const envFrom = server.envFrom ?? [];
  if (!Array.isArray(envFrom) || envFrom.length > 32) throw new Error(`${label}.envFrom must contain at most 32 names`);
  for (const name of envFrom) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) throw new Error(`${label}.envFrom contains an invalid name`);
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  if (!ownObject(server.env ?? {})) throw new Error(`${label}.env must be an object`);
  for (const [name, value] of Object.entries(server.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`${label}.env contains an invalid name`);
    env[name] = boundedString(value, `${label}.env.${name}`, 8192);
  }
  return env;
}

function resolveHeaders(server, label) {
  if (!ownObject(server.headers ?? {})) throw new Error(`${label}.headers must be an object`);
  const headers = Object.create(null);
  for (const [name, raw] of Object.entries(server.headers ?? {})) {
    if (!HTTP_HEADER_NAME_PATTERN.test(name)) throw new Error(`${label}.headers contains an invalid name`);
    const value = boundedString(raw, `${label}.headers.${name}`, 8192);
    const match = ENV_HEADER_REFERENCE_PATTERN.exec(value);
    if (match) {
      if (typeof process.env[match[1]] !== "string") throw new Error(`${label}.headers.${name} references a missing environment variable`);
      headers[name] = process.env[match[1]];
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function normalizeServer(id, raw, workspace, source) {
  if (!SERVER_ID_PATTERN.test(id) || !ownObject(raw)) throw new Error(`Invalid MCP server definition: ${id}`);
  const label = `${source}.servers.${id}`;
  const transport = raw.transport ?? "stdio";
  if (!TRANSPORTS.has(transport)) throw new Error(`${label}.transport is unsupported`);
  const common = {
    id,
    source,
    enabled: raw.enabled !== false,
    transport,
    startupTimeoutMs: boundedInt(raw.startupTimeoutMs, 30_000, 1_000, 300_000, `${label}.startupTimeoutMs`),
    toolTimeoutMs: boundedInt(raw.toolTimeoutMs, 120_000, 1_000, 1_800_000, `${label}.toolTimeoutMs`),
    maxTools: boundedInt(raw.maxTools, 64, 1, 128, `${label}.maxTools`),
  };
  if (transport === "stdio") {
    const command = path.resolve(boundedString(raw.command, `${label}.command`));
    let commandStat;
    try { commandStat = fs.lstatSync(command); } catch {}
    if (!path.isAbsolute(raw.command) || !commandStat?.isFile() || commandStat.isSymbolicLink()) throw new Error(`${label}.command must be an existing absolute non-symlink file`);
    if (!Array.isArray(raw.args ?? []) || (raw.args ?? []).length > 128) throw new Error(`${label}.args is invalid`);
    const args = (raw.args ?? []).map((arg, index) => expandWorkspace(boundedString(arg, `${label}.args[${index}]`, 8192), workspace));
    const cwdRaw = raw.cwd ?? "${workspace}";
    const cwdCandidate = path.resolve(expandWorkspace(boundedString(cwdRaw, `${label}.cwd`), workspace));
    if (!fs.existsSync(cwdCandidate) || !fs.statSync(cwdCandidate).isDirectory()) throw new Error(`${label}.cwd must be an existing directory`);
    const cwd = fs.realpathSync.native(cwdCandidate);
    return { ...common, command, args, cwd, env: resolveEnvironment(raw, label) };
  }
  const url = new URL(boundedString(raw.url, `${label}.url`, 8192));
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error(`${label}.url must use HTTPS, except for loopback HTTP`);
  if (url.username || url.password) throw new Error(`${label}.url must not contain credentials`);
  return { ...common, url: url.href, headers: resolveHeaders(raw, label) };
}

export function loadMcpConfig(workspace, projectTrusted) {
  const root = agentDir();
  const globalPath = path.join(root, "config", "mcp.json");
  const globalConfig = readConfigFile(globalPath) ?? { version: 1, allowProjectConfig: false, servers: {} };
  const merged = new Map();
  for (const [id, server] of Object.entries(globalConfig.servers)) merged.set(id, normalizeServer(id, server, workspace, "global"));

  const projectPath = path.join(workspace, ".sp", "config", "mcp.json");
  if (projectTrusted && globalConfig.allowProjectConfig === true && fs.existsSync(projectPath)) {
    const projectConfig = readConfigFile(projectPath, true);
    for (const [id, server] of Object.entries(projectConfig.servers)) {
      if (merged.has(id)) throw new Error(`Project MCP server duplicates global server id: ${id}`);
      merged.set(id, normalizeServer(id, server, workspace, "project"));
    }
  }
  if (merged.size > MAX_SERVERS) throw new Error(`MCP config exceeds ${MAX_SERVERS} servers`);
  return { globalPath, projectPath, allowProjectConfig: globalConfig.allowProjectConfig === true, servers: [...merged.values()] };
}
