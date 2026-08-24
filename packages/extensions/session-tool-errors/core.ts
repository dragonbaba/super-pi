import type { SessionEntry } from "@super-pi/coding-agent";
import {
  ABORTED_RE,
  ANSI_ESCAPE_RE,
  AUTHORIZATION_RE,
  COMMAND_FAILED_RE,
  CONFIGURATION_ERROR_RE,
  CONTROL_CHARACTER_RE,
  DUPLICATE_CALL_RE,
  EDIT_NON_UNIQUE_RE,
  EDIT_NOT_FOUND_RE,
  EDIT_OVERLAP_RE,
  EMPTY_NONZERO_EXIT_RE,
  ENCODING_ERROR_RE,
  ENVIRONMENT_ERROR_RE,
  EXACT_MIGRATION_VERSION_RE,
  LSP_ENVIRONMENT_ERROR_RE,
  LSP_INPUT_VALIDATION_RE,
  LSP_WORKSPACE_ESCAPE_RE,
  MSYS_ARGV_RECOVERY_RE,
  MSYS_TASKKILL_REWRITE_RE,
  MUTATION_READ_REQUIRED_RE,
  PATH_NOT_FOUND_RE,
  PLATFORM_PATH_ERROR_RE,
  POLICY_BLOCKED_RE,
  PROVIDER_ERROR_RE,
  PROVIDER_QUOTA_EXHAUSTED_RE,
  REQUIRED_CODEGRAPH_ARGUMENT_RE,
  RG_NO_MATCH_RESULT_RE,
  SCRIPT_ASSERTION_RE,
  SCRIPT_RUNTIME_ERROR_RE,
  SCRIPT_SYNTAX_ERROR_RE,
  SNAPSHOT_EDIT_ERROR_RE,
  SECRET_ASSIGNMENT_RE,
  SELF_DIAGNOSIS_RE,
  SHELL_SYNTAX_ERROR_RE,
  SIMPLE_RG_PREFIX_RE,
  TIMEOUT_RE,
  UTF8_REJECTED_RE,
  VALIDATION_RE,
  VERIFICATION_BUILD_RE,
  VERIFICATION_LINT_RE,
  VERIFICATION_TEST_RE,
  VERIFICATION_TYPECHECK_RE,
  WHITESPACE_RE,
  WORKDIR_MISMATCH_RE,
} from "./regex.ts";
const MAX_RAW_ERROR_CHARACTERS = 12_000;
const RAW_ERROR_HEAD_CHARACTERS = 8_000;
const RAW_ERROR_TAIL_CHARACTERS = MAX_RAW_ERROR_CHARACTERS - RAW_ERROR_HEAD_CHARACTERS;
export const MAX_REPORT_BYTES = 96 * 1024;
export const MAX_REPORT_OBSERVATIONS = 512;
export const MAX_REPORT_GROUPS = 48;
export const MAX_REPORT_CATEGORIES = 24;
export const MAX_REPORT_GROUPS_PER_CATEGORY = 8;
const MAX_REPORT_FIELD_CHARACTERS = 12_000;

const STRUCTURED_MUTATION_CAUSES = new Map<string, { category: string; cause: string }>([
  ["READ_REQUIRED", { category: "read_required", cause: "Mutation Guard 要求先读取目标的相关范围或完整内容，且读取结果必须已在前一 tool turn 被模型观察。" }],
  ["STALE_STATE", { category: "stale_state", cause: "目标在读取或匹配后发生变化，Compare-and-Swap 校验拒绝基于旧状态写入。" }],
  ["EDIT_TARGET_AMBIGUOUS", { category: "edit_target_ambiguous", cause: "编辑目标存在多个候选，定点读取或 expectedLine 未能唯一确定一个 occurrence。" }],
  ["NO_OP_EDIT", { category: "no_op_edit", cause: "编辑项的 oldText 与 newText 在换行归一化后相同；移除无效编辑后再提交。" }],
  ["MUTATION_BUDGET_EXCEEDED", { category: "mutation_budget_exceeded", cause: "请求的替换数量或文本范围超过 Mutation Guard 的单次预算。" }],
  ["TARGET_APPEARED", { category: "target_appeared", cause: "创建新文件时目标并发出现，排他创建拒绝覆盖。" }],
  ["WRITE_FAILED", { category: "write_failed", cause: "写入失败，运行时确认未发生状态变更或已完成安全回滚。" }],
  ["EDIT_FAILED", { category: "edit_failed", cause: "编辑写盘失败，运行时确认目标仍保持编辑前状态。" }],
  ["PARTIAL_MUTATION", { category: "partial_mutation", cause: "Mutation Guard 检测到可能或确定的部分变更，不能视为安全失败或成功。" }],
]);

