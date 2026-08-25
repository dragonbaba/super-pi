import { createHash, type Hash } from "node:crypto";

export const SESSION_PERMISSION_STATE_TYPE = "session-permission-state-v1";
export const SESSION_PERMISSION_AUDIT_TYPE = "session-permission-audit-v1";
export const SESSION_PERMISSION_EVENT = "session-permission:state-v1";
const PERMISSION_PATH_APPROVAL = Symbol.for("pi.session-permission.path-approval.v2");
const SUBAGENT_WORKSPACE_DELEGATION = Symbol.for("pi.session-permission.subagent-workspace-delegation.v1");
const STRUCTURED_READONLY_WORKSPACE_DELEGATION = Symbol.for("pi.session-permission.structured-readonly-workspace-delegation.v1");
const BROWSER_EXEC_AUTHORIZATION = Symbol.for("pi.session-permission.browser-exec-authorization.v1");
const CONSUMED_ATTACHMENT_DESCRIPTOR: PropertyDescriptor = Object.freeze({
  configurable: true,
  enumerable: false,
  writable: false,
  value: undefined,
});

export type SessionPermissionMode = "read-only" | "workspace-write" | "full-access";
export type SessionApprovalPolicy = "ask" | "never-ask";

export type SessionAllowRuleKind = "exact" | "prefix";

export interface SessionAllowRule {
  id: string;
  kind: SessionAllowRuleKind;
  pattern: string;
  label: string;
}

export interface PermissionPathApproval {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  operation: "edit" | "write" | "lsp_fix";
  requestHash: string;
  canonicalTarget: string;
  protectedRoots: readonly string[];
}

export interface SubagentWorkspaceGrant {
  canonicalCwd: string;
  device: number;
  inode: number;
  permissionMode: SessionPermissionMode;
  writable: boolean;
  source: "primary" | "additional" | "full-access-exact";
}

export interface SubagentWorkspaceDelegation {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  grants: readonly SubagentWorkspaceGrant[];
}

export interface StructuredReadonlyPathGrant {
  canonicalRoot: string;
  rootDevice: number;
  rootInode: number;
  source: "primary" | "additional" | "full-access-exact";
}

export interface StructuredReadonlyWorkspaceDelegation extends StructuredReadonlyPathGrant {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  requestHash: string;
  canonicalCwd: string;
  cwdDevice: number;
  cwdInode: number;
  additionalRoots: readonly StructuredReadonlyPathGrant[];
}

export interface BrowserExecAuthorization {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  requestHash: string;
}

export interface PermissionStateSnapshot {
  schemaVersion: 3;
  mode: SessionPermissionMode;
  approvalPolicy: SessionApprovalPolicy;
  allowRules: readonly SessionAllowRule[];
  primaryWorkspace: string;
  additionalWorkspaces: readonly string[];
  sequence: number;
}

interface PermissionCarryingInput {
  [PERMISSION_PATH_APPROVAL]?: PermissionPathApproval;
  [SUBAGENT_WORKSPACE_DELEGATION]?: SubagentWorkspaceDelegation;
  [STRUCTURED_READONLY_WORKSPACE_DELEGATION]?: StructuredReadonlyWorkspaceDelegation;
  [BROWSER_EXEC_AUTHORIZATION]?: BrowserExecAuthorization;
}

