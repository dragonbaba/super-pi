import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type { SessionAllowRule, SessionApprovalPolicy, SessionPermissionMode } from "./permission-contract.ts";
import { SESSION_PERMISSION_STATE_TYPE } from "./permission-contract.ts";

const MAX_ADDITIONAL_WORKSPACES = 16;
const MAX_ALLOW_RULES = 32;
const MAX_PATH_CHARS = 4_096;
const MAX_RULE_ID_CHARS = 64;
const MAX_RULE_PATTERN_CHARS = 4_096;
const MAX_RULE_LABEL_CHARS = 320;
const MODE_VALUES = new Set<SessionPermissionMode>(["read-only", "workspace-write", "full-access"]);
const APPROVAL_POLICY_VALUES = new Set<SessionApprovalPolicy>(["ask", "never-ask"]);

export interface WorkspaceGrant {
  requestedPath: string;
  canonicalPath: string;
  device: number;
  inode: number;
}

interface PersistedPermissionState {
  schemaVersion: 1 | 2 | 3;
  mode: SessionPermissionMode;
  approvalPolicy: SessionApprovalPolicy;
  allowRules: SessionAllowRule[];
  workspaces: WorkspaceGrant[];
  sequence: number;
}

export interface PermissionStateCheckpoint {
  mode: SessionPermissionMode;
  approvalPolicy: SessionApprovalPolicy;
  allowRules: SessionAllowRule[];
  workspaces: WorkspaceGrant[];
  sequence: number;
}

export interface PermissionTargetAssessment {
  canonicalTarget?: string;
  workspace?: WorkspaceGrant;
  unverifiableReason?: "unverifiable_target" | "workspace_identity_changed";
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  let probe = resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(probe), ...suffix);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(probe.slice(parent.length).replaceAll("/", "").replaceAll("\\", ""));
      probe = parent;
    }
  }
}

async function workspaceGrant(path: string, cwd: string): Promise<WorkspaceGrant> {
  if (!path || path.length > MAX_PATH_CHARS) throw new Error("Workspace path must contain 1-4096 characters.");
  const requestedPath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const canonicalPath = await realpath(requestedPath);
  const info = await lstat(canonicalPath);
  if (!info.isDirectory()) throw new Error("Workspace path must resolve to an existing directory.");
  if (canonicalPath === parse(canonicalPath).root) throw new Error("A filesystem root cannot be added as a workspace.");
  return { requestedPath, canonicalPath, device: info.dev, inode: info.ino };
}

function validStoredGrant(value: unknown): value is WorkspaceGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<WorkspaceGrant>;
  return typeof grant.requestedPath === "string"
    && grant.requestedPath.length > 0
    && grant.requestedPath.length <= MAX_PATH_CHARS
    && typeof grant.canonicalPath === "string"
    && grant.canonicalPath.length > 0
    && grant.canonicalPath.length <= MAX_PATH_CHARS
    && typeof grant.device === "number"
    && Number.isFinite(grant.device)
    && grant.device >= 0
    && typeof grant.inode === "number"
    && Number.isFinite(grant.inode)
    && grant.inode >= 0;
}

function validStoredRule(value: unknown): value is SessionAllowRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<SessionAllowRule>;
  return typeof rule.id === "string"
    && rule.id.length > 0
    && rule.id.length <= MAX_RULE_ID_CHARS
    && (rule.kind === "exact" || rule.kind === "prefix")
    && typeof rule.pattern === "string"
    && rule.pattern.length > 0
    && rule.pattern.length <= MAX_RULE_PATTERN_CHARS
    && !rule.pattern.includes("\0")
    && typeof rule.label === "string"
    && rule.label.length > 0
    && rule.label.length <= MAX_RULE_LABEL_CHARS;
}

