import fs from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { MAX_WRITE_BYTES } from "../files/write-limits.ts";
import { parseSandboxNetwork, type SandboxNetwork, type SandboxNetworkSession } from "./network-policy.ts";
import { workspaceInput } from "./workspace-paths.ts";
import { HOST_PATH_QUERY, refreshedHostEnvironment } from "./host-path.ts";
import { isVmPrivateName, isVmPrivateDirectory, isVmPrivatePath, parseSandboxPrivateDirectories } from "./workspace-policy.mjs";

export interface WorkspaceSandboxOptions {
  settings?: { include?: string[]; exclude?: string[] };
  powershellPath?: string;
  network?: SandboxNetwork;
  /** Session-level consent that turns networking on for later VMs (R5). */
  networkSession?: SandboxNetworkSession;
  directories?: readonly string[];
  privateDirectories?: readonly string[];
}

export interface WorkspaceArtifact { name: string; bytes: number; sha256: string; }
export interface WorkspaceChange { path: string; before: string | null; content: string | null; workspaceIndex?: number; artifact?: WorkspaceArtifact; }
export interface WorkspaceReply { id: string; ok: boolean; text?: string; snapshot?: string; changes?: WorkspaceChange[]; error?: string;
  noEffects?: boolean;
  image?: { mimeType: string; artifact: WorkspaceArtifact };
  phase?: string; execution?: { exitCode: number; timedOut: boolean; closed: boolean; stdout: string; stderr: string; truncated?: boolean }; }
