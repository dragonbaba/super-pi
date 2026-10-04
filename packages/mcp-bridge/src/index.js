import { createHash } from "node:crypto";
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
  const knownRemoteToolNames = new Set();
  // Names the host activated only because they were newly registered.
  const hostActivatedRemoteNames = new Set();
  let activationIntent = new Map();
  let activationGeneration = 0;
  let fingerprints = new Map();

  const restoreActivationIntent = (ctx) => {
    activationGeneration++;
    activationIntent = new Map();
    const branch = ctx.sessionManager?.getBranch() ?? [];
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== ACTIVATION_ENTRY) continue;
      const data = entry.data;
      if (data?.version === 1 && Array.isArray(data.tools) && data.tools.length <= MAX_ACTIVATION_ENTRIES) {
        for (const item of data.tools) {
          if (typeof item?.name === "string" && item.name.length <= 58 && typeof item.fingerprint === "string" && item.fingerprint.length === 64) {
            activationIntent.set(item.name, item.fingerprint);
          }
        }
      }
      break;
    }
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
      const intent = new Map(activationIntent);
      let changed = false;
      for (const name of matches) {
        const fingerprint = toolActivationFingerprint(runtime, name, fingerprints);
        if (fingerprint !== undefined && intent.get(name) !== fingerprint) { intent.set(name, fingerprint); changed = true; }
      }
      if (changed) {
        while (intent.size > MAX_ACTIVATION_ENTRIES) intent.delete(intent.keys().next().value);
        const tools = [];
        for (const [name, fingerprint] of intent) tools.push({ name, fingerprint });
        pi.appendEntry(ACTIVATION_ENTRY, { version: 1, tools });
        activationIntent = intent;
      }
      if (added.length > 0) pi.setActiveTools([...active, ...added]);
      return { content: [{ type: "text", text: added.length > 0 ? `Activated MCP tools: ${added.join(", ")}` : `Matching MCP tools were already active: ${matches.join(", ")}` }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    authController?.abort(); authController = null;
    const token = await lifecycle.begin(ctx.signal);
    if (!token) return;
    restoreActivationIntent(ctx);
    configError = null;
    let nextRuntime = null;
    try {
      configInfo = loadMcpConfig(ctx.cwd, ctx.isProjectTrusted());
      if (configInfo.servers.length === 0 || !lifecycle.isCurrent(token)) return;
      const [{ McpBridgeRuntime }, { McpSchemaCache, configFingerprint }] = await Promise.all([
        import("./bridge.js"),
        import("./schema-cache.js"),
      ]);
      if (!lifecycle.isCurrent(token)) return;
      const schemaCache = new McpSchemaCache();
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
      fingerprints = new Map();
      for (const server of configInfo.servers) {
        fingerprints.set(server.id, configFingerprint(server, ctx.cwd));
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
    authController?.abort(); authController = null;
    await lifecycle.shutdown();
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
        const server = configInfo?.servers.find(item => item.id === args.trim() && item.oauth);
        if (!server) { ctx.ui.notify("Specify a configured OAuth MCP server ID.", "error"); return; }
        const { McpOAuth } = await import("./oauth.js");
        const owner = new McpOAuth(server);
        authController?.abort();
        const controller = new AbortController(); authController = controller;
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
        try {
          if (action === "login") await owner.login(url => ctx.ui.notify(`Open this URL to authorize ${server.id}:\n${url}`, "info"), signal);
          else await owner.logout(signal);
        } catch { ctx.ui.notify(`MCP ${action} failed or was cancelled. No credentials are shown in diagnostics.`, "error"); return; }
        finally { if (authController === controller) authController = null; }
        // Reload replaces this runner and its command context; ctx must not be used afterwards.
        ctx.ui.notify(`MCP ${action} completed for ${server.id}. Reloading MCP servers.`, "info");
        await ctx.reload();
      },
    });
  }
}

export { loadMcpConfig };
