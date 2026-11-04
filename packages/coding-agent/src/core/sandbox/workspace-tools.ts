import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { Type } from "typebox";
import type { ExtensionContext, ExtensionRuntime, ToolDefinition } from "../extensions/types.ts";
import { FileService } from "../files/file-service.ts";
import { MAX_WRITE_BYTES } from "../files/write-limits.ts";
import { assessProtectedMutationPath } from "../files/protected-path-policy.ts";
import { WorkspaceSandboxBackend, type WorkspaceChange } from "./workspace-backend.ts";

const names = ["read", "ls", "find", "grep", "write", "edit", "delete", "move", "file_batch", "powershell"] as const;
const BASELINE_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TRAILING_PATH_PATTERN = /[. ]$/;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error("[SANDBOX_WRITEBACK] " + reason); }

/** Guest operations and host publication are separate owners and trust domains. */
export class WorkspaceSandboxTools {
  private readonly backend: WorkspaceSandboxBackend;
  private readonly runtime: () => ExtensionRuntime;
  private readonly definitions = new Map<string, ToolDefinition>();
  constructor(cwd: string, parent: string, mode: "read-only" | "sandbox-write", runtime: () => ExtensionRuntime, toolchainOptions = {}) {
    this.backend = new WorkspaceSandboxBackend(cwd, parent, mode, toolchainOptions); this.runtime = runtime;
    for (const name of names) {
      const parameters = name === "powershell" ? Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 120 })) })
        : name === "file_batch" ? Type.Object({ operations: Type.Array(Type.Any(), { minItems: 1, maxItems: 16 }) })
        : name === "write" ? Type.Object({ path: Type.String(), content: Type.String(), snapshot: Type.Optional(Type.String()) })
        : name === "edit" ? Type.Object({ path: Type.String(), snapshot: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) })
        : name === "move" ? Type.Object({ path: Type.String(), destination: Type.String() })
        : name === "delete" ? Type.Object({ path: Type.String() })
        : name === "read" ? Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) })
        : Type.Object({ path: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()) });
      const owner = this;
      const definition: ToolDefinition = { name, label: name + " (Sandbox)", parameters, executionMode: "sequential", modelExposure: "nested",
        description: name === "powershell" ? "Run PowerShell 7 inside the session Windows Sandbox. Tools are discovered from the host PATH and their installation directories mounted read-only. Use Get-Command to inspect guest availability; C:\\SuperPiTools\\toolchains.json lists skipped directories. Only discovered installations have guest paths; the host user profile, credentials and project node_modules are not inherited. Workspace changes publish only after successful execution and current authorization. No host fallback; no network or background processes. Timeout at most 120 seconds."
          : name === "find" || name === "grep" ? "Search sandbox workspace using a literal substring; at most 200 results."
          : "Operate inside the session sandbox workspace. Paths are workspace-relative. Read returns a snapshot hash required for overwriting or exact-text editing. Protected metadata and dependencies are excluded from the snapshot.",
        async execute(id, args, signal, _update, ctx) { return owner.execute(name, id, args as Record<string, unknown>, ctx, signal); },
      };
      this.definitions.set(name, definition);
    }
  }
  install(base: Record<string, ToolDefinition>): void { for (const [name, definition] of this.definitions) base[name] = definition; }
  private async execute(name: string, id: string, input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal) {
    const runtime = this.runtime(), boundary = runtime.executionBoundary, generation = boundary.generation;
    const check = () => { boundary.assertCurrent(generation); signal?.throwIfAborted(); };
    check();
    const reply = await this.backend.invoke(name, input, signal);
    let published = 0;
    try {
      check();
      const changes = reply.changes ?? []; need(Array.isArray(changes) && changes.length <= 32, "Invalid change set");
      if (runtime.nativePermissions?.mode === "read-only") need(changes.length === 0, "Read-only operation produced writes");
      const contents = this.validateChanges(changes), receipts: unknown[] = [];
      for (let i = 0; i < changes.length; i++) { check(); receipts.push(await this.publish(changes[i]!, contents[i], id, ctx, signal, check)); published++; }
      return { content: [{ type: "text" as const, text: reply.text || "(no output)" }], details: { sandbox: true, snapshot: reply.snapshot, writeback: receipts } };
    } catch (error) {
      const failure = published ? new Error(`[SANDBOX_WRITEBACK_PARTIAL] ${published} file(s) already published; remaining changes stopped. ${error instanceof Error ? error.message : String(error)}`, { cause: error }) : error;
      try { await this.backend.discardSnapshot(); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], "Sandbox writeback failed and cleanup remains unresolved"); }
      throw failure;
    }
  }
  private validateChanges(changes: readonly WorkspaceChange[]): (string | undefined)[] {
    const paths = new Set<string>(); let total = 0;
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
      const key = components.join("/").toLowerCase(); need(!paths.has(key), "Duplicate candidate path"); paths.add(key);
      const size = change.content === null ? 0 : Buffer.byteLength(change.content, "base64");
      need(size <= MAX_WRITE_BYTES, "Candidate exceeds the native write limit (1 MiB)");
      total += size; need(total <= 16 * 1024 * 1024, "Candidates exceed 16 MiB");
    }
    const contents: (string | undefined)[] = [];
    for (const change of changes) {
      const bytes = change.content === null ? undefined : Buffer.from(change.content, "base64");
      need(!bytes || isUtf8(bytes), "Candidate is not UTF-8 text");
      contents.push(bytes?.toString("utf8"));
    }
    return contents;
  }
  private async publish(change: WorkspaceChange, content: string | undefined, id: string, ctx: ExtensionContext, signal: AbortSignal | undefined, check: () => void) {
    const target = path.resolve(ctx.cwd, change.path), service = new FileService(ctx.cwd, ctx.sessionManager.getSessionId());
    let snapshot: string | undefined;
    try {
      const assessment = await assessProtectedMutationPath(ctx.cwd, target); check();
      need(assessment.canonicalTarget && assessment.violations.length === 0, "Protected or redirected host candidate");
      await this.backend.assertWorkspaceCurrent(); check();
      if (change.before !== null) {
        const handle = await fs.open(target, "r");
        try {
          const before = await handle.stat({ bigint: true }); need(before.isFile() && before.size <= 2n * 1024n * 1024n, "Original file capacity");
          this.backend.assertSourceVersion(change.path, before);
          const original = await handle.readFile(); const after = await handle.stat({ bigint: true }); check();
          need(before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && hash(original) === change.before, "Host file changed since sandbox snapshot");
          snapshot = "snap_" + randomBytes(16).toString("base64url");
          need(service.revisions.remember({ id: snapshot, mode: "full", sessionId: service.sessionId, canonicalPath: await fs.realpath(target),
            identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs }, sha256: change.before,
            firstSeenLine: 1, lastSeenLine: 1, residentBytes: original.length, bytes: original }, service.revisions.generation), "Baseline retention failed");
        } finally { await handle.close(); }
      } else { try { await fs.lstat(target); throw new Error("Host target already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      const operation = content === undefined ? "delete" : "write";
      const input = { path: change.path, ...(content === undefined ? {} : { content, snapshot }) };
      // Refusals bind the stable guest baseline, never a freshly allocated host receipt ID.
      const policyInput = { path: change.path, ...(content === undefined ? {} : { content, snapshot: change.before ?? undefined }) };
      const runtime = this.runtime(), policy = runtime.nativePermissions;
      need(policy && policy.mode === "sandbox-write", "Writeback authority revoked");
      const authorization = await policy.authorize({ type: "tool_call", toolName: operation, toolCallId: id + ":writeback", input: policyInput } as any, ctx, this.definitions.get(operation));
      try {
        check(); authorization.consume(policyInput, id + ":writeback", operation, signal);
        const item = await service.prepare(operation, input, signal, operation === "write" ? change.before === null ? "create" : "overwrite" : undefined);
        try {
          await this.backend.assertWorkspaceCurrent(); check();
          // A delete has no revision input: ensure prepare captured the original source,
          // then let FileService guard that prepared identity at the physical commit.
          if (change.before !== null) this.backend.assertSourceVersion(change.path, await fs.lstat(target, { bigint: true }));
          check();
          const receipt = await service.execute(item, id, { signal, assertCurrent: check, record: entry => runtime.appendEntry("sandbox-writeback-v1", entry) });
          need(receipt.ok, "Host commit did not succeed (" + receipt.status + "): " + (receipt.cause ?? "inspect the writeback receipt"));
          await this.backend.recordPublication(change.path, operation === "delete"); return receipt;
        }
        finally { service.release(item); }
      } finally { authorization.release(); }
    } finally { service.dispose(); }
  }
  async close(): Promise<void> { await this.backend.close(); }
  async drain(): Promise<void> { await this.backend.drain(); }
  get diagnostics() { return this.backend.diagnostics; }
}
