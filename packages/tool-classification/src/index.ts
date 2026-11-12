import type { ExtensionAPI, InputEvent, ToolCallEvent, ToolExecutionEndEvent, ToolCatalogSnapshot } from "@super-pi/coding-agent";
import { Type } from "typebox";

function readToolCatalog(pi: ExtensionAPI): ToolCatalogSnapshot {
  return pi.getToolCatalog?.() ?? { tools: pi.getAllTools(), activeTools: pi.getActiveTools() };
}

const CORE_TOOL_NAMES = [
  "codemode",
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

/** Explicit state takes precedence; only hosts without the field use the legacy name heuristic. */
function planOwnsToolSelection(catalog: ToolCatalogSnapshot, active: ReadonlySet<string>): boolean {
  if (catalog.selectionMode !== undefined) return catalog.selectionMode === "plan";
  for (let index = 0; index < PLAN_MODE_TOOL_NAMES.length; index++) {
    if (!active.has(PLAN_MODE_TOOL_NAMES[index])) return false;
  }
  return true;
}

const PRESERVABLE_POLICY_TOOL_NAMES = ["goal_complete", "goal_blocked", "inspect_image"] as const;
const POLICY_OWNED_TOOL_NAMES = new Set<string>([
  ...PLAN_MODE_TOOL_NAMES,
  ...PRESERVABLE_POLICY_TOOL_NAMES,
]);

const CATEGORY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  browser: ["browser", "web", "chrome", "page", "screenshot", "浏览器", "网页", "截图"],
  browser_debug: ["browser_debug", "devtools", "cdp", "chrome devtools", "local preview", "localhost", "browser debugging", "浏览器调试", "本地预览", "本地页面预览", "前端调试"],
  delegation: ["delegation", "delegate", "subagent", "agent", "parallel", "委派", "子代理", "并行"],
  memory: ["memory", "recall", "session", "history", "remember", "记忆", "回忆", "会话", "历史"],
  skills: ["skill", "skills", "procedure", "workflow", "技能", "流程"],
  mcp: ["mcp", "remote", "integration", "external tool", "远程工具", "外部工具", "集成"],
  navigation: ["navigation", "lsp", "diagnostic", "symbol", "reference", "导航", "诊断", "符号", "引用"],
};

const CATEGORY_ENTRIES = Object.entries(CATEGORY_ALIASES);
const CATEGORY_SEARCH_TEXT: Readonly<Record<string, string>> = Object.fromEntries(
  CATEGORY_ENTRIES.map(([category, aliases]) => [category, aliases.join(" ")]),
);
const TOKEN_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;
const CJK_TERM = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });
const BROWSER_DEBUG_QUERY = /\b(?:browser_debug|cdp|devtools|localhost)\b|chrome_devtools_|\blocal (?:html|page|preview)\b|\b(?:browser|frontend|dom) debug(?:ging)?\b|\b(?:dom|javascript) inspection\b|\binspect (?:dom|javascript)\b|\bui validation\b|\bvalidate ui\b|本地(?:网页|页面|预览)|(?:浏览器|前端|网页|页面)调试|(?:dom|javascript)\s*检查|(?:ui|界面)\s*验证/iu;
const BROWSER_APPROVAL_PAUSE = Object.freeze({ block: true,
  reason: "[BROWSER_APPROVAL_PAUSED] Browser Harness reported incomplete Chrome approval. Stop this automatic browser workflow and wait for user direction; do not retry Browser Harness or switch to another browser/profile to bypass it. DevTools is available for separately directed local preview and debugging, but does not prove approval of the original connection.",
});

/** Primitive pause/session identity; stable hooks inspect failures, never progress. */
class BrowserRoutingGuard {
  awaitingUser = false;
  sessionId: string | undefined;
  approvalGeneration = 0;
  readonly reset = (): void => { this.awaitingUser = false; this.approvalGeneration++; };
  readonly dispose = (): void => { this.reset(); this.sessionId = undefined; };
  readonly observeSelection = (data: unknown): void => {
    if (this.sessionId === undefined || data === null || typeof data !== "object"
      || !("sessionId" in data) || data.sessionId !== this.sessionId
      || !("phase" in data) || !("approvalGeneration" in data)) return;
    if (data.phase === "begin") data.approvalGeneration = this.approvalGeneration;
    else if (data.phase === "commit" && data.approvalGeneration === this.approvalGeneration) this.awaitingUser = false;
  };
  readonly observeInput = (event: InputEvent): void => {
    // A fresh user-directed task may choose CDP; this does not grant Chrome permission.
    if (event.source !== "extension") this.reset();
  };
  readonly observeResult = (event: ToolExecutionEndEvent): void => {
    if (event.toolName !== "browser_exec" || !event.isError) return;
    const content = event.result?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      if (block.text.startsWith("[BROWSER_EXEC_PERMISSION_REQUIRED]")
        || block.text.startsWith("[BROWSER_EXEC_ABORTED] [BROWSER_APPROVAL_PENDING]")
        || block.text.startsWith("[BROWSER_EXEC_TIMEOUT] [BROWSER_APPROVAL_PENDING]")
        || block.text.startsWith("[BROWSER_EXEC_TIMEOUT] Browser deadline exceeded. An earlier Chrome approval prompt")) {
        this.awaitingUser = true;
        this.approvalGeneration++;
        return;
      }
    }
  };
  readonly checkCall = (event: ToolCallEvent) => {
    if (this.awaitingUser && (event.toolName === "browser_exec" || event.toolName.startsWith("chrome_devtools_"))) return BROWSER_APPROVAL_PAUSE;
    return undefined;
  };
}