export function mutationRequestHash(operation: PermissionPathApproval["operation"], input: unknown): string {
  const value = input && typeof input === "object"
    ? input as { path?: unknown; purpose?: unknown; content?: unknown; snapshot?: unknown; edits?: unknown; kind?: unknown; root?: unknown; server?: unknown; write?: unknown }
    : {};
  const hash = createHash("sha256");
  updateStructuredHashField(hash, operation);
  updateStructuredHashField(hash, value.path);
  updateStructuredHashField(hash, value.purpose);
  if (operation === "write") {
    updateStructuredHashField(hash, value.content);
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

export function permissionPathApproval(input: unknown): PermissionPathApproval | undefined {
  if (!input || typeof input !== "object") return undefined;
  return (input as PermissionCarryingInput)[PERMISSION_PATH_APPROVAL];
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
  if (approval.toolCallId !== toolCallId
    || approval.operation !== operation
    || approval.requestHash !== mutationRequestHash(operation, input)) {
    throw new Error("[POLICY_BLOCKED] Attached one-call mutation approval is stale, mismatched, or was altered after authorization.");
  }
  return approval;
}

export function attachSubagentWorkspaceDelegation(input: unknown, delegation: SubagentWorkspaceDelegation): void {
  if (!input || typeof input !== "object") throw new Error("Subagent delegation input must be an object.");
  const grants = Object.freeze(delegation.grants.map((grant) => Object.freeze({ ...grant })));
  const immutableDelegation = Object.freeze({ ...delegation, grants });
  Object.defineProperty(input, SUBAGENT_WORKSPACE_DELEGATION, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: immutableDelegation,
  });
}

export function consumeSubagentWorkspaceDelegation(input: unknown): SubagentWorkspaceDelegation | undefined {
  if (!input || typeof input !== "object") return undefined;
  const carrying = input as PermissionCarryingInput;
  const delegation = carrying[SUBAGENT_WORKSPACE_DELEGATION];
  if (delegation) Object.defineProperty(carrying, SUBAGENT_WORKSPACE_DELEGATION, CONSUMED_ATTACHMENT_DESCRIPTOR);
  return delegation;
}

function updateStructuredHashField(hash: Hash, value: unknown): void {
  if (typeof value !== "string") {
    hash.update("-1:");
    return;
  }
  hash.update(`${Buffer.byteLength(value, "utf8")}:`);
  hash.update(value);
}

export function structuredReadonlyRequestHash(input: unknown): string {
  const value = input && typeof input === "object" ? input as { cwd?: unknown; command?: unknown; args?: unknown } : {};
  const hash = createHash("sha256");
  updateStructuredHashField(hash, value.cwd);
  updateStructuredHashField(hash, value.command);
  if (!Array.isArray(value.args)) {
    hash.update("args:-1;");
  } else {
    hash.update(`args:${value.args.length};`);
    for (const argument of value.args) updateStructuredHashField(hash, argument);
  }
  return hash.digest("hex");
}

export function browserExecRequestHash(input: unknown): string {
  const value = input && typeof input === "object"
    ? input as { code?: unknown; session?: unknown; timeoutMs?: unknown; purpose?: unknown }
    : {};
  const hash = createHash("sha256");
  updateStructuredHashField(hash, value.code);
  updateStructuredHashField(hash, value.session);
  hash.update(typeof value.timeoutMs === "number" ? `timeout:${value.timeoutMs};` : "timeout:-1;");
  updateStructuredHashField(hash, value.purpose);
  return hash.digest("hex");
}

export function attachBrowserExecAuthorization(input: unknown, authorization: BrowserExecAuthorization): void {
  if (!input || typeof input !== "object") throw new Error("Browser execution input must be an object.");
  Object.defineProperty(input, BROWSER_EXEC_AUTHORIZATION, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...authorization }),
  });
}

export function consumeBrowserExecAuthorization(input: unknown, toolCallId: string): BrowserExecAuthorization {
  if (!input || typeof input !== "object") throw new Error("[POLICY_BLOCKED] Browser execution authorization is missing.");
  const carrying = input as PermissionCarryingInput;
  const authorization = carrying[BROWSER_EXEC_AUTHORIZATION];
  if (authorization) Object.defineProperty(carrying, BROWSER_EXEC_AUTHORIZATION, CONSUMED_ATTACHMENT_DESCRIPTOR);
  if (!authorization
    || authorization.toolCallId !== toolCallId
    || authorization.requestHash !== browserExecRequestHash(input)) {
    throw new Error("[POLICY_BLOCKED] Browser execution authorization is missing or stale.");
  }
  return authorization;
}

export function attachStructuredReadonlyWorkspaceDelegation(
  input: unknown,
  delegation: StructuredReadonlyWorkspaceDelegation,
): void {
  if (!input || typeof input !== "object") throw new Error("Structured read-only delegation input must be an object.");
  const frozenRoots: Readonly<StructuredReadonlyPathGrant>[] = [];
  for (const grant of delegation.additionalRoots) frozenRoots.push(Object.freeze({ ...grant }));
  const additionalRoots = Object.freeze(frozenRoots);
  Object.defineProperty(input, STRUCTURED_READONLY_WORKSPACE_DELEGATION, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...delegation, additionalRoots }),
  });
}

export function consumeStructuredReadonlyWorkspaceDelegation(
  input: unknown,
): StructuredReadonlyWorkspaceDelegation | undefined {
  if (!input || typeof input !== "object") return undefined;
  const carrying = input as PermissionCarryingInput;
  const delegation = carrying[STRUCTURED_READONLY_WORKSPACE_DELEGATION];
  if (delegation) {
    Object.defineProperty(carrying, STRUCTURED_READONLY_WORKSPACE_DELEGATION, CONSUMED_ATTACHMENT_DESCRIPTOR);
  }
  return delegation;
}