function parsePersistedState(value: unknown): PersistedPermissionState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<PersistedPermissionState>;
  if ((state.schemaVersion !== 1 && state.schemaVersion !== 2 && state.schemaVersion !== 3) || !MODE_VALUES.has(state.mode as SessionPermissionMode)) return undefined;
  if (!Array.isArray(state.workspaces) || state.workspaces.length > MAX_ADDITIONAL_WORKSPACES) return undefined;
  const workspaces: WorkspaceGrant[] = [];
  for (const value of state.workspaces) {
    if (!validStoredGrant(value)) return undefined;
    workspaces.push({
      requestedPath: value.requestedPath,
      canonicalPath: value.canonicalPath,
      device: value.device,
      inode: value.inode,
    });
  }
  const approvalPolicy = state.schemaVersion !== 1 && APPROVAL_POLICY_VALUES.has(state.approvalPolicy as SessionApprovalPolicy)
    ? state.approvalPolicy as SessionApprovalPolicy
    : "ask";
  const allowRules: SessionAllowRule[] = [];
  if (state.schemaVersion === 3) {
    if (!Array.isArray(state.allowRules) || state.allowRules.length > MAX_ALLOW_RULES) return undefined;
    for (const value of state.allowRules) {
      if (!validStoredRule(value)) return undefined;
      allowRules.push({ id: value.id, kind: value.kind, pattern: value.pattern, label: value.label });
    }
  }
  return {
    schemaVersion: 3,
    mode: state.mode as SessionPermissionMode,
    approvalPolicy,
    allowRules,
    workspaces,
    sequence: typeof state.sequence === "number" && Number.isSafeInteger(state.sequence) && state.sequence >= 0
      ? state.sequence
      : 0,
  };
}

async function grantIdentityIsCurrent(grant: WorkspaceGrant): Promise<boolean> {
  try {
    const canonicalPath = await realpath(grant.requestedPath);
    if (canonicalPath !== grant.canonicalPath) return false;
    const info = await lstat(canonicalPath);
    return info.isDirectory() && info.dev === grant.device && info.ino === grant.inode;
  } catch {
    return false;
  }
}

export class SessionPermissionState {
  #mode: SessionPermissionMode = "workspace-write";
  #approvalPolicy: SessionApprovalPolicy = "ask";
  #primary?: WorkspaceGrant;
  #additional: WorkspaceGrant[] = [];
  #allowRules: SessionAllowRule[] = [];
  #sequence = 0;

  get mode(): SessionPermissionMode {
    return this.#mode;
  }

  get approvalPolicy(): SessionApprovalPolicy {
    return this.#approvalPolicy;
  }

  get primary(): WorkspaceGrant {
    if (!this.#primary) throw new Error("Session permission state is not initialized.");
    return this.#primary;
  }

  get additional(): readonly WorkspaceGrant[] {
    return this.#additional;
  }

  get allowRules(): readonly SessionAllowRule[] {
    return this.#allowRules;
  }

  get sequence(): number {
    return this.#sequence;
  }

  checkpoint(): PermissionStateCheckpoint {
    return {
      mode: this.#mode,
      approvalPolicy: this.#approvalPolicy,
      allowRules: this.#allowRules.map((rule) => ({ ...rule })),
      workspaces: this.#additional.map((grant) => ({ ...grant })),
      sequence: this.#sequence,
    };
  }

  restoreCheckpoint(checkpoint: PermissionStateCheckpoint): void {
    this.#mode = checkpoint.mode;
    this.#approvalPolicy = checkpoint.approvalPolicy;
    this.#allowRules = checkpoint.allowRules.map((rule) => ({ ...rule }));
    this.#additional = checkpoint.workspaces.map((grant) => ({ ...grant }));
    this.#sequence = checkpoint.sequence;
  }

  async restore(cwd: string, branch: readonly unknown[]): Promise<void> {
    this.#primary = await workspaceGrant(cwd, cwd);
    this.#mode = "workspace-write";
    this.#approvalPolicy = "ask";
    this.#additional = [];
    this.#allowRules = [];
    this.#sequence = 0;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry?.type !== "custom" || entry.customType !== SESSION_PERMISSION_STATE_TYPE) continue;
      const stored = parsePersistedState(entry.data);
      if (!stored) continue;
      this.#mode = stored.mode;
      this.#approvalPolicy = stored.approvalPolicy;
      this.#additional = stored.workspaces;
      this.#allowRules = stored.allowRules;
      this.#sequence = stored.sequence;
      break;
    }
  }