const SNAPSHOT_EDIT_CAUSES = new Map<string, { category: string; cause: string }>([
  ["UNKNOWN", { category: "snapshot_unknown", cause: "快照能力不存在、已消费、已淘汰或属于另一个 Session；应重新读取目标。" }],
  ["PATH", { category: "snapshot_path_mismatch", cause: "快照与请求的规范目标路径不一致。" }],
  ["STALE", { category: "stale_state", cause: "快照之后目标身份或内容发生变化，提交前校验拒绝旧状态编辑。" }],
  ["MISMATCH", { category: "snapshot_anchor_mismatch", cause: "LINE#ID 与不可变快照中的对应行不匹配；应复制错误上下文返回的最新锚点重试。" }],
  ["UNSEEN", { category: "snapshot_unseen_range", cause: "行操作超出 read 实际展示并授权的行范围。" }],
  ["BUDGET", { category: "mutation_budget_exceeded", cause: "快照编辑的操作、文本或结果大小超过有界预算。" }],
  ["BOUNDARY", { category: "input_validation", cause: "替换文本重复包含未删除的相邻边界行；应从 newLines 移除该边界行。" }],
  ["OVERLAP", { category: "overlap", cause: "快照行操作重叠、嵌套或共享不明确的插入边界。" }],
  ["NO_OP", { category: "no_op_edit", cause: "快照行操作生成的内容与原文件完全相同。" }],
  ["INVALID", { category: "input_validation", cause: "快照行操作的 kind、LINE#ID 锚点或 newLines 组合无效。" }],
  ["UNSUPPORTED", { category: "snapshot_unsupported", cause: "目标不是当前快照行协议支持的严格 UTF-8 行文本。" }],
  ["SYNTAX", { category: "syntax_regression", cause: "编辑会为 JavaScript/TypeScript 引入新的解析诊断，因此在写盘前被拒绝。" }],
  ["IDENTITY", { category: "stale_state", cause: "快照目标不再是原来的常规文件身份。" }],
  ["PARTIAL", { category: "partial_mutation", cause: "原子替换已提交，但提交后回读验证失败；必须人工核对目标。" }],
]);

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export interface ErrorObservation {
  /** Session entry identity for bounded machine aggregation; omitted from reports. */
  entryId?: string;
  /** Originating assistant message identity, used only to collapse same-batch abort cascades. */
  batchId?: string;
  cascadeCount?: number;
  /** Tool-result entry identities represented by a collapsed abort; omitted from reports and stores. */
  cascadeEntryIds?: string[];
  source: "tool" | "assistant" | "user_bash";
  tool: string;
  model?: string;
  category: string;
  cause: string;
  text: string;
  failedEditInput?: string;
  postErrorReasoning?: string;
  reasoningKind?: "self_diagnosis" | "follow_up_reasoning";
  followUpOutcome: "succeeded" | "failed" | "mixed" | "provider_retry_succeeded" | "not_recorded" | "no_immediate_tool_call";
  timestamp: string;
}

interface ErrorGroup extends ErrorObservation {
  count: number;
}

type VerificationFamily = "test" | "typecheck" | "build" | "lint" | "diagnostics";

interface ToolCallOwner {
  model?: string;
  batchId: string;
  failedEditInput?: string;
  simpleRipgrepCommand?: boolean;
  verificationFamily?: VerificationFamily;
}

interface AssistantFollowUp {
  reasoning?: string;
  reasoningKind?: "self_diagnosis" | "follow_up_reasoning";
  outcome: ErrorObservation["followUpOutcome"];
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.length > 0) {
      parts.push(candidate.text);
    }
  }
  return parts.join("\n");
}

function thinkingContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; thinking?: unknown };
    if (candidate.type === "thinking" && typeof candidate.thinking === "string" && candidate.thinking.trim().length > 0) {
      parts.push(candidate.thinking.trim());
    }
  }
  const reflection = parts.join("\n\n");
  return reflection.length > 0 ? reflection : undefined;
}

