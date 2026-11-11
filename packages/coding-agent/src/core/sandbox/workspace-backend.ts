import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MAX_WRITE_BYTES } from "../files/write-limits.ts";
import { canonicalizeProspectivePath, canonicalWorkspaceMetadata } from "../files/protected-path-policy.ts";
import { containsDirectory } from "../session-execution-profile.ts";
import { workspaceInput } from "./workspace-paths.ts";
import { parseSandboxNetwork, type SandboxNetwork, type SandboxNetworkSession } from "./network-policy.ts";
import { HOST_PATH_QUERY, refreshedHostEnvironment } from "./host-path.ts";
import { SandboxToolchains } from "./mxc-toolchains.mjs";
import { MxcProcess } from "./mxc-process.ts";
import { IMAGE_LIMIT, READ_LINES, SEARCH_ROWS, SEARCH_ENTRIES, TEXT_LIMIT, FILE_PROTOCOL_LIMIT, normalizeReadOffset, normalizeReadLimit } from "./mxc-file-limits.mjs";

export interface WorkspaceSandboxOptions {
  settings?: { include?: string[]; exclude?: string[] }; powershellPath?: string;
  network?: SandboxNetwork; networkSession?: SandboxNetworkSession; directories?: readonly string[];
}
export interface WorkspaceArtifact { name: string; bytes: number; sha256: string; }
export interface WorkspaceRead {
  version: 1; offset: number; limit: number; windowComplete: boolean; hasMore: boolean; lineTruncated: boolean;
  returnedLines: number; incompleteLine?: number; nextOffset?: number;
}
export interface WorkspaceSearch {
  version: 1; operation: "ls" | "find" | "grep"; outputMode: "content" | "files";
  scanComplete: boolean; coverageComplete: boolean; outputTruncated: boolean; excerptTruncated: boolean;
  stopReason: "none" | "row-limit" | "text-limit" | "entry-limit";
  visitedEntries: number; scannedFiles: number; observedRecords: number; returnedRecords: number; outputUnits: number;
  skippedTooLarge: number; skippedNonUtf8: number; skippedNul: number; excludedProtected: number; excludedLinks: number;
}
export interface WorkspaceReply {
  id: string; ok: boolean; text?: string; snapshot?: string; error?: string; noEffects?: boolean; phase?: string;
  image?: { mimeType: string; artifact: WorkspaceArtifact };
  read?: WorkspaceRead; search?: WorkspaceSearch;
  execution?: { exitCode: number; timedOut: boolean; closed: boolean; stdout: string; stderr: string; truncated?: boolean };
}
export class WorkspaceOperationError extends Error {
  readonly reply: WorkspaceReply;
  constructor(reply: WorkspaceReply) { super("[SANDBOX_" + (reply.phase ?? "OPERATION").toUpperCase() + "] " + reply.error); this.reply = reply; }
}
export const HOST_PATH_WORKSPACE = 0, HOST_PATH_TOOL = 1, HOST_PATH_HOST_ONLY = 2;
const EXECUTOR_SHA256 = "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";
const ARTIFACT_NAME = /^[a-f0-9]{32}-0\.bin$/;
const COMMAND_OUTPUT_BYTES = 32768; // Byte-ring capacity, independent of the file body's UTF-16 budget.
const READ_FACT_KEYS = new Set(["version", "offset", "limit", "windowComplete", "hasMore", "lineTruncated", "returnedLines", "incompleteLine", "nextOffset"]);
const SEARCH_FACT_KEYS = new Set(["version", "operation", "outputMode", "scanComplete", "coverageComplete", "outputTruncated", "excerptTruncated", "stopReason",
  "visitedEntries", "scannedFiles", "observedRecords", "returnedRecords", "outputUnits", "skippedTooLarge", "skippedNonUtf8", "skippedNul", "excludedProtected", "excludedLinks"]);