function categoryFor(name: string): string {
  if (name === "browser_exec") return "browser";
  if (name.startsWith("chrome_devtools_")) return "browser_debug";
  if (name === "subagent") return "delegation";
  if (name === "memory" || name === "memory_search" || name === "session_search") return "memory";
  if (name === "skill_manage") return "skills";
  if (name === "mcp_search_tools") return "mcp";
  if (name.startsWith("lsp_")) return "navigation";
  return "other";
}

function normalizedTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const part of query.split(TOKEN_SPLIT)) {
    if (!part) continue;
    if (CJK_TERM.test(part)) {
      for (const word of WORD_SEGMENTER.segment(part)) {
        if (word.isWordLike) terms.add(word.segment);
      }
    } else terms.add(part);
  }
  return Array.from(terms);
}

function requestedCategory(query: string): string | undefined {
  for (const [category, aliases] of CATEGORY_ENTRIES) {
    if (aliases.includes(query)) return category;
  }
  return undefined;
}

interface ToolCandidate {
  name: string;
  category: string;
  score: number;
}
interface ToolSearchDetails {
  query: string;
  matches: ToolCandidate[];
  added: string[];
  rejected: string[];
  blocked?: "browser_approval";
}

function compareCandidates(left: ToolCandidate, right: ToolCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export default function toolClassificationExtension(pi: ExtensionAPI): void {
  const browserRouting = new BrowserRoutingGuard();
  pi.on("input", browserRouting.observeInput);
  pi.on("tool_execution_end", browserRouting.observeResult);
  pi.on("tool_call", browserRouting.checkCall);
  pi.on("session_tree", browserRouting.reset);
  const stopUserSelection = pi.events.on("super-pi:chrome-devtools:user-selection", browserRouting.observeSelection);
  pi.on("session_shutdown", browserRouting.dispose);
  pi.on("session_shutdown", stopUserSelection);
  pi.registerTool({
    name: "tool_search",
    label: "Tool Search",
    description: "Search registered inactive Pi tools by capability and activate the best matches for this session. Use when the stable core tools cannot perform the task. Use browser/browser_exec for public-web reading and interaction in the user's browser. Use browser_debug or a chrome_devtools_* name for local HTML/localhost preview, DOM/JavaScript inspection, UI validation, or an explicitly requested CDP endpoint; these tools can be activated here and may launch an isolated browser. Choose by task and required login/profile, not by which connection failed. Incomplete Browser Harness approval pauses automatic browser switching until user direction; a new CDP profile does not inherit the original login or establish its approval.",
    promptSnippet: "Search and activate conditional tools when the stable core tool pack is insufficient",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: "Capability, exact tool name, or category: browser for ordinary web work; browser_debug for local preview/DOM/JavaScript/CDP; memory, delegation, skills, or mcp." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Maximum tools to activate; defaults to 6." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const query = params.query.trim().toLowerCase().normalize("NFC");
      const category = requestedCategory(query);
      const browserDebug = category === "browser_debug" || BROWSER_DEBUG_QUERY.test(query);
      const terms = normalizedTerms(query);
      const wordScoreLimit = (terms.length + 1) ** 2;
      const limit = params.limit ?? 6;
      const candidates: ToolCandidate[] = [];
      if (browserDebug && browserRouting.awaitingUser) return {
        content: [{ type: "text", text: BROWSER_APPROVAL_PAUSE.reason }], isError: true,
        details: { query: params.query, matches: [], added: [], rejected: [], blocked: "browser_approval" } as ToolSearchDetails,
      };
      const catalog = readToolCatalog(pi);
      const active = catalog.activeTools;
      const activeSet = new Set(active);
      for (const tool of catalog.tools) {
        if (
          tool.name === "tool_search"
          || tool.available === false
          || activeSet.has(tool.name)
          || POLICY_OWNED_TOOL_NAMES.has(tool.name)
        ) continue;

        const toolCategory = categoryFor(tool.name);
        if (toolCategory === "browser_debug" && !browserDebug) continue;
        if (toolCategory === "browser" && browserDebug) continue;
        if (category !== undefined && category !== toolCategory) continue;
        const name = tool.name.toLowerCase().normalize("NFC");
        // Each covered term outweighs all possible name bonuses. Exact names and
        // category routing outweigh the entire word score, regardless of term count.
        let score = name === query ? 2 * wordScoreLimit : category === toolCategory ? wordScoreLimit : 0;
        if (category === undefined && browserDebug && toolCategory === "browser_debug") score += wordScoreLimit;
        if (category === undefined) {
          const description = tool.description.toLowerCase().normalize("NFC");
          const categoryText = CATEGORY_SEARCH_TEXT[toolCategory] ?? toolCategory;
          for (const term of terms) {
            if (name.includes(term)) score += terms.length + 2;
            else if (description.includes(term) || categoryText.includes(term)) score += terms.length + 1;
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

  pi.on("session_start", (_event, ctx) => {
    browserRouting.sessionId = ctx.sessionManager.getSessionId();
    browserRouting.reset();
    const catalog = readToolCatalog(pi);
    const activeBeforeReset = catalog.activeTools;
    const allTools = catalog.tools;
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
    if (planOwnsToolSelection(catalog, activeSet)) return;

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
