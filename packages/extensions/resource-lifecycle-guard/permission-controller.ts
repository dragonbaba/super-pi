import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@super-pi/coding-agent";
import { inspectHighRiskBashMutation, type HighRiskMutationScan } from "./core.ts";
import { inspectBashPermissionScope } from "./permission-bash.ts";
import {
  attachBrowserExecAuthorization,
  browserExecRequestHash,
  attachPermissionPathApproval,
  attachStructuredReadonlyWorkspaceDelegation,
  attachSubagentWorkspaceDelegation,
  mutationRequestHash,
  structuredReadonlyRequestHash,
  SESSION_PERMISSION_AUDIT_TYPE,
  SESSION_PERMISSION_EVENT,
  SESSION_PERMISSION_STATE_TYPE,
  type SessionAllowRuleKind,
  type SessionApprovalPolicy,
  type SessionPermissionMode,
  type StructuredReadonlyPathGrant,
  type SubagentWorkspaceGrant,
} from "./permission-contract.ts";
import { createSessionAllowRule, sessionAllowRuleMatches, simpleCommandPrefix } from "./permission-rule.ts";
import {
  isSessionApprovalPolicy,
  isSessionPermissionMode,
  SessionPermissionState,
  type PermissionStateCheckpoint,
  type PermissionTargetAssessment,
} from "./permission-state.ts";
import { protectedRootViolations } from "./mutation-policy.ts";
import { assessProtectedMutationPath } from "../mutation-guard-write/protected-path-policy.ts";
import { classifyStructuredReadonlyArguments, type StructuredReadonlyCommandName } from "./structured-argv.ts";

const STATUS_KEY = "session-permissions";
const MAX_PURPOSE_CHARS = 800;
const MAX_COMMAND_DISPLAY_CHARS = 4_000;
const MAX_REJECTION_CHARS = 800;
const MAX_REJECTIONS = 32;
const MODE_LABELS: Record<SessionPermissionMode, string> = {
  "read-only": "1 · 只读",
  "workspace-write": "2 · 工作区读写（默认）",
  "full-access": "3 · 全部读写",
};
const MODE_CHOICES = [MODE_LABELS["read-only"], MODE_LABELS["workspace-write"], MODE_LABELS["full-access"]];
const LABEL_TO_MODE = new Map<string, SessionPermissionMode>([
  [MODE_LABELS["read-only"], "read-only"],
  [MODE_LABELS["workspace-write"], "workspace-write"],
  [MODE_LABELS["full-access"], "full-access"],
]);
const APPROVAL_LABELS: Record<SessionApprovalPolicy, string> = {
  ask: "审批 · 按需询问（默认）",
  "never-ask": "审批 · 已知范围内不询问（未知/高风险仍确认）",
};
const APPROVAL_CHOICES = [APPROVAL_LABELS.ask, APPROVAL_LABELS["never-ask"]];
const LABEL_TO_APPROVAL = new Map<string, SessionApprovalPolicy>([
  [APPROVAL_LABELS.ask, "ask"],
  [APPROVAL_LABELS["never-ask"], "never-ask"],
]);
const MANAGE_RULES = "管理当前 Session 指令白名单";
const APPROVAL_FLOW_CHOICES = [...APPROVAL_CHOICES, MANAGE_RULES];
const ALLOW_ONCE = "仅允许本次";
const ALLOW_SESSION_EXACT = "将当前完整指令加入 Session 白名单";
const ALLOW_SESSION_PREFIX = "将当前指令前缀加入 Session 白名单";
const ADD_EXACT_RULE = "添加精确指令白名单";
const ADD_PREFIX_RULE = "添加指令前缀白名单";
const SWITCH_WORKSPACE = "切换到工作区读写并允许";
const SWITCH_FULL = "切换到全部读写并允许";
const CLEAR_RULES = "清空全部 Session 白名单";
const BACK = "返回";
const REJECT_REASON = "拒绝并填写理由";
const REJECT = "拒绝";
const EDIT_CLASSES = ["file:edit"] as const;
const WRITE_CLASSES = ["file:write"] as const;
const LSP_FIX_CLASSES = ["file:lsp_fix"] as const;

interface ToolCallEventShape {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

interface ToolCallBlock {
  block: true;
  reason: string;
}

interface SubagentInputShape {
  agent?: unknown;
  task?: unknown;
  cwd?: unknown;
  readOnly?: unknown;
  tasks?: unknown;
  chain?: unknown;
}

interface SubagentTaskRequest {
  cwd: string;
  readOnly: boolean;
}

function subagentTaskRequests(input: unknown, defaultCwd: string): SubagentTaskRequest[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as SubagentInputShape;
  const hasTasks = Array.isArray(value.tasks) && value.tasks.length > 0;
  const hasChain = Array.isArray(value.chain) && value.chain.length > 0;
  const hasSingle = typeof value.agent === "string" && typeof value.task === "string";
  if (Number(hasTasks) + Number(hasChain) + Number(hasSingle) !== 1) return undefined;
  const items = hasTasks ? value.tasks as unknown[] : hasChain ? value.chain as unknown[] : [value];
  const requests: SubagentTaskRequest[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return undefined;
    const task = item as { cwd?: unknown; readOnly?: unknown };
    if (task.cwd !== undefined && typeof task.cwd !== "string") return undefined;
    if (task.readOnly !== undefined && typeof task.readOnly !== "boolean") return undefined;
    requests.push({ cwd: task.cwd ?? defaultCwd, readOnly: task.readOnly === true });
  }
  return requests;
}

interface OperationRequest {
  operation: "edit" | "write" | "lsp_fix" | "bash" | "browser_exec";
  purpose?: string;
  summary: string;
  exactTargets: string[];
  targetAssessments: PermissionTargetAssessment[];
  classes: readonly string[];
  pathApproval?: { canonicalTarget: string; protectedRoots: string[] };
  highRisk: boolean;
  opaqueScript: boolean;
  primitives: string[];
  fingerprintMaterial: string;
  bashCommand?: string;
}

interface RejectionRecord {
  reason?: string;
}

function boundedText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function displayRuleId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}

