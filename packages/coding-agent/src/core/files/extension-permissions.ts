import { createHash, type Hash } from "node:crypto";
export { attachPermissionPathApproval, consumePermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "./file-invocation.ts";

export const SESSION_PERMISSION_STATE_TYPE = "session-permission-state-v1";
export const SESSION_PERMISSION_AUDIT_TYPE = "session-permission-audit-v1";
export const SESSION_PERMISSION_EVENT = "session-permission:state-v1";
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
  backend?: "bash" | "powershell";
  cwd?: string;
  id: string;
  kind: SessionAllowRuleKind;
  pattern: string;
  label: string;
}

export interface SubagentWorkspaceGrant {
  canonicalCwd: string;
  device: number;
  inode: number;
  permissionMode: SessionPermissionMode;
  writable: boolean;
  source: "primary" | "additional" | "full-access-exact";
}

interface CurrentInvocationAuthority {
  /** Live issuer check, never serialized or recovered from session history. */
  assertCurrent(): void;
  revocationSignal: AbortSignal;
}

function assertInvocationAuthority(value: CurrentInvocationAuthority): void {
  if (typeof value.assertCurrent !== "function") throw new Error("[POLICY_BLOCKED] Current invocation authorization is missing.");
  if (!(value.revocationSignal instanceof AbortSignal)) throw new Error("[POLICY_BLOCKED] Current invocation revocation signal is missing.");
  value.revocationSignal.throwIfAborted();
  value.assertCurrent();
}

export interface SubagentWorkspaceDelegation extends CurrentInvocationAuthority {
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

export interface StructuredReadonlyWorkspaceDelegation extends StructuredReadonlyPathGrant, CurrentInvocationAuthority {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  requestHash: string;
  canonicalCwd: string;
  /** Native issuer base for a relative cwd; legacy grants use canonicalRoot. */
  invocationCwd?: string;
  cwdDevice: number;
  cwdInode: number;
  additionalRoots: readonly StructuredReadonlyPathGrant[];
}

export interface BrowserExecAuthorization extends CurrentInvocationAuthority {
  schemaVersion: 1;
  sequence: number;
  toolCallId: string;
  requestHash: string;
}

export interface PermissionStateSnapshot {
  schemaVersion: 4;
  mode: SessionPermissionMode;
  approvalPolicy: SessionApprovalPolicy;
  allowRules: readonly SessionAllowRule[];
  primaryWorkspace: string;
  additionalWorkspaces: readonly string[];
  sequence: number;
}

interface PermissionCarryingInput {
  [SUBAGENT_WORKSPACE_DELEGATION]?: SubagentWorkspaceDelegation;
  [STRUCTURED_READONLY_WORKSPACE_DELEGATION]?: StructuredReadonlyWorkspaceDelegation;
  [BROWSER_EXEC_AUTHORIZATION]?: BrowserExecAuthorization;
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
  if (delegation) assertInvocationAuthority(delegation);
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
  return assertBrowserExecAuthorization(authorization, input, toolCallId);
}

/** Revalidate the consumed grant after asynchronous preparation, immediately before execution. */
export function assertBrowserExecAuthorization(authorization: BrowserExecAuthorization | undefined, input: unknown, toolCallId: string): BrowserExecAuthorization {
  if (!authorization
    || authorization.toolCallId !== toolCallId
    || authorization.requestHash !== browserExecRequestHash(input)) {
    throw new Error("[POLICY_BLOCKED] Browser execution authorization is missing or stale.");
  }
  assertInvocationAuthority(authorization);
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
    assertInvocationAuthority(delegation);
  }
  return delegation;
}
