import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_CONTENT_ITEMS,
  MAX_IMAGE_BYTES,
  MAX_SSE_EVENT_BYTES,
  MAX_TEXT_BYTES,
  MAX_TRANSPORT_RESPONSE_BYTES,
  decodedBase64Bytes,
  boundedJson,
  canonicalJsonShape,
  piToolName,
  sanitizeText,
  truncateUtf8,
  validateJsonShape,
} from "./security.js";

function timeoutSignal(parent, timeoutMs) {
  const controller = new AbortController();
  if (parent?.aborted) controller.abort(parent.reason);
  const timer = setTimeout(() => controller.abort(new Error(`MCP startup timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); },
  };
}

class McpResponseLimiter {
  constructor(eventStream) {
    this.eventStream = eventStream;
    this.totalBytes = 0;
    this.eventBytes = 0;
    this.lineBytes = 0;
  }

  check(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new Error("MCP response chunk was invalid");
    if (!this.eventStream) {
      this.totalBytes += chunk.byteLength;
      if (this.totalBytes > MAX_TRANSPORT_RESPONSE_BYTES) throw new Error("MCP response exceeded 10 MiB");
      return;
    }
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      this.eventBytes += 1;
      if (this.eventBytes > MAX_SSE_EVENT_BYTES) throw new Error("MCP event exceeded 4 MiB");
      if (byte === 10) {
        if (this.lineBytes === 0) this.eventBytes = 0;
        this.lineBytes = 0;
      } else if (byte !== 13) {
        this.lineBytes += 1;
      }
    }
  }
}

class McpBoundedResponseSource {
  constructor(body, eventStream) {
    this.reader = body.getReader();
    this.limiter = new McpResponseLimiter(eventStream);
  }

  async pull(controller) {
    try {
      const next = await this.reader.read();
      if (next.done) { controller.close(); return; }
      this.limiter.check(next.value);
      controller.enqueue(next.value);
    } catch (error) {
      try { await this.reader.cancel(error); } catch { }
      controller.error(error);
    }
  }

  async cancel(reason) {
    try { await this.reader.cancel(reason); } catch { }
  }
}

function limitMcpResponse(response) {
  if (!response.body) return response;
  const eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
  const declared = Number(response.headers.get("content-length"));
  if (!eventStream && Number.isFinite(declared) && declared > MAX_TRANSPORT_RESPONSE_BYTES) {
    response.body.cancel().catch(() => undefined);
    throw new Error("MCP response exceeded 10 MiB");
  }
  const body = new ReadableStream(new McpBoundedResponseSource(response.body, eventStream));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function fetchWithHeaders(headers) {
  return async (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    const response = await fetch(input, { ...init, headers: merged, redirect: "error" });
    return limitMcpResponse(response);
  };
}

function createTransport(config, state) {
  if (config.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      stderr: "pipe",
      maxBufferSize: 10 * 1024 * 1024,
    });
    transport.stderr?.on("data", (chunk) => {
      if (state.stderrBytes >= 8192) return;
      state.stderr = truncateUtf8(`${state.stderr}${chunk}`, 8192);
      state.stderrBytes = Math.min(8192, Buffer.byteLength(state.stderr, "utf8"));
    });
    return transport;
  }
  const customFetch = fetchWithHeaders(config.headers);
  if (config.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
      fetch: customFetch,
      reconnectionOptions: { initialReconnectionDelay: 500, maxReconnectionDelay: 10_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 2 },
    });
  }
  return new SSEClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
    eventSourceInit: { fetch: customFetch },
    fetch: customFetch,
  });
}

function normalizeInputSchema(schema) {
  const cloned = validateJsonShape(schema ?? { type: "object", properties: {} });
  if (!cloned || cloned.type !== "object" || Array.isArray(cloned)) throw new Error("MCP tool inputSchema must be a JSON object schema");
  return canonicalJsonShape(cloned);
}

function appendMcpText(content, value, remaining) {
  if (remaining <= 0 || content.length >= MAX_CONTENT_ITEMS) return remaining;
  const text = truncateUtf8(value, remaining);
  if (!text) return remaining;
  const used = Math.min(remaining, Buffer.byteLength(text, "utf8"));
  content.push({ type: "text", text });
  return remaining - used;
}

function resultText(result) {
  const content = [];
  let remaining = MAX_TEXT_BYTES;
  const items = Array.isArray(result?.content) ? result.content : [];
  const count = Math.min(items.length, MAX_CONTENT_ITEMS);
  for (let index = 0; index < count && remaining > 0; index += 1) {
    const item = items[index];
    if (item?.type === "text") remaining = appendMcpText(content, item.text, remaining);
    else if (item?.type === "resource" && typeof item.resource?.text === "string") remaining = appendMcpText(content, item.resource.text, remaining);
    else if (item?.type === "resource_link") remaining = appendMcpText(content, `[MCP resource: ${item.name ?? item.uri} — ${item.uri}]`, remaining);
  }
  if (result?.structuredContent !== undefined) remaining = appendMcpText(content, boundedJson(result.structuredContent, remaining), remaining);
  if (content.length === 0) return "MCP tool returned no text content";
  let joined = "";
  for (let index = 0; index < content.length; index += 1) joined += `${index === 0 ? "" : "\n\n"}${content[index].text}`;
  return joined;
}

export function convertMcpResult(result) {
  const content = [];
  let remainingText = MAX_TEXT_BYTES;
  let imageBytes = 0;
  const items = Array.isArray(result?.content) ? result.content : [];
  const count = Math.min(items.length, MAX_CONTENT_ITEMS);
  for (let index = 0; index < count && content.length < MAX_CONTENT_ITEMS; index += 1) {
    const item = items[index];
    if (item?.type === "text") {
      remainingText = appendMcpText(content, item.text, remainingText);
      continue;
    }
    if (item?.type === "image") {
      const size = decodedBase64Bytes(item.data);
      if (size !== null && size <= MAX_IMAGE_BYTES && imageBytes + size <= MAX_IMAGE_BYTES * 2 && typeof item.mimeType === "string" && item.mimeType.startsWith("image/")) {
        imageBytes += size;
        content.push({ type: "image", data: item.data, mimeType: item.mimeType });
      } else {
        remainingText = appendMcpText(content, "[MCP image omitted: invalid format or size limit exceeded]", remainingText);
      }
      continue;
    }
    if (item?.type === "resource" && typeof item.resource?.text === "string") {
      remainingText = appendMcpText(content, `[MCP resource ${item.resource.uri}]\n${item.resource.text}`, remainingText);
      continue;
    }
    if (item?.type === "resource_link") {
      remainingText = appendMcpText(content, `[MCP resource link: ${item.name ?? item.uri} — ${item.uri}]`, remainingText);
      continue;
    }
    remainingText = appendMcpText(content, `[MCP ${sanitizeText(item?.type ?? "unknown", 40)} content omitted]`, remainingText);
  }
  if (result?.structuredContent !== undefined) remainingText = appendMcpText(content, boundedJson(result.structuredContent, remainingText), remainingText);
  if (result?.toolResult !== undefined) appendMcpText(content, boundedJson(result.toolResult, remainingText), remainingText);
  if (content.length === 0) content.push({ type: "text", text: "MCP tool completed without content." });
  return content;
}

function mapRemoteTools(tools) {
  const mapped = new Map();
  for (const tool of tools) mapped.set(tool.name, tool);
  return mapped;
}

export class McpBridgeRuntime {
  constructor(pi, workspace, schemaCache = null) {
    this.pi = pi;
    this.workspace = workspace;
    this.schemaCache = schemaCache;
    this.states = new Map();
    this.registeredNames = new Map();
    this.registeredSchemaBytes = new Map();
    this.searchIndex = new Map();
    this.closed = false;
  }

  addConfigured(config) {
    this.states.set(config.id, {
      config, status: "disconnected", error: null, stderr: "", stderrBytes: 0, client: null, transport: null, tools: new Map(), serverInfo: null,
    });
  }

  addCached(config, cached) {
    const state = {
      config, status: "cached", error: null, stderr: "", stderrBytes: 0, client: null, transport: null,
      tools: mapRemoteTools(cached.tools), serverInfo: cached.serverInfo,
    };
    this.states.set(config.id, state);
    for (const tool of cached.tools) this.registerRemoteTool(state, tool);
    return state;
  }

  addDisabled(config) {
    this.states.set(config.id, {
      config, status: "disabled", error: null, stderr: "", stderrBytes: 0, client: null, transport: null, tools: new Map(), serverInfo: null,
    });
  }

  async connect(config, signal) {
    if (this.closed) throw new Error("MCP runtime is closed");
    const state = this.states.get(config.id) ?? {
      config, status: "disconnected", error: null, stderr: "", stderrBytes: 0, client: null, transport: null, tools: new Map(), serverInfo: null,
    };
    state.config = config;
    state.status = "connecting";
    state.error = null;
    this.states.set(config.id, state);
    try {
      await state.client?.close().catch(() => undefined);
      if (this.closed || signal?.aborted) throw signal?.reason ?? new Error("MCP startup aborted");
      const client = new Client({ name: "@super-pi/mcp-bridge", version: "0.1.0" }, { capabilities: { roots: { listChanged: false } } });
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: pathToFileURL(this.workspace).href, name: sanitizeText(this.workspace, 200) }],
      }));
      const transport = createTransport(config, state);
      client.onclose = () => { if (!this.closed) state.status = "disconnected"; };
      client.onerror = (error) => { state.error = sanitizeText(error?.message ?? error, 500); };
      state.client = client;
      state.transport = transport;
      const startup = timeoutSignal(signal, config.startupTimeoutMs);
      let listed;
      try {
        await client.connect(transport, { signal: startup.signal, timeout: config.startupTimeoutMs });
        if (this.closed || startup.signal.aborted) throw startup.signal.reason ?? new Error("MCP startup aborted");
        listed = await client.listTools({}, { signal: startup.signal, timeout: config.startupTimeoutMs });
        if (this.closed || startup.signal.aborted) throw startup.signal.reason ?? new Error("MCP startup aborted");
      } finally {
        startup.dispose();
      }
      if (!Array.isArray(listed.tools) || listed.tools.length > config.maxTools) throw new Error(`Server exposed more than ${config.maxTools} tools`);
      state.serverInfo = client.getServerVersion() ?? null;
      state.tools = mapRemoteTools(listed.tools);
      state.status = "connected";
      for (const tool of listed.tools) this.registerRemoteTool(state, tool);
      this.schemaCache?.put(config, this.workspace, listed.tools, state.serverInfo);
      return state;
    } catch (error) {
      state.status = this.closed ? "closed" : "error";
      state.error = sanitizeText(error instanceof Error ? error.message : error, 500);
      await state.client?.close().catch(() => undefined);
      state.client = null;
      state.transport = null;
      throw new Error(state.error || "MCP connection failed", { cause: error });
    }
  }

  registerRemoteTool(state, remoteTool) {
    const name = piToolName(state.config.id, remoteTool.name);
    const existing = this.registeredNames.get(name);
    if (existing && existing !== `${state.config.id}\0${remoteTool.name}`) throw new Error(`MCP tool-name collision: ${name}`);
    if (existing) return;
    const parameters = normalizeInputSchema(remoteTool.inputSchema);
    this.registeredNames.set(name, `${state.config.id}\0${remoteTool.name}`);
    this.registeredSchemaBytes.set(name, Buffer.byteLength(JSON.stringify(parameters), "utf8")
      + Buffer.byteLength(remoteTool.description ?? "", "utf8"));
    this.searchIndex.set(
      name,
      `${name} ${state.config.id} ${remoteTool.name} ${remoteTool.description ?? ""}`.toLowerCase(),
    );
    const runtime = this;
    this.pi.registerTool({
      name,
      label: `MCP ${sanitizeText(state.config.id, 32)} / ${sanitizeText(remoteTool.name, 80)}`,
      description: sanitizeText(remoteTool.description ?? `MCP tool ${remoteTool.name}`, 1000),
      parameters,
      executionMode: "sequential",
      async execute(_toolCallId, args, signal) {
        const result = await runtime.callRemoteTool(state, remoteTool.name, args, signal);
        if (result?.isError) throw new Error(resultText(result));
        return { content: convertMcpResult(result), details: { server: state.config.id, remoteTool: sanitizeText(remoteTool.name, 200) } };
      },
    });
  }

  async callRemoteTool(state, remoteName, args, signal) {
    if ((state.status === "disconnected" || state.status === "cached" || !state.client) && !this.closed) {
      await this.connect(state.config, signal);
    }
    if (state.status !== "connected" || !state.client) throw new Error(`MCP server ${state.config.id} is not connected; run /mcp-reload`);
    try {
      return await state.client.callTool(
        { name: remoteName, arguments: args },
        undefined,
        { signal, timeout: state.config.toolTimeoutMs, maxTotalTimeout: state.config.toolTimeoutMs, resetTimeoutOnProgress: true },
      );
    } catch (error) {
      state.error = sanitizeText(error instanceof Error ? error.message : error, 500);
      throw error;
    }
  }

  toolNames() {
    return [...this.registeredNames.keys()];
  }

  toolSchemaBytes(name) {
    return this.registeredSchemaBytes.get(name) ?? 0;
  }

  searchTools(query, limit = 8) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const matches = [];
    for (const [piName, haystack] of this.searchIndex) {
      if (haystack.includes(needle)) {
        matches.push(piName);
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  statusText() {
    if (this.states.size === 0) return "No MCP servers are configured.";
    return [...this.states.values()].map((state) => {
      const server = state.serverInfo ? ` (${sanitizeText(state.serverInfo.name, 80)} ${sanitizeText(state.serverInfo.version, 40)})` : "";
      const detail = state.error || (state.status === "error" ? state.stderr : "");
      const error = detail ? ` — ${sanitizeText(detail, 240)}` : "";
      return `${state.config.id}: ${state.status}${server}; ${state.tools.size} tools; ${state.config.transport}${error}`;
    }).join("\n");
  }

  toolsText() {
    const rows = [];
    for (const [piName, key] of this.registeredNames) {
      const [server, remote] = key.split("\0");
      rows.push(`${piName} → ${sanitizeText(server, 40)}/${sanitizeText(remote, 160)}`);
    }
    return rows.length ? rows.join("\n") : "No MCP tools are registered.";
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const closes = [];
    for (const state of this.states.values()) {
      state.status = "closed";
      if (state.client) closes.push(state.client.close());
      state.client = null;
      state.transport = null;
    }
    await Promise.allSettled(closes);
    this.searchIndex.clear();
    this.registeredSchemaBytes.clear();
    this.registeredNames.clear();
  }
}
