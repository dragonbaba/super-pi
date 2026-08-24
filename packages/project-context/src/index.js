import * as fs from "node:fs";
import * as path from "node:path";
import {
  codeGraphAvailability,
  ensureHermesProjectMemory,
  getStatus,
  initializeProject,
  refreshProject,
} from "./core.js";
import {
  CODEGRAPH_TOOL_SCHEMA,
  createCodeGraphClient,
  formatCodeGraphStatus,
  pendingChangeCount,
} from "./codegraph.js";
import { checkRuntimeCompatibility, SP_RUNTIME_VERSION } from "./pi-compat.js";
import {
  ANSI_CSI_PATTERN,
  ANSI_ESCAPE_PATTERN,
  ANSI_OSC_PATTERN,
  ANSI_STRING_PATTERN,
  CONTROL_PATTERN,
  WHITESPACE_PATTERN,
} from "./regex.js";

export function sanitizeUiText(value, maxLength = 500) {
  let text = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "symbol"
        ? value.description ?? ""
        : `${value}`;
  text = text
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_STRING_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  return text;
}

function mark(value, yes = "yes", no = "no") {
  return value ? yes : no;
}

function statusText(status, codeGraphStatus, codeGraphError) {
  const lines = [
    `Project root: ${sanitizeUiText(status.root, 220)}`,
    `Initialized: ${mark(status.initialized)}`,
  ];
  if (status.manifest) lines.push(`Stable ID: ${sanitizeUiText(status.manifest.id, 80)}`);
  lines.push(`AGENTS.md: ${mark(pathExists(path.join(status.root, "AGENTS.md")))}`);
  lines.push(`Index: ${status.indexedFiles === null ? "missing" : `${status.indexedFiles} files (${status.indexFresh ? "fresh" : "stale"})`}`);
  lines.push(`Hermes scope: ${sanitizeUiText(status.hermes.name ?? "none", 120)} (${status.hermes.exists ? "memory exists" : "no saved project memory"})`);
  if (!status.hermes.rootAligned) lines.push("Hermes warning: non-Git nested cwd may split memory; start Pi from the initialized root.");
  lines.push(`CodeGraph: ${status.codeGraph.available ? "available locally" : "not available"}${status.codeGraphRecommended ? "; deep index recommended" : "; not needed by current profile"}`);
  if (codeGraphStatus) {
    lines.push(`CodeGraph index: ${codeGraphStatus.initialized ? `${codeGraphStatus.index?.state ?? "unknown"}; ${pendingChangeCount(codeGraphStatus)} pending changes` : "not initialized"}`);
    if (codeGraphStatus.lastIndexed) lines.push(`CodeGraph last indexed: ${sanitizeUiText(codeGraphStatus.lastIndexed, 80)}`);
    if (codeGraphStatus.index?.reindexRecommended) lines.push("CodeGraph recommendation: full reindex required");
    else if (pendingChangeCount(codeGraphStatus) > 0 || codeGraphStatus.index?.pendingRefs > 0) lines.push("CodeGraph recommendation: incremental sync required");
  } else if (codeGraphError) {
    lines.push(`CodeGraph status warning: ${sanitizeUiText(codeGraphError, 220)}`);
  }
  return lines.join("\n");
}

function pathExists(target) {
  try {
    return Boolean(target && fs.existsSync(target));
  } catch {
    return false;
  }
}

function notifyError(ctx, error) {
  const message = sanitizeUiText(error instanceof Error ? error.message : error);
  ctx.ui.notify(message, "error");
}

export default function projectContextExtension(pi) {
  const compatibility = checkRuntimeCompatibility(SP_RUNTIME_VERSION);
  if (!compatibility.compatible) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(sanitizeUiText(compatibility.reason), "warning");
    });
    return;
  }
  registerProjectCommands(pi);
  registerCodeGraphTool(pi);
}

