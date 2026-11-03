import { win32 as path } from "node:path";

/** Intent only. This profile is not enabled by creating or serializing a request. */
export const WINDOWS_SANDBOX_PROFILE = Object.freeze({
  id: "windows-powershell-foreground-v1" as const,
  executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  workspace: "C:\\SuperPiVolume\\workspace",
  commandEncoding: "utf16le-base64",
  environment: Object.freeze({
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
    TEMP: "C:\\SuperPiVolume\\temp", TMP: "C:\\SuperPiVolume\\temp",
  }),
});
export const SANDBOX_TASK_LIMITS = Object.freeze({
  entries: 16, inputFileBytes: 4096, inputBytes: 16384,
  candidateFileBytes: 4096, candidateBytes: 16384,
  commandBytes: 8192, metadataBytes: 32768, timeoutMs: 30000,
  stdoutBytes: 32768, stderrBytes: 32768,
});
export interface SandboxTaskInput { readonly path: string; readonly snapshot: string; }
export interface SandboxTaskWrite {
  readonly path: string; readonly operation: "add" | "modify"; readonly snapshot: string | null;
}
export interface SandboxTaskRequest {
  readonly version: 1;
  readonly profile: "windows-powershell-foreground-v1";
  readonly command: string;
  /** Relative to the selected workspace, not to a host shell's ambient directory. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly inputs: readonly SandboxTaskInput[];
  readonly writes: readonly SandboxTaskWrite[];
}
const requests = new WeakSet<object>();
const SNAPSHOT = /^snap_[A-Za-z0-9_-]{22}$/;
function need(value: unknown, why: string): asserts value {
  if (!value) throw new Error("[SANDBOX_REQUEST_INVALID] " + why);
}
/** Read only own data fields. Accessors and extra host/authority fields are refused. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  need(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a data record.");
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Expected a plain record.");
  const names = Reflect.ownKeys(value);
  need(names.length === keys.length && names.every(name => typeof name === "string" && keys.includes(name)), "Unexpected request fields.");
  const copy: Record<string, unknown> = {};
  for (const name of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    need(descriptor && "value" in descriptor, "Request accessors are unsupported.");
    copy[name] = descriptor.value;
  }
  return copy;
}
function rows(value: unknown): unknown[] {
  need(Array.isArray(value), "Expected a bounded list.");
  const length = Object.getOwnPropertyDescriptor(value, "length")!.value;
  need(Number.isSafeInteger(length) && length >= 0 && length <= SANDBOX_TASK_LIMITS.entries, "Too many entries.");
  need(Reflect.ownKeys(value).length === length + 1, "Sparse or extended lists are unsupported.");
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    need(descriptor && "value" in descriptor, "List accessors are unsupported.");
    result.push(descriptor.value);
  }
  return result;
}
function relative(value: unknown): string {
  need(typeof value === "string" && value.length > 0 && value.length <= 120, "Invalid relative path.");
  const parts = value.split("/");
  need(parts.length <= 4, "Path depth exceeds this profile.");
  for (const part of parts) {
    need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) && !part.endsWith(".")
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "Unsupported path component.");
    need(!/^(credentials?|secrets?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(part)
      && !/\.(pem|key|pfx|p12)$/i.test(part), "Protected input name.");
  }
  return value;
}
function validText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** Cold invocation boundary; no I/O, path permission, revision issuance or execution. */
export function parseSandboxTaskRequest(input: unknown): SandboxTaskRequest {
  const data = record(input, ["version", "profile", "command", "cwd", "timeoutMs", "inputs", "writes"]);
  need(data.version === 1 && data.profile === WINDOWS_SANDBOX_PROFILE.id, "Unsupported command environment.");
  need(typeof data.command === "string" && data.command.length > 0 && !data.command.includes("\0")
    && validText(data.command) && Buffer.byteLength(data.command, "utf8") <= SANDBOX_TASK_LIMITS.commandBytes, "Command encoding or size.");
  need(Number.isSafeInteger(data.timeoutMs) && (data.timeoutMs as number) > 0
    && (data.timeoutMs as number) <= SANDBOX_TASK_LIMITS.timeoutMs, "Unsupported execution deadline.");
  const cwd = data.cwd === "." ? "." : relative(data.cwd);
  const inputs: SandboxTaskInput[] = [], writes: SandboxTaskWrite[] = [];
  const selected = new Map<string, SandboxTaskInput>(), targets = new Set<string>(), allPaths: string[] = [];
  const addPath = (name: string) => {
    const key = name.toLowerCase();
    for (const old of allPaths) need(key !== old && !key.startsWith(old + "/") && !old.startsWith(key + "/"), "Conflicting file paths.");
    need(allPaths.length < SANDBOX_TASK_LIMITS.entries, "Combined file limit.");
    allPaths.push(key);
  };
  for (const value of rows(data.inputs)) {
    const item = record(value, ["path", "snapshot"]), name = relative(item.path);
    need(typeof item.snapshot === "string" && SNAPSHOT.test(item.snapshot), "Original read revision required.");
    addPath(name);
    const copy = Object.freeze({ path: name, snapshot: item.snapshot });
    selected.set(name.toLowerCase(), copy); inputs.push(copy);
  }
  for (const value of rows(data.writes)) {
    const item = record(value, ["path", "operation", "snapshot"]), name = relative(item.path), key = name.toLowerCase();
    need(!targets.has(key), "Repeated write target."); targets.add(key);
    if (item.operation === "modify") {
      const original = selected.get(key);
      need(original && original.path === name && item.snapshot === original.snapshot, "Modification must use its selected original revision.");
    } else {
      need(item.operation === "add" && item.snapshot === null, "Only explicit add/modify targets are supported.");
      addPath(name);
    }
    writes.push(Object.freeze({ path: name, operation: item.operation as "add" | "modify", snapshot: item.snapshot as string | null }));
  }
  if (cwd !== ".") for (const name of allPaths) {
    const directory = cwd.toLowerCase();
    need(directory !== name && !directory.startsWith(name + "/"), "Working directory conflicts with a file.");
  }
  const request: SandboxTaskRequest = Object.freeze({
    version: 1, profile: WINDOWS_SANDBOX_PROFILE.id, command: data.command,
    cwd, timeoutMs: data.timeoutMs as number, inputs: Object.freeze(inputs), writes: Object.freeze(writes),
  });
  need(Buffer.byteLength(JSON.stringify(request), "utf8") <= SANDBOX_TASK_LIMITS.metadataBytes, "Request metadata limit.");
  requests.add(request);
  return request;
}
/** A validated-intent brand, never an authorization token. */
export function assertSandboxTaskRequest(request: SandboxTaskRequest): void {
  need(requests.has(request), "Use the request parser; a serialized request is not a live binding.");
}
export function sandboxGuestCwd(request: SandboxTaskRequest): string {
  assertSandboxTaskRequest(request);
  return request.cwd === "." ? WINDOWS_SANDBOX_PROFILE.workspace
    : path.join(WINDOWS_SANDBOX_PROFILE.workspace, ...request.cwd.split("/"));
}
