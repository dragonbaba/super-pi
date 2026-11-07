import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { Type } from "typebox";
import type { ExtensionContext, ExtensionRuntime, ToolDefinition } from "../extensions/types.ts";
import { FileService, type FileReceipt } from "../files/file-service.ts";
import { MAX_WRITE_BYTES } from "../files/write-limits.ts";
import { assessProtectedMutationPath } from "../files/protected-path-policy.ts";
import { HOST_PATH_HOST_SYSTEM, HOST_PATH_TOOL, WorkspacePathStop, WorkspaceSandboxBackend, WorkspaceOperationError, type WorkspaceChange, type WorkspaceReply,
  type WorkspaceSandboxOptions } from "./workspace-backend.ts";
import type { ShellExecutionFacts } from "../tools/shell-execution.ts";
import type { SandboxNetworkSession } from "./network-policy.ts";
import { inspectSandboxCommand, type SandboxCommandFacts } from "../shell-policy/sandbox-command.ts";
import { WORKSPACE_TOOL_NAMES } from "../session-execution-profile.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { IMAGE_TYPE_SNIFF_BYTES } from "../../utils/image-signature.mjs";
import { processImage } from "../../utils/image-process.ts";
import { SubagentScheduler, type TaskWorkspace } from "../tasks/scheduler.ts";
import { HARD_MAX_CONCURRENT } from "../tasks/limits.ts";

