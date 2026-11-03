import fs from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

export interface WorkspaceChange { path: string; before: string | null; content: string | null; }
export interface WorkspaceReply { id: string; ok: boolean; text?: string; snapshot?: string; changes?: WorkspaceChange[]; error?: string; }
const EXCLUDED = new Set([".git", ".sp", ".artifacts", ".codegraph", "node_modules"]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error("[SANDBOX_WORKSPACE] " + reason); }
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One lazy VM at a time per permission generation. Failed snapshots are discarded, never replayed. */
export class WorkspaceSandboxBackend {
  private root?: string;
  private identity?: string;
  private vm: any;
  private compiler: any;
  private pending?: Promise<WorkspaceReply>;
  private closed = false;
  private readonly owned = new Map<string, string>();
  private readonly sources = new Map<string, { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }>();
  private sourceRoot?: string;
  private sourceIdentity?: string;
  private starts = 0;
  private calls = 0;
  private readonly cwd: string;
  private readonly parent: string;
  private readonly mode: "read-only" | "sandbox-write";
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write") { this.cwd = cwd; this.parent = parent; this.mode = mode; }
  get diagnostics() { return { starts: this.starts, calls: this.calls, pending: !!this.pending, vm: !!this.vm, root: this.root, closed: this.closed, sourceFiles: this.sources.size, ownedArtifacts: this.owned.size }; }
  invoke(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkspaceReply> {
    if (this.closed || this.pending) return Promise.reject(new Error("[SANDBOX_BUSY] Workspace is closed or has an active operation"));
    return this.pending = this.run(operation, input, signal).finally(this.releasePending);
  }
  private readonly releasePending = (): void => { this.pending = undefined; };
  private async remember(file: string): Promise<void> {
    const stat = await fs.lstat(file, { bigint: true }); need(!stat.isSymbolicLink(), "Redirected owned artifact");
    this.owned.set(file, stat.dev + ":" + stat.ino);
  }
  private async capture(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const stack = [[source, destination]]; let count = 0, bytes = 0;
    while (stack.length) {
      signal?.throwIfAborted(); const [from, to] = stack.pop()!;
      await fs.mkdir(to); await this.remember(to);
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name.toLowerCase())) continue;
        need(++count <= 20000 && !entry.isSymbolicLink(), "Workspace entry limit or redirected path: " + entry.name);
        const sourcePath = path.join(from, entry.name), target = path.join(to, entry.name);
        if (this.root && (sourcePath === this.root || this.root.startsWith(sourcePath + path.sep))) continue;
        const stat = await fs.lstat(sourcePath, { bigint: true });
        need(!stat.isSymbolicLink() && await fs.realpath(sourcePath) === sourcePath, "Redirected workspace source");
        if (stat.isDirectory()) stack.push([sourcePath, target]);
        else {
          need(stat.isFile() && stat.size <= 64n * 1024n * 1024n, "Workspace file exceeds 64 MiB: " + entry.name);
          bytes += Number(stat.size); need(bytes <= 256 * 1024 * 1024, "Workspace snapshot exceeds 256 MiB");
          const sourceFile = await fs.open(sourcePath, "r");
          try {
            const before = await sourceFile.stat({ bigint: true });
            need(before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size
              && before.mtimeNs === stat.mtimeNs && before.ctimeNs === stat.ctimeNs, "Source changed before capture");
            // A growing file must not make readFile allocate beyond the admitted size.
            const data = Buffer.allocUnsafe(Number(before.size)); let offset = 0;
            while (offset < data.length) {
              signal?.throwIfAborted();
              const read = await sourceFile.read(data, offset, data.length - offset, offset);
              need(read.bytesRead > 0, "Source shortened during capture"); offset += read.bytesRead;
            }
            const after = await sourceFile.stat({ bigint: true });
            need(before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.size === after.size, "Source changed during capture");
            const output = await fs.open(target, "wx");
            try { await this.remember(target); await output.writeFile(data); } finally { await output.close(); }
            this.sources.set(path.relative(this.sourceRoot!, sourcePath).replaceAll("\\", "/").toLowerCase(), { dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs });
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
    const worker = new URL("./workspace-worker.mjs", import.meta.url);
    for (const [from, name] of [[process.execPath, "node.exe"], [fileURLToPath(worker), "worker.mjs"], [fileURLToPath(new URL("windows-sandbox-task-worker.cs", runtimeUrl)), "command.cs"]]) {
      const bytes = await fs.readFile(from); const target = path.join(tools, name); await fs.writeFile(target, bytes, { flag: "wx" }); await this.remember(target);
      need(hash(await fs.readFile(target)) === hash(bytes), "Tool copy changed");
    }
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const compile = this.compiler = new runtime.CapturedProcess(compiler, ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(tools, "command.exe"), path.join(tools, "command.cs")], tools);
    need(await compile.wait(15000) === "settled" && compile.result?.exitCode === 0, "Guest command supervisor compilation failed");
    this.compiler = undefined;
    await this.remember(path.join(tools, "command.exe"));
    const mappings = [[input, "C:\\SuperPiInput", true], [tools, "C:\\SuperPiTools", true], [exchange, "C:\\SuperPiExchange", false]] as const;
    let config = "<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><vGPU>Disable</vGPU><MemoryInMB>2048</MemoryInMB><MappedFolders>";
    for (const [host, guest, readOnly] of mappings) config += "<MappedFolder><HostFolder>" + xml(host) + "</HostFolder><SandboxFolder>" + guest + "</SandboxFolder><ReadOnly>" + readOnly + "</ReadOnly></MappedFolder>";
    config += "</MappedFolders></Configuration>";
    const journal = path.join(this.root, "owner.json"); await fs.writeFile(journal, "{}"); await this.remember(journal);
    this.vm = new runtime.SandboxLifecycle({ cli, config, taskId: randomUUID(), journal(record: unknown) { writeFileSync(journal, JSON.stringify(record)); } });
    await this.vm.start(signal); this.starts++;
  }
  private async run(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkspaceReply> {
    try {
      signal?.throwIfAborted(); if (!this.vm) await this.start(signal); signal?.throwIfAborted();
      await this.assertWorkspaceCurrent();
      const id = randomUUID().replaceAll("-", ""), exchange = path.join(this.root!, "exchange");
      const request = JSON.stringify({ id, mode: this.mode, operation, input }); need(Buffer.byteLength(request) <= 4 * 1024 * 1024, "Request too large");
      await fs.writeFile(path.join(exchange, "request.json"), request); this.calls++;
      await this.vm.invoke("exec", ["exec", "--id", this.vm.id, "-c", '"C:\\SuperPiTools\\node.exe" "C:\\SuperPiTools\\worker.mjs"', "-d", "C:\\SuperPiTools", "-r", "System", "--raw"], 150000, signal);
      // Only settled command records are compacted. Physical owners stay in the lifecycle slots.
      if (this.vm.calls.length > 16) { this.vm.calls.copyWithin(0, this.vm.calls.length - 16); this.vm.calls.length = 16; this.vm.save(); }
      signal?.throwIfAborted();
      const resultFile = path.join(exchange, "response.json"), stat = await fs.lstat(resultFile);
      need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 24 * 1024 * 1024, "Invalid guest response");
      const reply: WorkspaceReply = JSON.parse(await fs.readFile(resultFile, "utf8"));
      need(reply && reply.id === id && typeof reply.ok === "boolean", "Response identity mismatch");
      need(reply.text === undefined || typeof reply.text === "string", "Invalid guest output text");
      if (!reply.ok) throw new Error(reply.error || "Guest operation failed");
      return reply;
    } catch (error) {
      try { await this.discardSnapshot(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Sandbox operation failed and cleanup remains unresolved"); }
      throw error;
    }
  }
  private async closeVm(): Promise<void> {
    if (this.vm) { await this.vm.cleanup(); need(this.vm.state === "closed", "Sandbox cleanup unresolved"); this.vm = undefined; }
  }
  /** Called after a settled invocation/publication failure. A later call captures a fresh workspace. */
  async discardSnapshot(): Promise<void> {
    try { await this.closeVm(); await this.releaseArtifacts(); }
    catch (error) { this.closed = true; throw error; }
  }
  async drain(): Promise<void> { try { await this.pending; } catch { /* original caller owns its failure */ } }
  async assertWorkspaceCurrent(): Promise<void> {
    need(this.sourceRoot, "Workspace source not captured");
    const canonical = await fs.realpath(this.cwd), stat = await fs.lstat(canonical, { bigint: true });
    need(canonical === this.sourceRoot && stat.dev + ":" + stat.ino === this.sourceIdentity, "Original workspace directory changed");
  }
  assertSourceVersion(name: string, current: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): void {
    need(this.sourceRoot, "Workspace source not captured");
    const before = this.sources.get(name.replaceAll("\\", "/").toLowerCase());
    need(before && before.dev === current.dev && before.ino === current.ino && before.size === current.size && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs, "Original source identity changed");
  }
  async recordPublication(name: string, deleted: boolean): Promise<void> {
    need(this.sourceRoot, "Workspace source not captured");
    const key = name.replaceAll("\\", "/").toLowerCase();
    if (deleted) this.sources.delete(key);
    else { const stat = await fs.lstat(path.resolve(this.sourceRoot, name), { bigint: true }); this.sources.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }); }
  }
  async close(): Promise<void> {
    this.closed = true;
    // Callers revoke the execution boundary before joining this owner.
    try { await this.pending; } catch { /* original caller owns the failure */ }
    await this.discardSnapshot();
  }
  private async releaseArtifacts(): Promise<void> {
    if (this.compiler) { need(await this.compiler.wait(15000) === "settled", "Compiler still active; original owner retained"); this.compiler = undefined; }
    if (!this.root) return;
    const stat = await fs.lstat(this.root, { bigint: true });
    need(stat.dev + ":" + stat.ino === this.identity && await fs.realpath(this.root) === this.root, "Cleanup root identity changed");
    const exchange = path.join(this.root, "exchange");
    const expected = new Set(["request.json", "response.json", "command.txt", "command-result.json"]);
    if (existsSync(exchange)) for (const name of await fs.readdir(exchange)) {
      need(expected.has(name), "Unknown guest artifact retained: " + name);
      const file = path.join(exchange, name), current = await fs.lstat(file); need(current.isFile() && !current.isSymbolicLink(), "Redirected guest artifact retained"); await fs.unlink(file);
    }
    const paths = Array.from(this.owned.keys()).sort((a, b) => b.length - a.length);
    for (const file of paths) {
      const current = await fs.lstat(file, { bigint: true }); need(current.dev + ":" + current.ino === this.owned.get(file) && !current.isSymbolicLink(), "Owned artifact changed");
      if (current.isDirectory()) await fs.rmdir(file); else await fs.unlink(file);
      this.owned.delete(file);
    }
    this.owned.clear(); this.sources.clear(); this.sourceRoot = undefined; this.sourceIdentity = undefined; this.root = undefined; this.identity = undefined;
  }
}
