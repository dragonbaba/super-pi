import type { ExtensionAPI } from "@super-pi/coding-agent";
import { Type } from "typebox";

const CORE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "structured_readonly_command",
  "lsp_diagnostics",
  "lsp_fix",
  "lsp_navigate",
  "tool_search",
] as const;

const PLAN_MODE_TOOL_NAMES = ["plan_mode_question", "plan_mode_complete"] as const;
const PRESERVABLE_POLICY_TOOL_NAMES = ["goal_complete", "goal_blocked", "inspect_image"] as const;
const POLICY_OWNED_TOOL_NAMES = new Set<string>([
  ...PLAN_MODE_TOOL_NAMES,
  ...PRESERVABLE_POLICY_TOOL_NAMES,
]);

const CATEGORY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  browser: ["browser", "web", "chrome", "cdp", "page", "screenshot", "浏览器", "网页", "截图"],
  delegation: ["delegation", "delegate", "subagent", "agent", "parallel", "委派", "子代理", "并行"],
  memory: ["memory", "recall", "session", "history", "remember", "记忆", "回忆", "会话", "历史"],
  skills: ["skill", "skills", "procedure", "workflow", "技能", "流程"],
  graph: ["graph", "codegraph", "impact", "callers", "callees", "图谱", "影响分析", "调用关系"],
  mcp: ["mcp", "remote", "integration", "external tool", "远程工具", "外部工具", "集成"],
  navigation: ["navigation", "lsp", "diagnostic", "symbol", "reference", "导航", "诊断", "符号", "引用"],
};

const CATEGORY_ENTRIES = Object.entries(CATEGORY_ALIASES);
const CATEGORY_SEARCH_TEXT: Readonly<Record<string, string>> = Object.fromEntries(
  CATEGORY_ENTRIES.map(([category, aliases]) => [category, aliases.join(" ")]),
);
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

function categoryFor(name: string): string {
  if (name === "browser_exec" || name.startsWith("chrome_devtools_")) return "browser";
  if (name === "subagent") return "delegation";
  if (name === "memory" || name === "memory_search" || name === "session_search") return "memory";
  if (name === "skill_manage") return "skills";
  if (name === "codegraph") return "graph";
  if (name === "mcp_search_tools") return "mcp";
  if (name.startsWith("lsp_")) return "navigation";
  return "other";
}

function normalizedTerms(query: string): string[] {
  return query.toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
}

function requestedCategory(query: string): string | undefined {
  const normalized = query.trim().toLowerCase();
  for (const [category, aliases] of CATEGORY_ENTRIES) {
    if (aliases.includes(normalized)) return category;
  }
  return undefined;
}

interface ToolCandidate {
  name: string;
  category: string;
  score: number;
}

function compareCandidates(left: ToolCandidate, right: ToolCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export default function toolClassificationExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description: "Search registered inactive Pi tools by capability and activate the best matches for this session. Use when the stable core tools cannot perform the task.",
    promptSnippet: "Search and activate conditional tools when the stable core tool pack is insufficient",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: "Capability, tool name, or category such as browser, memory, delegation, graph, skills, or mcp." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Maximum tools to activate; defaults to 6." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const category = requestedCategory(params.query);
      const terms = normalizedTerms(params.query);
      const limit = params.limit ?? 6;
      const candidates: ToolCandidate[] = [];
      for (const tool of pi.getAllTools()) {
        if (
          tool.name === "tool_search"
          || activeSet.has(tool.name)
          || POLICY_OWNED_TOOL_NAMES.has(tool.name)
        ) continue;

        const toolCategory = categoryFor(tool.name);
        if (category !== undefined && category !== toolCategory) continue;
        let score = category === toolCategory ? 100 : 0;
        if (category === undefined) {
          const haystack = `${tool.name} ${tool.description} ${toolCategory} ${CATEGORY_SEARCH_TEXT[toolCategory] ?? ""}`.toLowerCase();
          for (const term of terms) {
            if (haystack.includes(term)) score += 1;
          }
        }
        if (score > 0) candidates.push({ name: tool.name, category: toolCategory, score });
      }
      candidates.sort(compareCandidates);
      if (candidates.length > limit) candidates.length = limit;

      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: `No inactive tools matched: ${params.query}` }],
          details: {
            query: params.query,
            matches: [] as ToolCandidate[],
            added: [] as string[],
            rejected: [] as string[],
          },
        };
      }

      const requested = candidates.map((candidate) => candidate.name);
      pi.setActiveTools([...active, ...requested]);
      const activeAfter = new Set(pi.getActiveTools());
      const added = requested.filter((name) => activeAfter.has(name));
      const rejected = requested.filter((name) => !activeAfter.has(name));
      return {
        content: [{
          type: "text",
          text: added.length > 0
            ? `Activated conditional tools: ${added.join(", ")}${rejected.length > 0 ? `; rejected: ${rejected.join(", ")}` : ""}`
            : `Conditional tool activation was rejected: ${rejected.join(", ")}`,
        }],
        details: { query: params.query, matches: candidates, added, rejected },
      };
    },
  });

  pi.registerCommand("tool-classes", {
    description: "Show active core/conditional Pi tool classification",
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools();
      const conditional = active.filter((name) => !CORE_TOOL_NAMES.includes(name as (typeof CORE_TOOL_NAMES)[number]));
      ctx.ui.notify(
        `Core: ${CORE_TOOL_NAMES.filter((name) => active.includes(name)).join(", ")}\nConditional active: ${conditional.join(", ") || "none"}`,
        "info",
      );
    },
  });

  pi.on("session_start", () => {
    const activeBeforeReset = pi.getActiveTools();
    const allTools = pi.getAllTools();
    const activeSet = new Set(activeBeforeReset);

    // An explicit --tools/SDK allowlist exposes only the selected definitions,
    // and Pi activates that entire visible catalog before session_start. Keep
    // the caller's exact selection instead of replacing conditional tools with
    // the default core pack. This also preserves --no-tools (both lists empty).
    if (activeBeforeReset.length === allTools.length) {
      let explicitSelection = true;
      for (let index = 0; index < allTools.length; index += 1) {
        if (activeSet.has(allTools[index].name)) continue;
        explicitSelection = false;
        break;
      }
      if (explicitSelection) return;
    }
    let planModeOwnsSelection = true;
    for (let index = 0; index < PLAN_MODE_TOOL_NAMES.length; index += 1) {
      if (activeSet.has(PLAN_MODE_TOOL_NAMES[index])) continue;
      planModeOwnsSelection = false;
      break;
    }
    if (planModeOwnsSelection) return;

    const available = new Set<string>();
    for (let index = 0; index < allTools.length; index += 1) {
      available.add(allTools[index].name);
    }
    const nextActive: string[] = [];
    for (let index = 0; index < CORE_TOOL_NAMES.length; index += 1) {
      const name = CORE_TOOL_NAMES[index];
      if (available.has(name)) nextActive.push(name);
    }
    for (let index = 0; index < PRESERVABLE_POLICY_TOOL_NAMES.length; index += 1) {
      const name = PRESERVABLE_POLICY_TOOL_NAMES[index];
      if (available.has(name) && activeSet.has(name)) nextActive.push(name);
    }
    pi.setActiveTools(nextActive);
  });
}
