import { createHash } from "node:crypto";
import type { SessionAllowRule, SessionAllowRuleKind } from "./permission-contract.ts";

const RULE_SCHEMA = "permission-rule-v2";
const MAX_RULE_PATTERN_CHARS = 4_096;
const MAX_RULE_LABEL_CHARS = 320;
const SIMPLE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/u;
const DISPLAY_WHITESPACE_PATTERN = /\s+/gu;

function normalizedPattern(kind: SessionAllowRuleKind, value: string): string {
  let pattern = value.trim();
  if (kind === "prefix" && pattern.endsWith("*")) pattern = pattern.slice(0, -1).trimEnd();
  if (!pattern || pattern.length > MAX_RULE_PATTERN_CHARS || pattern.includes("\0")) {
    throw new Error("Session command rules require 1-4096 characters and cannot contain NUL bytes.");
  }
  if (kind === "prefix" && (pattern.includes("\n") || pattern.includes("\r"))) {
    throw new Error("A Session command prefix must fit on one line.");
  }
  return pattern;
}

function ruleId(kind: SessionAllowRuleKind, pattern: string): string {
  return createHash("sha256").update(RULE_SCHEMA).update("\0").update(kind).update("\0").update(pattern).digest("hex");
}

function ruleLabel(kind: SessionAllowRuleKind, pattern: string): string {
  const display = pattern.replace(DISPLAY_WHITESPACE_PATTERN, " ");
  const suffix = kind === "prefix" ? " *" : "";
  const prefix = kind === "prefix" ? "前缀" : "精确";
  const available = MAX_RULE_LABEL_CHARS - prefix.length - suffix.length - 3;
  const bounded = display.length <= available ? display : `${display.slice(0, available - 1)}…`;
  return `${prefix}：${bounded}${suffix}`;
}

export function createSessionAllowRule(kind: SessionAllowRuleKind, value: string): SessionAllowRule {
  const pattern = normalizedPattern(kind, value);
  return { id: ruleId(kind, pattern), kind, pattern, label: ruleLabel(kind, pattern) };
}

export function sessionAllowRuleMatches(rule: SessionAllowRule, command: string): boolean {
  const value = command.trim();
  if (rule.kind === "exact") return value === rule.pattern;
  if (value === rule.pattern) return true;
  if (!value.startsWith(rule.pattern)) return false;
  const boundary = value.charCodeAt(rule.pattern.length);
  return boundary === 32 || boundary === 9 || boundary === 10 || boundary === 13;
}

export function simpleCommandPrefix(command: string): string | undefined {
  const value = command.trimStart();
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    if (code === 32 || code === 9 || code === 10 || code === 13) break;
    end += 1;
  }
  const executable = value.slice(0, end);
  return SIMPLE_COMMAND_PATTERN.test(executable) ? executable : undefined;
}
