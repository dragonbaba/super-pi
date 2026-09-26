import { TOOL_RESULT_BUDGET_INTEGER_PATTERN } from "./tool-result-budget-regex.ts";
import type { ToolResultPresentationOptions } from "./tool-result-presentation.ts";

export function parseToolResultBudgetCommand(value: string): ToolResultPresentationOptions | undefined | "status" {
  const command = value.trim();
  if (!command || command === "status") return "status";
  if (command === "off") return undefined;
  const budgetTokens = Number(command);
  if (!TOOL_RESULT_BUDGET_INTEGER_PATTERN.test(command) || !Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
    throw new Error("用法：/tool-budget status | off | <正整数 tokens>。没有自动默认预算。");
  }
  return { enabled: true, budgetTokens };
}

/** Explicit-command snapshot. Never produced by a delta, progress or render loop. */
export interface ToolResultBudgetStatus {
  state: "disabled" | "enabled-unconfigured" | "enabled" | "budget-too-small";
  budgetTokens?: number;
  lastRequest: "not-observed" | "applied" | "blocked" | "preparation-failed";
  scope: "startup-configuration" | "session-override";
  imageAndBillingEstimate: "unavailable";
  retainedRecords: number;
  retainedCodeUnits: number;
}

export function formatToolResultBudgetStatus(status: ToolResultBudgetStatus): string {
  const state = status.state === "disabled" ? "关闭" : status.state === "enabled-unconfigured" ? "启用，但未配置有效预算"
    : status.state === "budget-too-small" ? "预算过小，下一次模型请求已阻止" : "启用，已配置结果投影预算";
  const request = status.lastRequest === "not-observed" ? "尚未观察到模型请求" : status.lastRequest === "blocked" ? "请求被预算检查阻止"
    : status.lastRequest === "preparation-failed" ? "最近一次请求的结果投影准备失败，请检查错误记录" : "预算已用于最近一次请求准备";
  return `工具结果预算：${state}\n预算：${status.budgetTokens ?? "未设置"} 文本估算 tokens\n${request}\n配置来源：${status.scope === "session-override" ? "本会话明确设置" : "启动配置"}\n图像计费、缓存命中与实际费用：估算不适用，数值未知。\n已成功接收的完整工具结果保存在 Session/UI；MCP 输入接收失败时，完整输出可能不可用，远端工具可能已经执行。\n/tool-budget <正整数> 设置本会话预算；/tool-budget off 关闭。操作不保存全局/项目配置，不重新执行已完成工具。`;
}
