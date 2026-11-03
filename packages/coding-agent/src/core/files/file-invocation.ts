import { createHash, type Hash } from "node:crypto";
import type { NativePlan } from "./native-file-core.ts";
import type { FileCreationPlan } from "./file-creation.ts";

// One-call binding shared with the legacy issuer; it carries no command classification policy.
const PERMISSION_PATH_APPROVAL = Symbol.for("pi.session-permission.path-approval.v2");
const CONSUMED_ATTACHMENT_DESCRIPTOR: PropertyDescriptor = Object.freeze({ configurable: true, enumerable: false, writable: false, value: undefined });

export interface PermissionPathApproval {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  operation: "edit" | "write" | "lsp_fix" | "delete" | "move" | "file_batch";
  requestHash: string;
  canonicalTarget: string;
  protectedRoots: readonly string[];
  nativePlan?: NativePlan;
  creationPlan?: FileCreationPlan;
  writePreflight?: boolean;
  assertCurrent?: () => void;
  revocationSignal?: AbortSignal;
}

interface PermissionCarryingInput { [PERMISSION_PATH_APPROVAL]?: PermissionPathApproval; }

export function mutationRequestHash(operation: PermissionPathApproval["operation"], input: unknown): string {
  const value = input && typeof input === "object"
    ? input as { path?: unknown; destination?: unknown; purpose?: unknown; content?: unknown; snapshot?: unknown; edits?: unknown; kind?: unknown; root?: unknown; server?: unknown; write?: unknown; operations?: unknown; dryRun?: unknown; mode?: unknown }
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
  } else if (operation === "move" || operation === "delete") {
    updateStructuredHashField(hash, value.destination);
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
    value: Object.freeze({ ...approval, protectedRoots: Object.freeze([...approval.protectedRoots]) }),
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
