import { createHash, createHmac } from "node:crypto";
import { loadMcpConfig } from "./config.js";
import { checkRuntimeCompatibility, discoverPiVersion } from "./runtime-compat.js";
import { MAX_ACTIVATED_SCHEMA_BYTES, MAX_SERVERS, sanitizeText } from "./security.js";
import { McpRuntimeLifecycle } from "./lifecycle.js";

const ACTIVATION_ENTRY = "mcp-tool-activation-v1";
const MAX_ACTIVATION_ENTRIES = MAX_SERVERS * 128;

export function toolActivationFingerprint(runtime, name, fingerprints) {
  const config = runtime.toolConfig(name);
  const identity = config && fingerprints.get(config.id);
  if (typeof identity !== "string") return undefined;
  return createHash("sha256").update(identity).update("\0").update(runtime.registeredNames.get(name)).digest("hex");
}

function isActivationItem(item) {
  return typeof item?.name === "string" && item.name.length <= 58 && typeof item.fingerprint === "string" && item.fingerprint.length === 64;
}

function activationRecord(entry) {
  if (entry.type !== "custom" || entry.customType !== ACTIVATION_ENTRY) return undefined;
  const data = entry.data;
  return data?.version === 1 && typeof data.base === "boolean" && Array.isArray(data.tools) && data.tools.length <= MAX_ACTIVATION_ENTRIES ? data : undefined;
}

// Re-setting a name moves it to the newest position, so the size bound evicts
// the least recently recorded identity. Restore replays the same operations.
export function applyActivationItems(intent, items) {
  for (const item of items) {
    if (!isActivationItem(item)) continue;
    intent.delete(item.name);
    intent.set(item.name, item.fingerprint);
  }
  while (intent.size > MAX_ACTIVATION_ENTRIES) intent.delete(intent.keys().next().value);
}

// Explicit auth command only. Include import/preparation in the owned operation,
// but leave ctx.reload outside it: reload emits session_shutdown itself.
async function runAuthCommand(action, server, ctx, signal) {
  const { McpOAuth } = await import("./oauth.js");
  signal.throwIfAborted();
  const owner = new McpOAuth(server);
  if (action === "login") {
    await owner.login(url => {
      if (!signal.aborted) ctx.ui.notify(`Open this URL to authorize ${server.id}:\n${url}`, "info");
    }, signal);
  } else await owner.logout(signal);
}

