import { access, lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";

const WINDOWS_EXECUTABLE_NAMES = ["browser-use.exe"] as const;
const POSIX_EXECUTABLE_NAMES = ["browser-use"] as const;
const IMAGE_PATH_RES = [
  /"((?:[A-Za-z]:[\\/]|\/)[^"\r\n]+?\.(?:png|jpe?g|webp))"/giu,
  /'((?:[A-Za-z]:[\\/]|\/)[^'\r\n]+?\.(?:png|jpe?g|webp))'/giu,
  /((?:[A-Za-z]:[\\/]|\/)[^\s"']+?\.(?:png|jpe?g|webp))/giu,
] as const;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const SCREENSHOT_READ_CHUNK_BYTES = 64 * 1024;
const SCREENSHOT_PATH_SCRATCH = new Set<string>();
const ENV_EXACT = new Set([
  "APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATH", "PATHEXT", "PROGRAMDATA",
  "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR",
  "BH_AUTH_PATH", "BH_CHROME_PATH", "BH_CONFIG_DIR", "BH_DEBUG_CLICKS", "BH_DEVICE_NAME",
  "BH_DOMAIN_SKILLS", "BH_HOME", "BH_RECORD", "BH_RECORD_IDLE", "BH_RUNTIME_DIR",
  "BH_RUNTIME_DIR_SHARED", "BH_TELEMETRY", "BH_TMP_DIR", "BH_TMP_DIR_SHARED",
  "BROWSER_HARNESS_HOME", "BROWSER_HARNESS_TELEMETRY",
  "BU_AUTOSPAWN", "BU_BROWSER_ID", "BU_CDP_URL", "BU_CDP_WS",
  "BROWSER_USE_ACTION_TIMEOUT_S", "BROWSER_USE_ALLOWED_DOMAINS", "BROWSER_USE_CDP_TIMEOUT_S",
  "BROWSER_USE_CONFIG_DIR", "BROWSER_USE_CONFIG_PATH", "BROWSER_USE_DISABLE_EXTENSIONS",
  "BROWSER_USE_HEADLESS", "BROWSER_USE_LOGGING_LEVEL", "BROWSER_USE_SETUP_LOGGING",
]);
const URL_LITERAL_RE = /https?:\/\/[^\s'"\\)]+/giu;
const URL_TRAILING_PUNCTUATION_RE = /[,.;}]+$/u;
const METADATA_HOSTS = new Set([
  "metadata.google.internal", "metadata.goog", "instance-data", "metadata.azure.internal",
]);
const SENSITIVE_QUERY_KEYS = new Set([
  "api_key", "apikey", "access_token", "auth", "authorization", "credential",
  "key", "password", "secret", "signature", "token",
]);

export interface BrowserUseExecutable {
  command: string;
  source: "configured" | "managed" | "path" | "uv";
}

export interface LoadedScreenshot {
  path: string;
  data: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b, c] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return a === 0 || a === 10 || a === 127 || a! >= 224
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function ipv6Groups(address: string): number[] | undefined {
  let normalized = address.toLowerCase();
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    normalized = `${normalized.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

function privateIp(host: string): boolean {
  const version = isIP(host);
  if (version === 4) return privateIpv4(host);
  if (version !== 6) return false;
  const groups = ipv6Groups(host);
  if (!groups) return true;
  const [a, b, c, d, e, f, g, h] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && (h === 0 || h === 1)) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return privateIpv4(`${g! >>> 8}.${g! & 0xff}.${h! >>> 8}.${h! & 0xff}`);
  }
  return (a! & 0xfe00) === 0xfc00
    || (a! & 0xffc0) === 0xfe80
    || (a! & 0xff00) === 0xff00
    || (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    || (a === 0x100 && b === 0 && c === 0 && d === 0)
    || (a === 0x2001 && (b === 0 || b === 2 || b === 0x0db8 || (b! & 0xfff0) === 0x20))
    || a === 0x2002;
}

function internalHostname(host: string): boolean {
  if (host === "localhost" || METADATA_HOSTS.has(host)) return true;
  if (isIP(host)) return privateIp(host);
  return !host.includes(".") || [".internal", ".local", ".localhost", ".lan", ".home.arpa"].some((suffix) => host.endsWith(suffix));
}

export function browserUrlSafetyError(code: string): string | undefined {
  for (const match of code.matchAll(URL_LITERAL_RE)) {
    const literal = match[0].replace(URL_TRAILING_PUNCTUATION_RE, "");
    let url: URL;
    try {
      url = new URL(literal);
    } catch {
      continue;
    }
    if (url.username || url.password) return "URL embeds credentials.";
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return `URL contains credential-like query parameter (${key}).`;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (METADATA_HOSTS.has(host) || host === "169.254.169.254" || host === "100.100.100.200") return "URL targets a cloud metadata endpoint.";
    if (internalHostname(host)) return `URL targets a private or internal address (${host}).`;
  }
  return undefined;
}

function executableNames(): readonly string[] {
  return process.platform === "win32" ? WINDOWS_EXECUTABLE_NAMES : POSIX_EXECUTABLE_NAMES;
}

async function regularExecutable(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(candidates: readonly string[], source: BrowserUseExecutable["source"]): Promise<BrowserUseExecutable | undefined> {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !await regularExecutable(candidate)) continue;
    try {
      const command = await realpath(candidate);
      if (await regularExecutable(command)) return { command, source };
    } catch {
      // Candidate changed between checks; continue without trusting it.
    }
  }
  return undefined;
}

export async function findBrowserUseExecutable(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<BrowserUseExecutable | undefined> {
  const configured = env.SP_BROWSER_USE_CLI?.trim();
  if (configured && isAbsolute(configured)) {
    const found = await firstExecutable([resolve(configured)], "configured");
    if (found) return found;
  }

  const managed = await firstExecutable(executableNames().map((name) => join(agentDir, "bin", name)), "managed");
  if (managed) return managed;

  const uvBinRoots: string[] = [];
  if (env.USERPROFILE) uvBinRoots.push(join(env.USERPROFILE, ".local", "bin"));
  if (env.HOME && env.HOME !== env.USERPROFILE) uvBinRoots.push(join(env.HOME, ".local", "bin"));
  if (env.APPDATA) uvBinRoots.push(join(env.APPDATA, "uv", "bin"));
  const userUv = await firstExecutable(
    uvBinRoots.flatMap((root) => executableNames().map((name) => join(root, name))),
    "uv",
  );
  if (userUv) return userUv;

  const pathEntries = (env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const pathCandidates: string[] = [];
  for (const entry of pathEntries) for (const name of executableNames()) pathCandidates.push(join(entry, name));
  return firstExecutable(pathCandidates, "path");
}

export function buildBrowserUseEnvironment(source: NodeJS.ProcessEnv, workspace: string, session?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [rawKey, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = rawKey.toUpperCase();
    if (!ENV_EXACT.has(key)) continue;
    if (key === "BU_CDP_URL" || key === "BU_CDP_WS") {
      let endpoint: URL;
      try {
        endpoint = new URL(value);
      } catch {
        throw new Error("Invalid Browser Use CDP endpoint.");
      }
      if (endpoint.username || endpoint.password || [...endpoint.searchParams.keys()].some((name) => SENSITIVE_QUERY_KEYS.has(name.toLowerCase()))) {
        throw new Error("Credential-bearing Browser Use CDP endpoints are not forwarded to model Python.");
      }
    }
    env[key] = value;
  }
  env.ANONYMIZED_TELEMETRY = "false";
  env.BH_AGENT_WORKSPACE = workspace;
  env.BH_CLIENT = "@super-pi/browser-use";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  if (session) {
    env.BU_NAME = session;
    if (source.BROWSER_USE_API_KEY) env.BROWSER_USE_API_KEY = source.BROWSER_USE_API_KEY;
  } else {
    env.BU_NAME = undefined;
  }
  return env;
}

export function extractScreenshotCandidates(output: string): string[] {
  const paths: string[] = [];
  const seen = SCREENSHOT_PATH_SCRATCH;
  seen.clear();
  try {
    for (const pattern of IMAGE_PATH_RES) {
      for (const match of output.matchAll(pattern)) {
        const path = match[1]!;
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    }
    return paths;
  } finally {
    seen.clear();
  }
}

function imageMime(data: Buffer): LoadedScreenshot["mimeType"] | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function pathInside(path: string, root: string): boolean {
  const normalizedPath = process.platform === "win32" ? path.toLowerCase() : path;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`);
}