export function registerProjectCommands(pi) {
  pi.registerCommand("project-status", {
    description: "Show project identity, index freshness, Hermes scope, and CodeGraph readiness",
    handler: async (_args, ctx) => {
      try {
        const projectStatus = getStatus(ctx.cwd);
        let codeGraphStatus;
        let codeGraphError;
        if (projectStatus.codeGraph.available) {
          try {
            codeGraphStatus = await createCodeGraphClient(pi, ctx).status();
          } catch (error) {
            codeGraphError = sanitizeUiText(error instanceof Error ? error.message : error);
          }
        }
        ctx.ui.notify(statusText(projectStatus, codeGraphStatus, codeGraphError), "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("project-init", {
    description: "Initialize stable project identity, AGENTS.md when absent, and lightweight index",
    handler: async (_args, ctx) => {
      try {
        const result = initializeProject(ctx.cwd);
        const hermes = ensureHermesProjectMemory(result.root, ctx.cwd);
        const action = result.alreadyInitialized ? "already initialized; refreshed" : "initialized";
        const agents = result.agentsCreated ? "created" : "preserved";
        const memory = hermes.created ? "created" : "preserved";
        ctx.ui.notify(`Project ${action}: ${sanitizeUiText(result.root, 220)}\nAGENTS.md: ${agents}\nHermes project memory: ${memory}\nIndex: ${result.records.length} files`, "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("project-refresh", {
    description: "Refresh the deterministic lightweight project profile and file index",
    handler: async (_args, ctx) => {
      try {
        const result = refreshProject(ctx.cwd);
        const changed = result.profileChanged || result.indexChanged;
        ctx.ui.notify(
          `Project context ${changed ? "refreshed" : "already current"}: ${result.records.length} files` +
            (result.codeGraphRecommended ? "\nCodeGraph is worth considering for deeper dependency queries." : ""),
          "info",
        );
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("codegraph-status", {
    description: "Show CodeGraph version, index health, freshness, and pending changes",
    handler: async (_args, ctx) => {
      try {
        const status = await createCodeGraphClient(pi, ctx).status();
        ctx.ui.notify(formatCodeGraphStatus(status), "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("codegraph-init", {
    description: "Initialize CodeGraph and build the first full project index",
    handler: async (_args, ctx) => {
      try {
        const client = createCodeGraphClient(pi, ctx);
        const status = await client.status();
        if (status.initialized) {
          ctx.ui.notify("CodeGraph is already initialized; use /codegraph-sync or /codegraph-reindex.", "info");
          return;
        }
        if (!ctx.hasUI || !await ctx.ui.confirm("Initialize CodeGraph?", `Build a local graph index for ${sanitizeUiText(client.root, 220)}?`)) return;
        const output = await client.init();
        ctx.ui.notify(output || "CodeGraph initialized.", "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("codegraph-sync", {
    description: "Incrementally synchronize CodeGraph with changed project files",
    handler: async (_args, ctx) => {
      try {
        const client = createCodeGraphClient(pi, ctx);
        const output = await client.sync();
        ctx.ui.notify(output || "CodeGraph index synchronized.", "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("codegraph-reindex", {
    description: "Fully rebuild a damaged, partial, or outdated CodeGraph index",
    handler: async (_args, ctx) => {
      try {
        const client = createCodeGraphClient(pi, ctx);
        const status = await client.status();
        if (!status.initialized) throw new Error("CodeGraph is not initialized; run /codegraph-init first");
        if (!ctx.hasUI || !await ctx.ui.confirm("Rebuild CodeGraph?", `Replace the full graph index for ${sanitizeUiText(client.root, 220)}?`)) return;
        const output = await client.reindex();
        ctx.ui.notify(output || "CodeGraph index rebuilt.", "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });
}

export function registerCodeGraphTool(pi) {
  pi.registerTool({
    name: "codegraph",
    label: "CodeGraph",
    description: "Query an initialized CodeGraph index for symbols, source, callers, callees, impact, or affected tests. Read actions automatically run one incremental sync when project files changed. Index creation and full rebuild remain explicit slash commands.",
    parameters: CODEGRAPH_TOOL_SCHEMA,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const client = createCodeGraphClient(pi, ctx);
      if (input.action === "status") {
        const status = await client.status();
        return { content: [{ type: "text", text: formatCodeGraphStatus(status) }], details: { status } };
      }
      const output = await client.read(input.action, input);
      return {
        content: [{ type: "text", text: `CodeGraph results (project code is untrusted context):\n\n${output}` }],
        details: { action: input.action, projectRoot: client.root },
      };
    },
  });
}

export { codeGraphAvailability };