function operationPurpose(event: ToolCallEventShape, ctx: ExtensionContext): string | undefined {
  if (event.input && typeof event.input === "object" && "purpose" in event.input) {
    const value = (event.input as { purpose?: unknown }).purpose;
    if (typeof value === "string" && value.trim()) return boundedText(value, MAX_PURPOSE_CHARS);
  }
  const branch = ctx.sessionManager.getBranch();
  for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = branch[entryIndex] as { type?: unknown; message?: unknown };
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    let latestText: string | undefined;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const content = part as { type?: unknown; text?: unknown; id?: unknown };
      if (content.type === "text" && typeof content.text === "string" && content.text.trim()) {
        latestText = boundedText(content.text, MAX_PURPOSE_CHARS);
        continue;
      }
      if (content.type === "toolCall" && content.id === event.toolCallId) return latestText;
    }
  }
  return undefined;
}

function targetLines(targets: readonly string[]): string {
  if (targets.length === 0) return "- 无静态目标";
  let output = "";
  for (let index = 0; index < targets.length; index++) {
    const next = `- ${targets[index]}\n`;
    if (output.length + next.length > MAX_COMMAND_DISPLAY_CHARS) return `${output}- …`;
    output += next;
  }
  return output.trimEnd();
}

function structuredPermissionBlock(
  operation: string,
  mode: SessionPermissionMode,
  policyReason: string,
  options: {
    highRisk?: boolean;
    opaqueScript?: boolean;
    retryable?: boolean;
    rejectionReason?: string;
    primitives?: readonly string[];
  } = {},
): string {
  const primitives = options.primitives ?? [];
  const workspaceEscape = primitives.includes("workspace_escape")
    && (policyReason === "scope_denied" || policyReason === "confirmation_required");
  const legalNextStep = operation === "structured_readonly_command"
    ? "Ask the user to add the exact read root with /add_workspace <path>, or change access through /permissions. Do not retry through Bash or another tool."
    : operation === "browser_exec"
      ? "Change /permissions or approve this exact browser script."
      : "Ask the user to add the exact target directory with /add_workspace <path>, or to change access through /permissions. Do not retry the mutation through Bash or an ad-hoc script.";
  if (operation === "structured_readonly_command") {
    let reason = `POLICY_BLOCKED: ${operation}: ${policyReason}`;
    if (primitives.length > 0) reason += ` (${primitives.join(", ")})`;
    reason += ".";
    if (workspaceEscape) reason += ` Retry: ${legalNextStep}`;
    return reason;
  }
  return JSON.stringify({
    ok: false,
    category: "POLICY_BLOCKED",
    operation,
    permissionMode: mode,
    policyReason,
    highRisk: options.highRisk === true,
    opaqueScript: options.opaqueScript === true,
    primitives,
    rejectionReason: options.rejectionReason,
    stateChanged: false,
    retryable: options.retryable ?? true,
    ...(workspaceEscape ? { legalNextStep } : {}),
  });
}

function structuredInputValidationBlock(operation: string, message: string): string {
  if (operation === "structured_readonly_command") {
    return `INPUT_VALIDATION: ${operation}: ${message}`;
  }
  return JSON.stringify({
    ok: false,
    category: "INPUT_VALIDATION",
    operation,
    cause: message,
    stateChanged: false,
    retryable: false,
  });
}

function sensitiveProtectedRoots(roots: readonly string[]): boolean {
  for (const root of roots) if (root !== "workspace_escape") return true;
  return false;
}

function hasUnverifiableAssessment(assessments: readonly PermissionTargetAssessment[]): boolean {
  for (const assessment of assessments) if (assessment.unverifiableReason !== undefined) return true;
  return false;
}

function allTargetsInsideWorkspaces(assessments: readonly PermissionTargetAssessment[]): boolean {
  for (const assessment of assessments) if (assessment.workspace === undefined) return false;
  return true;
}

function canonicalTargets(assessments: readonly PermissionTargetAssessment[]): string[] {
  const targets: string[] = [];
  for (const assessment of assessments) if (assessment.canonicalTarget) targets.push(assessment.canonicalTarget);
  return targets;
}

function appendUniqueBounded(values: string[], value: string): boolean {
  for (const current of values) if (current === value) return true;
  if (values.length >= 16) return false;
  values.push(value);
  return true;
}

