import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { Type } from "typebox";
import type { ExtensionContext, ExtensionRuntime, ToolDefinition } from "../extensions/types.ts";
import { FileService, type FileReceipt } from "../files/file-service.ts";
import { MAX_WRITE_BYTES } from "../files/write-limits.ts";
import { assessProtectedMutationPath } from "../files/protected-path-policy.ts";
import { WorkspaceSandboxBackend, WorkspaceOperationError, type WorkspaceChange, type WorkspaceReply, type WorkspaceSandboxOptions } from "./workspace-backend.ts";
import type { ShellExecutionFacts } from "../tools/shell-execution.ts";
import { parseSandboxNetwork } from "./network-policy.ts";
import { WORKSPACE_TOOL_NAMES } from "../session-execution-profile.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { IMAGE_TYPE_SNIFF_BYTES } from "../../utils/image-signature.mjs";
import { processImage } from "../../utils/image-process.ts";

const names = WORKSPACE_TOOL_NAMES;
const BASELINE_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TRAILING_PATH_PATTERN = /[. ]$/;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
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
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write", runtime: () => ExtensionRuntime, toolchainOptions: WorkspaceSandboxOptions = {}) {
    this.backend = new WorkspaceSandboxBackend(cwd, parent, mode, toolchainOptions); this.runtime = runtime;
    const workspace = " Session host workspace: " + cwd + ". Additional working directories: " + (toolchainOptions.directories?.join("; ") || "none")
      + ". Relative paths use the primary workspace; absolute paths can address every added working directory. Use /add-dir to add another directory.";
    const commandEnvironment = " Command cwd: " + cwd
      + ". Commands and file tools use the same workspace paths. Inside the VM these name isolated snapshots. Network access: " + parseSandboxNetwork(toolchainOptions.network) + ".";
    for (const name of names) {
      const parameters = name === "powershell" || name === "bash" ? Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 120 })) })
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
    const check = () => { boundary.assertCurrent(generation); signal?.throwIfAborted(); };
    check();
    let reply;
    try { reply = await this.backend.invoke(name, input, signal); }
    catch (error) {
      if (error instanceof WorkspaceOperationError) return { isError: true, content: [{ type: "text" as const, text: error.message }],
        details: { sandbox: true, phase: error.reply.phase, execution: error.reply.execution,
          shellExecution: shellFacts(error.reply, this.backend.workspace(), error.reply.phase === "execution" && error.reply.execution?.closed ? undefined : error.reply.error), published: 0 } };
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
        shellExecution: shellFacts(reply, this.backend.workspace()), writeback: receipts } };
    } catch (error) {
      let published = 0, partial = 0;
      for (const receipt of receipts) { if (receipt.ok) published++; else if (receipt.stateChanged !== false) partial++; }
      const failure = new Error(`[SANDBOX_PUBLICATION] ${published} file(s) already published; ${partial} additional file(s) may have partial changes; remaining changes stopped. ${error instanceof Error ? error.message : String(error)}${reply.execution ? "\nCommand exit=" + reply.execution.exitCode + "\n" + reply.execution.stdout + reply.execution.stderr : ""}`, { cause: error });
      try { await this.backend.discardSnapshot(); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], "Sandbox writeback failed and cleanup remains unresolved"); }
      if (reply.execution) return { isError: true, content: [{ type: "text" as const, text: failure.message }], details: { sandbox: true, phase: "publication",
        execution: reply.execution, shellExecution: shellFacts(reply, this.backend.workspace(), failure.message), published, partial, writeback: receipts } };
      throw failure;
    }
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
      const components = change.path.replaceAll("\\", "/").split("/");
      for (const part of components) {
        const lower = part.toLowerCase();
        need(part && part !== "." && part !== ".." && !TRAILING_PATH_PATTERN.test(part) && lower !== ".git" && lower !== ".sp", "Protected candidate path");
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
  async close(): Promise<void> { await this.backend.close(); }
  async drain(): Promise<void> { await this.backend.drain(); }
  get diagnostics() { return this.backend.diagnostics; }
}