// Fixed transport initialization; the caller's command body is neither parsed nor rewritten.
const POWERSHELL_UTF8 = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;\n";
const require = createRequire(import.meta.url);
let executorPath: Promise<string> | undefined;
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error("[SANDBOX_MXC] " + reason); }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
function validateFileFacts(reply: WorkspaceReply, operation: string, input: Record<string, unknown>): void {
  if (operation === "read" && !reply.image) {
    const r = reply.read;
    need(r && typeof r === "object" && r.version === 1 && r.offset === normalizeReadOffset(input.offset)
      && Number.isInteger(r.offset) && r.offset >= 1
      && r.limit === normalizeReadLimit(input.limit) && integer(r.limit, READ_LINES)
      && typeof r.windowComplete === "boolean" && typeof r.hasMore === "boolean" && typeof r.lineTruncated === "boolean"
      && integer(r.returnedLines, r.limit), "Invalid read facts");
    for (const key in r) need(READ_FACT_KEYS.has(key), "Unexpected read facts field");
    need(r.incompleteLine === (r.lineTruncated ? r.offset + r.returnedLines : undefined)
      && r.nextOffset === (r.hasMore && !r.lineTruncated && r.returnedLines > 0 ? r.offset + r.returnedLines : undefined)
      && (!r.lineTruncated || r.hasMore && r.returnedLines < r.limit)
      && (!r.hasMore || r.lineTruncated || r.returnedLines > 0 || r.limit === 0)
      && (Number.isSafeInteger(r.offset) || !r.hasMore && r.returnedLines === 0)
      && r.windowComplete === (!r.lineTruncated && (r.returnedLines === r.limit || !r.hasMore)), "Inconsistent read facts");
  } else need(reply.read === undefined, "Unexpected read facts");
  if (operation === "ls" || operation === "find" || operation === "grep") {
    const s = reply.search;
    need(s && typeof s === "object" && s.version === 1 && s.operation === operation
      && s.outputMode === (operation === "grep" ? "content" : "files")
      && typeof s.scanComplete === "boolean" && typeof s.coverageComplete === "boolean"
      && typeof s.outputTruncated === "boolean" && typeof s.excerptTruncated === "boolean"
      && (s.stopReason === "none" || s.stopReason === "row-limit" || s.stopReason === "text-limit" || s.stopReason === "entry-limit")
      && integer(s.visitedEntries, SEARCH_ENTRIES) && integer(s.scannedFiles, SEARCH_ENTRIES + 1)
      && integer(s.observedRecords, SEARCH_ROWS + 1) && integer(s.returnedRecords, SEARCH_ROWS) && integer(s.outputUnits, TEXT_LIMIT)
      && integer(s.skippedTooLarge, s.scannedFiles) && integer(s.skippedNonUtf8, s.scannedFiles) && integer(s.skippedNul, s.scannedFiles)
      && integer(s.excludedProtected) && integer(s.excludedLinks), "Invalid search facts");
    for (const key in s) need(SEARCH_FACT_KEYS.has(key), "Unexpected search facts field");
    need(s.scanComplete === (s.stopReason === "none")
      && s.coverageComplete === (s.scanComplete && s.skippedTooLarge + s.skippedNonUtf8 + s.skippedNul === 0)
      && s.skippedTooLarge + s.skippedNonUtf8 + s.skippedNul <= s.scannedFiles
      && s.observedRecords === s.returnedRecords + (s.outputTruncated ? 1 : 0)
      && (s.stopReason !== "row-limit" || s.returnedRecords === SEARCH_ROWS) && s.outputUnits >= s.returnedRecords
      && s.outputTruncated === (s.stopReason === "row-limit" || s.stopReason === "text-limit")
      && (!s.excerptTruncated || operation === "grep" && s.outputMode === "content" && s.returnedRecords > 0), "Inconsistent search facts");
  } else need(reply.search === undefined, "Unexpected search facts");
}
async function officialExecutor(): Promise<string> {
  need(process.platform === "win32" && process.arch === "x64", "MXC currently requires Windows x64; no host or VM fallback");
  let manifest: string;
  try { manifest = require.resolve("@microsoft/mxc-sdk/package.json"); }
  catch { throw new Error("[SANDBOX_MXC] Install the pinned @microsoft/mxc-sdk dependency before selecting sandbox mode"); }
  need(JSON.parse(await fs.readFile(manifest, "utf8")).version === "1.0.1", "Unexpected MXC package version");
  const executable = await fs.realpath(path.join(path.dirname(manifest), "bin", "x64", "wxc-exec.exe")), hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  need(hash.digest("hex") === EXECUTOR_SHA256, "MXC executor differs from the reviewed official artifact"); return executable;
}

