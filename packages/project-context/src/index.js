import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureHermesProjectMemory,
  getIndexState,
  getStatus,
  initializeProject,
  refreshProject,
  resolveProject,
} from "./core.js";
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

function statusText(status, lastIndex) {
  const lines = [
    `Project root: ${sanitizeUiText(status.root, 220)}`,
    `Initialized: ${mark(status.initialized)}`,
  ];
  if (status.manifest) lines.push(`Stable ID: ${sanitizeUiText(status.manifest.id, 80)}`);
  lines.push(`AGENTS.md: ${mark(pathExists(path.join(status.root, "AGENTS.md")))}`);
  lines.push(`Index: ${status.indexState}`);
  if (lastIndex?.root === status.root) lines.push(`Last index build: ${lastIndex.text}`);
  lines.push(`Hermes scope: ${sanitizeUiText(status.hermes.name ?? "none", 120)} (${status.hermes.exists ? "memory exists" : "no saved project memory"})`);
  if (!status.hermes.rootAligned) lines.push("Hermes warning: non-Git nested cwd may split memory; start Pi from the initialized root.");
  return lines.join("\n");
}

function pathExists(target) {
  try {
    return Boolean(target && fs.existsSync(target));
  } catch {
    return false;
  }
}

function errorText(error) {
  return sanitizeUiText(error instanceof Error ? error.message : error);
}

function buildIndex(cwd, project) {
  const { root } = project;
  try {
    const result = refreshProject(cwd, project);
    const changed = result.profileChanged || result.indexChanged;
    return { root, text: `${changed ? "refreshed" : "already current"}: ${result.records.length} files`, failed: false };
  } catch (error) {
    let previous = "";
    try { if (getIndexState(root) === "published") previous = " Previous index retained."; } catch {}
    return { root, text: `not completed: ${errorText(error)}.${previous}`, failed: true };
  }
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
}

export function registerProjectCommands(pi) {
  let lastIndex;
  pi.registerCommand("project-status", {
    description: "Show project identity, published index status, and Hermes scope",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(statusText(getStatus(ctx.cwd), lastIndex), "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("project-init", {
    description: "Initialize project identity and AGENTS.md navigation, then build the lightweight index",
    handler: async (_args, ctx) => {
      try {
        const result = initializeProject(ctx.cwd);
        const action = result.alreadyInitialized ? "already initialized" : "initialized";
        let memory;
        let memoryFailed = false;
        try {
          const hermes = ensureHermesProjectMemory(result.root, ctx.cwd);
          memory = hermes.created ? "created" : "preserved";
        } catch (error) {
          memoryFailed = true;
          memory = `not prepared: ${errorText(error)}`;
        }
        lastIndex = buildIndex(ctx.cwd, result);
        ctx.ui.notify(`Project ${action}: ${sanitizeUiText(result.root, 220)}\nAGENTS.md: ${result.agents}\nHermes project memory: ${memory}\nIndex: ${lastIndex.text}`,
          memoryFailed || lastIndex.failed ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("project-refresh", {
    description: "Refresh the deterministic lightweight project profile and file index",
    handler: async (_args, ctx) => {
      try {
        const project = resolveProject(ctx.cwd);
        lastIndex = buildIndex(ctx.cwd, project);
        ctx.ui.notify(`Project context ${lastIndex.text}`, lastIndex.failed ? "error" : "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

}