export default function mcpBridgeExtension(pi) {
  const compatibility = checkRuntimeCompatibility(discoverPiVersion());
  if (!compatibility.compatible) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(compatibility.reason, "warning");
    });
    return;
  }

  let configError = null;
  let configInfo = null;
  let authController = null;
  let authOperation = null;
  let authGeneration = 0;
  let authEnabled = false;
  const stopAuth = async () => {
    authEnabled = false;
    authGeneration++;
    authController?.abort();
    try { await authOperation; } catch { /* the command observes its own failure */ }
  };
  const knownRemoteToolNames = new Set();
  // Names the host activated only because they were newly registered.
  const hostActivatedRemoteNames = new Set();
  let activationIntent = new Map();
  // Delta items appended since the branch's latest full snapshot.
  let activationDeltaItems = 0;
  let activationGeneration = 0;
  let fingerprints = new Map();

  // Records are full snapshots (`base: true`) or deltas. Restore replays the
  // latest snapshot on the branch and the deltas after it.
  const restoreActivationIntent = (ctx) => {
    activationGeneration++;
    activationIntent = new Map();
    activationDeltaItems = 0;
    const branch = ctx.sessionManager?.getBranch() ?? [];
    let start = branch.length;
    for (let index = branch.length - 1; index >= 0; index--) {
      const record = activationRecord(branch[index]);
      if (!record) continue;
      start = index;
      if (record.base) break;
    }
    for (let index = start; index < branch.length; index++) {
      const record = activationRecord(branch[index]);
      if (!record) continue;
      if (record.base) { activationIntent = new Map(); activationDeltaItems = 0; }
      else activationDeltaItems += record.tools.length;
      applyActivationItems(activationIntent, record.tools);
    }
  };

  // A snapshot is written once the deltas since the previous one would be at
  // least as large, so persisted data stays linear in the number of changes.
  const recordActivationChanges = (changes) => {
    if (changes.length === 0) return;
    const intent = new Map(activationIntent);
    applyActivationItems(intent, changes);
    if (activationDeltaItems + changes.length >= intent.size) {
      const tools = [];
      for (const [name, fingerprint] of intent) tools.push({ name, fingerprint });
      pi.appendEntry(ACTIVATION_ENTRY, { version: 1, base: true, tools });
      activationDeltaItems = 0;
    } else {
      pi.appendEntry(ACTIVATION_ENTRY, { version: 1, base: false, tools: changes });
      activationDeltaItems += changes.length;
    }
    activationIntent = intent;
  };

  // A reset (startup, tree navigation) applies only the branch intent. A catalog
  // update also keeps remote tools activated by other means while still valid.
  const syncRemoteTools = (runtime, reset = false) => {
    for (const name of runtime.registeredNames.keys()) knownRemoteToolNames.add(name);
    const next = new Set();
    for (const name of pi.getActiveTools()) {
      if (!knownRemoteToolNames.has(name)) next.add(name);
      else if (!reset && !hostActivatedRemoteNames.has(name) && runtime.toolConfig(name)) next.add(name);
    }
    hostActivatedRemoteNames.clear();
    for (const [name, fingerprint] of activationIntent) {
      if (toolActivationFingerprint(runtime, name, fingerprints) === fingerprint) next.add(name);
    }
    next.add("mcp_search_tools");
    pi.setActiveTools([...next]);
  };

  const deactivateRemoteTools = (clearNames = true) => {
    const active = pi.getActiveTools();
    const next = [];
    for (const name of active) {
      if (!knownRemoteToolNames.has(name)) next.push(name);
    }
    if (next.length !== active.length) pi.setActiveTools(next);
    if (clearNames) { knownRemoteToolNames.clear(); hostActivatedRemoteNames.clear(); }
  };
  const lifecycle = new McpRuntimeLifecycle(deactivateRemoteTools);

  pi.registerTool({
    name: "mcp_search_tools",
    label: "MCP tool search",
    description: "Search configured MCP tools. After activation, use Codemode callTool(name, args) in this script; describeTools([name]) provides the current schema.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Words from the desired MCP server, tool, or capability" } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_toolCallId, args, signal) {
      const runtime = lifecycle.current;
      if (!runtime) throw new Error("MCP runtime is not started");
      const generation = activationGeneration;
      await runtime.waitForDiscovery(signal);
      if (lifecycle.current !== runtime || generation !== activationGeneration || signal?.aborted) throw new Error("MCP search was cancelled or replaced");
      const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
      const candidates = runtime.searchTools(query, 8);
      if (candidates.length === 0) return { content: [{ type: "text", text: `No deferred MCP tools matched: ${sanitizeText(query, 200)}` }] };
      const matches = [];
      let schemaBytes = 0;
      for (const name of candidates) {
        const nextBytes = runtime.toolSchemaBytes(name);
        if (matches.length > 0 && schemaBytes + nextBytes > MAX_ACTIVATED_SCHEMA_BYTES) continue;
        matches.push(name);
        schemaBytes += nextBytes;
      }
      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const added = matches.filter((name) => !activeSet.has(name));
      if (added.length > 0) pi.setActiveTools([...active, ...added]);
      // Host policy (for example an allowlist) may ignore names; record and
      // report only the tools the host actually accepted.
      const accepted = new Set(pi.getActiveTools());
      const changes = [];
      for (const name of matches) {
        if (!accepted.has(name)) continue;
        const fingerprint = toolActivationFingerprint(runtime, name, fingerprints);
        if (fingerprint !== undefined && activationIntent.get(name) !== fingerprint) changes.push({ name, fingerprint });
      }
      recordActivationChanges(changes);
      const activated = added.filter((name) => accepted.has(name));
      const rejected = matches.filter((name) => !accepted.has(name));
      const lines = [];
      if (activated.length > 0) lines.push(`Activated MCP tools: ${activated.join(", ")}`);
      else if (rejected.length < matches.length) lines.push(`Matching MCP tools were already active: ${matches.filter((name) => accepted.has(name)).join(", ")}`);
      if (rejected.length > 0) lines.push(`Not activated by the host tool policy: ${rejected.join(", ")}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const authStopped = stopAuth();
    let token;
    try { token = await lifecycle.begin(ctx.signal); }
    finally { await authStopped; }
    if (!token || !lifecycle.isCurrent(token) || token.signal.aborted) return;
    restoreActivationIntent(ctx);
    configError = null;
    let nextRuntime = null;
    try {
      const { McpSchemaCache, configFingerprint, prepareSchemaCache } = await import("./schema-cache.js");
      if (!lifecycle.isCurrent(token)) return;
      const cacheSnapshot = prepareSchemaCache();
      configInfo = loadMcpConfig(ctx.cwd, ctx.isProjectTrusted());
      authEnabled = true;
      if (configInfo.servers.length === 0 || !lifecycle.isCurrent(token)) return;
      const [{ McpBridgeRuntime }, { loadActivationKey }] = await Promise.all([
        import("./bridge.js"),
        import("./activation-key.js"),
      ]);
      if (!lifecycle.isCurrent(token)) return;
      const schemaCache = new McpSchemaCache(cacheSnapshot.path, cacheSnapshot);
      nextRuntime = new McpBridgeRuntime({
        registerTool(tool) {
          if (!lifecycle.isCurrent(token) || token.signal.aborted || nextRuntime.closed) throw new Error("MCP startup aborted");
          // Record ownership before host registration: a later catalog entry can
          // fail, and cleanup must still deactivate every partially registered tool.
          knownRemoteToolNames.add(tool.name);
          const wasActive = pi.getActiveTools().includes(tool.name);
          pi.registerTool(tool);
          if (!wasActive && pi.getActiveTools().includes(tool.name)) hostActivatedRemoteNames.add(tool.name);
        },
      }, ctx.cwd, schemaCache);
      // The configuration digest covers secret values; only a keyed digest of it
      // is persisted. Without a key, activation intent is not recorded or restored.
      fingerprints = new Map();
      const activationKey = loadActivationKey();
      if (activationKey) {
        for (const server of configInfo.servers) {
          fingerprints.set(server.id, createHmac("sha256", activationKey).update(configFingerprint(server, ctx.cwd)).digest("hex"));
        }
      }
      if (!await lifecycle.attach(token, nextRuntime)) return;
      if (!lifecycle.isCurrent(token) || token.signal.aborted || nextRuntime.closed) {
        await nextRuntime.close();
        lifecycle.fail(token, nextRuntime);
        return;
      }
      const uncached = [];
      for (const server of configInfo.servers) {
        if (!server.enabled) nextRuntime.addDisabled(server);
        else {
          const cached = schemaCache.get(server, ctx.cwd);
          if (cached) nextRuntime.addCached(server, cached);
          else {
            nextRuntime.addConfigured(server);
            uncached.push(server);
          }
        }
      }
      if (!lifecycle.publish(token, nextRuntime)) {
        await nextRuntime.close();
        lifecycle.fail(token, nextRuntime);
        return;
      }
      const isCurrent = () => lifecycle.isCurrent(token) && lifecycle.current === nextRuntime && !token.signal.aborted && !nextRuntime.closed;
      nextRuntime.onToolsChanged = () => { if (isCurrent()) syncRemoteTools(nextRuntime); };
      syncRemoteTools(nextRuntime, true);
      const connections = [];
      for (const server of uncached) connections.push(nextRuntime.connect(server, token.signal));
      // The runtime is usable now; discovery owns its own bounded background
      // tasks. Search waits for discovery, and a cached tool waits only for its server.
      void Promise.allSettled(connections).then((results) => {
        if (!isCurrent()) return;
        const failures = [];
        for (let index = 0; index < results.length; index++) {
          if (results[index].status === "rejected") failures.push(`${uncached[index].id}: connection failed; see /mcp-status`);
        }
        if (failures.length && ctx.hasUI) ctx.ui.notify(`MCP connection failures:\n${failures.join("\n")}`, "warning");
      }).catch(() => undefined);
    } catch (error) {
      await nextRuntime?.close().catch(() => undefined);
      if (!lifecycle.fail(token, nextRuntime)) return;
      deactivateRemoteTools();
      configError = sanitizeText(error instanceof Error ? error.message : error, 500);
      if (ctx.hasUI) ctx.ui.notify(`MCP bridge configuration error: ${configError}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    activationGeneration++;
    const authStopped = stopAuth();
    try { await lifecycle.shutdown(); }
    finally { await authStopped; }
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreActivationIntent(ctx);
    if (lifecycle.current) syncRemoteTools(lifecycle.current, true);
  });

  pi.registerCommand("mcp-status", {
    description: "Show configured MCP servers, transports, connection state, and tool counts",
    handler: async (_args, ctx) => {
      const header = configInfo
        ? `Global config: ${configInfo.globalPath}\nProject config: ${configInfo.allowProjectConfig ? "allowed when trusted" : "disabled globally"}`
        : "MCP configuration has not been loaded.";
      const body = configError ? `Configuration error: ${configError}` : lifecycle.current?.statusText() ?? "MCP runtime is not started.";
      ctx.ui.notify(`${header}\n${body}`, configError ? "error" : "info");
    },
  });

  pi.registerCommand("mcp-tools", {
    description: "List Pi tool names mapped to remote MCP server tools",
    handler: async (_args, ctx) => {
      ctx.ui.notify(lifecycle.current?.toolsText() ?? "MCP runtime is not started.", "info");
    },
  });

  pi.registerCommand("mcp-reload", {
    description: "Reload Pi resources and reconnect MCP servers from configuration",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  for (const action of ["login", "logout"]) {
    pi.registerCommand(`mcp-${action}`, {
      description: `${action === "login" ? "Authorize" : "Remove local authorization for"} an OAuth MCP server: /mcp-${action} <server-id>`,
      handler: async (args, ctx) => {
        if (!authEnabled) return;
        const parentSignal = ctx.signal;
        if (parentSignal?.aborted) return;
        const server = configInfo?.servers.find(item => item.id === args.trim() && item.oauth);
        if (!server) { ctx.ui.notify("Specify a configured OAuth MCP server ID.", "error"); return; }
        const generation = ++authGeneration;
        authController?.abort();
        // All replacement waiters share the active operation, not a Promise tail.
        // Only the latest request may proceed once its predecessor has cleaned up.
        if (authOperation) { try { await authOperation; } catch {} }
        if (!authEnabled || generation !== authGeneration || parentSignal?.aborted) return;
        const controller = new AbortController(); authController = controller;
        const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
        const operation = runAuthCommand(action, server, ctx, signal);
        authOperation = operation;
        try {
          await operation;
        } catch {
          if (authEnabled && generation === authGeneration && !signal.aborted) {
            ctx.ui.notify(`MCP ${action} failed or was cancelled. No credentials are shown in diagnostics.`, "error");
          }
          return;
        } finally {
          if (authOperation === operation) authOperation = null;
          if (authController === controller) authController = null;
        }
        if (!authEnabled || generation !== authGeneration || signal.aborted) return;
        // Reload replaces this runner and its command context; ctx must not be used afterwards.
        ctx.ui.notify(`MCP ${action} completed for ${server.id}. Reloading MCP servers.`, "info");
        if (authEnabled && generation === authGeneration && !signal.aborted) await ctx.reload();
      },
    });
  }
}

export { loadMcpConfig };
