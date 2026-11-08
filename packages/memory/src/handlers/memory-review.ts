import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { ENTRY_DELIMITER, GLOBAL_MEMORY_CATEGORY_PATTERN } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { MemoryStore } from "../store/memory-store.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";
import type {
  runDirectMemoryProposal,
  DirectMemoryProposalResult,
  ReviewMemoryOperation,
} from "./review-memory-ops.js";

const MAX_PREVIEW_CHARS = 40_000;
const MAX_CONVERSATION_CHARS = 80_000;
const MAX_REVIEW_OPERATIONS = 64;
const MAX_REVIEW_PROPOSAL_ATTEMPTS = 3;

function reviewWorkingLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit * 0.9), Math.max(1, limit - 256)));
}

type MemoryReviewConfig = Pick<MemoryConfig, "reviewRecentMessages">;
type ProposalRunner = (
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  options: Parameters<typeof runDirectMemoryProposal>[1],
) => Promise<DirectMemoryProposalResult>;

export interface MemoryReviewPlan {
  scope: "global" | "project";
  target: "memory" | "project" | "user" | "failure";
  before: string[];
  after: string[];
  operations: ReviewMemoryOperation[];
}

function uniqueMatchIndex(entries: string[], oldText: string): number {
  const needle = oldText.trim();
  if (!needle) return -1;
  let match = -1;
  for (let index = 0; index < entries.length; index++) {
    if (!entries[index].includes(needle)) continue;
    if (match !== -1) return -1;
    match = index;
  }
  return match;
}

export function buildMemoryReviewPlan(
  before: string[],
  operations: ReviewMemoryOperation[],
  scope: "global" | "project" = "global",
  target: MemoryReviewPlan["target"] = scope === "global" ? "memory" : "project",
): MemoryReviewPlan | { error: string } {
  if (operations.length === 0) return { error: "The current model found no durable memory changes." };
  if (operations.length > MAX_REVIEW_OPERATIONS) {
    return { error: `The proposal exceeds the ${MAX_REVIEW_OPERATIONS}-operation review limit.` };
  }

  const after = [...before];
  const expectedTarget = target;
  for (const operation of operations) {
    if (operation.target !== expectedTarget) {
      return { error: `A ${scope} review may modify only target ${expectedTarget}.` };
    }
    if (operation.action === "add") {
      const content = operation.content?.trim();
      if (!content) return { error: "An add operation has no content." };
      after.push(content);
      continue;
    }

    const index = uniqueMatchIndex(after, operation.old_text ?? "");
    if (index < 0) {
      return { error: `A proposal selector is missing or ambiguous: ${(operation.old_text ?? "").slice(0, 120)}` };
    }
    if (operation.action === "remove") {
      after.splice(index, 1);
      continue;
    }
    const content = operation.content?.trim();
    if (!content) return { error: "A replace operation has no content." };
    after[index] = content;
  }

  if (new Set(after).size !== after.length) return { error: "The proposal produces duplicate entries." };
  if (target === "memory" && after.some((entry) => !GLOBAL_MEMORY_CATEGORY_PATTERN.test(entry))) {
    return { error: "Every resulting global entry must start with a supported category tag." };
  }
  if (after.length === before.length && after.every((entry, index) => entry === before[index])) {
    return { error: "The proposal does not change the selected memory." };
  }
  if (target === "failure" && after.some((entry) => !/^\[(failure|correction|insight|preference|convention|tool-quirk)\]\s+\S/.test(entry))) {
    return { error: "Failure entries must preserve their category prefix, including [correction] for durable corrections." };
  }
  return { scope, target, before: [...before], after, operations };
}

