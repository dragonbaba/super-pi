import path from "node:path";
import { Type } from "typebox";
import type { ExtensionContext, ExtensionRuntime, ToolDefinition } from "../extensions/types.ts";
import { HOST_PATH_HOST_ONLY, HOST_PATH_TOOL, WorkspaceSandboxBackend, WorkspaceOperationError, type WorkspaceReply,
  type WorkspaceSandboxOptions } from "./workspace-backend.ts";
import type { ShellExecutionFacts } from "../tools/shell-execution.ts";
import type { SandboxNetworkSession } from "./network-policy.ts";
import { inspectSandboxCommand, type SandboxCommandFacts } from "../shell-policy/sandbox-command.ts";
import { WORKSPACE_TOOL_NAMES } from "../session-execution-profile.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { IMAGE_TYPE_SNIFF_BYTES } from "../../utils/image-signature.mjs";
import { processImage } from "../../utils/image-process.ts";
import { processedImage } from "../../utils/processed-image.ts";
import { SubagentScheduler, type TaskWorkspace } from "../tasks/scheduler.ts";
import { HARD_MAX_CONCURRENT } from "../tasks/limits.ts";
import { READ_LINES, IMAGE_LIMIT } from "./mxc-file-limits.mjs";

const names = WORKSPACE_TOOL_NAMES;
const BASELINE_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_LIMITS = Object.freeze({ maxConcurrent: 1, maxTasks: HARD_MAX_CONCURRENT + 1 });
// Queue admission only; native permissions own mutation authorization.
const OPERATION_SLOT: readonly TaskWorkspace[] = Object.freeze([{ canonicalCwd: "", allowMutation: false }]);
// R5 failure classification based on observed output, never command rejection. A refused connection is not
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
function needImage(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function shellFacts(reply: WorkspaceReply, cwd: string, failure?: string): ShellExecutionFacts | undefined {
  const execution = reply.execution;
  if (!execution) return undefined;
  return { version: 1, producer: "agent", started: true, executionStatus: execution.timedOut ? "interrupted" : "exited",
    sideEffects: "unknown", retryGuidance: "inspect_before_retry", cwd, exitCode: execution.exitCode, signal: null,
    termination: execution.timedOut ? "timeout" : "exit", observationError: failure?.slice(0, 1000),
    output: { complete: !execution.truncated, tailTruncated: execution.truncated === true, log: execution.truncated ? "capped" : "not_needed", cleanup: "not_needed" } };
}

/** Every file and command operation executes inside the same native MXC boundary. */
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
  private readonly autoResizeImages?: () => boolean;
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write", runtime: () => ExtensionRuntime, toolchainOptions: WorkspaceSandboxOptions = {}, autoResizeImages?: () => boolean) {
    this.autoResizeImages = autoResizeImages;
    this.backend = new WorkspaceSandboxBackend(cwd, parent, mode, toolchainOptions); this.runtime = runtime;
    this.networkSession = toolchainOptions.networkSession;
    const network = this.backend.networkEnabled ? "enabled" : this.networkSession
      ? "disabled; common network commands (npm/pip install, git clone/fetch/pull/push, curl, wget) first ask the user to enable it for this session" : "disabled";
    const workspace = " Session host workspace: " + cwd + ". Additional working directories: " + (toolchainOptions.directories?.join("; ") || "none")
      + ". Relative paths use the primary workspace; absolute paths can address every added working directory. Use /add-dir to add another directory.";
    const commandEnvironment = " Command cwd: " + cwd
      + ". Commands and file tools directly use the authorized workspace. Use PowerShell 7 syntax; Bash is unavailable in this mode. Network access: " + network + ".";
    for (const name of names) {
      const parameters = name === "powershell" ? Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String({ description: "Literal working directory inside the primary or added workspace; defaults to the primary workspace." })), timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 120 })) })
        : name === "file_batch" ? Type.Object({ operations: Type.Array(Type.Any(), { minItems: 1, maxItems: 16 }) })
        : name === "write" ? Type.Object({ path: Type.String(), content: Type.String(), snapshot: Type.Optional(Type.String()) })
        : name === "edit" ? Type.Object({ path: Type.String(), snapshot: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) })
        : name === "move" ? Type.Object({ path: Type.String(), destination: Type.String() })
        : name === "delete" ? Type.Object({ path: Type.String() })
        : name === "read" ? Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: READ_LINES })) })
        : name === "grep" ? Type.Object({ path: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()),
          outputMode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")])) })
        : Type.Object({ path: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()) });
      const owner = this;
      const definition: ToolDefinition = { name, label: name + " (Sandbox)", parameters, executionMode: "sequential", modelExposure: "nested",
        description: name === "powershell" ? "Run PowerShell 7 inside the session MXC sandbox. Tool installations are discovered from host PATH. Writes affect the authorized workspace immediately and are not rolled back on failure. No shell or host fallback; descendants stop when the command ends. Timeout at most 120 seconds." + workspace + commandEnvironment
          : name === "grep" ? "Search sandbox UTF-8 files using a literal substring. outputMode: content (default, matching line prefixes), files (one path per matching file), count (path:matching-line-count, one record per file). Repeated occurrences on one line count once. At most 200 records and 32,768 UTF-16 code units of body. Status prefixes and details.search report scan stops, skipped files and clipped excerpts." + workspace
          : name === "find" || name === "ls" ? "List sandbox paths; find filters file paths by a literal substring. At most 200 records and 32,768 UTF-16 code units of body. Check details.search and status prefixes for scan/output limits." + workspace
          : name === "read" ? "Read UTF-8 text (files up to 2 MiB; at most 2000 lines and 32,768 UTF-16 code units of body per call) or JPEG, PNG, GIF, WebP, BMP images (up to 16 MiB) by file signature. details.read distinguishes windowComplete, hasMore and lineTruncated; nextOffset is safe only at a complete line boundary. A clipped line suffix cannot be recovered with line offsets. Images return native image attachments, resized to inline limits; offset/limit apply only to text. In CodeMode use await show(result.ref) to display the image; do not print shell base64. For text writes/edits pass snapshot: result.details.snapshot (the SHA-256 hash); result.ref is only a display reference, never a file snapshot." + workspace
          : "Operate directly inside the authorized sandbox workspace. Existing-file write/edit requires snapshot: result.details.snapshot from a read or clean own write/edit; each successful mutation returns the next SHA-256 for continuation without a reread. New-file write omits snapshot and returns one. Never pass result.ref. A stale hash requires read and reconciliation. file_batch details.items preserves individual verified snapshots and partial effects; failed/unknown items have no successor. Protected .git and .sp metadata remain read-only." + workspace,
        async execute(id, args, signal, _update, ctx) { return owner.execute(name, id, args as Record<string, unknown>, ctx, signal); },
      };
      this.definitions.set(name, definition);
    }
  }
  install(base: Record<string, ToolDefinition>): Record<string, ToolDefinition> {
    const installed: Record<string, ToolDefinition> = Object.create(null);
    for (const name of Object.keys(base)) if (name !== "bash") installed[name] = base[name]!;
    for (const [name, definition] of this.definitions) installed[name] = definition;
    return installed;
  }
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
    const command = name === "powershell" && typeof input.command === "string" ? input.command : undefined;
    if (command !== undefined) {
      const facts = this.commandFacts;
      inspectSandboxCommand("powershell", command, facts);
      // Without a dialog (subagents, print mode) a network command runs offline as before.
      if (ctx.hasUI) {
        if (facts.network !== undefined && this.networkSession && !this.backend.networkEnabled) { await this.requestNetwork(ctx, facts.network, command, signal); check(); }
        if (!this.networkStatus && this.networkSession?.enabled) { ctx.ui.setStatus(NETWORK_STATUS_KEY, "沙箱已联网（本会话）"); this.networkStatus = true; }
      }
    }
    check();
    let reply;
    try { reply = await this.backend.invoke(name, input, signal); }
    catch (error) {
      if (error instanceof WorkspaceOperationError) return { isError: true, content: [{ type: "text" as const,
        text: command !== undefined && error.reply.phase === "execution" ? error.message + await this.failureNote(error.reply, ctx) : error.message }],
        details: { sandbox: true, phase: error.reply.phase, items: error.reply.items, requiresVerification: error.reply.requiresVerification, execution: error.reply.execution,
          shellExecution: shellFacts(error.reply, cwd, error.reply.phase === "execution" && error.reply.execution?.closed ? undefined : error.reply.error), noEffects: error.reply.noEffects } };
      throw error;
    }
    if (reply.image !== undefined) return this.readImage(name, reply, ctx, check);
    check();
    const note = reply.execution && reply.execution.exitCode !== 0 ? await this.failureNote(reply, ctx) : "";
    return { isError: !reply.ok, content: [{ type: "text" as const, text: (reply.text || "(no output)") + note }],
      details: { sandbox: true, snapshot: reply.snapshot, items: reply.items, read: reply.read, search: reply.search,
        execution: reply.execution, shellExecution: shellFacts(reply, cwd) } };
  }
  /** One dialog per recognized network command while offline; consent lasts for the session. */
  private async requestNetwork(ctx: ExtensionContext, network: string, command: string, signal: AbortSignal): Promise<void> {
    const shown = command.length > MAX_DIALOG_COMMAND ? command.slice(0, MAX_DIALOG_COMMAND) + "…" : command;
    const selected = await ctx.ui.select("允许本会话的沙箱联网？", NETWORK_CHOICES, { signal, timeout: NETWORK_TIMEOUT_MS, kind: "permission",
      details: "命令：" + shown + "\n识别为联网命令：" + network + "\n沙箱当前禁止联网。允许后，后续进程按联网策略运行，直到本会话结束；全局 sandboxNetwork 设置不变。" });
    if (selected !== NETWORK_CHOICES[0]) throw new Error("[SANDBOX_NETWORK_DECLINED] 用户没有允许本会话的沙箱联网，命令未执行（" + network
      + "）。不要换写法或改用其他联网方式重试；请告知用户，等待下一步指令。");
    await this.backend.enableSessionNetwork();
    ctx.ui.notify("本会话的沙箱已允许联网。", "info");
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
      if (kind !== HOST_PATH_HOST_ONLY && kind !== HOST_PATH_TOOL) continue;
      // Only a failure that names this path is about it (`& 'C:\Program Files\nodejs\npm.cmd' test` may fail for its own reasons).
      const resolved = path.resolve(candidate);
      lower ??= output.toLowerCase();
      if (!mentionsPath(lower, resolved.toLowerCase())) continue;
      if (kind === HOST_PATH_HOST_ONLY && PATH_NOT_FOUND.test(output))
        this.stopForPath("[SANDBOX_PATH_UNMAPPED] 命令引用的路径不在授权工作区内：" + resolved + "。命令在沙箱中失败。");
      if (kind === HOST_PATH_TOOL && ACCESS_DENIED.test(output))
        this.stopForPath("[SANDBOX_PATH_READ_ONLY] " + resolved + " 是工具链目录，在沙箱中只读，命令在写入时失败。");
    }
    return "";
  }
  private async readImage(name: string, reply: WorkspaceReply, ctx: ExtensionContext, check: () => void) {
    try {
      check();
      const image = reply.image, artifact = image?.artifact;
      needImage(name === "read" && !reply.execution && artifact
        && typeof image.mimeType === "string" && typeof artifact.sha256 === "string" && BASELINE_PATTERN.test(artifact.sha256)
        && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= IMAGE_LIMIT, "Invalid read image envelope");
      const bytes = (await this.backend.candidate(artifact))!; check();
      needImage(detectSupportedImageMimeType(bytes.subarray(0, IMAGE_TYPE_SNIFF_BYTES)) === image.mimeType, "Image signature mismatch");
      // Reuse native read processing over authenticated MXC output; never reopen the source path on the host.
      const autoResizeImages = this.autoResizeImages?.() ?? true;
      const processed = await processImage(bytes, image.mimeType, { autoResizeImages }); check();
      await this.backend.releaseArtifact(artifact); check();
      const note = ctx.model && !ctx.model.input.includes("image") ? "\n[Current model does not support images. The image will be omitted from this request.]" : "";
      const text = "Read image file [" + (processed.ok ? processed.mimeType : image.mimeType) + "]"
        + (processed.ok ? processed.hints.length ? "\n" + processed.hints.join("\n") : "" : "\n" + processed.message) + note;
      return { content: processed.ok ? [{ type: "text" as const, text }, processedImage(processed.data, processed.mimeType, autoResizeImages)]
        : [{ type: "text" as const, text }], details: { sandbox: true, snapshot: reply.snapshot } };
    } catch (error) {
      const failure = new Error("[SANDBOX_IMAGE] " + (error instanceof Error ? error.message : String(error)), { cause: error });
      try { await this.backend.close(); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], "Sandbox image read failed and cleanup remains unresolved"); }
      throw failure;
    }
  }
  async close(): Promise<void> {
    this.shutdown.abort(); this.operations.dispose();
    await this.operations.waitForIdle(); await this.backend.close();
  }
  async drain(): Promise<void> { await this.operations.waitForIdle(); await this.backend.drain(); }
  get diagnostics() { return { ...this.backend.diagnostics, active: this.operations.active, queued: this.operations.queued,
    reservations: this.operations.reservationCount, highWaterMark: this.operations.highWaterMark, queueHighWaterMark: this.operations.queueHighWaterMark }; }
}