  setMode(mode: SessionPermissionMode): boolean {
    if (!MODE_VALUES.has(mode) || this.#mode === mode) return false;
    this.#mode = mode;
    this.#sequence += 1;
    return true;
  }

  setApprovalPolicy(policy: SessionApprovalPolicy): boolean {
    if (!APPROVAL_POLICY_VALUES.has(policy) || this.#approvalPolicy === policy) return false;
    this.#approvalPolicy = policy;
    this.#sequence += 1;
    return true;
  }

  addAllowRule(rule: SessionAllowRule): boolean {
    if (!validStoredRule(rule)) throw new Error("Session allow rule is invalid or exceeds its bounds.");
    for (const existing of this.#allowRules) if (existing.id === rule.id) return false;
    if (this.#allowRules.length >= MAX_ALLOW_RULES) throw new Error(`A Session can contain at most ${MAX_ALLOW_RULES} allow rules.`);
    this.#allowRules.push({ id: rule.id, kind: rule.kind, pattern: rule.pattern, label: rule.label });
    this.#sequence += 1;
    return true;
  }

  removeAllowRule(id: string): SessionAllowRule | undefined {
    if (!id) return undefined;
    let matchIndex = -1;
    for (let index = 0; index < this.#allowRules.length; index++) {
      const candidate = this.#allowRules[index]!.id;
      if (candidate === id) {
        matchIndex = index;
        break;
      }
      if (!candidate.startsWith(id)) continue;
      if (matchIndex >= 0) return undefined;
      matchIndex = index;
    }
    if (matchIndex < 0) return undefined;
    const removed = this.#allowRules[matchIndex]!;
    this.#allowRules.splice(matchIndex, 1);
    this.#sequence += 1;
    return removed;
  }

  clearAllowRules(): number {
    const count = this.#allowRules.length;
    if (count === 0) return 0;
    this.#allowRules = [];
    this.#sequence += 1;
    return count;
  }

  async addWorkspace(path: string, cwd: string): Promise<WorkspaceGrant> {
    const grant = await workspaceGrant(path, cwd);
    if (grant.canonicalPath === this.primary.canonicalPath) throw new Error("The primary workspace is already writable.");
    for (const existing of this.#additional) {
      if (existing.requestedPath === grant.requestedPath || existing.canonicalPath === grant.canonicalPath) {
        throw new Error("That workspace is already added to this Session.");
      }
    }
    if (this.#additional.length >= MAX_ADDITIONAL_WORKSPACES) {
      throw new Error(`A Session can contain at most ${MAX_ADDITIONAL_WORKSPACES} additional workspaces.`);
    }
    this.#additional.push(grant);
    this.#sequence += 1;
    return grant;
  }

  async removeWorkspace(path: string, cwd: string): Promise<WorkspaceGrant> {
    if (!path || path.length > MAX_PATH_CHARS) throw new Error("Workspace path must contain 1-4096 characters.");
    const requestedPath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    let canonicalPath: string | undefined;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch {
      canonicalPath = undefined;
    }
    let index = -1;
    for (let current = 0; current < this.#additional.length; current++) {
      const grant = this.#additional[current]!;
      if (grant.requestedPath === requestedPath || (canonicalPath !== undefined && grant.canonicalPath === canonicalPath)) {
        index = current;
        break;
      }
    }
    if (index < 0) throw new Error("That exact workspace is not added to this Session.");
    const removed = this.#additional[index]!;
    this.#additional.splice(index, 1);
    this.#sequence += 1;
    return removed;
  }

  serialized(): PersistedPermissionState {
    const workspaces: WorkspaceGrant[] = [];
    for (const grant of this.#additional) {
      workspaces.push({
        requestedPath: grant.requestedPath,
        canonicalPath: grant.canonicalPath,
        device: grant.device,
        inode: grant.inode,
      });
    }
    const allowRules: SessionAllowRule[] = [];
    for (const rule of this.#allowRules) allowRules.push({ id: rule.id, kind: rule.kind, pattern: rule.pattern, label: rule.label });
    return {
      schemaVersion: 3,
      mode: this.#mode,
      approvalPolicy: this.#approvalPolicy,
      allowRules,
      workspaces,
      sequence: this.#sequence,
    };
  }

  async assessTarget(path: string, cwd: string): Promise<PermissionTargetAssessment> {
    let canonicalTarget: string;
    try {
      canonicalTarget = await canonicalizeProspectivePath(isAbsolute(path) ? path : resolve(cwd, path));
    } catch {
      return { unverifiableReason: "unverifiable_target" };
    }
    if (isInside(this.primary.canonicalPath, canonicalTarget)) {
      return { canonicalTarget, workspace: this.primary };
    }
    for (const grant of this.#additional) {
      if (!isInside(grant.canonicalPath, canonicalTarget)) continue;
      if (!(await grantIdentityIsCurrent(grant))) {
        return { canonicalTarget, unverifiableReason: "workspace_identity_changed" };
      }
      return { canonicalTarget, workspace: grant };
    }
    return { canonicalTarget };
  }
}

export function isSessionPermissionMode(value: string): value is SessionPermissionMode {
  return MODE_VALUES.has(value as SessionPermissionMode);
}

export function isSessionApprovalPolicy(value: string): value is SessionApprovalPolicy {
  return APPROVAL_POLICY_VALUES.has(value as SessionApprovalPolicy);
}