const names = WORKSPACE_TOOL_NAMES;
const BASELINE_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TRAILING_PATH_PATTERN = /[. ]$/;
const OPERATION_LIMITS = Object.freeze({ maxConcurrent: 1, maxTasks: HARD_MAX_CONCURRENT + 1 });
// Queue admission only; native permissions and publication own mutation authorization.
const OPERATION_SLOT: readonly TaskWorkspace[] = Object.freeze([{ canonicalCwd: "", allowMutation: false }]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
// R5 failure classification: what an offline VM or an unmapped path prints. A refused connection is not
// listed: a local server that is not running (`localhost:3000`) refuses too.
const NETWORK_FAILURE = /ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve (?:host|proxy)|No such host is known|Name or service not known|Temporary failure in name resolution|remote name could not be resolved|ENETUNREACH|Network is unreachable|Failed to establish a new (?:network )?connection/i;
const PATH_NOT_FOUND = /cannot find (?:the )?path|No such file or directory|system cannot find|ENOENT|is not recognized as|does not exist|找不到/i;
const ACCESS_DENIED = /Access (?:to the path .{0,512} )?is denied|EACCES|EPERM|Permission denied|Read-only file system|UnauthorizedAccess|拒绝访问/i;
const NETWORK_CHOICES = ["允许本会话联网", "拒绝"];
const NETWORK_TIMEOUT_MS = 60000, MAX_DIALOG_COMMAND = 4000;
const NETWORK_STATUS_KEY = "sandbox-network";
/** Output names `key` with either separator (`c:\\program files\\x`, `c:/program files/x`). */
function mentionsPath(output: string, key: string): boolean {
  if (output.indexOf(key) >= 0) return true;
  return key.indexOf("\\") >= 0 && output.indexOf(key.replaceAll("\\", "/")) >= 0;
}
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error("[SANDBOX_WRITEBACK] " + reason); }
function needImage(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function shellFacts(reply: WorkspaceReply, cwd: string, failure?: string): ShellExecutionFacts | undefined {
  const execution = reply.execution;
  if (!execution) return undefined;
  return { version: 1, producer: "agent", started: true, executionStatus: execution.timedOut ? "interrupted" : "exited",
    sideEffects: "unknown", retryGuidance: "inspect_before_retry", cwd, exitCode: execution.exitCode, signal: null,
    termination: execution.timedOut ? "timeout" : "exit", observationError: failure?.slice(0, 1000),
    output: { complete: !execution.truncated, tailTruncated: execution.truncated === true, log: execution.truncated ? "capped" : "not_needed", cleanup: "not_needed" } };
}

/** Guest operations and host publication are separate owners and trust domains. */
export class WorkspaceSandboxTools {
  private readonly backend: WorkspaceSandboxBackend;
  private readonly runtime: () => ExtensionRuntime;
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly operations = new SubagentScheduler(OPERATION_LIMITS, "Sandbox operation");
  private readonly shutdown = new AbortController();
  /** Reused by the serialized operations (one at a time). */
  private readonly commandFacts: SandboxCommandFacts = { network: undefined, paths: [] };
  private readonly networkSession?: SandboxNetworkSession;
  private networkStatus = false;
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write", runtime: () => ExtensionRuntime, toolchainOptions: WorkspaceSandboxOptions = {}) {
    this.backend = new WorkspaceSandboxBackend(cwd, parent, mode, toolchainOptions); this.runtime = runtime;
    this.networkSession = toolchainOptions.networkSession;
    const network = this.backend.networkEnabled ? "enabled" : this.networkSession
      ? "disabled; common network commands (npm/pip install, git clone/fetch/pull/push, curl, wget) first ask the user to enable it for this session" : "disabled";
    const workspace = " Session host workspace: " + cwd + ". Additional working directories: " + (toolchainOptions.directories?.join("; ") || "none")
      + ". Relative paths use the primary workspace; absolute paths can address every added working directory. Use /add-dir to add another directory.";
    const commandEnvironment = " Command cwd: " + cwd
      + ". Commands and file tools use the same workspace paths. Inside the VM these name isolated snapshots. Network access: " + network + ".";
    for (const name of names) {
      const parameters = name === "powershell" || name === "bash" ? Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String({ description: "Literal working directory inside the primary or added workspace; defaults to the primary workspace." })), timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 120 })) })
        : name === "file_batch" ? Type.Object({ operations: Type.Array(Type.Any(), { minItems: 1, maxItems: 16 }) })
        : name === "write" ? Type.Object({ path: Type.String(), content: Type.String(), snapshot: Type.Optional(Type.String()) })
        : name === "edit" ? Type.Object({ path: Type.String(), snapshot: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) })
        : name === "move" ? Type.Object({ path: Type.String(), destination: Type.String() })
        : name === "delete" ? Type.Object({ path: Type.String() })
        : name === "read" ? Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) })
        : Type.Object({ path: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()) });
      const owner = this;
      const definition: ToolDefinition = { name, label: name + " (Sandbox)", parameters, executionMode: "sequential", modelExposure: "nested",
        description: name === "powershell" || name === "bash" ? "Run " + (name === "bash" ? "Bash" : "PowerShell 7") + " inside the session Windows Sandbox. Tool installation directories are discovered from host PATH. Command and publication outcomes are separate. No host fallback or background processes. Timeout at most 120 seconds." + workspace + commandEnvironment
          : name === "find" || name === "grep" ? "Search sandbox workspace using a literal substring; at most 200 results." + workspace
          : name === "read" ? "Read UTF-8 text (up to 2 MiB, 2000 lines/32 KiB per call) or JPEG, PNG, GIF, WebP, BMP images (up to 16 MiB) by file signature. Images return native image attachments, resized to inline limits; offset/limit apply only to text. In CodeMode use await show(result.ref) to display the image; do not print shell base64. For text writes/edits pass snapshot: result.details.snapshot (the SHA-256 hash); result.ref is only a display reference, never a file snapshot." + workspace
          : "Operate inside the session sandbox workspace. Before overwriting or exact-text editing, use const r = await tools.read({path}); then pass snapshot: r.details.snapshot to write/edit, including inside file_batch. Never pass r.ref. New-file write needs no snapshot. A stale hash requires another read and reconciliation before retry. Protected metadata and dependencies are excluded from the snapshot." + workspace,
        async execute(id, args, signal, _update, ctx) { return owner.execute(name, id, args as Record<string, unknown>, ctx, signal); },
      };
      this.definitions.set(name, definition);
    }
  }
  install(base: Record<string, ToolDefinition>): void { for (const [name, definition] of this.definitions) base[name] = definition; }
  definition(name: string): ToolDefinition | undefined { return this.definitions.get(name); }
  private async execute(name: string, id: string, input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal) {
    const runtime = this.runtime(), boundary = runtime.executionBoundary, generation = boundary.generation;
    const operationSignal = AbortSignal.any(signal ? [signal, boundary.signal, this.shutdown.signal] : [boundary.signal, this.shutdown.signal]);
    const reservation = this.operations.reserve(OPERATION_SLOT);
    try {
      return await this.operations.run(operationSignal, async () => {
        boundary.assertCurrent(generation);
        return this.perform(name, id, input, ctx, operationSignal);
      });
    } finally { reservation.release(); }
  }
  private async perform(name: string, id: string, input: Record<string, unknown>, ctx: ExtensionContext, signal: AbortSignal) {
    const runtime = this.runtime(), boundary = runtime.executionBoundary, generation = boundary.generation;
    const check = () => { boundary.assertCurrent(generation); signal?.throwIfAborted(); };
    const cwd = typeof input.cwd === "string" ? path.resolve(this.backend.workspace(), input.cwd) : this.backend.workspace();
    const command = (name === "bash" || name === "powershell") && typeof input.command === "string" ? input.command : undefined;
    let hostPaths: readonly string[] | undefined;
    if (command !== undefined) {
      const facts = this.commandFacts;
      inspectSandboxCommand(name as "bash" | "powershell", command, facts);
      if (facts.paths.length) hostPaths = facts.paths;
      // Without a dialog (subagents, print mode) a network command runs offline as before.
      if (ctx.hasUI) {
        if (facts.network !== undefined && this.networkSession && !this.backend.networkEnabled) { await this.requestNetwork(ctx, facts.network, command, signal); check(); }
        if (!this.networkStatus && this.networkSession?.enabled) { ctx.ui.setStatus(NETWORK_STATUS_KEY, "沙箱已联网（本会话）"); this.networkStatus = true; }
      }
    }
    check();
    let reply;
    try { reply = await this.backend.invoke(name, input, signal, hostPaths); }
    catch (error) {
      if (error instanceof WorkspacePathStop) this.stopForPath("[SANDBOX_PATH_UNMAPPED] 命令引用的宿主路径不在沙箱工作区内：" + error.hostPath
        + "。沙箱里看不到这个路径，命令未执行。");
      if (error instanceof WorkspaceOperationError) return { isError: true, content: [{ type: "text" as const,
        text: command !== undefined && error.reply.phase === "execution" ? error.message + await this.failureNote(error.reply, ctx) : error.message }],
        details: { sandbox: true, phase: error.reply.phase, execution: error.reply.execution,
          shellExecution: shellFacts(error.reply, cwd, error.reply.phase === "execution" && error.reply.execution?.closed ? undefined : error.reply.error), published: 0 } };
      throw error;
    }
    if (reply.image !== undefined) return this.readImage(name, reply, ctx, check);
    const receipts: FileReceipt[] = [];
    try {
      check();
      const changes = reply.changes ?? []; need(Array.isArray(changes) && changes.length <= (reply.execution ? 1024 : 32), "Invalid change set");
      if (runtime.nativePermissions?.mode === "read-only") need(changes.length === 0, "Read-only operation produced writes");
      const contents = this.validateChanges(changes);
      for (const change of changes) if (change.artifact) { await this.backend.candidate(change.artifact, false); check(); }
      for (let i = 0; i < changes.length; i++) { check(); await this.publish(changes[i]!, contents[i], id, ctx, signal, check, receipts); }
      await this.backend.releaseCandidates(changes);
      return { content: [{ type: "text" as const, text: reply.text || "(no output)" }], details: { sandbox: true, snapshot: reply.snapshot, execution: reply.execution,
        shellExecution: shellFacts(reply, cwd), writeback: receipts } };
    } catch (error) {
      let published = 0, partial = 0;
      for (const receipt of receipts) { if (receipt.ok) published++; else if (receipt.stateChanged !== false) partial++; }
      const failure = new Error(`[SANDBOX_PUBLICATION] ${published} file(s) already published; ${partial} additional file(s) may have partial changes; remaining changes stopped. ${error instanceof Error ? error.message : String(error)}${reply.execution ? "\nCommand exit=" + reply.execution.exitCode + "\n" + reply.execution.stdout + reply.execution.stderr : ""}`, { cause: error });
      try { await this.backend.discardSnapshot(); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], "Sandbox writeback failed and cleanup remains unresolved"); }
      if (reply.execution) return { isError: true, content: [{ type: "text" as const, text: failure.message }], details: { sandbox: true, phase: "publication",
        execution: reply.execution, shellExecution: shellFacts(reply, cwd, failure.message), published, partial, writeback: receipts } };
      throw failure;
    }
  }
  /** One dialog per recognized network command while offline; consent lasts for the session. */
  private async requestNetwork(ctx: ExtensionContext, network: string, command: string, signal: AbortSignal): Promise<void> {
    const shown = command.length > MAX_DIALOG_COMMAND ? command.slice(0, MAX_DIALOG_COMMAND) + "…" : command;
    const selected = await ctx.ui.select("允许本会话的沙箱联网？", NETWORK_CHOICES, { signal, timeout: NETWORK_TIMEOUT_MS, kind: "permission",
      details: "命令：" + shown + "\n识别为联网命令：" + network + "\n沙箱当前禁止联网。允许后关闭当前沙箱 VM，之后的命令在开启网络的新 VM 中运行（工作区重新快照），直到本会话结束；全局 sandboxNetwork 设置不变。" });
    if (selected !== NETWORK_CHOICES[0]) throw new Error("[SANDBOX_NETWORK_DECLINED] 用户没有允许本会话的沙箱联网，命令未执行（" + network
      + "）。不要换写法或改用其他联网方式重试；请告知用户，等待下一步指令。");
    await this.backend.enableSessionNetwork();
    ctx.ui.notify("本会话的沙箱已允许联网；下一条命令会在新的联网 VM 中运行。", "info");
  }
  /** Pause the whole turn: only the user can widen the workspace (`/add-dir`). */
  private stopForPath(reason: string): never {
    void this.runtime().executionBoundary.pauseForUser();
    throw new Error(reason + "当前整轮任务已暂停：请告知用户这个路径；需要时由用户用 /add-dir 把所在目录加入工作区。不要换写法、复制到别处或改用其他路径绕开。");
  }
  /** Why a failed command failed, when the sandbox caused it (R5); path causes pause the turn. */
  private async failureNote(reply: WorkspaceReply, ctx: ExtensionContext): Promise<string> {
    const execution = reply.execution;
    if (!execution || execution.timedOut) return "";
    const output = execution.stdout + execution.stderr;
    let lower: string | undefined;
    if (!this.backend.networkEnabled && NETWORK_FAILURE.test(output))
      return "\n[SANDBOX_NETWORK_DISABLED] 沙箱当前禁止联网，这次失败来自网络请求（DNS 解析失败或网络不可达），换写法、换镜像源重试同样会失败。请告知用户需要联网"
        + (ctx.hasUI && this.networkSession ? "；常见联网命令（如 npm install、git clone）执行前会询问用户是否允许本会话联网。" : "；可在全局设置中开启 sandboxNetwork。");
    for (const candidate of this.commandFacts.paths) {
      const kind = await this.backend.hostPathKind(candidate);
      if (kind !== HOST_PATH_HOST_SYSTEM && kind !== HOST_PATH_TOOL) continue;
      // Only a failure that names this path is about it (`& 'C:\Program Files\nodejs\npm.cmd' test` may fail for its own reasons).
      const resolved = path.resolve(candidate);
      lower ??= output.toLowerCase();
      if (!mentionsPath(lower, resolved.toLowerCase())) continue;
      if (kind === HOST_PATH_HOST_SYSTEM && PATH_NOT_FOUND.test(output))
        this.stopForPath("[SANDBOX_PATH_UNMAPPED] 命令引用的宿主路径没有映射到沙箱：" + resolved + "。命令在沙箱中失败。");
      if (kind === HOST_PATH_TOOL && ACCESS_DENIED.test(output))
        this.stopForPath("[SANDBOX_PATH_READ_ONLY] " + resolved + " 是工具链目录，在沙箱中只读挂载，命令在写入时失败。");
    }
    return "";
  }
  private async readImage(name: string, reply: WorkspaceReply, ctx: ExtensionContext, check: () => void) {
    try {
      check();
      const image = reply.image, artifact = image?.artifact;
      needImage(name === "read" && !reply.execution && reply.changes?.length === 0 && artifact
        && typeof image.mimeType === "string" && typeof artifact.sha256 === "string" && BASELINE_PATTERN.test(artifact.sha256)
        && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= 16 * 1024 * 1024, "Invalid read image envelope");
      const bytes = (await this.backend.candidate(artifact, true))!; check();
      needImage(detectSupportedImageMimeType(bytes.subarray(0, IMAGE_TYPE_SNIFF_BYTES)) === image.mimeType, "Image signature mismatch");
      // Reuse native read processing, only over authenticated guest bytes; never reopen a host source path.
      const processed = await processImage(bytes, image.mimeType); check();
      await this.backend.releaseArtifact(artifact); check();
      const note = ctx.model && !ctx.model.input.includes("image") ? "\n[Current model does not support images. The image will be omitted from this request.]" : "";
      const text = "Read image file [" + (processed.ok ? processed.mimeType : image.mimeType) + "]"
        + (processed.ok ? processed.hints.length ? "\n" + processed.hints.join("\n") : "" : "\n" + processed.message) + note;
      return { content: processed.ok ? [{ type: "text" as const, text }, { type: "image" as const, data: processed.data, mimeType: processed.mimeType }]
        : [{ type: "text" as const, text }], details: { sandbox: true, snapshot: reply.snapshot } };
    } catch (error) {
      const failure = new Error("[SANDBOX_IMAGE] " + (error instanceof Error ? error.message : String(error)), { cause: error });
      try { await this.backend.discardSnapshot(); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], "Sandbox image read failed and cleanup remains unresolved"); }
      throw failure;
    }
  }
  private validateChanges(changes: readonly WorkspaceChange[]): (string | undefined)[] {
    const paths = new Set<string>(), artifacts = new Set<string>(); let total = 0, textTotal = 0;
    // Validate the entire envelope and aggregate capacity before decoding or committing anything.
    for (const change of changes) {
      need(change && typeof change.path === "string" && change.path.length > 0 && change.path.length < 4096 && !path.isAbsolute(change.path)
        && !change.path.includes(":") && !change.path.includes("\0"), "Invalid candidate path");
      need(!this.backend.isPrivatePath(change.path), "Protected candidate path (including VM-private paths)");
      const components = change.path.replaceAll("\\", "/").split("/");
      for (const part of components) {
        need(part && part !== "." && part !== ".." && !TRAILING_PATH_PATTERN.test(part), "Protected candidate path");
      }
      need(change.before === null || typeof change.before === "string" && BASELINE_PATTERN.test(change.before), "Invalid baseline");
      need(change.content === null || typeof change.content === "string" && change.content.length <= 2800000 && BASE64_PATTERN.test(change.content), "Invalid candidate bytes");
      this.backend.workspace(change.workspaceIndex);
      const key = (change.workspaceIndex ?? 0) + ":" + components.join("/").toLowerCase(); need(!paths.has(key), "Duplicate candidate path"); paths.add(key);
      if (change.artifact) {
        need(typeof change.artifact.name === "string" && !artifacts.has(change.artifact.name), "Duplicate artifact identity"); artifacts.add(change.artifact.name);
        need(change.content === null && typeof change.artifact.sha256 === "string" && BASELINE_PATTERN.test(change.artifact.sha256)
          && Number.isSafeInteger(change.artifact.bytes) && change.artifact.bytes >= 0 && change.artifact.bytes <= 64 * 1024 * 1024, "Invalid artifact metadata");
        total += change.artifact.bytes; need(total <= 256 * 1024 * 1024, "Artifact bytes exceed 256 MiB"); continue;
      }
      const size = change.content === null ? 0 : Buffer.byteLength(change.content, "base64");
      need(size <= MAX_WRITE_BYTES, "Candidate exceeds the native write limit (1 MiB)");
      textTotal += size; total += size; need(textTotal <= 16 * 1024 * 1024 && total <= 256 * 1024 * 1024, "Candidates exceed their byte capacity");
    }
    const contents: (string | undefined)[] = [];
    for (const change of changes) {
      const bytes = change.content === null ? undefined : Buffer.from(change.content, "base64");
      need(!bytes || isUtf8(bytes), "Candidate is not UTF-8 text");
      contents.push(bytes?.toString("utf8"));
    }
    return contents;
  }
  private async publish(change: WorkspaceChange, content: string | undefined, id: string, ctx: ExtensionContext, signal: AbortSignal | undefined, check: () => void, receipts: FileReceipt[]) {
    const workspace = this.backend.workspace(change.workspaceIndex), target = path.resolve(workspace, change.path), service = new FileService(workspace, ctx.sessionManager.getSessionId());
    let snapshot: string | undefined;
    try {
      const assessment = await assessProtectedMutationPath(workspace, target); check();
      need(assessment.canonicalTarget && assessment.violations.length === 0, "Protected or redirected host candidate");
      await this.backend.assertWorkspaceCurrent(); check();
      if (change.before !== null && (change.artifact || content === undefined)) this.backend.assertSourceVersion(change.path, await fs.lstat(target, { bigint: true }), change.workspaceIndex);
      else if (change.before !== null) {
        const handle = await fs.open(target, "r");
        try {
          const before = await handle.stat({ bigint: true }); need(before.isFile() && before.size <= 2n * 1024n * 1024n, "Original file capacity");
          this.backend.assertSourceVersion(change.path, before, change.workspaceIndex);
          const original = await handle.readFile(); const after = await handle.stat({ bigint: true }); check();
          need(before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && hash(original) === change.before, "Host file changed since sandbox snapshot");
          snapshot = "snap_" + randomBytes(16).toString("base64url");
          need(service.revisions.remember({ id: snapshot, mode: "full", sessionId: service.sessionId, canonicalPath: await fs.realpath(target),
            identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs }, sha256: change.before,
            firstSeenLine: 1, lastSeenLine: 1, residentBytes: original.length, bytes: original }, service.revisions.generation), "Baseline retention failed");
        } finally { await handle.close(); }
      } else { try { await fs.lstat(target); throw new Error("Host target already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      const operation = content === undefined && !change.artifact ? "delete" : "write";
      const input = { path: change.path, ...(content === undefined ? {} : { content, snapshot }) };
      // Refusals bind the stable guest baseline, never a freshly allocated host receipt ID.
      const policyInput = { path: change.workspaceIndex ? target : change.path, ...(change.artifact ? { content: "artifact-sha256:" + change.artifact.sha256, snapshot: change.before ?? undefined }
        : content === undefined ? {} : { content, snapshot: change.before ?? undefined }) };
      const runtime = this.runtime(), policy = runtime.nativePermissions;
      need(policy && policy.mode === "sandbox-write", "Writeback authority revoked");
      const authorization = await policy.authorize({ type: "tool_call", toolName: operation, toolCallId: id + ":writeback", input: policyInput } as any, ctx, this.definitions.get(operation));
      try {
        check(); authorization.consume(policyInput, id + ":writeback", operation, signal);
        const item = change.artifact ? await service.prepareArtifact(change.path, (await this.backend.candidate(change.artifact, true))!, change.artifact.sha256, change.before, signal)
          : await service.prepare(operation, input, signal, operation === "write" ? change.before === null ? "create" : "overwrite" : undefined);
        try {
          await this.backend.assertWorkspaceCurrent(); check();
          // A delete has no revision input: ensure prepare captured the original source,
          // then let FileService guard that prepared identity at the physical commit.
          if (change.before !== null) this.backend.assertSourceVersion(change.path, await fs.lstat(target, { bigint: true }), change.workspaceIndex);
          check();
          const receipt = await service.execute(item, id, { signal, assertCurrent: check, record: entry => runtime.appendEntry("sandbox-writeback-v1", entry) });
          receipts.push(receipt);
          need(receipt.ok, "Host commit did not succeed (" + receipt.status + "): " + (receipt.cause ?? "inspect the writeback receipt"));
          await this.backend.recordPublication(change.path, operation === "delete", change.workspaceIndex,
            change.artifact?.sha256 ?? (content === undefined ? undefined : createHash("sha256").update(content).digest("hex"))); return receipt;
        }
        finally { service.release(item); }
      } finally { authorization.release(); }
    } finally { service.dispose(); }
  }
  async close(): Promise<void> {
    this.shutdown.abort(); this.operations.dispose();
    await this.operations.waitForIdle(); await this.backend.close();
  }
  async drain(): Promise<void> { await this.operations.waitForIdle(); await this.backend.drain(); }
  get diagnostics() { return { ...this.backend.diagnostics, active: this.operations.active, queued: this.operations.queued,
    reservations: this.operations.reservationCount, highWaterMark: this.operations.highWaterMark, queueHighWaterMark: this.operations.queueHighWaterMark }; }
}