function parseStructuredFailure(text: string): Record<string, unknown> | undefined {
  const source = text.trimStart().slice(0, MAX_RAW_ERROR_CHARACTERS);
  if (source.charCodeAt(0) !== 123) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === 34) inString = false;
      continue;
    }
    if (code === 34) {
      inString = true;
      continue;
    }
    if (code === 123) depth++;
    else if (code === 125 && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) return undefined;
  try {
    const value = JSON.parse(source.slice(0, end)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyStructuredMutationError(payload: Record<string, unknown> | undefined): { category: string; cause: string } | undefined {
  if (!payload
    || payload.ok !== false
    || (payload.operation !== "edit" && payload.operation !== "write")
    || typeof payload.category !== "string"
    || typeof payload.stateChanged !== "boolean") return undefined;
  return STRUCTURED_MUTATION_CAUSES.get(payload.category);
}

function classifyStructuredPreflightError(payload: Record<string, unknown> | undefined): { category: string; cause: string } | undefined {
  if (!payload || payload.ok !== false || payload.stateChanged !== false || typeof payload.category !== "string") return undefined;
  if (payload.category === "INPUT_VALIDATION") {
    return { category: "input_validation", cause: "工具参数未通过结构化输入校验。" };
  }
  if (payload.category === "WORKDIR_MISMATCH") {
    return { category: "workdir_mismatch", cause: "包生命周期命令在缺少目标 package.json 的目录中被执行前预检阻止。" };
  }
  if (payload.category === "PLATFORM_PATH_ERROR") {
    return { category: "platform_path_error", cause: "结构化工具参数使用了当前平台或非 Shell 调用不支持的路径形式。" };
  }
  if (payload.category === "DUPLICATE_CALL") {
    return { category: "duplicate_call", cause: "同一 assistant 工具批次已包含完全相同的调用，重复 sibling 在执行前被去重。" };
  }
  if (payload.category === "REPEATED_CALL_BLOCKED") {
    return { category: "repeated_call_blocked", cause: "完全相同的调用已连续失败，循环护栏保持阻断直到参数或方法改变。" };
  }
  return undefined;
}

function classifyStructuredReadonlyError(payload: Record<string, unknown> | undefined): { category: string; cause: string } | undefined {
  if (!payload
    || payload.ok !== false
    || (payload.command !== "git" && payload.command !== "rg")
    || typeof payload.category !== "string"
    || payload.stateChanged !== false) return undefined;
  const output = typeof payload.output === "string" ? payload.output : "";
  if (WORKDIR_MISMATCH_RE.test(output)) return { category: "workdir_mismatch", cause: "只读命令在不包含所需仓库或配置的工作目录中执行。" };
  if (PATH_NOT_FOUND_RE.test(output)) return { category: "path_not_found", cause: "只读命令引用的目标路径不存在。" };
  if (payload.category === "timeout_or_aborted") return { category: "timeout_or_aborted", cause: "结构化只读命令超时或被中止。" };
  if (payload.category === "input_validation") return { category: "input_validation", cause: "rg 参数或以连字符开头的搜索模式未通过输入校验。" };
  if (payload.category === "command_failed") return { category: "command_failed", cause: "结构化只读命令以非零状态退出，且确认没有状态变更。" };
  return undefined;
}

function verificationFamily(tool: string, argumentsValue: unknown): VerificationFamily | undefined {
  if (tool === "lsp_diagnostics") return "diagnostics";
  if (tool !== "bash" || !argumentsValue || typeof argumentsValue !== "object") return undefined;
  const command = (argumentsValue as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  if (VERIFICATION_TEST_RE.test(command)) return "test";
  if (VERIFICATION_TYPECHECK_RE.test(command)) return "typecheck";
  if (VERIFICATION_BUILD_RE.test(command)) return "build";
  if (VERIFICATION_LINT_RE.test(command)) return "lint";
  return undefined;
}

function verificationFailure(family: VerificationFamily): { category: string; cause: string } {
  return {
    category: `${family}_failed`,
    cause: `${family} 验证命令以非零状态退出；原始输出保留用于定位具体失败。`,
  };
}

export function classifyToolFailure(tool: string, text: string, input?: unknown): { category: string; cause: string } {
  return classifyError(tool, text, verificationFamily(tool, input));
}

export function classifyError(tool: string, text: string, family?: VerificationFamily): { category: string; cause: string } {
  const structuredPayload = parseStructuredFailure(text);
  const structuredMutation = classifyStructuredMutationError(structuredPayload);
  if (structuredMutation) return structuredMutation;
  const structuredPreflight = classifyStructuredPreflightError(structuredPayload);
  if (structuredPreflight) return structuredPreflight;
  if (tool === "structured_readonly_command") {
    const structuredReadonly = classifyStructuredReadonlyError(structuredPayload);
    if (structuredReadonly) return structuredReadonly;
  }
  if (tool === "codegraph" && REQUIRED_CODEGRAPH_ARGUMENT_RE.test(text)) {
    return { category: "input_validation", cause: "CodeGraph 调用缺少当前 action 要求的参数。" };
  }
  if (tool === "edit") {
    const match = SNAPSHOT_EDIT_ERROR_RE.exec(text);
    const code = match?.[1];
    if (code) {
      const snapshotFailure = SNAPSHOT_EDIT_CAUSES.get(code.toUpperCase());
      if (snapshotFailure) return snapshotFailure;
    }
  }
  const exactMigrationVersionError = EXACT_MIGRATION_VERSION_RE.test(text);
  if (VALIDATION_RE.test(text) || exactMigrationVersionError) {
    return {
      category: "input_validation",
      cause: exactMigrationVersionError
        ? "迁移目标版本必须使用精确版本号，当前输入未通过版本校验。"
        : "工具参数未通过 schema 或工具自身输入校验。",
    };
  }
  const isLspTool = tool === "lsp_diagnostics" || tool === "lsp_navigate" || tool === "lsp_fix";
  if (isLspTool && LSP_WORKSPACE_ESCAPE_RE.test(text)) {
    return {
      category: "workspace_escape",
      cause: "LSP 请求路径解析到 workspace root 之外；应切换到目标 workspace 或使用受支持的跨根读取方式。",
    };
  }
  if (isLspTool && LSP_INPUT_VALIDATION_RE.test(text)) {
    return {
      category: "input_validation",
      cause: "LSP 的 server、route、path、line、symbol 或数量边界未通过输入校验。",
    };
  }
  if (isLspTool && LSP_ENVIRONMENT_ERROR_RE.test(text)) {
    return {
      category: "environment_error",
      cause: "配置的 LSP server command 在当前环境中不可用；应安装该服务或更新 pi-lsp.json。",
    };
  }
  if ((tool === "edit" || tool === "write") && MUTATION_READ_REQUIRED_RE.test(text)) {
    return STRUCTURED_MUTATION_CAUSES.get("READ_REQUIRED")!;
  }
  if (tool === "edit") {
    if (EDIT_NON_UNIQUE_RE.test(text)) {
      return { category: "old_text_non_unique", cause: "oldText 在目标文件中不唯一，需要缩小或增加能唯一定位的上下文。" };
    }
    if (EDIT_NOT_FOUND_RE.test(text)) {
      return { category: "old_text_not_found", cause: "目标文件当前内容与 oldText 不一致；常见原因是状态已变化、空白不匹配或片段来自错误文件。" };
    }
    if (EDIT_OVERLAP_RE.test(text)) {
      return { category: "overlap", cause: "同一次 edit 中有重叠或嵌套区域；各项都基于原文件匹配，不能表达顺序依赖。" };
    }
    if (UTF8_REJECTED_RE.test(text)) {
      return { category: "utf8_rejected", cause: "目标文件不是严格 UTF-8，运行时为避免有损重写而拒绝写盘。" };
    }
  }
  if (DUPLICATE_CALL_RE.test(text)) return { category: "duplicate_call", cause: "同一 assistant 工具批次中的重复调用被执行前去重。" };
  if (POLICY_BLOCKED_RE.test(text)) return { category: "policy_blocked", cause: "调用被安全策略或用户确认门禁阻止。" };
  if (tool === "assistant" && PROVIDER_QUOTA_EXHAUSTED_RE.test(text)) {
    return { category: "provider_quota_exhausted", cause: "模型提供商明确报告当前账号的额度、余额或订阅资格已耗尽；普通重试不会恢复。" };
  }
  if (tool === "assistant" && PROVIDER_ERROR_RE.test(text)) return { category: "provider_error", cause: "模型提供商或其连接层返回错误。" };
  if ((tool === "bash" || tool === "user_bash") && ENCODING_ERROR_RE.test(text)) return { category: "encoding_error", cause: "脚本输入、输出或终端编码不兼容。" };
  if ((tool === "bash" || tool === "user_bash") && MSYS_ARGV_RECOVERY_RE.test(text)) {
    return { category: "platform_path_error", cause: "Windows MSYS 在 Bash 解析前重写了命令行中的连续反斜杠；应改用结构化 argv，模型 Bash 工具则由有界 stdin 桥保护。" };
  }
  if ((tool === "bash" || tool === "user_bash") && SHELL_SYNTAX_ERROR_RE.test(text)) return { category: "shell_syntax_error", cause: "Shell 命令的引号、管道、工作目录参数或平台语法无效。" };
  if ((tool === "bash" || tool === "user_bash") && SCRIPT_SYNTAX_ERROR_RE.test(text)) return { category: "script_syntax_error", cause: "Shell 内嵌脚本存在语法或解析错误。" };
  if ((tool === "bash" || tool === "user_bash") && SCRIPT_ASSERTION_RE.test(text)) return { category: "script_assertion", cause: "验证脚本中的断言失败。" };
  if ((tool === "bash" || tool === "user_bash") && SCRIPT_RUNTIME_ERROR_RE.test(text)) return { category: "script_runtime_error", cause: "Shell 内嵌脚本在运行时抛出了异常。" };
  if ((tool === "bash" || tool === "user_bash") && ENVIRONMENT_ERROR_RE.test(text)) return { category: "environment_error", cause: "命令、组件或执行权限在当前环境中不可用。" };
  if ((tool === "bash" || tool === "user_bash") && CONFIGURATION_ERROR_RE.test(text)) return { category: "configuration_error", cause: "工具版本与当前配置不兼容，或配置项无效。" };
  const msysTaskkillRewrite = (tool === "bash" || tool === "user_bash") && MSYS_TASKKILL_REWRITE_RE.test(text);
  if ((tool === "bash" || tool === "user_bash") && (PLATFORM_PATH_ERROR_RE.test(text) || msysTaskkillRewrite)) {
    return {
      category: "platform_path_error",
      cause: msysTaskkillRewrite
        ? "MSYS shell 将 taskkill 的 /PID、/T 或 /F 参数重写成了路径；需禁用参数转换或改用原生进程调用。"
        : "平台路径格式未转换为当前运行时要求的形式。",
    };
  }
  if ((tool === "bash" || tool === "user_bash") && WORKDIR_MISMATCH_RE.test(text)) return { category: "workdir_mismatch", cause: "命令在不包含所需项目清单或配置文件的工作目录中执行。" };
  if (PATH_NOT_FOUND_RE.test(text)) return { category: "path_not_found", cause: "目标路径不存在或路径参数错误。" };
  if (TIMEOUT_RE.test(text)) return { category: "timeout", cause: "操作超过工具或运行环境允许的时间。" };
  if (ABORTED_RE.test(text)) return { category: "aborted", cause: "操作被取消或中止，不能据此判定任务成功。" };
  if ((tool === "bash" || tool === "user_bash") && family && (EMPTY_NONZERO_EXIT_RE.test(text) || COMMAND_FAILED_RE.test(text))) return verificationFailure(family);
  if ((tool === "bash" || tool === "user_bash") && EMPTY_NONZERO_EXIT_RE.test(text)) return { category: "empty_nonzero_exit", cause: "命令无输出并以非零状态退出；对搜索工具可能只是无匹配，不能据此推断运行时崩溃。" };
  if ((tool === "bash" || tool === "user_bash") && COMMAND_FAILED_RE.test(text)) return { category: "command_failed", cause: "命令以非零状态退出，但输出不足以归入更具体的类别。" };
  return { category: "runtime_error", cause: "工具或提供商返回了未被专门分类的运行时错误，需要结合原始内容检查。" };
}

export function sanitizeErrorText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(CONTROL_CHARACTER_RE, "")
    .replace(AUTHORIZATION_RE, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_RE, "$1=[REDACTED]");
}

function formatFailedEditInput(argumentsValue: unknown): string | undefined {
  if (!argumentsValue || typeof argumentsValue !== "object") return undefined;
  const input = argumentsValue as {
    path?: unknown;
    snapshot?: unknown;
    edits?: unknown;
    oldText?: unknown;
    newText?: unknown;
  };
  const output: Record<string, unknown> = {};
  if (typeof input.path === "string") output.path = input.path;
  if (Array.isArray(input.edits)) {
    output.edits = input.edits.map((item) => {
      if (!item || typeof item !== "object") return item;
      const edit = item as {
        oldText?: unknown;
        newText?: unknown;
        kind?: unknown;
        start?: unknown;
        end?: unknown;
        newLines?: unknown;
      };
      const normalized: Record<string, unknown> = {};
      if (typeof edit.kind === "string") normalized.kind = edit.kind;
      if (typeof edit.start === "string") normalized.start = edit.start;
      if (typeof edit.end === "string") normalized.end = edit.end;
      if (Array.isArray(edit.newLines) && edit.newLines.every((line) => typeof line === "string")) normalized.newLines = edit.newLines;
      if (typeof edit.oldText === "string") normalized.oldText = edit.oldText;
      if (typeof edit.newText === "string") normalized.newText = edit.newText;
      return normalized;
    });
  } else if (typeof input.oldText === "string" || typeof input.newText === "string") {
    output.oldText = input.oldText;
    output.newText = input.newText;
  }
  if (Object.keys(output).length === 0) return undefined;
  return sanitizeErrorText(JSON.stringify(output, null, 2));
}
function hasShellOperatorOrInvalidQuotes(command: string): boolean {
  let quote = 0;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === 39) {
      if (code === 39) quote = 0;
      continue;
    }
    if (code === 92) {
      escaped = true;
      continue;
    }
    if (quote === 34) {
      if (code === 34) {
        quote = 0;
        continue;
      }
      if (code === 96 || (code === 36 && command.charCodeAt(index + 1) === 40)) return true;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      continue;
    }
    if (code === 10 || code === 13 || code === 38 || code === 59 || code === 60
      || code === 62 || code === 96 || code === 124
      || (code === 36 && command.charCodeAt(index + 1) === 40)) return true;
  }
  return quote !== 0 || escaped;
}