export class SessionPermissionController {
  readonly #pi: ExtensionAPI;
  readonly #state = new SessionPermissionState();
  readonly #rejections = new Map<string, RejectionRecord>();
  #committedState?: PermissionStateCheckpoint;
  #auditSequence = 0;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  get state(): SessionPermissionState {
    return this.#state;
  }

  registerCommands(): void {
    this.#pi.registerCommand("permissions", {
      description: "管理当前 Session 的访问范围、审批策略和指令白名单",
      handler: (args, ctx) => this.#permissionsCommand(args, ctx),
    });
    this.#pi.registerCommand("add_workspace", {
      description: "向当前 Session 添加一个具有工作区读写权限的目录",
      handler: (args, ctx) => this.#addWorkspaceCommand(args, ctx),
    });
    this.#pi.registerCommand("remove_workspace", {
      description: "从当前 Session 移除先前添加的工作区路径",
      handler: (args, ctx) => this.#removeWorkspaceCommand(args, ctx),
    });
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    await this.#state.restore(ctx.cwd, ctx.sessionManager.getBranch());
    this.#committedState = this.#state.checkpoint();
    this.#rejections.clear();
    this.#publish(ctx);
  }

  systemGuidance(): string {
    let workspaces = this.#state.primary.canonicalPath;
    for (const grant of this.#state.additional) workspaces += `; ${grant.canonicalPath}`;
    return `Filesystem permissions: mode=${this.#state.mode}; approval=${this.#state.approvalPolicy}; writable roots=${workspaces}. Use /permissions before accessing outside these roots; session command allow rules may apply.`;
  }

  async authorizeToolCall(event: ToolCallEventShape, ctx: ExtensionContext): Promise<ToolCallBlock | undefined> {
    if (event.toolName === "structured_readonly_command") return this.#authorizeStructuredReadonlyDelegation(event, ctx);
    if (event.toolName === "subagent") return this.#authorizeSubagentDelegation(event, ctx);
    const request = await this.#buildRequest(event, ctx);
    if (!request) return undefined;
    if (hasUnverifiableAssessment(request.targetAssessments)) {
      this.#appendAudit(request, "blocked", "unverifiable_target", this.#state.mode, this.#state.mode, false);
      return {
        block: true,
        reason: structuredPermissionBlock(request.operation, this.#state.mode, "unverifiable_target", {
          highRisk: request.highRisk,
          opaqueScript: request.opaqueScript,
          retryable: false,
          primitives: request.primitives,
        }),
      };
    }

    const scopeAllowed = this.#scopeAllows(request);
    if (request.bashCommand && this.#ruleScopeAllows(request)) {
      for (const rule of this.#state.allowRules) {
        if (!sessionAllowRuleMatches(rule, request.bashCommand)) continue;
        this.#appendAudit(request, "approved", "session_rule_match", this.#state.mode, this.#state.mode, false);
        return undefined;
      }
    }
    if (this.#state.approvalPolicy === "never-ask") {
      if (scopeAllowed) {
        this.#attachPathApproval(event, request);
        return undefined;
      }
      if (!request.highRisk && !request.opaqueScript) {
        this.#appendAudit(request, "blocked", "scope_denied", this.#state.mode, this.#state.mode, false);
        return {
          block: true,
          reason: structuredPermissionBlock(request.operation, this.#state.mode, "scope_denied", {
            highRisk: request.highRisk,
            opaqueScript: request.opaqueScript,
            primitives: request.primitives,
          }),
        };
      }
    }
    if (scopeAllowed && !request.highRisk && !request.opaqueScript) {
      this.#attachPathApproval(event, request);
      return undefined;
    }

    const fingerprint = createHash("sha256")
      .update(`${request.operation}\u0000${request.fingerprintMaterial}\u0000${request.purpose ?? ""}`)
      .digest("hex");
    const priorRejection = this.#rejections.get(fingerprint);
    if (priorRejection) {
      this.#appendAudit(request, "blocked", "unchanged_rejected_request", this.#state.mode, this.#state.mode, Boolean(priorRejection.reason));
      return {
        block: true,
        reason: structuredPermissionBlock(request.operation, this.#state.mode, "unchanged_rejected_request", {
          highRisk: request.highRisk,
          opaqueScript: request.opaqueScript,
          rejectionReason: priorRejection.reason,
          primitives: request.primitives,
        }),
      };
    }
    if (!ctx.hasUI) {
      this.#appendAudit(request, "blocked", "confirmation_required", this.#state.mode, this.#state.mode, false);
      return {
        block: true,
        reason: structuredPermissionBlock(request.operation, this.#state.mode, "confirmation_required", {
          highRisk: request.highRisk,
          opaqueScript: request.opaqueScript,
          primitives: request.primitives,
        }),
      };
    }

    const modeBefore = this.#state.mode;
    const choices = [ALLOW_ONCE];
    const commandPrefix = request.bashCommand ? simpleCommandPrefix(request.bashCommand) : undefined;
    if (this.#state.approvalPolicy === "ask" && request.bashCommand) {
      choices.push(ALLOW_SESSION_EXACT);
      if (commandPrefix) choices.push(`${ALLOW_SESSION_PREFIX}：${commandPrefix} *`);
    }
    if (!request.highRisk && !request.opaqueScript) {
      const insideAuthorizedWorkspace = allTargetsInsideWorkspaces(request.targetAssessments);
      if (modeBefore === "read-only" && insideAuthorizedWorkspace) choices.push(SWITCH_WORKSPACE);
      if (modeBefore !== "full-access") choices.push(SWITCH_FULL);
    }
    choices.push(REJECT_REASON, REJECT);
    const commandDetail = request.operation === "bash" || request.operation === "browser_exec"
      ? `\n\n脚本/命令：\n${request.summary}`
      : `\n\n操作：${request.summary}`;
    const requestKind = request.highRisk ? "高危操作" : request.opaqueScript ? "不透明脚本" : "越权文件操作";
    const dialogTitle = `${requestKind}权限申请\n\n当前模式：${MODE_LABELS[modeBefore]}\n审批策略：${APPROVAL_LABELS[this.#state.approvalPolicy]}\n模型说明：${request.purpose ?? "未提供；请根据结构化操作判断"}\n目标：\n${targetLines(request.exactTargets)}${commandDetail}\n\n请选择本次处理方式：`;
    const choice = await ctx.ui.select(dialogTitle, choices);
    const prefixChoice = commandPrefix ? `${ALLOW_SESSION_PREFIX}：${commandPrefix} *` : undefined;
    const chosePrefix = prefixChoice !== undefined && choice === prefixChoice;
    if (choice === ALLOW_ONCE || choice === ALLOW_SESSION_EXACT || chosePrefix || choice === SWITCH_WORKSPACE || choice === SWITCH_FULL) {
      let policyReason = "user_approved_once";
      if ((choice === ALLOW_SESSION_EXACT || chosePrefix) && request.bashCommand) {
        try {
          const kind: SessionAllowRuleKind = choice === ALLOW_SESSION_EXACT ? "exact" : "prefix";
          const value = kind === "exact" ? request.bashCommand : commandPrefix!;
          if (this.#state.addAllowRule(createSessionAllowRule(kind, value))) {
            this.#persist(ctx);
            policyReason = "session_rule_added";
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
      } else if (choice === SWITCH_WORKSPACE) {
        this.#state.setMode("workspace-write");
        policyReason = "user_switched_mode";
      } else if (choice === SWITCH_FULL) {
        this.#state.setMode("full-access");
        policyReason = "user_switched_mode";
      }
      if (this.#state.mode !== modeBefore) this.#persist(ctx);
      this.#attachPathApproval(event, request);
      this.#appendAudit(request, "approved", policyReason, modeBefore, this.#state.mode, false);
      return undefined;
    }
    if (choice !== REJECT && choice !== REJECT_REASON) {
      this.#appendAudit(request, "blocked", "confirmation_cancelled", modeBefore, this.#state.mode, false);
      return {
        block: true,
        reason: structuredPermissionBlock(request.operation, this.#state.mode, "confirmation_cancelled", {
          highRisk: request.highRisk,
          opaqueScript: request.opaqueScript,
          primitives: request.primitives,
        }),
      };
    }

    let rejectionReason: string | undefined;
    if (choice === REJECT_REASON) {
      const entered = await ctx.ui.input("拒绝理由（将返回给模型）", "请说明需要修改、缩小或补充的内容");
      if (typeof entered === "string" && entered.trim()) rejectionReason = boundedText(entered, MAX_REJECTION_CHARS);
    }
    this.#rememberRejection(fingerprint, rejectionReason);
    this.#appendAudit(request, "blocked", "user_rejected", modeBefore, this.#state.mode, Boolean(rejectionReason));
    return {
      block: true,
      reason: structuredPermissionBlock(request.operation, this.#state.mode, "user_rejected", {
        highRisk: request.highRisk,
        opaqueScript: request.opaqueScript,
        rejectionReason,
        primitives: request.primitives,
      }),
    };
  }

  async #authorizeStructuredReadonlyDelegation(
    event: ToolCallEventShape,
    ctx: ExtensionContext,
  ): Promise<ToolCallBlock | undefined> {
    if (!event.input || typeof event.input !== "object") {
      return { block: true, reason: structuredInputValidationBlock("structured_readonly_command", "Input must be an object.") };
    }
    const structuredInput = event.input as { cwd?: unknown; command?: unknown; args?: unknown };
    const rawCwd = structuredInput.cwd;
    if (rawCwd !== undefined && typeof rawCwd !== "string") {
      return { block: true, reason: structuredInputValidationBlock("structured_readonly_command", "cwd must be a string.") };
    }
    if (structuredInput.command !== "rg" && structuredInput.command !== "git") {
      return { block: true, reason: structuredInputValidationBlock("structured_readonly_command", "command must be rg or git.") };
    }
    if (!Array.isArray(structuredInput.args)) {
      return { block: true, reason: structuredInputValidationBlock("structured_readonly_command", "args must be an array of strings.") };
    }
    for (const argument of structuredInput.args) {
      if (typeof argument !== "string") {
        return { block: true, reason: structuredInputValidationBlock("structured_readonly_command", "args must be an array of strings.") };
      }
    }
    const assessment = await this.#state.assessTarget(rawCwd ?? ctx.cwd, ctx.cwd);
    if (assessment.unverifiableReason || !assessment.canonicalTarget) {
      return {
        block: true,
        reason: structuredPermissionBlock("structured_readonly_command", this.#state.mode, "unverifiable_target", {
          retryable: false,
          primitives: ["workspace_escape"],
        }),
      };
    }
    if (!assessment.workspace && this.#state.mode !== "full-access") {
      return {
        block: true,
        reason: structuredPermissionBlock("structured_readonly_command", this.#state.mode, "scope_denied", {
          primitives: ["workspace_escape"],
        }),
      };
    }
    const canonicalRoot = assessment.workspace?.canonicalPath ?? assessment.canonicalTarget;
    let rootInfo;
    let cwdInfo;
    try {
      [rootInfo, cwdInfo] = await Promise.all([lstat(canonicalRoot), lstat(assessment.canonicalTarget)]);
    } catch {
      rootInfo = undefined;
      cwdInfo = undefined;
    }
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink()) {
      return {
        block: true,
        reason: structuredPermissionBlock("structured_readonly_command", this.#state.mode, "unverifiable_target", {
          retryable: false,
          primitives: ["workspace_escape"],
        }),
      };
    }
    const source: StructuredReadonlyPathGrant["source"] = assessment.workspace
      ? assessment.workspace.canonicalPath === this.#state.primary.canonicalPath ? "primary" : "additional"
      : "full-access-exact";
    const additionalRoots: StructuredReadonlyPathGrant[] = [];
    const pathArguments = classifyStructuredReadonlyArguments(
      structuredInput.command as StructuredReadonlyCommandName,
      structuredInput.args,
    ).pathArguments;
    for (const argument of pathArguments) {
      const pathValue = argument.startsWith("@") ? argument.slice(1) : argument;
      if (!isAbsolute(pathValue)) continue;
      const pathAssessment = await this.#state.assessTarget(pathValue, ctx.cwd);
      if (pathAssessment.unverifiableReason || !pathAssessment.canonicalTarget) {
        return {
          block: true,
          reason: structuredPermissionBlock("structured_readonly_command", this.#state.mode, "unverifiable_target", {
            retryable: false,
            primitives: ["workspace_escape"],
          }),
        };
      }
      if (!pathAssessment.workspace && this.#state.mode !== "full-access") {
        return {
          block: true,
          reason: structuredPermissionBlock("structured_readonly_command", this.#state.mode, "scope_denied", {
            primitives: ["workspace_escape"],
          }),
        };
      }
      let targetInfo;
      try {
        targetInfo = await lstat(pathAssessment.canonicalTarget);
      } catch {
        targetInfo = undefined;
      }
      if (!targetInfo || targetInfo.isSymbolicLink()) {
        return {
          block: true,
          reason: structuredPermissionBlock("structured_readonly_command", this.#state.mode, "unverifiable_target", {
            retryable: false,
            primitives: ["workspace_escape"],
          }),
        };
      }
      const argumentRoot = pathAssessment.workspace?.canonicalPath
        ?? (targetInfo.isDirectory() ? pathAssessment.canonicalTarget : dirname(pathAssessment.canonicalTarget));
      let alreadyAuthorized = argumentRoot === canonicalRoot;
      if (!alreadyAuthorized) {
        for (const grant of additionalRoots) {
          if (grant.canonicalRoot !== argumentRoot) continue;
          alreadyAuthorized = true;
          break;
        }
      }
      if (alreadyAuthorized) continue;
      if (additionalRoots.length >= 16) {
        return { block: true, reason: structuredInputValidationBlock("structured_readonly_command", "At most 16 distinct external argument roots are allowed.") };
      }
      const argumentRootInfo = argumentRoot === pathAssessment.canonicalTarget
        ? targetInfo
        : await lstat(argumentRoot);
      additionalRoots.push({
        canonicalRoot: argumentRoot,
        rootDevice: argumentRootInfo.dev,
        rootInode: argumentRootInfo.ino,
        source: pathAssessment.workspace
          ? pathAssessment.workspace.canonicalPath === this.#state.primary.canonicalPath ? "primary" : "additional"
          : "full-access-exact",
      });
    }
    attachStructuredReadonlyWorkspaceDelegation(event.input, {
      schemaVersion: 1,
      sequence: this.#state.sequence,
      toolCallId: event.toolCallId,
      requestHash: structuredReadonlyRequestHash(event.input),
      canonicalRoot,
      rootDevice: rootInfo.dev,
      rootInode: rootInfo.ino,
      canonicalCwd: assessment.canonicalTarget,
      cwdDevice: cwdInfo.dev,
      cwdInode: cwdInfo.ino,
      source,
      additionalRoots,
    });
    return undefined;
  }

  async #authorizeSubagentDelegation(event: ToolCallEventShape, ctx: ExtensionContext): Promise<ToolCallBlock | undefined> {
    const taskRequests = subagentTaskRequests(event.input, ctx.cwd);
    if (!taskRequests) {
      return {
        block: true,
        reason: structuredInputValidationBlock(
          "subagent",
          "Provide exactly one of single, parallel tasks, or chain mode with string cwd values and optional boolean readOnly values.",
        ),
      };
    }
    const grants: SubagentWorkspaceGrant[] = [];
    let outsideWorkspace = false;
    for (const taskRequest of taskRequests) {
      const assessment = await this.#state.assessTarget(taskRequest.cwd, ctx.cwd);
      if (assessment.unverifiableReason || !assessment.canonicalTarget) {
        return {
          block: true,
          reason: structuredPermissionBlock("subagent", this.#state.mode, "unverifiable_target", {
            retryable: false,
            primitives: ["workspace_escape"],
          }),
        };
      }
      let info;
      try {
        info = await lstat(assessment.canonicalTarget);
      } catch {
        info = undefined;
      }
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        return {
          block: true,
          reason: structuredPermissionBlock("subagent", this.#state.mode, "unverifiable_target", {
            retryable: false,
            primitives: ["workspace_escape"],
          }),
        };
      }
      let source: SubagentWorkspaceGrant["source"];
      if (assessment.workspace) {
        source = assessment.workspace.canonicalPath === this.#state.primary.canonicalPath ? "primary" : "additional";
      } else {
        outsideWorkspace = true;
        source = "full-access-exact";
      }
      const permissionMode = taskRequest.readOnly ? "read-only" : this.#state.mode;
      grants.push({
        canonicalCwd: assessment.canonicalTarget,
        device: info.dev,
        inode: info.ino,
        permissionMode,
        writable: permissionMode !== "read-only",
        source,
      });
    }

    if (outsideWorkspace && this.#state.mode !== "full-access") {
      return {
        block: true,
        reason: structuredPermissionBlock("subagent", this.#state.mode, "scope_denied", {
          primitives: ["workspace_escape"],
        }),
      };
    }
    if (outsideWorkspace && this.#state.approvalPolicy === "ask") {
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: structuredPermissionBlock("subagent", this.#state.mode, "confirmation_required", {
            primitives: ["workspace_escape"],
          }),
        };
      }
      const choice = await ctx.ui.select(
        `子代理工作区委派\n\n将以下精确 canonical cwd 委派给独立 Pi 子进程；每个子进程仍只能访问自己的单一 cwd：\n${targetLines(grants.map((grant) => grant.canonicalCwd))}`,
        [ALLOW_ONCE, REJECT],
      );
      if (choice !== ALLOW_ONCE) {
        return {
          block: true,
          reason: structuredPermissionBlock("subagent", this.#state.mode, choice === REJECT ? "user_rejected" : "confirmation_cancelled", {
            primitives: ["workspace_escape"],
          }),
        };
      }
    }

    attachSubagentWorkspaceDelegation(event.input, {
      schemaVersion: 1,
      sequence: this.#state.sequence,
      toolCallId: event.toolCallId,
      grants,
    });
    return undefined;
  }

  async #buildRequest(event: ToolCallEventShape, ctx: ExtensionContext): Promise<OperationRequest | undefined> {
    const purpose = operationPurpose(event, ctx);
    if (event.toolName === "browser_exec") {
      if (!event.input || typeof event.input !== "object") return undefined;
      const input = event.input as { code?: unknown; session?: unknown; timeoutMs?: unknown };
      if (typeof input.code !== "string") return undefined;
      const assessment = await this.#state.assessTarget(ctx.cwd, ctx.cwd);
      return {
        operation: "browser_exec",
        purpose,
        summary: boundedText(input.code, MAX_COMMAND_DISPLAY_CHARS),
        exactTargets: assessment.canonicalTarget ? [assessment.canonicalTarget] : [],
        targetAssessments: [assessment],
        classes: ["browser:exec", "opaque:python"],
        highRisk: true,
        opaqueScript: true,
        primitives: ["arbitrary_python", "filesystem_access", "network_access", "process_access"],
        fingerprintMaterial: `${input.code}\u0000${typeof input.session === "string" ? input.session : ""}\u0000${typeof input.timeoutMs === "number" ? input.timeoutMs : ""}`,
      };
    }
    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "lsp_fix") {
      if (!event.input || typeof event.input !== "object" || !("path" in event.input)) return undefined;
      const rawPath = (event.input as { path?: unknown }).path;
      if (typeof rawPath !== "string") return undefined;
      const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
      const assessment = await this.#state.assessTarget(path, ctx.cwd);
      const protectedAssessment = await assessProtectedMutationPath(ctx.cwd, assessment.canonicalTarget ?? path);
      const exactTargets = assessment.canonicalTarget ? [assessment.canonicalTarget] : [];
      return {
        operation: event.toolName,
        purpose,
        summary: `${event.toolName} ${path}`,
        exactTargets,
        targetAssessments: [assessment],
        classes: event.toolName === "edit" ? EDIT_CLASSES : event.toolName === "write" ? WRITE_CLASSES : LSP_FIX_CLASSES,
        pathApproval: protectedAssessment.canonicalTarget && protectedAssessment.violations.length > 0
          ? { canonicalTarget: protectedAssessment.canonicalTarget, protectedRoots: protectedAssessment.violations }
          : undefined,
        highRisk: sensitiveProtectedRoots(protectedAssessment.violations),
        opaqueScript: false,
        primitives: protectedAssessment.violations,
        fingerprintMaterial: `${path}\u0000${protectedAssessment.canonicalTarget ?? ""}`,
      };
    }
    if (event.toolName !== "bash") return undefined;
    const bashInput = event.input as { command: string; cwd?: unknown };
    const hasExplicitCwd = typeof bashInput.cwd === "string" && bashInput.cwd.length > 0;
    const effectiveCwd = hasExplicitCwd ? resolve(ctx.cwd, bashInput.cwd as string) : ctx.cwd;
    const high = inspectHighRiskBashMutation(event.input, effectiveCwd);
    const scope = inspectBashPermissionScope(event.input, effectiveCwd);
    if (!scope) return undefined;
    if (high?.unverifiableScope) {
      const roots = await protectedRootViolations(high, effectiveCwd);
      return this.#dynamicHighRequest(event, purpose, high, roots, scope.classes, effectiveCwd, hasExplicitCwd);
    }
    const targets: string[] = [];
    let targetOverflow = false;
    if (hasExplicitCwd && !appendUniqueBounded(targets, effectiveCwd)) targetOverflow = true;
    if (high) for (const target of high.targets) if (!appendUniqueBounded(targets, target)) targetOverflow = true;
    for (const target of scope.targets) if (!appendUniqueBounded(targets, target)) targetOverflow = true;
    const targetAssessments: PermissionTargetAssessment[] = [];
    const primitives: string[] = [];
    let protectedTarget = false;
    if (high) for (const primitive of high.primitives) appendUniqueBounded(primitives, primitive);
    for (const primitive of scope.primitives) appendUniqueBounded(primitives, primitive);
    for (const target of targets) {
      const assessment = await this.#state.assessTarget(target, ctx.cwd);
      targetAssessments.push(assessment);
      const protectedAssessment = await assessProtectedMutationPath(ctx.cwd, assessment.canonicalTarget ?? target);
      if (sensitiveProtectedRoots(protectedAssessment.violations)) protectedTarget = true;
      for (const violation of protectedAssessment.violations) appendUniqueBounded(primitives, violation);
    }
    if (targetOverflow) targetAssessments.push({ unverifiableReason: "unverifiable_target" });
    const command = bashInput.command;
    return {
      operation: "bash",
      purpose,
      summary: boundedText(hasExplicitCwd ? `[cwd=${effectiveCwd}] ${command}` : command, MAX_COMMAND_DISPLAY_CHARS),
      exactTargets: canonicalTargets(targetAssessments),
      targetAssessments,
      classes: scope.classes,
      highRisk: high !== undefined || protectedTarget,
      opaqueScript: scope.kind === "opaque-script",
      primitives,
      fingerprintMaterial: `${effectiveCwd}\u0000${command}`,
      bashCommand: hasExplicitCwd ? undefined : command,
    };
  }

  #dynamicHighRequest(
    event: ToolCallEventShape,
    purpose: string | undefined,
    high: HighRiskMutationScan,
    roots: string[],
    classes: readonly string[],
    effectiveCwd = "",
    hasExplicitCwd = false,
  ): OperationRequest {
    const command = (event.input as { command: string }).command;
    const primitives: string[] = [];
    for (const primitive of high.primitives) appendUniqueBounded(primitives, primitive);
    for (const root of roots) appendUniqueBounded(primitives, root);
    return {
      operation: "bash",
      purpose,
      summary: boundedText(hasExplicitCwd ? `[cwd=${effectiveCwd}] ${command}` : command, MAX_COMMAND_DISPLAY_CHARS),
      exactTargets: high.targets,
      targetAssessments: [{ unverifiableReason: "unverifiable_target" }],
      classes,
      highRisk: true,
      opaqueScript: true,
      primitives,
      fingerprintMaterial: `${effectiveCwd}\u0000${command}`,
      bashCommand: hasExplicitCwd ? undefined : command,
    };
  }

  #attachPathApproval(event: ToolCallEventShape, request: OperationRequest): void {
    if (request.operation === "browser_exec") {
      attachBrowserExecAuthorization(event.input, {
        schemaVersion: 1,
        sequence: this.#state.sequence,
        toolCallId: event.toolCallId,
        requestHash: browserExecRequestHash(event.input),
      });
      return;
    }
    if (!request.pathApproval || request.operation === "bash") return;
    attachPermissionPathApproval(event.input, {
      schemaVersion: 1,
      sequence: this.#state.sequence,
      toolCallId: event.toolCallId,
      operation: request.operation,
      requestHash: mutationRequestHash(request.operation, event.input),
      ...request.pathApproval,
    });
  }

  #scopeAllows(request: OperationRequest): boolean {
    if (request.operation === "bash" && !request.highRisk && !request.opaqueScript && request.primitives.length === 0) return true;
    if (this.#state.mode === "read-only") return false;
    if (this.#state.mode === "full-access") return true;
    if (request.opaqueScript) return false;
    if (request.targetAssessments.length === 0) return false;
    for (const assessment of request.targetAssessments) if (!assessment.workspace) return false;
    return true;
  }

  #ruleScopeAllows(request: OperationRequest): boolean {
    if (this.#state.mode === "read-only") return false;
    if (this.#state.mode === "full-access") return true;
    if (request.targetAssessments.length === 0) return false;
    for (const assessment of request.targetAssessments) if (!assessment.workspace) return false;
    return true;
  }

  async #permissionsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const requested = args.trim();
    if (!requested) {
      if (!ctx.hasUI) {
        ctx.ui.notify(this.#statusText(), "info");
        return;
      }
      const modeChoice = await ctx.ui.select("选择当前 Session 访问范围", MODE_CHOICES);
      const mode = modeChoice ? LABEL_TO_MODE.get(modeChoice) : undefined;
      if (!mode) {
        ctx.ui.notify(this.#statusText(), "info");
        return;
      }
      const approvalChoice = await ctx.ui.select("选择当前 Session 审批策略", APPROVAL_FLOW_CHOICES);
      if (!approvalChoice) {
        ctx.ui.notify(this.#statusText(), "info");
        return;
      }
      const policy = LABEL_TO_APPROVAL.get(approvalChoice);
      if (policy) {
        const modeChanged = this.#state.setMode(mode);
        const policyChanged = this.#state.setApprovalPolicy(policy);
        if (modeChanged || policyChanged) this.#persist(ctx);
      } else if (approvalChoice === MANAGE_RULES) {
        const rulesChanged = await this.#manageRules(ctx, false);
        if (rulesChanged) {
          this.#state.setMode(mode);
          this.#persist(ctx);
        }
      }
      this.#publish(ctx);
      ctx.ui.notify(this.#statusText(), "info");
      return;
    }
    if (requested === "status") {
      ctx.ui.notify(this.#statusText(), "info");
      return;
    }
    if (requested === "rules") {
      ctx.ui.notify(this.#rulesText(), "info");
      return;
    }
    if (requested === "clear-rules") {
      const count = this.#state.clearAllowRules();
      if (count > 0) this.#persist(ctx);
      ctx.ui.notify(`已清空 ${count} 条当前 Session 白名单。`, "info");
      return;
    }
    const addRulePrefix = "add-rule ";
    if (requested.startsWith(addRulePrefix)) {
      const value = requested.slice(addRulePrefix.length);
      const separator = value.indexOf(" ");
      const kind = separator > 0 ? value.slice(0, separator) : "";
      const pattern = separator > 0 ? value.slice(separator + 1) : "";
      if ((kind !== "exact" && kind !== "prefix") || !pattern.trim()) {
        ctx.ui.notify("Usage: /permissions add-rule <exact|prefix> <command>", "warning");
        return;
      }
      this.#addCommandRule(kind, pattern, ctx, true);
      return;
    }
    const removePrefix = "remove-rule ";
    if (requested.startsWith(removePrefix)) {
      const id = requested.slice(removePrefix.length).trim();
      const removed = this.#state.removeAllowRule(id);
      if (removed) this.#persist(ctx);
      ctx.ui.notify(removed ? `已删除 Session 白名单：${displayRuleId(removed.id)} · ${removed.label}` : `未找到或前缀不唯一：${id}`, removed ? "info" : "warning");
      return;
    }
    if (isSessionPermissionMode(requested)) {
      if (this.#state.setMode(requested)) this.#persist(ctx);
      ctx.ui.notify(this.#statusText(), "info");
      return;
    }
    if (isSessionApprovalPolicy(requested)) {
      if (this.#state.setApprovalPolicy(requested)) this.#persist(ctx);
      ctx.ui.notify(this.#statusText(), "info");
      return;
    }
    ctx.ui.notify("Usage: /permissions [read-only|workspace-write|full-access|ask|never-ask|status|rules|add-rule <exact|prefix> <command>|clear-rules|remove-rule <id>]", "warning");
  }

  async #manageRules(ctx: ExtensionCommandContext, persistChanges = true): Promise<boolean> {
    if (!ctx.hasUI) {
      ctx.ui.notify(this.#rulesText(), "info");
      return false;
    }
    const choices: string[] = [ADD_EXACT_RULE, ADD_PREFIX_RULE];
    for (const rule of this.#state.allowRules) choices.push(`${displayRuleId(rule.id)} · ${rule.label}`);
    if (this.#state.allowRules.length > 0) choices.push(CLEAR_RULES);
    choices.push(BACK);
    const choice = await ctx.ui.select("管理当前 Session 指令白名单", choices);
    if (!choice || choice === BACK) return false;
    if (choice === ADD_EXACT_RULE || choice === ADD_PREFIX_RULE) {
      if (this.#state.approvalPolicy !== "ask") {
        ctx.ui.notify("只有在审批策略为 ask 时才能添加 Session 白名单；已有规则仍会继续生效。", "warning");
        return false;
      }
      const kind: SessionAllowRuleKind = choice === ADD_EXACT_RULE ? "exact" : "prefix";
      const prompt = kind === "exact" ? "输入要精确匹配的完整 Bash 指令" : "输入指令前缀，例如 bun 或 bun run（末尾 * 可省略）";
      const value = await ctx.ui.input(choice, prompt);
      if (!value?.trim()) return false;
      return this.#addCommandRule(kind, value, ctx, persistChanges);
    }
    if (choice === CLEAR_RULES) {
      const count = this.#state.clearAllowRules();
      if (count > 0 && persistChanges) this.#persist(ctx);
      ctx.ui.notify(`已清空 ${count} 条当前 Session 白名单。`, "info");
      return count > 0;
    }
    for (const rule of this.#state.allowRules) {
      if (choice !== `${displayRuleId(rule.id)} · ${rule.label}`) continue;
      this.#state.removeAllowRule(rule.id);
      if (persistChanges) this.#persist(ctx);
      ctx.ui.notify(`已删除 Session 白名单：${displayRuleId(rule.id)} · ${rule.label}`, "info");
      return true;
    }
    return false;
  }

  #addCommandRule(kind: SessionAllowRuleKind, value: string, ctx: ExtensionContext, persistChanges: boolean): boolean {
    if (this.#state.approvalPolicy !== "ask") {
      ctx.ui.notify("只有在审批策略为 ask 时才能添加 Session 白名单；请先执行 /permissions ask。", "warning");
      return false;
    }
    try {
      const rule = createSessionAllowRule(kind, value);
      const added = this.#state.addAllowRule(rule);
      if (added && persistChanges) this.#persist(ctx);
      ctx.ui.notify(added ? `已添加 Session 白名单：${displayRuleId(rule.id)} · ${rule.label}` : `Session 白名单已存在：${displayRuleId(rule.id)} · ${rule.label}`, "info");
      return added;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      return false;
    }
  }

  async #addWorkspaceCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    let path = args.trim();
    if (!path && ctx.hasUI) path = (await ctx.ui.input("添加工作区", "输入现存目录的完整路径"))?.trim() ?? "";
    if (!path) {
      ctx.ui.notify("Usage: /add_workspace <path>", "warning");
      return;
    }
    try {
      const grant = await this.#state.addWorkspace(path, ctx.cwd);
      this.#persist(ctx);
      this.#publish(ctx);
      ctx.ui.notify(`已添加当前 Session 工作区：${grant.requestedPath}\nCanonical: ${grant.canonicalPath}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async #removeWorkspaceCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    let path = args.trim();
    if (!path && ctx.hasUI) path = (await ctx.ui.input("移除工作区", "输入添加时使用的相同路径"))?.trim() ?? "";
    if (!path) {
      ctx.ui.notify("Usage: /remove_workspace <path>", "warning");
      return;
    }
    try {
      const grant = await this.#state.removeWorkspace(path, ctx.cwd);
      this.#persist(ctx);
      this.#publish(ctx);
      ctx.ui.notify(`已移除当前 Session 工作区：${grant.requestedPath}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  #persist(ctx: ExtensionContext): void {
    const state = this.#state.serialized();
    try {
      this.#pi.appendEntry(SESSION_PERMISSION_STATE_TYPE, state);
    } catch (error) {
      if (this.#committedState) this.#state.restoreCheckpoint(this.#committedState);
      this.#publish(ctx);
      throw error;
    }
    this.#committedState = this.#state.checkpoint();
    try {
      this.#pi.events.emit(SESSION_PERMISSION_EVENT, state);
    } catch {
      // The durable Session entry is authoritative; event delivery is best-effort.
    }
    this.#publish(ctx);
  }

  #publish(ctx: ExtensionContext): void {
    const workspaceSuffix = this.#state.additional.length > 0 ? ` +${this.#state.additional.length}` : "";
    const ruleSuffix = this.#state.allowRules.length > 0 ? ` r${this.#state.allowRules.length}` : "";
    ctx.ui.setStatus(STATUS_KEY, `permission: ${this.#state.mode}/${this.#state.approvalPolicy}${workspaceSuffix}${ruleSuffix}`);
  }

  #statusText(): string {
    const lines = [
      `当前 Session 访问范围：${MODE_LABELS[this.#state.mode]}`,
      `审批策略：${APPROVAL_LABELS[this.#state.approvalPolicy]}`,
      `指令白名单：${this.#state.allowRules.length} 条`,
      `主工作区：${this.#state.primary.canonicalPath}`,
      "附加工作区：",
    ];
    if (this.#state.additional.length === 0) lines.push("- 无");
    else for (const grant of this.#state.additional) lines.push(`- ${grant.requestedPath} -> ${grant.canonicalPath}`);
    return lines.join("\n");
  }

  #rulesText(): string {
    if (this.#state.allowRules.length === 0) return "当前 Session 没有指令白名单。";
    const lines = [`当前 Session 指令白名单（${this.#state.allowRules.length}）：`];
    for (const rule of this.#state.allowRules) lines.push(`- ${displayRuleId(rule.id)} · ${rule.label}`);
    return lines.join("\n");
  }

  #rememberRejection(fingerprint: string, reason: string | undefined): void {
    this.#rejections.delete(fingerprint);
    this.#rejections.set(fingerprint, { reason });
    while (this.#rejections.size > MAX_REJECTIONS) {
      const oldest = this.#rejections.keys().next().value;
      if (oldest === undefined) break;
      this.#rejections.delete(oldest);
    }
  }

  #appendAudit(
    request: OperationRequest,
    outcome: "approved" | "blocked",
    policyReason: string,
    modeBefore: SessionPermissionMode,
    modeAfter: SessionPermissionMode,
    rejectionReasonProvided: boolean,
  ): void {
    try {
      this.#pi.appendEntry(SESSION_PERMISSION_AUDIT_TYPE, {
        schemaVersion: 1,
        controllerVersion: "1.5.0-pi.84.1",
        operation: request.operation,
        outcome,
        policyReason,
        modeBefore,
        modeAfter,
        approvalPolicy: this.#state.approvalPolicy,
        allowRuleCount: this.#state.allowRules.length,
        highRisk: request.highRisk,
        opaqueScript: request.opaqueScript,
        primitives: request.primitives,
        targetCount: request.exactTargets.length,
        purposeProvided: request.purpose !== undefined,
        rejectionReasonProvided,
        sequence: ++this.#auditSequence,
      });
      if (request.operation === "bash" && request.highRisk) {
        this.#pi.appendEntry("resource-mutation-policy-v1", {
          schemaVersion: 1,
          guardVersion: "0.8.3-pi.84.1",
          operation: "bash",
          risk: "HIGH",
          outcome,
          policyReason,
          parserVersion: 2,
          primitives: request.primitives,
          targetsInspected: request.exactTargets.length,
          dynamicScope: request.opaqueScript,
          unverifiableScope: request.opaqueScript,
          workspaceWide: false,
          sequence: this.#auditSequence,
        });
      }
    } catch {
      // Auditing is best-effort; enforcement remains active.
    }
  }
}