function sameFileIdentity(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedScreenshot(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= MAX_SCREENSHOT_BYTES) {
    const remaining = MAX_SCREENSHOT_BYTES + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(SCREENSHOT_READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
    totalBytes += bytesRead;
    if (totalBytes > MAX_SCREENSHOT_BYTES) return undefined;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return undefined;
}

export async function loadRecentScreenshot(path: string, roots: readonly string[], startedAtMs: number): Promise<LoadedScreenshot | undefined> {
  if (!isAbsolute(path) || ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase())) return undefined;
  let resolvedPath: string;
  let resolvedRoots: string[];
  try {
    [resolvedPath, ...resolvedRoots] = await Promise.all([realpath(path), ...roots.map((root) => realpath(root))]);
  } catch {
    return undefined;
  }
  if (!resolvedRoots.some((root) => pathInside(resolvedPath, root))) return undefined;

  let handle;
  try {
    const pathBefore = await lstat(resolvedPath);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return undefined;
    handle = await open(resolvedPath, "r");
    const before = await handle.stat();
    if (!sameFileIdentity(pathBefore, before) || before.size <= 0 || before.size > MAX_SCREENSHOT_BYTES || before.mtimeMs < startedAtMs - 1_000) return undefined;
    const data = await readBoundedScreenshot(handle);
    if (!data) return undefined;
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(resolvedPath)]);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile()) return undefined;
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter)) return undefined;
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.size !== pathAfter.size || after.mtimeMs !== pathAfter.mtimeMs) return undefined;
    const mimeType = imageMime(data);
    return mimeType ? { path: resolvedPath, data, mimeType } : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