/** One MXC owner per permission generation; no project tree capture or publication. */
export class WorkspaceSandboxBackend {
  private root?: string; private identity?: string; private tools?: string; private exchange?: string;
  private temporary?: string; private state?: string; private executable?: string;
  private toolchains?: SandboxToolchains; private environment?: NodeJS.ProcessEnv;
  private readonly roots: string[] = []; private readonly identities: string[] = [];
  private readonly runner = new MxcProcess(); private readonly shutdown = new AbortController();
  private pending?: Promise<WorkspaceReply>; private closeOperation?: Promise<void>;
  private closed = false; private starts = 0; private calls = 0;
  private readonly artifacts = new Set<string>(); private readonly network: SandboxNetwork;
  private readonly cwd: string; private readonly parent: string; private readonly mode: "read-only" | "sandbox-write"; private readonly options: WorkspaceSandboxOptions;
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write", options: WorkspaceSandboxOptions = {}) {
    this.cwd = cwd; this.parent = parent; this.mode = mode; this.options = options; this.network = parseSandboxNetwork(options.network);
  }
  get networkEnabled(): boolean { return this.network === "enabled" || this.options.networkSession?.enabled === true; }
  get diagnostics() { return { backend: "mxc", starts: this.starts, calls: this.calls, pending: !!this.pending, closed: this.closed,
    root: this.root, ownedArtifacts: this.artifacts.size, process: this.runner.diagnostics }; }
  workspace(index = 0): string {
    need(Number.isSafeInteger(index) && index >= 0 && index <= (this.options.directories?.length ?? 0), "Unknown workspace identity");
    return this.roots[index] ?? (index ? this.options.directories![index - 1] : this.cwd);
  }
  async enableSessionNetwork(): Promise<void> {
    need(this.options.networkSession && !this.pending, "Session network consent unavailable during an operation"); this.options.networkSession.enabled = true;
  }
  async hostPathKind(candidate: string): Promise<number> {
    const canonical = await canonicalizeProspectivePath(candidate);
    for (const root of this.roots) if (containsDirectory(root, canonical)) return HOST_PATH_WORKSPACE;
    for (const root of this.toolchains?.mountRoots ?? []) if (containsDirectory(root, canonical)) return HOST_PATH_TOOL;
    return HOST_PATH_HOST_ONLY;
  }
  invoke(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkspaceReply> {
    if (this.closed) return Promise.reject(new Error("[SANDBOX_CLOSED] MXC workspace owner is closed"));
    if (operation === "bash") return Promise.reject(new Error("[SANDBOX_UNSUPPORTED] Windows sandbox provides PowerShell 7 only"));
    if (this.pending) return Promise.reject(new Error("[SANDBOX_BUSY] Wait for the current operation"));
    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    return this.pending = this.run(operation, input, combined).finally(this.releasePending);
  }
  private readonly releasePending = (): void => { this.pending = undefined; };
  private async start(signal: AbortSignal): Promise<void> {
    this.executable = await (executorPath ??= officialExecutor()); signal.throwIfAborted();
    await fs.mkdir(this.parent, { recursive: true });
    this.root = await fs.mkdtemp(path.join(await fs.realpath(this.parent), "mxc-"));
    const identity = await fs.lstat(this.root, { bigint: true }); this.identity = identity.dev + ":" + identity.ino;
    this.tools = path.join(this.root, "tools"); this.exchange = path.join(this.root, "exchange");
    this.temporary = path.join(this.root, "temporary"); this.state = path.join(this.root, "state");
    for (const directory of [this.tools, this.exchange, this.temporary, this.state]) await fs.mkdir(directory);
    for (const directory of [this.cwd, ...(this.options.directories ?? [])]) {
      const canonical = await fs.realpath(directory), stat = await fs.lstat(canonical, { bigint: true });
      need(stat.isDirectory(), "Workspace is not a directory"); this.roots.push(canonical); this.identities.push(stat.dev + ":" + stat.ino);
    }
    for (const [url, name] of [[new URL("./mxc-file-worker.mjs", import.meta.url), "worker.mjs"],
      [new URL("./mxc-file-limits.mjs", import.meta.url), "mxc-file-limits.mjs"],
      [new URL("../../utils/image-signature.mjs", import.meta.url), "image-signature.mjs"]] as const)
      await fs.copyFile(fileURLToPath(url), path.join(this.tools, name), fs.constants.COPYFILE_EXCL);
    await fs.writeFile(path.join(this.tools, "package.json"), '{"type":"module"}', { flag: "wx" });
    await fs.writeFile(path.join(this.tools, "powershell.config.json"), '{"DisableImplicitWinCompat":true}', { flag: "wx" });
    const settings = { ...this.options.settings, exclude: [...(this.options.settings?.exclude ?? []), ...(this.options.directories ?? [])] };
    let toolchains = new SandboxToolchains({ cwd: this.workspace(), settings, powershellPath: this.options.powershellPath });
    const discovery = await this.runner.run(toolchains.hostShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HOST_PATH_QUERY, "utf16le").toString("base64")],
      this.workspace(), { ...process.env, TEMP: this.temporary, TMP: this.temporary, TMPDIR: this.temporary }, signal, 15000);
    need(discovery.code === 0 && !discovery.timedOut && !discovery.truncated, "PowerShell 7 PATH refresh failed: " + discovery.stderr);
    const environment = refreshedHostEnvironment(process.env, JSON.parse(Buffer.from(discovery.stdout.trim(), "base64").toString("utf8")));
    this.toolchains = toolchains = new SandboxToolchains({ cwd: this.workspace(), settings, powershellPath: this.options.powershellPath, environment });
    this.environment = { ...toolchains.environment, SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
      COMSPEC: path.join(process.env.SystemRoot!, "System32", "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: this.temporary, HOME: this.temporary, LOCALAPPDATA: this.temporary, APPDATA: this.temporary,
      TMP: this.temporary, TEMP: this.temporary, TMPDIR: this.temporary };
    const config = await this.policy(this.workspace(), signal);
    const probe = await this.runner.run(this.executable, ["--probe", config], this.workspace(), this.executorEnvironment(), signal, 15000);
    need(probe.code === 0 && !probe.truncated && !probe.timedOut, "MXC probe failed: " + probe.stderr);
    const result = JSON.parse(probe.stdout);
    need(!result.error && result.tier === "base-container" && result.needsDaclAugmentation === false, "Native MXC isolation unavailable; no DACL, VM or host fallback"); this.starts++;
  }
  private executorEnvironment(): NodeJS.ProcessEnv { return { ...this.environment, MXC_DACL_STATE_DIR: this.state }; }
  private async policy(cwd: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); this.toolchains!.assertCurrent();
    const read = [...this.toolchains!.mountRoots, this.tools!, ...await canonicalWorkspaceMetadata(this.roots)];
    if (this.mode === "read-only") read.push(...this.roots);
    const write = [this.temporary!, this.exchange!]; if (this.mode === "sandbox-write") write.push(...this.roots);
    const queries = new Set<string>();
    const grants = [...read, ...write];
    for (const root of grants) for (let parent = path.dirname(root);;) {
      let granted = false;
      for (const existing of grants) if (containsDirectory(existing, parent)) { granted = true; break; }
      // Equal-path enumeration can replace a content grant in MXC's native list.
      if (!granted) queries.add(parent);
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    }
    const env = []; for (const [key, value] of Object.entries(this.environment!)) if (value !== undefined) env.push(key + "=" + value);
    const access = this.networkEnabled ? "allow" : "deny";
    const policy = { version: "1.0.0", containment: "processcontainer", containerId: path.basename(this.root!),
      fallback: { allowDaclMutation: false }, telemetry: { enabled: false }, lifecycle: { destroyOnExit: true, preservePolicy: false },
      process: { commandLine: "node --version", cwd, timeout: 120000, inheritDefaultEnv: false, env },
      filesystem: { readonlyPaths: read, readwritePaths: write, deniedPaths: [] },
      network: { egress: { default: access }, ingress: { default: access, hostLoopback: access } },
      ui: { disable: false, clipboard: "all", injection: false }, processContainer: { capabilities: ["registryRead"], filesystem: { enumeratePaths: [...queries] },
        ui: { isolation: "desktop", desktopSystemControl: false, systemSettings: "none", ime: false } } };
    const file = path.join(this.tools!, "policy.json"); await fs.writeFile(file, JSON.stringify(policy)); return file;
  }
  private async run(operation: string, input: Record<string, unknown>, signal: AbortSignal): Promise<WorkspaceReply> {
    signal.throwIfAborted();
    input = workspaceInput(this.workspace(), operation, input, this.options.directories ?? []);
    if (!this.starts) {
      try { await this.start(signal); }
      catch (error) {
        if (signal.aborted && error === signal.reason && !this.shutdown.signal.aborted) {
          try { await this.releaseResources(); }
          catch (cleanupError) { this.closed = true; throw cleanupError; }
        } else this.closed = true;
        throw error;
      }
    }
    await this.assertWorkspaceCurrent(); signal.throwIfAborted();
    const id = randomUUID().replaceAll("-", ""), shell = operation === "powershell";
    const root = this.workspace(input.workspaceIndex as number | undefined);
    const cwd = shell ? path.resolve(root, typeof input.cwd === "string" ? input.cwd : ".") : root;
    const canonicalCwd = await fs.realpath(cwd); need(containsDirectory(root, canonicalCwd), "Command cwd leaves its workspace");
    const policy = await this.policy(canonicalCwd, signal); let args: string[], timeout = 30000;
    if (shell) {
      need(typeof input.command === "string" && input.command.length <= 32768, "Invalid command");
      if (input.timeout !== undefined) need(typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 && input.timeout <= 120, "Invalid timeout");
      timeout = input.timeout === undefined ? 30000 : Number(input.timeout) * 1000;
      const script = path.join(this.tools!, "command.ps1");
      await fs.writeFile(script, POWERSHELL_UTF8 + input.command, "utf8");
      args = [this.toolchains!.hostShell, "-NoLogo", "-NoProfile", "-NonInteractive", "-SettingsFile", path.join(this.tools!, "powershell.config.json"),
        "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-Command", "& ([ScriptBlock]::Create([IO.File]::ReadAllText('" + script.replaceAll("'", "''") + "')))"];
    } else {
      const request = JSON.stringify({ id, mode: this.mode, workspaces: this.roots, operation, input, exchange: this.exchange, maxWriteBytes: MAX_WRITE_BYTES });
      need(Buffer.byteLength(request) <= 4 * 1024 * 1024, "Request too large");
      const file = path.join(this.tools!, "request.json"); await fs.writeFile(file, request); args = [process.execPath, path.join(this.tools!, "worker.mjs"), file];
    }
    this.calls++;
    const result = await this.runner.run(this.executable!, [policy, "--", ...args], canonicalCwd, this.executorEnvironment(), signal, timeout, shell ? COMMAND_OUTPUT_BYTES : FILE_PROTOCOL_LIMIT);
    if (shell) return { id, ok: !result.timedOut, phase: "execution", error: result.timedOut ? "Command timed out; completed effects are not rolled back" : undefined,
      text: (result.stdout + (result.stderr ? "\n" + result.stderr : "") || "(no output)") + (result.truncated ? "\n[Output tail truncated]" : ""),
      execution: { exitCode: result.code, timedOut: result.timedOut, closed: true, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated } };
    need(!result.timedOut && !result.truncated && !result.stderr, "File worker failed: " + result.stderr);
    let reply: WorkspaceReply;
    try { reply = JSON.parse(result.stdout); } catch { throw new Error("[SANDBOX_MXC] Incomplete file result: " + result.stdout.slice(0, 2000)); }
    need(reply && typeof reply === "object" && reply.id === id && typeof reply.ok === "boolean", "File result identity mismatch");
    if (!reply.ok) throw new WorkspaceOperationError(reply);
    need(result.code === 0 && typeof reply.text === "string", "Invalid file result");
    validateFileFacts(reply, operation, input);
    if (reply.image) { need(operation === "read" && reply.image.artifact.name === id + "-0.bin", "Unexpected image artifact"); this.artifacts.add(reply.image.artifact.name); }
    return reply;
  }
  async assertWorkspaceCurrent(): Promise<void> {
    for (let index = 0; index < this.roots.length; index++) {
      const original = index ? this.options.directories![index - 1] : this.cwd;
      const canonical = await fs.realpath(original), stat = await fs.lstat(canonical, { bigint: true });
      need(canonical === this.roots[index] && stat.dev + ":" + stat.ino === this.identities[index], "Workspace directory identity changed");
    }
  }
  async candidate(artifact: WorkspaceArtifact): Promise<Buffer> {
    need(this.exchange && this.artifacts.has(artifact.name) && ARTIFACT_NAME.test(artifact.name)
      && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= IMAGE_LIMIT, "Invalid image artifact");
    const file = path.join(this.exchange, artifact.name), stat = await fs.lstat(file, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === BigInt(artifact.bytes) && await fs.realpath(file) === file, "Image artifact changed");
    const handle = await fs.open(file, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      need(opened.dev === stat.dev && opened.ino === stat.ino && opened.size === stat.size && opened.nlink === 1n, "Image artifact changed");
      const bytes = Buffer.allocUnsafe(artifact.bytes); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        need(read.bytesRead > 0, "Incomplete image artifact"); offset += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      need(after.size === opened.size && after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs
        && createHash("sha256").update(bytes).digest("hex") === artifact.sha256, "Image artifact hash mismatch"); return bytes;
    } finally { await handle.close(); }
  }
  async releaseArtifact(artifact: WorkspaceArtifact): Promise<void> {
    need(this.exchange && this.artifacts.has(artifact.name) && ARTIFACT_NAME.test(artifact.name), "Unknown image artifact");
    await fs.unlink(path.join(this.exchange, artifact.name)); this.artifacts.delete(artifact.name);
  }
  async drain(): Promise<void> { try { await this.pending; } catch { /* original caller owns its failure */ } }
  close(): Promise<void> { this.closed = true; this.shutdown.abort(); return this.closeOperation ??= this.performClose().catch(this.closeFailed); }
  private readonly closeFailed = (error: unknown): never => { this.closeOperation = undefined; throw error; };
  private async performClose(): Promise<void> {
    await this.drain();
    await this.releaseResources();
  }
  private async releaseResources(): Promise<void> {
    this.runner.assertStopped();
    if (this.root) {
      const stat = await fs.lstat(this.root, { bigint: true });
      need(!stat.isSymbolicLink() && stat.dev + ":" + stat.ino === this.identity && await fs.realpath(this.root) === this.root, "Owned cleanup root changed");
      await fs.rm(this.root, { recursive: true }); // Node removes child links themselves, never their targets.
    }
    this.root = undefined; this.identity = undefined; this.tools = undefined; this.exchange = undefined; this.temporary = undefined; this.state = undefined;
    this.toolchains = undefined; this.environment = undefined; this.artifacts.clear(); this.roots.length = 0; this.identities.length = 0;
  }
}