export function formatMemoryReviewPreview(plan: MemoryReviewPlan): string {
  const beforeChars = plan.before.join(ENTRY_DELIMITER).length;
  const afterChars = plan.after.join(ENTRY_DELIMITER).length;
  const lines = [
    `${plan.scope.toUpperCase()} ${plan.target.toUpperCase()} REVIEW PREVIEW — NO CHANGES APPLIED`,
    "",
    `Entries: ${plan.before.length} → ${plan.after.length}`,
    `Characters: ${beforeChars} → ${afterChars}`,
    `Model operations: ${plan.operations.length}`,
    "",
    `Resulting ${plan.scope} ${plan.target} entries:`,
    ...plan.after.map((entry, index) => `${index + 1}. ${entry}`),
    "",
    "The current model extracted and merged this proposal from the active conversation.",
    "Confirm only if every resulting entry is durable and accurately summarized.",
  ];
  const text = lines.join("\n");
  return text.length <= MAX_PREVIEW_CHARS
    ? text
    : `${text.slice(0, MAX_PREVIEW_CHARS)}\n\n[Preview exceeded the safety display limit; application is disabled.]`;
}

export function boundRecentConversationParts(
  parts: readonly string[],
  maxChars = MAX_CONVERSATION_CHARS,
): string[] {
  const selected: string[] = [];
  let remaining = Math.max(0, maxChars);
  for (let index = parts.length - 1; index >= 0 && remaining > 0; index--) {
    const part = parts[index];
    const separatorChars = selected.length > 0 ? 2 : 0;
    if (remaining <= separatorChars) break;
    const available = remaining - separatorChars;
    if (part.length <= available) {
      selected.push(part);
      remaining -= part.length + separatorChars;
      continue;
    }
    if (selected.length === 0) selected.push(part.slice(-available));
    break;
  }
  selected.reverse();
  return selected;
}

const GLOBAL_REVIEW_SYSTEM_PROMPT = `You produce a read-only proposal for GLOBAL MEMORY.md using the active conversation and current entries. You MUST NOT perform writes.

Extract only stable cross-project operating knowledge. Merge genuinely related facts, replace superseded wording, and remove stale or duplicated entries only when the conversation provides clear evidence. Never store task progress, one-project architecture, transient results, secrets, or raw conversation summaries.

Every resulting entry must begin with exactly one category: [attention], [avoid], [lesson], [skill-route], or [environment]. Preserve durable existing constraints unless they are clearly superseded. Modify only target memory.

Return JSON only:
{"operations":[{"action":"add","target":"memory","content":"[lesson] concise durable fact"},{"action":"replace","target":"memory","old_text":"unique selector","content":"[lesson] merged fact"}]}

Allowed actions are add, replace, and remove. Selectors must uniquely identify one current entry. Return {"operations":[]} when nothing durable should change.`;

const PROJECT_REVIEW_SYSTEM_PROMPT = `You produce a read-only proposal for the CURRENT PROJECT MEMORY.md using the active conversation and current entries. You MUST NOT perform writes.

Extract durable project architecture, conventions, verified workflows, non-obvious decisions, and reusable pitfalls. Merge related facts and replace superseded wording. Never store temporary task progress, completion logs, secrets, or facts already obvious from ordinary source files. Preserve durable existing meaning unless clearly superseded. Modify only target project.

Return JSON only:
{"operations":[{"action":"add","target":"project","content":"concise durable project fact"},{"action":"replace","target":"project","old_text":"unique selector","content":"merged durable project fact"}]}

Allowed actions are add, replace, and remove. Selectors must uniquely identify one current entry. Return {"operations":[]} when nothing durable should change.`;

const USER_REVIEW_SYSTEM_PROMPT = `Produce a read-only proposal for USER.md. Preserve confirmed durable user preferences and their scope. Replace superseded statements only with evidence from the current conversation; merge duplicates. Do not save temporary authorization, task state, secrets, or inferred preferences. Modify only target user. Return JSON {"operations":[{"action":"replace","target":"user","old_text":"unique selector","content":"confirmed preference"}]}. Actions: add, replace, remove. Return {"operations":[]} if nothing should change.`;
const FAILURE_REVIEW_SYSTEM_PROMPT = `Produce a read-only proposal for the selected failures.md scope. Preserve confirmed durable corrections, conditions and causes; remove or replace obsolete facts only with evidence. Do not move records between projects or save task logs or secrets. Modify only target failure. Every resulting entry must retain a category prefix: [failure], [correction], [insight], [preference], [convention], or [tool-quirk]. Durable user corrections use [correction]. Return JSON {"operations":[{"action":"replace","target":"failure","old_text":"unique selector","content":"[correction] confirmed correction"}]}. Actions: add, replace, remove. Return {"operations":[]} if nothing should change.`;