function isSimpleRipgrepCommand(argumentsValue: unknown): boolean {
  if (!argumentsValue || typeof argumentsValue !== "object") return false;
  const command = (argumentsValue as { command?: unknown }).command;
  return typeof command === "string"
    && SIMPLE_RG_PREFIX_RE.test(command)
    && !hasShellOperatorOrInvalidQuotes(command);
}

function addObservation(observations: ErrorObservation[], observation: ErrorObservation): void {
  const sanitized = sanitizeErrorText(observation.text).trim() || "(无文本错误详情)";
  observations.push({
    ...observation,
    text: sanitized,
    failedEditInput: observation.failedEditInput ? sanitizeErrorText(observation.failedEditInput) : undefined,
    postErrorReasoning: observation.postErrorReasoning ? sanitizeErrorText(observation.postErrorReasoning) : undefined,
  });
}

export function collectSessionErrors(entries: readonly SessionEntry[]): ErrorObservation[] {
  const observations: ErrorObservation[] = [];
  const owners = new Map<string, ToolCallOwner>();
  const assistantsByParentId = new Map<string, { id: string; reasoning?: string; stopReason?: string; toolCallIds: string[] }>();
  const resultErrorsByCallId = new Map<string, boolean>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") {
      resultErrorsByCallId.set(entry.message.toolCallId, entry.message.isError === true);
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.parentId) continue;
    const toolCallIds: string[] = [];
    for (const block of entry.message.content) {
      if (block.type === "toolCall") toolCallIds.push(block.id);
    }
    assistantsByParentId.set(entry.parentId, {
      id: entry.id,
      reasoning: thinkingContent(entry.message.content),
      stopReason: entry.message.stopReason,
      toolCallIds,
    });
  }

  const reasoningFields = (reasoning?: string): Pick<AssistantFollowUp, "reasoning" | "reasoningKind"> => ({
    reasoning,
    reasoningKind: reasoning
      ? (SELF_DIAGNOSIS_RE.test(reasoning) ? "self_diagnosis" : "follow_up_reasoning")
      : undefined,
  });

  const followUpFor = (entryId: string): AssistantFollowUp => {
    const assistant = assistantsByParentId.get(entryId);
    if (!assistant) return { outcome: "not_recorded" };
    const reasoning = reasoningFields(assistant.reasoning);
    if (assistant.toolCallIds.length === 0) return { ...reasoning, outcome: "no_immediate_tool_call" };
    const statuses = assistant.toolCallIds.map((id) => resultErrorsByCallId.get(id));
    if (statuses.some((status) => status === undefined)) return { ...reasoning, outcome: "not_recorded" };
    const failures = statuses.filter(Boolean).length;
    const outcome = failures === 0 ? "succeeded" : failures === statuses.length ? "failed" : "mixed";
    return { ...reasoning, outcome };
  };

  const providerRetryFollowUpFor = (entryId: string): AssistantFollowUp => {
    let child = assistantsByParentId.get(entryId);
    let reasoning: string | undefined;
    for (let depth = 0; child && depth < 8; depth++) {
      reasoning ??= child.reasoning;
      if (child.stopReason !== "error") {
        return { ...reasoningFields(reasoning), outcome: "provider_retry_succeeded" };
      }
      child = assistantsByParentId.get(child.id);
    }
    return { ...reasoningFields(reasoning), outcome: "not_recorded" };
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      const model = message.provider && message.model ? `${message.provider}/${message.model}` : undefined;
      for (const block of message.content) {
        if (block.type === "toolCall") {
          owners.set(block.id, {
            model,
            batchId: entry.id,
            failedEditInput: block.name === "edit" ? formatFailedEditInput(block.arguments) : undefined,
            simpleRipgrepCommand: block.name === "bash" && isSimpleRipgrepCommand(block.arguments),
            verificationFamily: verificationFamily(block.name, block.arguments),
          });
        }
      }
      if (message.stopReason === "error" || message.errorMessage) {
        const text = message.errorMessage || textContent(message.content) || `Assistant stopped with ${message.stopReason}.`;
        const classified = classifyError("assistant", text);
        const followUp = classified.category === "provider_error"
          ? providerRetryFollowUpFor(entry.id)
          : followUpFor(entry.id);
        addObservation(observations, {
          entryId: entry.id,
          source: "assistant",
          tool: "assistant/provider",
          model,
          ...classified,
          text,
          postErrorReasoning: followUp.reasoning,
          reasoningKind: followUp.reasoningKind,
          followUpOutcome: followUp.outcome,
          timestamp: entry.timestamp,
        });
      }
      continue;
    }

    if (message.role === "toolResult" && message.isError) {
      const text = textContent(message.content) || "Tool returned isError=true without text content.";
      const owner = owners.get(message.toolCallId);
      if (message.toolName === "bash" && owner?.simpleRipgrepCommand && RG_NO_MATCH_RESULT_RE.test(text)) {
        continue;
      }
      const classified = classifyError(message.toolName, text, owner?.verificationFamily);
      const followUp = followUpFor(entry.id);
      addObservation(observations, {
        entryId: entry.id,
        batchId: owner?.batchId,
        source: "tool",
        tool: message.toolName,
        model: owner?.model,
        ...classified,
        text,
        failedEditInput: message.toolName === "edit" && !VALIDATION_RE.test(text) ? owner?.failedEditInput : undefined,
        postErrorReasoning: followUp.reasoning,
        reasoningKind: followUp.reasoningKind,
        followUpOutcome: followUp.outcome,
        timestamp: entry.timestamp,
      });
      continue;
    }

    if (message.role === "bashExecution" && (message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0))) {
      const text = message.output || (message.cancelled ? "User bash command was cancelled." : `User bash exited with code ${message.exitCode}.`);
      const classified = classifyError("user_bash", text);
      const followUp = followUpFor(entry.id);
      addObservation(observations, {
        entryId: entry.id,
        source: "user_bash",
        tool: "user_bash",
        ...classified,
        text,
        postErrorReasoning: followUp.reasoning,
        reasoningKind: followUp.reasoningKind,
        followUpOutcome: followUp.outcome,
        timestamp: entry.timestamp,
      });
    }
  }

  return collapseCascadeAborts(observations);
}

