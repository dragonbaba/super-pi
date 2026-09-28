// Deterministic failure classification used by the tool-loop guard and recovery hints.
import {
  VALIDATION_RE,
  EDIT_NON_UNIQUE_RE,
  EDIT_NOT_FOUND_RE,
  EDIT_OVERLAP_RE,
  UTF8_REJECTED_RE,
  ABORTED_RE,
  TIMEOUT_RE,
  POLICY_BLOCKED_RE,
  DUPLICATE_CALL_RE,
  WORKDIR_MISMATCH_RE,
  PATH_NOT_FOUND_RE,
  PROVIDER_QUOTA_EXHAUSTED_RE,
  PROVIDER_ERROR_RE,
  SNAPSHOT_EDIT_ERROR_RE,
  MUTATION_READ_REQUIRED_RE,
  ENCODING_ERROR_RE,
  SHELL_SYNTAX_ERROR_RE,
  SCRIPT_SYNTAX_ERROR_RE,
  ENVIRONMENT_ERROR_RE,
  SCRIPT_ASSERTION_RE,
  SCRIPT_RUNTIME_ERROR_RE,
  CONFIGURATION_ERROR_RE,
  PLATFORM_PATH_ERROR_RE,
  LSP_WORKSPACE_ESCAPE_RE,
  LSP_INPUT_VALIDATION_RE,
  LSP_ENVIRONMENT_ERROR_RE,
  EXACT_MIGRATION_VERSION_RE,
  MSYS_TASKKILL_REWRITE_RE,
  MSYS_ARGV_RECOVERY_RE,
  EMPTY_NONZERO_EXIT_RE,
  COMMAND_FAILED_RE,
  VERIFICATION_TEST_RE,
  VERIFICATION_TYPECHECK_RE,
  VERIFICATION_BUILD_RE,
  VERIFICATION_LINT_RE,
  REQUIRED_CODEGRAPH_ARGUMENT_RE,
} from "./failure-classification-regex.ts";

const MAX_RAW_ERROR_CHARACTERS = 12_000;

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
  ["STALE", { category: "stale_state", cause: "快照之后目标身份或内容发生变化，提交前拒绝且未修改；重新读取所需范围，使用该次 read 的 snapshot 和 LINE#ID。" }],
  ["MISMATCH", { category: "snapshot_anchor_mismatch", cause: "LINE#ID 与不可变快照中的对应行不匹配；更正该快照的锚点。只有快照仍有效时可重试，否则重新读取。" }],
  ["UNSEEN", { category: "snapshot_unseen_range", cause: "行操作超出 read 实际展示并授权的行范围。" }],
  ["BUDGET", { category: "mutation_budget_exceeded", cause: "快照编辑的操作、文本或结果大小超过有界预算。" }],
  ["BOUNDARY", { category: "input_validation", cause: "替换文本与存活边界行相同，重复意图不明确；勿自动删除。若只是定位上下文则省略，有意重复时显式替换覆盖该行的已读范围。" }],
  ["OVERLAP", { category: "overlap", cause: "快照行操作重叠、嵌套或共享不明确的插入边界。" }],
  ["NO_OP", { category: "no_op_edit", cause: "快照行操作生成的内容与原文件完全相同。" }],
  ["INVALID", { category: "input_validation", cause: "快照行操作的 kind、LINE#ID 锚点或 newLines 组合无效。" }],
  ["UNSUPPORTED", { category: "snapshot_unsupported", cause: "目标不是当前快照行协议支持的严格 UTF-8 行文本。" }],
  ["SYNTAX", { category: "syntax_regression", cause: "编辑会为 JavaScript/TypeScript 引入新的解析诊断，因此在写盘前被拒绝。" }],
  ["IDENTITY", { category: "stale_state", cause: "快照目标不再是原来的常规文件身份。" }],
  ["PARTIAL", { category: "partial_mutation", cause: "原子替换已提交，但提交后回读验证失败；必须人工核对目标。" }],
]);

type VerificationFamily = "test" | "typecheck" | "build" | "lint" | "diagnostics";

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
    if (text.startsWith("[SNAPSHOT_EDIT_SYNTAX] TypeScript parser is unavailable")) return { category: "runtime_error", cause: "宿主 TypeScript 解析器不可用；候选未检查，本次未写入。恢复宿主依赖后使用仍有效的快照重新提交。" };
    const match = SNAPSHOT_EDIT_ERROR_RE.exec(text);
    const code = match?.[1];
    if (code) {
      const snapshotFailure = SNAPSHOT_EDIT_CAUSES.get(code.toUpperCase());
      if (snapshotFailure) return snapshotFailure;
    }
  }
  if (text.startsWith("[TOOL_ARGS_INCOMPLETE]")) return { category: "input_validation", cause: "工具参数在响应结束时未完成；本次调用未执行。" };
  if (text.startsWith("[TOOL_RESPONSE_LIMIT]")) return { category: "input_validation", cause: "响应达到输出上限，参数完整性尚不确定；本次调用未执行。" };
  if (text.startsWith("[SNAPSHOT_REQUIRED]")) return { category: "input_validation", cause: "LINE#ID 编辑漏传顶层 snapshot；优先补入配套 ID，不代表读取证据已过期。" };
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