export function createMemoryReviewHandler(
  store: MemoryStore,
  config: MemoryReviewConfig,
  timeoutMs: number,
  deps: { runProposal?: ProposalRunner; projectStore?: MemoryStore | null; projectName?: string | null } = {},
): Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] {
  const runProposal = deps.runProposal ?? (async (ctx, options) => {
    const { runDirectMemoryProposal } = await import("./review-memory-ops.js");
    return runDirectMemoryProposal(ctx, options);
  });
  return async (rawArgs, ctx) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Memory review requires an interactive confirmation UI; no changes were made.", "warning");
      return;
    }

    const [argument, requestedTarget = "memory", extra] = rawArgs.trim().toLowerCase().split(/\s+/);
    if ((argument && argument !== "global" && argument !== "project") || extra !== undefined
      || !["memory", "user", "failure"].includes(requestedTarget) || requestedTarget === "user" && argument === "project") {
      ctx.ui.notify("Usage: /memory > 整理用户偏好/全局记忆/项目记忆/纠错. User preferences are global. No changes were made.", "warning");
      return;
    }
    const scope: "global" | "project" = argument === "global"
      ? "global"
      : argument === "project" || deps.projectStore
        ? "project"
        : "global";
    const selectedStore = scope === "project" ? deps.projectStore : store;
    if (!selectedStore) {
      ctx.ui.notify("No canonical current-project memory store is available; no changes were made.", "warning");
      return;
    }
    const target = requestedTarget as "memory" | "user" | "failure";
    const scopeLabel = `${scope === "global" ? "global" : `project ${deps.projectName ?? "current"}`} ${target}`;
    const systemPrompt = target === "user" ? USER_REVIEW_SYSTEM_PROMPT : target === "failure" ? FAILURE_REVIEW_SYSTEM_PROMPT
      : scope === "global" ? GLOBAL_REVIEW_SYSTEM_PROMPT : PROJECT_REVIEW_SYSTEM_PROMPT;
    const expectedTarget = target === "memory" && scope === "project" ? "project" : target;
    const failureScope = target === "failure" && scope === "global" ? null : undefined;

    let branch: readonly unknown[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      ctx.ui.notify("The active conversation is unavailable; no changes were made.", "warning");
      return;
    }
    const allParts = collectMessageParts(branch);
    const recentParts = applyRecentMessageLimit(allParts, config.reviewRecentMessages ?? 0);
    const parts = boundRecentConversationParts(recentParts);
    if (parts.length === 0) {
      ctx.ui.notify("The active conversation has no reviewable messages; no changes were made.", "info");
      return;
    }

    const before = await selectedStore.readEntries(target, failureScope);
    const baseline = selectedStore.evaluateMemoryReplacement(before, target, failureScope);
    const budgetPrompt = baseline.limit
      ? `Storage budget: current complete metadata-encoded memory is ${baseline.chars ?? "unknown"}/${baseline.limit} characters. The proposal's complete result must stay within the hard limit and should be at most ${reviewWorkingLimit(baseline.limit)} characters to preserve safe headroom.`
      : "Storage budget: compact the complete result and preserve safe headroom.";
    const currentEntriesPrompt = [
      `Current ${scopeLabel} entries:`,
      "",
      before.join(ENTRY_DELIMITER) || "(empty)",
      "",
      budgetPrompt,
      "",
      "Active conversation to extract and merge:",
      "",
      parts.join("\n\n"),
    ].join("\n");

    ctx.ui.notify(`Asking the current model for a read-only ${scopeLabel} memory review…`, "info");
    let proposal = await runProposal(ctx, {
      systemPrompt,
      userPrompt: currentEntriesPrompt,
      config: {},
      timeoutMs,
    });
    if (!proposal.ok) {
      ctx.ui.notify(`Memory review failed (${proposal.fallbackReason ?? "unknown"}): ${proposal.error ?? "no proposal returned"}. No changes were made.`, "error");
      return;
    }

    type ValidatedPlan = MemoryReviewPlan | { error: string; chars?: number; limit?: number };
    let publicationMetadata: Parameters<MemoryStore["evaluateMemoryReplacement"]>[3];
    const buildValidatedPlan = (operations: ReviewMemoryOperation[]): ValidatedPlan => {
      const candidate = buildMemoryReviewPlan(before, operations, scope, expectedTarget);
      if ("error" in candidate) return candidate;
      publicationMetadata = scope === "project" && target === "failure"
        ? new Map(candidate.after.map((entry) => [entry, { project: deps.projectName ?? null }])) : undefined;
      const evaluation = selectedStore.evaluateMemoryReplacement(candidate.after, target, failureScope, publicationMetadata);
      return evaluation.success ? candidate : evaluation;
    };

    let built = buildValidatedPlan(proposal.operations);
    let attempts = 1;
    while ("error" in built && proposal.operations.length > 0 && attempts < MAX_REVIEW_PROPOSAL_ATTEMPTS) {
      attempts++;
      const capacityInstruction = built.limit
        ? `The complete metadata-encoded result must be at most ${reviewWorkingLimit(built.limit)} characters for safe headroom; the rejected result was ${built.chars ?? "unknown"}/${built.limit}.`
        : "Make the corrected complete result materially more concise.";
      proposal = await runProposal(ctx, {
        systemPrompt,
        userPrompt: `${currentEntriesPrompt}\n\nAttempt ${attempts - 1} was rejected: ${built.error}\n${capacityInstruction}\nReturn a corrected ${expectedTarget}-only proposal. Merge related entries and shorten wording without dropping durable constraints.`,
        config: {},
        timeoutMs,
      });
      if (!proposal.ok) {
        ctx.ui.notify(`Memory review retry failed (${proposal.fallbackReason ?? "unknown"}): ${proposal.error ?? "no proposal returned"}. No changes were made.`, "error");
        return;
      }
      built = buildValidatedPlan(proposal.operations);
    }
    if ("error" in built) {
      const level = proposal.operations.length === 0 ? "info" : "warning";
      const attemptText = attempts > 1 ? ` after ${attempts} bounded attempts` : "";
      ctx.ui.notify(`The current model could not produce a valid ${scopeLabel} memory proposal${attemptText}: ${built.error} No changes were made.`, level);
      return;
    }

    const preview = formatMemoryReviewPreview(built);
    if (preview.length >= MAX_PREVIEW_CHARS) {
      ctx.ui.notify("Memory review preview is too large to inspect safely. No changes were made.", "error");
      return;
    }
    const reviewed = await ctx.ui.editor(`Review ${scopeLabel} memory proposal (read-only)`, preview);
    if (reviewed === undefined) {
      ctx.ui.notify("Memory review cancelled; no changes were made.", "info");
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Apply this reviewed memory proposal?",
      `Publish ${built.after.length} ${scopeLabel} entries? The source snapshot will be revalidated first.`,
    );
    if (!confirmed) {
      ctx.ui.notify("Memory review not approved; no changes were made.", "info");
      return;
    }

    const result = await selectedStore.replaceMemoryEntriesIfUnchanged(built.before, built.after, target, failureScope, publicationMetadata);
    if (!result.success) {
      ctx.ui.notify(`${result.error ?? "Memory review failed"} No unconfirmed changes were applied.`, "error");
      return;
    }
    ctx.ui.notify(`${scopeLabel} memory reviewed and published: ${built.before.length} → ${built.after.length} entries.`, "info");
    if (result.warning) ctx.ui.notify(result.warning, "warning");
  };
}