function collapseCascadeAborts(observations: ErrorObservation[]): ErrorObservation[] {
  const collapsed: ErrorObservation[] = [];
  const firstByBatch = new Map<string, ErrorObservation>();

  for (const observation of observations) {
    if (observation.source !== "tool" || observation.category !== "aborted" || !observation.batchId) {
      collapsed.push(observation);
      continue;
    }

    const first = firstByBatch.get(observation.batchId);
    if (!first) {
      observation.cascadeCount = 1;
      firstByBatch.set(observation.batchId, observation);
      collapsed.push(observation);
      continue;
    }

    first.cascadeCount = (first.cascadeCount ?? 1) + 1;
    if (!first.cascadeEntryIds) {
      first.cascadeEntryIds = [];
      if (first.entryId) first.cascadeEntryIds.push(first.entryId);
    }
    if (observation.entryId) first.cascadeEntryIds.push(observation.entryId);
    first.timestamp = observation.timestamp;
    if (first.followUpOutcome === "not_recorded" && observation.followUpOutcome !== "not_recorded") {
      first.followUpOutcome = observation.followUpOutcome;
      first.reasoningKind = observation.reasoningKind;
      first.postErrorReasoning = observation.postErrorReasoning;
    }
    first.tool = "tool_batch";
    first.cause = "同一 assistant tool batch 的多个工具结果被级联中止，按一个失败事件计数。";
    first.text = "Multiple tool results in one assistant batch were aborted before completion.";
  }

  return collapsed;
}

