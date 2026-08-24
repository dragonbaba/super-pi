import * as path from "node:path";
import { codeGraphAvailability, resolveProject } from "./core.js";
import {
  ANSI_CSI_PATTERN,
  ANSI_ESCAPE_PATTERN,
  ANSI_OSC_PATTERN,
  ANSI_STRING_PATTERN,
  CONTROL_EXCEPT_WHITESPACE_PATTERN,
  CRLF_PATTERN,
  TEXT_CONTROL_PATTERN,
  TRAILING_REPLACEMENT_CHARACTER_PATTERN,
} from "./regex.js";

const MAX_OUTPUT_BYTES = 50 * 1024;
const QUERY_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 10 * 60_000;
const REINDEX_TIMEOUT_MS = 20 * 60_000;
const MAX_STABILIZATION_SYNCS = 2;
const READ_ACTIONS = new Set(["query", "explore", "node", "callers", "callees", "impact", "affected"]);
const operationQueues = new Map();

export function withCodeGraphQueue(root, operation) {
  const previous = operationQueues.get(root) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  operationQueues.set(root, current);
  return current.finally(() => {
    if (operationQueues.get(root) === current) operationQueues.delete(root);
  });
}

function integer(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function requiredText(value, name, maxLength = 500) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  const text = value.trim();
  if (text.length > maxLength || TEXT_CONTROL_PATTERN.test(text)) throw new Error(`${name} is invalid or too long`);
  return text;
}