export class WorkspaceOperationError extends Error {
  readonly reply: WorkspaceReply;
  constructor(reply: WorkspaceReply) { super("[SANDBOX_" + (reply.phase ?? "OPERATION").toUpperCase() + "] " + reply.error
    + (reply.execution ? "\nCommand exit=" + reply.execution.exitCode + "; timedOut=" + reply.execution.timedOut + "\n" + reply.execution.stdout + reply.execution.stderr : "")); this.reply = reply; }
}
/** A command names a host path the VM cannot see (R5): stopped before it runs, with no effects. */
export class WorkspacePathStop extends WorkspaceOperationError {
  readonly hostPath: string;
  constructor(id: string, hostPath: string) {
    super({ id, ok: false, phase: "request", noEffects: true, error: "Host path is not mapped into the sandbox: " + hostPath });
    this.hostPath = hostPath;
  }
}
/** Where a host path is inside the VM (R5 diagnostics). */
export const HOST_PATH_WORKSPACE = 0, HOST_PATH_TOOL = 1, HOST_PATH_VM = 2, HOST_PATH_HOST_SYSTEM = 3, HOST_PATH_HOST_ONLY = 4, HOST_PATH_MISSING = 5;
/** The VM's own Windows directories; Program Files and ProgramData exist there too, with other contents. */
const VM_SYSTEM_ROOTS = Object.freeze(["c:\\windows"]);
const VM_SHARED_ROOTS = Object.freeze(["c:\\program files", "c:\\program files (x86)", "c:\\programdata"]);
function withinKey(key: string, root: string): boolean {
  return key === root || key.length > root.length && key.startsWith(root) && key.charCodeAt(root.length) === 92;
}
const ARTIFACT_NAME = /^[a-f0-9]{32}-[0-9]{1,4}\.bin$/;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error("[SANDBOX_WORKSPACE] " + reason); }
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One lazy VM per permission generation. Only proven no-effects failures retain its snapshot. */
export class WorkspaceSandboxBackend {
  private root?: string;
  private identity?: string;
  private vm: any;
  private compiler: any;
  private pending?: Promise<WorkspaceReply>;
  private discardOperation?: Promise<void>;
  private closeOperation?: Promise<void>;
  private closed = false;
  private cleanupFailure?: string;
  private readonly owned = new Map<string, string>();
  private readonly sources = new Map<string, { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; sha256: string }>();
  private sourceRoot?: string;
  private sourceIdentity?: string;
  private readonly directoryIdentities = new Map<string, string>();
  private starts = 0;
  private calls = 0;
  private capturedEntries = 0;
  private capturedBytes = 0;
  private readonly cwd: string;
  private readonly parent: string;
  private readonly mode: "read-only" | "sandbox-write";
  private readonly toolchainOptions: WorkspaceSandboxOptions;
  private readonly network: SandboxNetwork;
  private vmNetwork = false;
  /** Lower-case host roots of the current VM's read-only tool mounts. */
  private toolRoots: readonly string[] = [];
  private readonly privateDirectories: readonly string[];
  /** Lower-case primary and added workspace roots. */
  private readonly workspaceKeys: string[] = [];
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write", toolchainOptions: WorkspaceSandboxOptions = {}) {
    this.cwd = path.resolve(cwd); this.parent = parent; this.mode = mode; this.toolchainOptions = toolchainOptions;
    this.network = parseSandboxNetwork(toolchainOptions.network);
    this.privateDirectories = parseSandboxPrivateDirectories(toolchainOptions.privateDirectories);
    this.workspaceKeys.push(this.cwd.toLowerCase());
    for (const directory of toolchainOptions.directories ?? []) this.workspaceKeys.push(path.resolve(directory).toLowerCase());
  }
  get diagnostics() { return { starts: this.starts, calls: this.calls, pending: !!this.pending, vm: !!this.vm, root: this.root, closed: this.closed, sourceFiles: this.sources.size, ownedArtifacts: this.owned.size }; }
  /** Global setting or this session's consent. */
  get networkEnabled(): boolean { return this.network === "enabled" || this.toolchainOptions.networkSession?.enabled === true; }
  /** Record the session's consent; a running offline VM is closed so the next call starts one with networking. */
  async enableSessionNetwork(): Promise<void> {
    const session = this.toolchainOptions.networkSession;
    need(session && !this.pending, "Session network consent is unavailable while an operation is active");
    session.enabled = true;
    if (this.vm && !this.vmNetwork) await this.discardSnapshot();
  }
  /** Where `candidate` (a static absolute drive path) is inside the VM; host access is one lstat and one realpath. */
  async hostPathKind(candidate: string): Promise<number> {
    const resolved = path.resolve(candidate);
    let kind = this.lexicalPathKind(resolved.toLowerCase());
    if (kind === HOST_PATH_WORKSPACE || kind === HOST_PATH_TOOL || kind === HOST_PATH_VM) return kind;
    try { await fs.lstat(resolved); } catch { return HOST_PATH_MISSING; }
    // `C:\Users\ADMINI~1\…` or a link may still name a workspace.
    try { const real = (await fs.realpath(resolved)).toLowerCase(), current = this.lexicalPathKind(real); if (current !== HOST_PATH_HOST_ONLY) kind = current; }
    catch { /* keep the lexical answer */ }
    return kind;
  }
  private lexicalPathKind(key: string): number {
    if (this.sourceRoot && withinKey(key, this.sourceRoot.toLowerCase())) return HOST_PATH_WORKSPACE;
    for (const root of this.workspaceKeys) if (withinKey(key, root)) return HOST_PATH_WORKSPACE;
    for (const root of this.toolRoots) if (withinKey(key, root)) return HOST_PATH_TOOL;
    // A drive root, and a directory holding a workspace or tool mount (`D:\Projects` for `D:\Projects\app`), exist in the VM.
    if (key.length <= 3) return HOST_PATH_VM;
    for (const root of this.workspaceKeys) if (withinKey(root, key)) return HOST_PATH_VM;
    for (const root of this.toolRoots) if (withinKey(root, key)) return HOST_PATH_VM;
    for (const root of VM_SYSTEM_ROOTS) if (withinKey(key, root)) return HOST_PATH_VM;
    for (const root of VM_SHARED_ROOTS) if (withinKey(key, root)) return HOST_PATH_HOST_SYSTEM;
    return HOST_PATH_HOST_ONLY;
  }
  isPrivatePath(name: string): boolean { return isVmPrivatePath(name, this.privateDirectories); }
  workspace(index = 0): string {
    need(Number.isSafeInteger(index) && index >= 0 && index <= (this.toolchainOptions.directories?.length ?? 0), "Unknown workspace identity");
    return index === 0 ? this.cwd : this.toolchainOptions.directories![index - 1];
  }
  private sourceKey(name: string, index = 0): string { return path.resolve(index === 0 ? this.sourceRoot ?? this.cwd : this.workspace(index), name).toLowerCase(); }
  /** `hostPaths`: static absolute paths a command names; one that exists only on the host stops it after the VM starts (R5). */
  invoke(operation: string, input: Record<string, unknown>, signal?: AbortSignal, hostPaths?: readonly string[]): Promise<WorkspaceReply> {
    if (this.closed) return Promise.reject(new Error("[SANDBOX_CLOSED] " + (this.cleanupFailure ?? "Session workspace is closed") + ". Waiting or retrying tools cannot reopen it; retry session shutdown to release retained owners."));
    if (this.pending || this.discardOperation) return Promise.reject(new Error("[SANDBOX_BUSY] Workspace has an active operation or cleanup; wait for that operation to settle"));
    return this.pending = this.run(operation, input, signal, hostPaths).finally(this.releasePending);
  }
  private readonly releasePending = (): void => { this.pending = undefined; };
  private async remember(file: string): Promise<void> {
    const stat = await fs.lstat(file, { bigint: true }); need(!stat.isSymbolicLink(), "Redirected owned artifact");
    this.owned.set(file, stat.dev + ":" + stat.ino);
  }
  private async capture(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const stack = [[source, destination]]; let scratch: Buffer | undefined;
    while (stack.length) {
      signal?.throwIfAborted(); const [from, to] = stack.pop()!;
      await fs.mkdir(to); await this.remember(to);
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        if (isVmPrivateName(entry.name.toLowerCase())) continue;
        if (entry.isDirectory() && isVmPrivateDirectory(path.relative(source, path.join(from, entry.name)), this.privateDirectories)) continue;
        need(++this.capturedEntries <= 20000 && !entry.isSymbolicLink(), "Workspace entry limit or redirected path: " + entry.name);
        const sourcePath = path.join(from, entry.name), target = path.join(to, entry.name);
        if (this.root && (sourcePath === this.root || this.root.startsWith(sourcePath + path.sep))) continue;
        const stat = await fs.lstat(sourcePath, { bigint: true });
        need(!stat.isSymbolicLink() && await fs.realpath(sourcePath) === sourcePath, "Redirected workspace source");
        if (stat.isDirectory()) stack.push([sourcePath, target]);
        else {
          need(stat.isFile() && stat.size <= 8n * 1024n * 1024n * 1024n, "Workspace source exceeds 8 GiB: " + entry.name);
          this.capturedBytes += Number(stat.size); need(this.capturedBytes <= 16 * 1024 * 1024 * 1024, "Workspace snapshot bytes=" + this.capturedBytes + "; limit=17179869184");
          const sourceFile = await fs.open(sourcePath, "r");
          try {
            const before = await sourceFile.stat({ bigint: true });
            need(before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size
              && before.mtimeNs === stat.mtimeNs && before.ctimeNs === stat.ctimeNs, "Source changed before capture");
            // A growing file must not make readFile allocate beyond the admitted size.
            const data = scratch ??= Buffer.allocUnsafe(256 * 1024), digest = createHash("sha256"); let offset = 0;
            const output = await fs.open(target, "wx");
            try {
              await this.remember(target);
              while (offset < Number(before.size)) {
                signal?.throwIfAborted();
                const read = await sourceFile.read(data, 0, Math.min(data.length, Number(before.size) - offset), offset);
                need(read.bytesRead > 0, "Source shortened during capture");
                digest.update(read.bytesRead === data.length ? data : data.subarray(0, read.bytesRead));
                let written = 0;
                while (written < read.bytesRead) {
                  const result = await output.write(data, written, read.bytesRead - written, offset + written);
                  need(result.bytesWritten > 0, "Snapshot write stalled"); written += result.bytesWritten;
                }
                offset += read.bytesRead;
              }
            } finally { await output.close(); }
            const after = await sourceFile.stat({ bigint: true });
            need(before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.size === after.size, "Source changed during capture");
            this.sources.set(sourcePath.toLowerCase(), { dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs, sha256: digest.digest("hex") });
          } finally { await sourceFile.close(); }
        }
      }
    }
  }
  private async start(signal?: AbortSignal): Promise<void> {
    need(process.platform === "win32", "Windows Sandbox is required; no host fallback");
    const packaged = new URL("./windows-runtime/windows-sandbox-lifecycle.mjs", import.meta.url);
    const source = new URL("../../../../../scripts/acceptance/windows-sandbox-lifecycle.mjs", import.meta.url);
    const runtimeUrl = existsSync(fileURLToPath(packaged)) ? packaged : source;
    const runtime = await import(runtimeUrl.href);
    const { SandboxToolchains } = await import(new URL("windows-sandbox-toolchains.mjs", runtimeUrl).href);
    const settings = { ...this.toolchainOptions.settings, exclude: [...(this.toolchainOptions.settings?.exclude ?? []), ...(this.toolchainOptions.directories ?? [])] };
    let toolchains = new SandboxToolchains({ cwd: this.cwd, ...this.toolchainOptions, settings });
    const discovery = this.compiler = new runtime.CapturedProcess(toolchains.hostShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HOST_PATH_QUERY, "utf16le").toString("base64")], this.cwd);
    need(await discovery.wait(15000, signal) === "settled" && runtime.successful(discovery.result), "Host PATH refresh failed; PowerShell 7 query did not settle successfully");
    this.compiler = undefined;
    const persistentPath = JSON.parse(Buffer.from(discovery.result.stdout.trim(), "base64").toString("utf8"));
    const environment = refreshedHostEnvironment(process.env, persistentPath);
    toolchains = new SandboxToolchains({ cwd: this.cwd, ...this.toolchainOptions, settings, environment });
    await toolchains.validateTrees(signal);
    const cli = new runtime.FixedCli();
    await fs.mkdir(this.parent, { recursive: true });
    need(await fs.realpath(this.parent) === path.resolve(this.parent), "Redirected artifact parent");
    this.root = await fs.mkdtemp(path.join(this.parent, "workspace-"));
    const rootStat = await fs.lstat(this.root, { bigint: true }); this.identity = rootStat.dev + ":" + rootStat.ino;
    await this.remember(this.root);
    const tools = path.join(this.root, "tools"), exchange = path.join(this.root, "exchange"), input = path.join(this.root, "input");
    await fs.mkdir(tools); await this.remember(tools); await fs.mkdir(exchange); await this.remember(exchange);
    this.sourceRoot = await fs.realpath(this.cwd);
    const sourceStat = await fs.lstat(this.sourceRoot, { bigint: true }); this.sourceIdentity = sourceStat.dev + ":" + sourceStat.ino;
    await this.capture(this.sourceRoot, input, signal);
    const additionalMappings: [string, string, boolean][] = [];
    for (let i = 0; i < (this.toolchainOptions.directories?.length ?? 0); i++) {
      const directory = this.workspace(i + 1), canonical = await fs.realpath(directory), identity = await fs.lstat(canonical, { bigint: true });
      need(canonical === directory && identity.isDirectory(), "Additional workspace identity changed");
      this.directoryIdentities.set(directory, identity.dev + ":" + identity.ino);
      const captured = path.join(this.root, "input-" + (i + 1)); await this.capture(directory, captured, signal);
      additionalMappings.push([captured, "C:\\SuperPiInput-" + (i + 1), true]);
    }
    const worker = new URL("./workspace-worker.mjs", import.meta.url);
    for (const name of ["core", "core/sandbox", "utils"]) { const directory = path.join(tools, name); await fs.mkdir(directory); await this.remember(directory); }
    for (const [from, name] of [[process.execPath, "node.exe"], [fileURLToPath(worker), "core/sandbox/workspace-worker.mjs"],
      [fileURLToPath(new URL("./workspace-policy.mjs", import.meta.url)), "core/sandbox/workspace-policy.mjs"],
      [fileURLToPath(new URL("../../utils/image-signature.mjs", import.meta.url)), "utils/image-signature.mjs"], [fileURLToPath(new URL("windows-sandbox-task-worker.cs", runtimeUrl)), "command.cs"]]) {
      const bytes = await fs.readFile(from); const target = path.join(tools, name); await fs.writeFile(target, bytes, { flag: "wx" }); await this.remember(target);
      need(hash(await fs.readFile(target)) === hash(bytes), "Tool copy changed");
    }
    const environmentFile = path.join(tools, "environment.txt");
    await fs.writeFile(environmentFile, toolchains.encodedEnvironment, { flag: "wx" }); await this.remember(environmentFile);
    const diagnosticsFile = path.join(tools, "toolchains.json");
    await fs.writeFile(diagnosticsFile, JSON.stringify({ shell: toolchains.shell, statistics: toolchains.statistics, skipped: toolchains.diagnostics }), { flag: "wx" }); await this.remember(diagnosticsFile);
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const compile = this.compiler = new runtime.CapturedProcess(compiler, ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(tools, "command.exe"), path.join(tools, "command.cs")], tools);
    need(await compile.wait(15000) === "settled" && compile.result?.exitCode === 0, "Guest command supervisor compilation failed");
    this.compiler = undefined;
    await this.remember(path.join(tools, "command.exe"));
    const mappings = [[input, "C:\\SuperPiInput", true], [tools, "C:\\SuperPiTools", true], [exchange, "C:\\SuperPiExchange", false]] as const;
    const network = this.networkEnabled;
    let config = "<Configuration><Networking>" + (network ? "Enable" : "Disable") + "</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><vGPU>Disable</vGPU><MemoryInMB>2048</MemoryInMB><MappedFolders>";
    for (const [host, guest, readOnly] of mappings) config += "<MappedFolder><HostFolder>" + xml(host) + "</HostFolder><SandboxFolder>" + guest + "</SandboxFolder><ReadOnly>" + readOnly + "</ReadOnly></MappedFolder>";
    for (const [host, guest] of additionalMappings) config += "<MappedFolder><HostFolder>" + xml(host) + "</HostFolder><SandboxFolder>" + guest + "</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>";
    config += "</MappedFolders></Configuration>";
    config = toolchains.appendConfig(config);
    const roots: string[] = toolchains.mountRoots;
    for (let i = 0; i < roots.length; i++) roots[i] = roots[i]!.toLowerCase();
    this.toolRoots = roots;
    const journal = path.join(this.root, "owner.json"); await fs.writeFile(journal, "{}"); await this.remember(journal);
    this.vm = new runtime.SandboxLifecycle({ cli, config, taskId: randomUUID(), journal(record: unknown) { writeFileSync(journal, JSON.stringify(record)); } });
    await this.vm.start(signal, async (vm: any) => {
      toolchains.assertCurrent();
      return { instanceId: vm.id, config: vm.config, configSha256: vm.configSha256,
        validate(current: any) { toolchains.assertCurrent(); return current === vm && !signal?.aborted; } };
    }); this.starts++; this.vmNetwork = network;
  }
  private async run(operation: string, input: Record<string, unknown>, signal?: AbortSignal, hostPaths?: readonly string[]): Promise<WorkspaceReply> {
    // Argument preparation has not touched the VM, including an already healthy snapshot.
    input = workspaceInput(this.cwd, operation, input, this.toolchainOptions.directories);
    const id = randomUUID().replaceAll("-", "");
    const request = JSON.stringify({ id, mode: this.mode, workspace: this.cwd, directories: this.toolchainOptions.directories ?? [],
      privateDirectories: this.privateDirectories, operation, input, maxWriteBytes: MAX_WRITE_BYTES }); need(Buffer.byteLength(request) <= 4 * 1024 * 1024, "Request too large");
    try {
      signal?.throwIfAborted(); if (!this.vm) await this.start(signal); signal?.throwIfAborted();
      await this.assertWorkspaceCurrent();
      // Tool mounts are known only once the VM started; a stopped command leaves it running.
      if (hostPaths) for (const candidate of hostPaths) if (await this.hostPathKind(candidate) === HOST_PATH_HOST_ONLY) throw new WorkspacePathStop(id, path.resolve(candidate));
      signal?.throwIfAborted();
      const exchange = path.join(this.root!, "exchange");
      await fs.writeFile(path.join(exchange, "request.json"), request); this.calls++;
      await this.vm.invoke("exec", ["exec", "--id", this.vm.id, "-c", '"C:\\SuperPiTools\\node.exe" "C:\\SuperPiTools\\core\\sandbox\\workspace-worker.mjs"', "-d", "C:\\SuperPiTools", "-r", "System", "--raw"], 150000, signal);
      // Only settled command records are compacted. Physical owners stay in the lifecycle slots.
      if (this.vm.calls.length > 16) { this.vm.calls.copyWithin(0, this.vm.calls.length - 16); this.vm.calls.length = 16; this.vm.save(); }
      signal?.throwIfAborted();
      const resultFile = path.join(exchange, "response.json"), stat = await fs.lstat(resultFile);
      need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 24 * 1024 * 1024, "Invalid guest response");
      const reply: WorkspaceReply = JSON.parse(await fs.readFile(resultFile, "utf8"));
      need(reply && reply.id === id && typeof reply.ok === "boolean", "Response identity mismatch");
      need(reply.text === undefined || typeof reply.text === "string", "Invalid guest output text");
      if (reply.execution) need(Number.isSafeInteger(reply.execution.exitCode) && typeof reply.execution.timedOut === "boolean"
        && typeof reply.execution.closed === "boolean" && typeof reply.execution.stdout === "string" && reply.execution.stdout.length <= 32768
        && typeof reply.execution.stderr === "string" && reply.execution.stderr.length <= 32768, "Invalid command execution facts");
      if (!reply.ok) {
        if (reply.noEffects === true) need((reply.phase === "request" || reply.phase === "read") && !reply.execution
          && reply.changes === undefined && reply.image === undefined, "Invalid no-effects outcome");
        throw new WorkspaceOperationError(reply);
      }
      if (reply.image !== undefined) need(operation === "read" && !reply.execution && reply.changes?.length === 0
        && reply.image?.artifact?.name === id + "-0.bin", "Unexpected read attachment");
      if (reply.execution && Array.isArray(reply.changes)) for (const change of reply.changes) {
        need(typeof change.path === "string", "Invalid candidate path");
        const baseline = this.sources.get(this.sourceKey(change.path, change.workspaceIndex));
        need(change.artifact || baseline, "Deletion has no captured baseline");
        change.before = baseline?.sha256 ?? null;
      }
      return reply;
    } catch (error) {
      if (error instanceof WorkspaceOperationError && error.reply.noEffects === true) throw error;
      try { await this.discardSnapshot(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Sandbox operation failed: " + String(error).slice(0, 2048) + "\nCleanup remains unresolved: " + String(cleanupError).slice(0, 2048)); }
      throw error;
    }
  }
  private async closeVm(): Promise<void> {
    if (this.vm) {
      await this.vm.cleanup(true);
      need((this.vm.state === "closed" || this.vm.state === "closed-before-start") && !this.vm.active && !this.vm.execution && !this.vm.connection,
        "Sandbox cleanup unresolved; state=" + this.vm.state + "; " + (this.vm.cleanupError ?? "physical owner still pending") + "; journal=" + this.root + path.sep + "owner.json");
      this.vm = undefined;
    }
  }
  /** Called after a settled invocation/publication failure. A later call captures a fresh workspace. */
  discardSnapshot(): Promise<void> {
    return this.discardOperation ??= this.performDiscardSnapshot();
  }
  private async performDiscardSnapshot(): Promise<void> {
    try { await this.closeVm(); await this.releaseArtifacts(); }
    catch (error) { this.closed = true; this.cleanupFailure = String(error).slice(0, 2048); throw error; }
    finally { this.discardOperation = undefined; }
  }
  async drain(): Promise<void> { try { await this.pending; } catch { /* original caller owns its failure */ } }
  async assertWorkspaceCurrent(): Promise<void> {
    need(this.sourceRoot, "Workspace source not captured");
    const canonical = await fs.realpath(this.cwd), stat = await fs.lstat(canonical, { bigint: true });
    need(canonical === this.sourceRoot && stat.dev + ":" + stat.ino === this.sourceIdentity, "Original workspace directory changed");
    for (const [directory, identity] of this.directoryIdentities) {
      const current = await fs.lstat(directory, { bigint: true });
      need(current.dev + ":" + current.ino === identity && await fs.realpath(directory) === directory, "Additional workspace directory changed");
    }
  }
  assertSourceVersion(name: string, current: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, workspaceIndex = 0): void {
    need(this.sourceRoot, "Workspace source not captured");
    const before = this.sources.get(this.sourceKey(name, workspaceIndex));
    need(before && before.dev === current.dev && before.ino === current.ino && before.size === current.size && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs, "Original source identity changed");
  }
  async recordPublication(name: string, deleted: boolean, workspaceIndex = 0, publishedHash?: string): Promise<void> {
    need(this.sourceRoot, "Workspace source not captured");
    const target = path.resolve(this.workspace(workspaceIndex), name), key = this.sourceKey(name, workspaceIndex);
    if (deleted) this.sources.delete(key);
    else { const stat = await fs.lstat(target, { bigint: true }); need(publishedHash, "Published content hash required");
      this.sources.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, sha256: publishedHash }); }
  }
  async candidate(artifact: WorkspaceArtifact, retain: boolean): Promise<Buffer | undefined> {
    need(this.root && ARTIFACT_NAME.test(artifact.name) && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= 64 * 1024 * 1024, "Invalid artifact envelope");
    const file = path.join(this.root, "exchange", artifact.name), stat = await fs.lstat(file, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === BigInt(artifact.bytes) && await fs.realpath(file) === file, "Redirected or resized artifact");
    const handle = await fs.open(file, "r"), buffer = Buffer.allocUnsafe(retain ? artifact.bytes : Math.min(256 * 1024, artifact.bytes));
    try {
      const before = await handle.stat({ bigint: true }); need(before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size, "Artifact identity changed");
      const digest = createHash("sha256"); let position = 0;
      while (position < artifact.bytes) {
        const start = retain ? position : 0, count = Math.min(buffer.length - start, artifact.bytes - position);
        const read = await handle.read(buffer, start, count, position); need(read.bytesRead > 0, "Artifact shortened");
        if (!retain) digest.update(read.bytesRead === buffer.length ? buffer : buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
      }
      if (retain) digest.update(buffer);
      const after = await handle.stat({ bigint: true });
      need(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && digest.digest("hex") === artifact.sha256, "Artifact changed or hash mismatch");
      return retain ? buffer : undefined;
    } finally { await handle.close(); }
  }
  async releaseCandidates(changes: readonly WorkspaceChange[]): Promise<void> {
    for (const change of changes) if (change.artifact) await this.releaseArtifact(change.artifact);
  }
  async releaseArtifact(artifact: WorkspaceArtifact): Promise<void> {
    need(this.root && ARTIFACT_NAME.test(artifact.name), "Invalid artifact release");
    const file = path.join(this.root, "exchange", artifact.name), stat = await fs.lstat(file);
    need(stat.isFile() && !stat.isSymbolicLink() && await fs.realpath(file) === file, "Redirected artifact release");
    await fs.unlink(file);
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closeOperation ??= this.performClose();
  }
  private async performClose(): Promise<void> {
    // Callers revoke the execution boundary before joining this owner.
    try { await this.pending; } catch { /* original caller owns the failure */ }
    try { await this.discardSnapshot(); }
    catch (error) {
      // Keep unresolved owners available to a later explicit cleanup retry.
      this.closeOperation = undefined;
      throw error;
    }
  }
  private async releaseArtifacts(): Promise<void> {
    if (this.compiler) { need(await this.compiler.wait(15000) === "settled", "Compiler still active; original owner retained"); this.compiler = undefined; }
    if (!this.root) return;
    const stat = await fs.lstat(this.root, { bigint: true });
    need(stat.dev + ":" + stat.ino === this.identity && await fs.realpath(this.root) === this.root, "Cleanup root identity changed");
    const exchange = path.join(this.root, "exchange");
    const expected = new Set(["request.json", "response.json", "command.txt", "command-result.json"]);
    if (existsSync(exchange)) for (const name of await fs.readdir(exchange)) {
      need(expected.has(name) || ARTIFACT_NAME.test(name), "Unknown guest artifact retained: " + name);
      const file = path.join(exchange, name), current = await fs.lstat(file); need(current.isFile() && !current.isSymbolicLink(), "Redirected guest artifact retained"); await fs.unlink(file);
    }
    const paths = Array.from(this.owned.keys()).sort((a, b) => b.length - a.length);
    for (const file of paths) {
      const current = await fs.lstat(file, { bigint: true }); need(current.dev + ":" + current.ino === this.owned.get(file) && !current.isSymbolicLink(), "Owned artifact changed");
      if (current.isDirectory()) await fs.rmdir(file); else await fs.unlink(file);
      this.owned.delete(file);
    }
    this.owned.clear(); this.sources.clear(); this.directoryIdentities.clear(); this.capturedEntries = 0; this.capturedBytes = 0;
    this.sourceRoot = undefined; this.sourceIdentity = undefined; this.root = undefined; this.identity = undefined;
  }
}
