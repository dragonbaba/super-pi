import { createHash, type Hash } from "node:crypto";
import type { NativePlan } from "./native-file-core.ts";
import type { FileCreationPlan } from "./file-creation.ts";
import type { NativeFileInvocationInput, NativeFileOperation } from "./file-operation-input.ts";

// One-call binding shared with the legacy issuer; it carries no command classification policy.
const PERMISSION_PATH_APPROVAL = Symbol.for("pi.session-permission.path-approval.v2");
const CONSUMED_ATTACHMENT_DESCRIPTOR: PropertyDescriptor = Object.freeze({ configurable: true, enumerable: false, writable: false, value: undefined });

export interface PermissionPathApproval {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  operation: "edit" | "write" | "lsp_fix" | "copy" | "delete" | "move" | "file_batch";
  requestHash: string;
  canonicalTarget: string;
  /** Native policy binds every batch source/destination, not only the first target. */
  canonicalPaths?: readonly string[];
  /** An external create must not turn into an overwrite during preparation. */
  newExternalFiles?: readonly string[];
  protectedRoots: readonly string[];
  nativePlan?: NativePlan;
  creationPlan?: FileCreationPlan;
  writePreflight?: boolean;
  assertCurrent?: () => void;
  revocationSignal?: AbortSignal;
}

interface PermissionCarryingInput { [PERMISSION_PATH_APPROVAL]?: PermissionPathApproval; }

/** Hash one journal item directly from its original array/scalar call, without a projected wrapper. */
export function nativeItemRequestHash(operation: NativeFileOperation, input: NativeFileInvocationInput, index: number): string {
  const pair = input.items?.[index], hash = createHash("sha256");
  updateStructuredHashField(hash, operation);
  updateStructuredHashField(hash, input.paths ? input.paths[index] : pair ? pair.path : input.path);
  updateStructuredHashField(hash, input.purpose);
  updateStructuredHashField(hash, pair ? pair.destination : input.destination);
  if (operation === "delete" && input.recursive !== undefined) hash.update(input.recursive ? "recursive:1;" : "recursive:0;");
  if (operation === "copy" && input.overwrite !== undefined) hash.update(input.overwrite ? "overwrite:1;" : "overwrite:0;");
  return hash.digest("hex");
}

export function mutationRequestHash(operation: PermissionPathApproval["operation"], input: unknown): string {
  const value = input && typeof input === "object"
    ? input as { path?: unknown; destination?: unknown; purpose?: unknown; content?: unknown; snapshot?: unknown; edits?: unknown; kind?: unknown; root?: unknown; server?: unknown; write?: unknown; operations?: unknown; dryRun?: unknown; mode?: unknown; paths?: unknown; items?: unknown; recursive?: unknown; overwrite?: unknown }
    : {};
  const hash = createHash("sha256");
  updateStructuredHashField(hash, operation);
  updateStructuredHashField(hash, value.path);
  updateStructuredHashField(hash, value.purpose);
  if (operation === "file_batch") {
    hash.update(value.dryRun === true ? "preview;" : "apply;");
    if (!Array.isArray(value.operations)) hash.update("invalid;");
    else for (const item of value.operations) {
      updateStructuredHashField(hash, item?.operation);
      updateStructuredHashField(hash, item?.mode);
      hash.update(mutationRequestHash(item?.operation, item));
    }
  } else if (operation === "move" || operation === "delete" || operation === "copy") {
    updateStructuredHashField(hash, value.destination);
    if (value.paths !== undefined) {
      hash.update("paths;");
      if (!Array.isArray(value.paths)) hash.update("invalid;");
      else for (const path of value.paths) updateStructuredHashField(hash, path);
    }
    if (value.items !== undefined) {
      hash.update("items;");
      if (!Array.isArray(value.items)) hash.update("invalid;");
      else for (const item of value.items) { updateStructuredHashField(hash, item?.path); updateStructuredHashField(hash, item?.destination); }
    }
    if (value.recursive !== undefined) hash.update(value.recursive === true ? "recursive:1;" : "recursive:0;");
    if (value.overwrite !== undefined) hash.update(value.overwrite === true ? "overwrite:1;" : "overwrite:0;");
    if (value.dryRun !== undefined) hash.update(value.dryRun === true ? "preview;" : "apply;");
  } else if (operation === "write") {
    updateStructuredHashField(hash, value.content);
    // Preserve the existing hash when the optional baseline is absent.
    if (value.snapshot !== undefined) { hash.update("snapshot;"); updateStructuredHashField(hash, value.snapshot); }
  } else if (operation === "edit") {
    updateStructuredHashField(hash, value.snapshot);
    if (!Array.isArray(value.edits)) {
      hash.update("edits:-1;");
    } else {
      hash.update(`edits:${value.edits.length};`);
      for (const edit of value.edits) {
        const item = edit && typeof edit === "object"
          ? edit as { oldText?: unknown; newText?: unknown; expectedLine?: unknown; kind?: unknown; start?: unknown; end?: unknown; newLines?: unknown }
          : {};
        updateStructuredHashField(hash, item.oldText);
        updateStructuredHashField(hash, item.newText);
        updateStructuredHashField(hash, item.kind);
        updateStructuredHashField(hash, item.start);
        updateStructuredHashField(hash, item.end);
        hash.update(typeof item.expectedLine === "number" ? `line:${item.expectedLine};` : "line:-1;");
        if (!Array.isArray(item.newLines)) {
          hash.update("newLines:-1;");
        } else {
          hash.update(`newLines:${item.newLines.length};`);
          for (const line of item.newLines) updateStructuredHashField(hash, line);
        }
      }
    }
  } else {
    updateStructuredHashField(hash, value.kind);
    updateStructuredHashField(hash, value.root);
    updateStructuredHashField(hash, value.server);
    hash.update(value.write === true ? "write:1;" : "write:0;");
  }
  return hash.digest("hex");
}
export function attachPermissionPathApproval(input: unknown, approval: PermissionPathApproval | undefined): void {
  if (!approval || !input || typeof input !== "object") return;
  Object.defineProperty(input, PERMISSION_PATH_APPROVAL, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...approval, protectedRoots: Object.freeze([...approval.protectedRoots]),
      canonicalPaths: approval.canonicalPaths && Object.freeze([...approval.canonicalPaths]),
      newExternalFiles: approval.newExternalFiles && Object.freeze([...approval.newExternalFiles]) }),
  });
}

export function consumePermissionPathApproval(
  input: unknown,
  toolCallId: string,
  operation: PermissionPathApproval["operation"],
): PermissionPathApproval | undefined {
  if (!input || typeof input !== "object") return undefined;
  const carrying = input as PermissionCarryingInput;
  const approval = carrying[PERMISSION_PATH_APPROVAL];
  if (approval) Object.defineProperty(carrying, PERMISSION_PATH_APPROVAL, CONSUMED_ATTACHMENT_DESCRIPTOR);
  if (!approval) return undefined;
  approval.assertCurrent?.();
  if (approval.toolCallId !== toolCallId
    || approval.operation !== operation
    || approval.requestHash !== mutationRequestHash(operation, input)) {
    throw new Error("[POLICY_BLOCKED] Attached one-call mutation approval is stale, mismatched, or was altered after authorization.");
  }
  return approval;
}

function updateStructuredHashField(hash: Hash, value: unknown): void {
  if (typeof value !== "string") {
    hash.update("-1:");
    return;
  }
  hash.update(`${Buffer.byteLength(value, "utf8")}:`);
  hash.update(value);
}