function groupErrors(observations: readonly ErrorObservation[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  const start = Math.max(0, observations.length - MAX_REPORT_OBSERVATIONS);
  for (let index = start; index < observations.length; index++) {
    const observation = observations[index];
    const normalizedText = observation.text.replace(WHITESPACE_RE, " ").trim();
    const normalizedInput = observation.failedEditInput?.replace(WHITESPACE_RE, " ").trim() ?? "";
    const normalizedReasoning = observation.postErrorReasoning?.replace(WHITESPACE_RE, " ").trim() ?? "";
    const key = `${observation.source}\u0000${observation.tool}\u0000${observation.model ?? ""}\u0000${observation.category}\u0000${normalizedText}\u0000${normalizedInput}\u0000${normalizedReasoning}\u0000${observation.reasoningKind ?? ""}\u0000${observation.followUpOutcome}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.timestamp = observation.timestamp;
    } else {
      groups.set(key, { ...observation, count: 1 });
    }
  }
  return [...groups.values()].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_TIME_FORMATTER.format(timestamp) : value;
}

function compactRawError(value: string): string {
  if (value.length <= MAX_RAW_ERROR_CHARACTERS) return value;
  let headEnd = RAW_ERROR_HEAD_CHARACTERS;
  const headCode = value.charCodeAt(headEnd);
  const headPreviousCode = value.charCodeAt(headEnd - 1);
  if (headCode >= 0xDC00 && headCode <= 0xDFFF && headPreviousCode >= 0xD800 && headPreviousCode <= 0xDBFF) headEnd--;
  let tailStart = value.length - RAW_ERROR_TAIL_CHARACTERS;
  const tailCode = value.charCodeAt(tailStart);
  const tailPreviousCode = value.charCodeAt(tailStart - 1);
  if (tailCode >= 0xDC00 && tailCode <= 0xDFFF && tailPreviousCode >= 0xD800 && tailPreviousCode <= 0xDBFF) tailStart--;
  const omitted = tailStart - headEnd;
  return `${value.slice(0, headEnd)}\n\n[... ${omitted} characters omitted from this raw error; full text remains in the current session ...]\n\n${value.slice(tailStart)}`;
}

function indentText(value: string): string {
  let output = "    ";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    output += character;
    if (character === "\n" && index + 1 < value.length) output += "    ";
  }
  return output;
}

function compactReportField(value: string): string {
  if (value.length <= MAX_REPORT_FIELD_CHARACTERS) return value;
  return `${value.slice(0, MAX_REPORT_FIELD_CHARACTERS)}\n[... field truncated by report budget; full text remains in the current session ...]`;
}

interface ReportBudget {
  bytes: number;
}

function appendReportLines(target: string[], budget: ReportBudget, source: readonly string[]): boolean {
  let additional = 0;
  for (const line of source) additional += Buffer.byteLength(line, "utf8") + (target.length > 0 || additional > 0 ? 1 : 0);
  if (budget.bytes + additional > MAX_REPORT_BYTES) return false;
  for (const line of source) target.push(line);
  budget.bytes += additional;
  return true;
}

function compareCategoryCounts(left: readonly [string, number], right: readonly [string, number]): number {
  return right[1] - left[1] || left[0].localeCompare(right[0]);
}

function formatFollowUpOutcome(outcome: ErrorObservation["followUpOutcome"]): string {
  switch (outcome) {
    case "succeeded": return "immediate follow-up tool call(s) succeeded";
    case "failed": return "immediate follow-up tool call(s) failed";
    case "mixed": return "immediate follow-up tool calls had mixed results";
    case "provider_retry_succeeded": return "Pi's automatic provider retry chain eventually succeeded";
    case "no_immediate_tool_call": return "no immediate follow-up tool call";
    case "not_recorded": return "no complete immediate follow-up result was recorded";
  }
}

export function formatSessionErrorReport(
  observations: readonly ErrorObservation[],
  metadata: { sessionId: string; sessionName?: string; generatedAt?: number },
): string {
  const generatedAt = metadata.generatedAt ?? Date.now();
  const groups = groupErrors(observations);
  const consideredCount = Math.min(observations.length, MAX_REPORT_OBSERVATIONS);
  const omittedObservationCount = observations.length - consideredCount;
  const sessionName = metadata.sessionName ? compactReportField(metadata.sessionName).slice(0, 256) : undefined;
  const sessionId = compactReportField(metadata.sessionId).slice(0, 256);
  const lines = [
    "# Current session error summary",
    "",
    `- Session: ${sessionName ? `${sessionName} · ` : ""}${sessionId}`,
    `- Generated: ${DATE_TIME_FORMATTER.format(generatedAt)} (Asia/Shanghai)`,
    "- Scope: current active branch only",
    `- Failed observations found: ${observations.length}`,
    `- Observations considered: ${consideredCount} (limit ${MAX_REPORT_OBSERVATIONS})`,
    `- Distinct grouped errors considered: ${groups.length}`,
    `- Report bounds: ${MAX_REPORT_BYTES} UTF-8 bytes, ${MAX_REPORT_GROUPS} detail groups, ${MAX_REPORT_CATEGORIES} categories, ${MAX_REPORT_GROUPS_PER_CATEGORY} groups/category`,
  ];
  const budget: ReportBudget = { bytes: Buffer.byteLength(lines.join("\n"), "utf8") };

  if (groups.length === 0) {
    appendReportLines(lines, budget, ["", "No failed tool results, assistant/provider errors, or failed user Bash executions were found."]);
    return lines.join("\n");
  }

  const categoryCounts = new Map<string, number>();
  const observationStart = Math.max(0, observations.length - consideredCount);
  for (let index = observationStart; index < observations.length; index++) {
    const category = observations[index].category;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const orderedCategories = [...categoryCounts].sort(compareCategoryCounts);
  appendReportLines(lines, budget, ["", "## Categories", ""]);
  const categoryLimit = Math.min(orderedCategories.length, MAX_REPORT_CATEGORIES);
  for (let index = 0; index < categoryLimit; index++) {
    const item = orderedCategories[index];
    appendReportLines(lines, budget, [`- ${compactReportField(item[0])}: ${item[1]}`]);
  }
  if (orderedCategories.length > categoryLimit) {
    appendReportLines(lines, budget, [`- … ${orderedCategories.length - categoryLimit} additional categories omitted by category limit`]);
  }

  appendReportLines(lines, budget, ["", "## Details"]);
  const shownByCategory = new Map<string, number>();
  let shownGroups = 0;
  let omittedByCategory = 0;
  let omittedByBytes = 0;
  for (let index = 0; index < groups.length; index++) {
    if (shownGroups >= MAX_REPORT_GROUPS) break;
    const group = groups[index];
    const categoryShown = shownByCategory.get(group.category) ?? 0;
    if (categoryShown >= MAX_REPORT_GROUPS_PER_CATEGORY) {
      omittedByCategory++;
      continue;
    }
    const detail = [
      "",
      `### ${shownGroups + 1}. ${compactReportField(group.tool)} · ${compactReportField(group.category)}`,
      "",
      `- Count: ${group.count}`,
      `- Latest: ${formatTimestamp(group.timestamp)} (Asia/Shanghai)`,
      `- Model: ${compactReportField(group.model ?? "not recorded")}`,
      `- Deterministic classification hint: ${compactReportField(group.cause)}`,
      `- Follow-up outcome: ${formatFollowUpOutcome(group.followUpOutcome)}`,
    ];
    if (group.cascadeCount && group.cascadeCount > 1) detail.push(`- Collapsed cascade members: ${group.cascadeCount}`);
    detail.push("- Raw error:", "", indentText(compactRawError(group.text)));
    if (group.postErrorReasoning) {
      const reasoningLabel = group.reasoningKind === "self_diagnosis"
        ? "Model self-diagnosis after this failure (verbatim stored thinking; explicit causal wording detected):"
        : "Next model reasoning after this failure (verbatim stored thinking; not asserted as the cause):";
      detail.push("", `- ${reasoningLabel}`, "", indentText(compactReportField(group.postErrorReasoning)));
    } else {
      detail.push("", "- Next model reasoning: not recorded in the directly following assistant message.");
    }
    if (group.failedEditInput) {
      detail.push("", "- Actual failed edit input (recovered from the session tool call; not model reflection):", "", indentText(compactReportField(group.failedEditInput)));
    }
    if (!appendReportLines(lines, budget, detail)) {
      omittedByBytes = groups.length - index;
      break;
    }
    shownByCategory.set(group.category, categoryShown + 1);
    shownGroups++;
  }

  const omittedByGroupLimit = Math.max(0, groups.length - shownGroups - omittedByCategory - omittedByBytes);
  const summary = [
    "",
    "## Bounded omissions",
    "",
    `- Older observations omitted before grouping: ${omittedObservationCount}`,
    `- Detail groups omitted by per-category limit: ${omittedByCategory}`,
    `- Detail groups omitted by total group limit: ${omittedByGroupLimit}`,
    `- Detail groups omitted by byte limit: ${omittedByBytes}`,
    "- Complete source evidence remains in the current session branch.",
  ];
  appendReportLines(lines, budget, summary);
  return lines.join("\n");
}
