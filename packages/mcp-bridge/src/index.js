import { loadMcpConfig } from "./config.js";
import { checkRuntimeCompatibility, discoverPiVersion } from "./runtime-compat.js";
import { MAX_ACTIVATED_SCHEMA_BYTES, sanitizeText } from "./security.js";
import { McpRuntimeLifecycle } from "./lifecycle.js";

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
  const knownRemoteToolNames = new Set();

  const deactivateRemoteTools = (clearNames = true) => {
    const active = pi.getActiveTools();
    const next = [];
    for (const name of active) {
      if (!knownRemoteToolNames.has(name)) next.push(name);
    }
    if (next.length !== active.length) pi.setActiveTools(next);
    if (clearNames) knownRemoteToolNames.clear();
  };
  const lifecycle = new McpRuntimeLifecycle(deactivateRemoteTools);

  pi.registerTool({
    name: "mcp_search_tools",
    label: "MCP tool search",
    description: "Search configured MCP tool metadata and activate matching tools for the next model request.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Words from the desired MCP server, tool, or capability" } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_toolCallId, args) {
      const runtime = lifecycle.current;
      if (!runtime) throw new Error("MCP runtime is not started");
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
      return { content: [{ type: "text", text: added.length > 0 ? `Activated MCP tools: ${added.join(", ")}` : `Matching MCP tools were already active: ${matches.join(", ")}` }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const token = await lifecycle.begin(ctx.signal);
    if (!token) return;
    configError = null;
    let nextRuntime = null;
    try {
      configInfo = loadMcpConfig(ctx.cwd, ctx.isProjectTrusted());
      if (configInfo.servers.length === 0 || !lifecycle.isCurrent(token)) return;
      const [{ McpBridgeRuntime }, { McpSchemaCache }] = await Promise.all([
        import("./bridge.js"),
        import("./schema-cache.js"),
      ]);
      if (!lifecycle.isCurrent(token)) return;
      const schemaCache = new McpSchemaCache();
      nextRuntime = new McpBridgeRuntime(pi, ctx.cwd, schemaCache);
      if (!await lifecycle.attach(token, nextRuntime)) return;
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
      const connections = [];
      for (const server of uncached) connections.push(nextRuntime.connect(server, token.signal));
      const results = await Promise.allSettled(connections);
      if (!lifecycle.publish(token, nextRuntime)) {
        await nextRuntime.close();
        lifecycle.fail(token, nextRuntime);
        return;
      }
      const failures = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") failures.push(`${uncached[index].id}: ${sanitizeText(result.reason?.message ?? result.reason, 240)}`);
      }
      for (const name of nextRuntime.toolNames()) knownRemoteToolNames.add(name);
      deactivateRemoteTools(false);
      const active = [];
      for (const name of pi.getActiveTools()) { if (name !== "mcp_search_tools") active.push(name); }
      pi.setActiveTools([...active, "mcp_search_tools"]);
      if (failures.length && ctx.hasUI) ctx.ui.notify(`MCP connection failures:\n${failures.join("\n")}`, "warning");
    } catch (error) {
      await nextRuntime?.close().catch(() => undefined);
      if (!lifecycle.fail(token, nextRuntime)) return;
      deactivateRemoteTools();
      configError = sanitizeText(error instanceof Error ? error.message : error, 500);
      if (ctx.hasUI) ctx.ui.notify(`MCP bridge configuration error: ${configError}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await lifecycle.shutdown();
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
}

export { loadMcpConfig };