function optionalProjectFile(value, root, name = "file") {
  const text = requiredText(value, name, 1000).replaceAll("\\", "/");
  if (path.isAbsolute(text)) throw new Error(`${name} must be relative to the project root`);
  const absolute = path.resolve(root, text);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${name} must stay inside the project root`);
  }
  return relative.replaceAll("\\", "/");
}

export function truncateCodeGraphOutput(value, maxBytes = MAX_OUTPUT_BYTES) {
  const source = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "symbol"
        ? value.description ?? ""
        : `${value}`;
  const text = source
    .replace(CRLF_PATTERN, "\n")
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_STRING_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_EXCEPT_WHITESPACE_PATTERN, "");
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  const clipped = encoded.subarray(0, maxBytes).toString("utf8").replace(TRAILING_REPLACEMENT_CHARACTER_PATTERN, "");
  return `${clipped}\n\n[CodeGraph output truncated: ${encoded.length} bytes total]`;
}

export function pendingChangeCount(status) {
  const pending = status?.pendingChanges;
  return [pending?.added, pending?.modified, pending?.removed]
    .reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0);
}

export function codeGraphNeedsReindex(status) {
  return status?.initialized === true && (
    status?.index?.reindexRecommended === true
    || status?.index?.state !== "complete"
    || Boolean(status?.worktreeMismatch)
  );
}

function sameProjectRoot(left, right) {
  if (typeof left !== "string" || left.trim() === "") return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function buildCodeGraphReadArgs(action, input, root) {
  const limit = integer(input.limit, action === "query" ? 10 : 20, 1, 100);
  switch (action) {
    case "query":
      return ["query", "--path", root, "--limit", `${limit}`, "--json", "--", requiredText(input.query, "query")];
    case "explore":
      return ["explore", "--path", root, "--max-files", `${integer(input.maxFiles, 8, 1, 30)}`, "--", requiredText(input.query, "query")];
    case "node": {
      const args = ["node", "--path", root];
      if (input.file !== undefined) args.push("--file", optionalProjectFile(input.file, root));
      if (input.offset !== undefined) args.push("--offset", `${integer(input.offset, 1, 1, 10_000_000)}`);
      if (input.lineLimit !== undefined) args.push("--limit", `${integer(input.lineLimit, 200, 1, 2000)}`);
      if (input.symbolsOnly === true) args.push("--symbols-only");
      if (input.symbol !== undefined) args.push("--", requiredText(input.symbol, "symbol"));
      if (input.symbol === undefined && input.file === undefined) throw new Error("node requires symbol or file");
      return args;
    }
    case "callers":
    case "callees":
      return [action, "--path", root, "--limit", `${limit}`, "--json", "--", requiredText(input.symbol, "symbol")];
    case "impact":
      return ["impact", "--path", root, "--depth", `${integer(input.depth, 2, 1, 10)}`, "--json", "--", requiredText(input.symbol, "symbol")];
    case "affected": {
      if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100) {
        throw new Error("affected requires 1-100 project-relative files");
      }
      const files = input.files.map((file, index) => optionalProjectFile(file, root, `files[${index}]`));
      return ["affected", "--path", root, "--depth", `${integer(input.depth, 5, 1, 20)}`, "--json", "--", ...files];
    }
    default:
      throw new Error(`Unsupported CodeGraph action: ${action}`);
  }
}

function assertTrusted(ctx) {
  if (typeof ctx?.isProjectTrusted !== "function" || !ctx.isProjectTrusted()) {
    throw new Error("CodeGraph is disabled until the current project is trusted");
  }
}

export function createCodeGraphClient(pi, ctx, dependencies = {}) {
  assertTrusted(ctx);
  const root = (dependencies.resolveProject ?? resolveProject)(ctx.cwd).root;
  const installed = (dependencies.codeGraphAvailability ?? codeGraphAvailability)();
  if (!installed.available || !installed.executable || !installed.cli) {
    throw new Error("CodeGraph is not installed at the expected local application path");
  }

  const execute = async (args, timeout = QUERY_TIMEOUT_MS, signal = ctx.signal) => {
    const result = await pi.exec(installed.executable, [installed.cli, ...args], {
      cwd: root,
      timeout,
      signal,
    });
    const stdout = truncateCodeGraphOutput(result.stdout ?? "").trim();
    const stderr = truncateCodeGraphOutput(result.stderr ?? "").trim();
    const output = [stdout, stderr].filter(Boolean).join("\n");
    if (result.code !== 0) throw new Error(output || `CodeGraph exited with code ${result.code}`);
    return { stdout, stderr, output };
  };

  const run = async (args, timeout = QUERY_TIMEOUT_MS, signal = ctx.signal) => (
    await execute(args, timeout, signal)
  ).output;

  const status = async () => {
    const { stdout } = await execute(["status", root, "--json"]);
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.initialized && !sameProjectRoot(parsed.projectPath, root)) {
        return {
          initialized: false,
          version: parsed.version,
          projectPath: root,
          inheritedProjectPath: parsed.projectPath,
          lastIndexed: null,
        };
      }
      return parsed;
    } catch {
      throw new Error("CodeGraph returned invalid status JSON");
    }
  };

  const assertHealthy = (current, operation) => {
    if (!current.initialized) throw new Error(`CodeGraph ${operation} did not produce an initialized index`);
    if (codeGraphNeedsReindex(current)) {
      throw new Error(`CodeGraph ${operation} completed but the index requires a full rebuild`);
    }
    return current;
  };

  const isDirty = (current) => pendingChangeCount(current) > 0 || current.index?.pendingRefs > 0;

  const stabilize = async (operation) => {
    let current = assertHealthy(await status(), operation);
    let followUpSyncs = 0;
    while (isDirty(current) && followUpSyncs < MAX_STABILIZATION_SYNCS) {
      await run(["sync", root], SYNC_TIMEOUT_MS);
      current = assertHealthy(await status(), operation);
      followUpSyncs++;
    }
    if (isDirty(current)) {
      const pendingChanges = pendingChangeCount(current);
      const pendingRefs = Number.isFinite(current.index?.pendingRefs) ? Math.max(0, current.index.pendingRefs) : 0;
      throw new Error(
        `CodeGraph ${operation} completed but the index is still not clean ` +
        `(${pendingChanges} file changes, ${pendingRefs} pending references after ${followUpSyncs} follow-up syncs)`,
      );
    }
    return current;
  };

  const ensureFresh = async () => {
    let current = await status();
    if (!current.initialized) throw new Error("CodeGraph is not initialized for this project; run /codegraph-init first");
    if (codeGraphNeedsReindex(current)) throw new Error("CodeGraph requires a full rebuild; run /codegraph-reindex");
    if (isDirty(current)) {
      await run(["sync", root], SYNC_TIMEOUT_MS);
      current = await stabilize("sync");
    }
    return current;
  };

  const initialize = async () => {
    const output = await run(["init", root], REINDEX_TIMEOUT_MS);
    await stabilize("initialization");
    return output;
  };

  const synchronize = async () => {
    const before = await status();
    if (!before.initialized) throw new Error("CodeGraph is not initialized; run /codegraph-init first");
    if (codeGraphNeedsReindex(before)) throw new Error("CodeGraph requires a full rebuild; run /codegraph-reindex");
    if (!isDirty(before)) return "CodeGraph index is already current.";
    const output = await run(["sync", root], SYNC_TIMEOUT_MS);
    await stabilize("sync");
    return output;
  };

  const rebuild = async () => {
    const output = await run(["index", root], REINDEX_TIMEOUT_MS);
    await stabilize("reindex");
    return output;
  };

  return {
    root,
    run,
    status: () => withCodeGraphQueue(root, status),
    ensureFresh: () => withCodeGraphQueue(root, ensureFresh),
    init: () => withCodeGraphQueue(root, initialize),
    sync: () => withCodeGraphQueue(root, synchronize),
    reindex: () => withCodeGraphQueue(root, rebuild),
    read(action, input) {
      if (!READ_ACTIONS.has(action)) return Promise.reject(new Error(`Unsupported CodeGraph read action: ${action}`));
      return withCodeGraphQueue(root, async () => {
        await ensureFresh();
        return run(buildCodeGraphReadArgs(action, input, root));
      });
    },
  };
}

export function formatCodeGraphStatus(status) {
  const lines = [
    `CodeGraph version: ${status?.version ?? "unknown"}`,
    `Initialized: ${status?.initialized ? "yes" : "no"}`,
  ];
  if (!status?.initialized) {
    if (status?.inheritedProjectPath) lines.push(`Nearest parent index ignored: ${status.inheritedProjectPath}`);
    return lines.join("\n");
  }
  lines.push(`Index state: ${status.index?.state ?? "unknown"}`);
  lines.push(`Last indexed: ${status.lastIndexed ?? "unknown"}`);
  lines.push(`Files / symbols / edges: ${status.fileCount ?? 0} / ${status.nodeCount ?? 0} / ${status.edgeCount ?? 0}`);
  lines.push(`Pending changes: ${pendingChangeCount(status)}`);
  if (status.index?.pendingRefs) lines.push(`Pending references: ${status.index.pendingRefs}`);
  if (status.worktreeMismatch) lines.push("Warning: index belongs to a different worktree");
  if (codeGraphNeedsReindex(status)) lines.push("Recommendation: run /codegraph-reindex");
  else if (pendingChangeCount(status) > 0 || status.index?.pendingRefs > 0) lines.push("Recommendation: run /codegraph-sync");
  else lines.push("Index is ready for queries");
  return lines.join("\n");
}

export const CODEGRAPH_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["status", "query", "explore", "node", "callers", "callees", "impact", "affected"] },
    query: { type: "string", maxLength: 500 },
    symbol: { type: "string", maxLength: 500 },
    file: { type: "string", maxLength: 1000 },
    files: { type: "array", maxItems: 100, items: { type: "string", maxLength: 1000 } },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    depth: { type: "integer", minimum: 1, maximum: 20 },
    maxFiles: { type: "integer", minimum: 1, maximum: 30 },
    offset: { type: "integer", minimum: 1 },
    lineLimit: { type: "integer", minimum: 1, maximum: 2000 },
    symbolsOnly: { type: "boolean" },
  },
};
