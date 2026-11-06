import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createMcpClient } from "./client.js";
export { createMcpClient } from "./client.js";
import { OwnedStdioTransport } from "./stdio-transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpCall, McpCallError } from "./call.js";
import { convertMcpResult } from "./result.js";
import { McpAuthorizationRequiredError, parseScopeChallenge } from "./oauth-scope.js";
import { waitForMcpReady } from "./lifecycle.js";
export { convertMcpResult } from "./result.js";
import {
  MAX_SSE_EVENT_BYTES,
  MAX_TRANSPORT_RESPONSE_BYTES,
  MAX_TOOL_CATALOG_BYTES,
  canonicalJsonShape,
  piToolName,
  sanitizeText,
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

class McpHttpOwner {
  constructor() {
    this.controller = new AbortController();
    this.closed = false;
    this.pending = 0;
    this.idle = null;
    this.finishIdle = null;
    this.sources = new Set();
    this.failedBodies = new Set();
    this.closing = null;
  }
  begin() {
    if (this.closed) throw new McpCallError("aborted");
    if (this.pending + this.sources.size >= 32) throw new Error("MCP HTTP request limit reached.");
    if (this.pending++ === 0) this.idle = new Promise(resolve => { this.finishIdle = resolve; });
  }
  finish() {
    if (--this.pending === 0) { const finish = this.finishIdle; this.idle = null; this.finishIdle = null; finish?.(); }
  }
  bodyFailed(body) {
    // Close admission on the first failure. Only this bounded admitted batch can
    // add identities (at most response + two request tee branches per request).
    this.closed = true;
    if (body) this.failedBodies.add(body);
  }
  async cancelBody(body) {
    if (!body) return;
    if (body.locked) {
      for (const source of this.sources) if (source.body === body) return;
    }
    try { await body.cancel(); }
    catch { this.bodyFailed(body); }
  }
  close() {
    this.closed = true;
    if (!this.controller.signal.aborted) this.controller.abort(new McpCallError("aborted"));
    return this.closing ??= this.drain().catch(error => { this.closing = null; throw error; });
  }
  async drain() {
    const pending = [];
    for (const source of this.sources) pending.push(source.cancel(this.controller.signal.reason));
    const results = await Promise.allSettled(pending);
    await this.idle;
    if (this.failedBodies.size) throw new Error("[MCP_CLEANUP_UNCONFIRMED] MCP body cancellation could not be confirmed.");
    for (const result of results) if (result.status === "rejected") {
      throw new Error("[MCP_CLEANUP_UNCONFIRMED] MCP response cleanup did not complete.");
    }
  }
}

class McpBoundedResponseSource {
  constructor(body, eventStream, owner) {
    this.body = body;
    this.reader = body.getReader();
    this.limiter = new McpResponseLimiter(eventStream);
    this.owner = owner;
    this.cancelling = null;
    owner.sources.add(this);
  }

  async pull(controller) {
    try {
      if (!this.reader) { controller.close(); return; }
      const next = await this.reader.read();
      if (next.done) { if (!this.cancelling) this.finish(); controller.close(); return; }
      this.limiter.check(next.value);
      controller.enqueue(next.value);
    } catch (error) {
      try { await this.cancel(error); } catch { /* The transport owner retains failed cleanup. */ }
      controller.error(error);
    }
  }

  cancel(reason) {
    if (!this.reader) return Promise.resolve();
    return this.cancelling ??= this.cancelReader(reason);
  }
  async cancelReader(reason) {
    const reader = this.reader;
    try { await reader.cancel(reason); }
    catch (error) {
      if (this.reader !== reader) return; // A concurrent terminal read already released this source.
      let terminalError;
      try { await reader.closed; } catch (closedError) { terminalError = closedError; }
      // Fetch abort errors its stream before cancellation. cancel() then rejects
      // with that same terminal error; this is distinct from a failed underlying
      // cancel on a closed stream, whose reader.closed fulfills.
      if (terminalError !== error) { if (this.owner) this.owner.closed = true; throw error; }
    }
    this.finish();
  }
  finish() {
    this.reader?.releaseLock();
    this.reader = undefined;
    this.body = undefined;
    this.owner?.sources.delete(this);
    this.owner = undefined;
  }
}

async function limitMcpResponse(response, owner) {
  if (!response.body) return response;
  const eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
  const declared = Number(response.headers.get("content-length"));
  if (!eventStream && Number.isFinite(declared) && declared > MAX_TRANSPORT_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new Error("MCP response exceeded 10 MiB");
  }
  if (owner.sources.size >= 32) throw new Error("MCP HTTP response limit reached.");
  const body = new ReadableStream(new McpBoundedResponseSource(response.body, eventStream, owner));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function fetchWithHeaders(headers, serverUrl, oauth) {
  const entries = Object.entries(headers);
  const origin = new URL(serverUrl).origin;
  const owner = new McpHttpOwner();
  const fetcher = async (input, init = {}) => {
    owner.begin();
    try { return await request(input, init); }
    finally { owner.finish(); }
  };
  const request = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : input).origin !== origin) throw new Error("MCP cross-origin endpoint rejected");
    // fetch(Request, { headers }) replaces the Request's own headers, so carry them forward first.
    const isRequest = input instanceof Request;
    const parentSignal = init.signal === undefined && isRequest ? input.signal : init.signal;
    const signal = parentSignal ? AbortSignal.any([parentSignal, owner.controller.signal]) : owner.controller.signal;
    signal.throwIfAborted();
    const merged = new Headers(isRequest ? input.headers : init.headers);
    if (isRequest && init.headers) for (const [name, value] of new Headers(init.headers)) merged.set(name, value);
    for (const [name, value] of entries) merged.set(name, value);
    let retryInput = input, response, retried = false, failed = false;
    try {
      let token = await oauth?.token(signal);
      if (token) merged.set("Authorization", `Bearer ${token}`);
      // The first attempt consumes a Request body; keep an unused copy for the OAuth retry.
      if (isRequest && oauth && input.body) retryInput = input.clone();
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(attempt === 0 ? input : retryInput, { ...init, headers: merged, signal, redirect: "error" });
        signal.throwIfAborted();
        if (oauth && (response.status === 401 || response.status === 403)) {
          let scope;
          try { scope = parseScopeChallenge(response.headers.get("www-authenticate")); }
          catch {
            // A malformed/oversized challenge is not evidence of insufficient
            // scope. Preserve the ordinary 401 retry and 403 response instead.
          }
          if (scope !== undefined) {
            await response.body?.cancel(); response = undefined;
            await oauth.recordScopeChallenge(scope, token, signal);
            throw new McpAuthorizationRequiredError(oauth.config?.id);
          }
        }
        if (response.status !== 401 || !oauth || attempt === 1) return await limitMcpResponse(response, owner);
        await response.body?.cancel(); response = undefined;
        token = await oauth.refresh(token, signal);
        merged.set("Authorization", `Bearer ${token}`);
        retried = true;
      }
    } catch (error) {
      failed = true;
      // EventSource drops error types from token lookup as well as 401 refresh.
      if (error instanceof McpAuthorizationRequiredError) fetcher.authorizationRequired = true;
      await owner.cancelBody(response?.body);
      throw error;
    } finally {
      if (retryInput !== input && (!retried || failed)) {
        const cancelled = owner.cancelBody(retryInput.body);
        // A failed fetch can leave the original tee branch unread. Cancel both
        // before awaiting either, otherwise cancelling the spare may never settle.
        if (failed && !input.body.locked) await owner.cancelBody(input.body);
        await cancelled;
      }
    }
  };
  // EventSource wraps fetch errors and drops their type. This primitive belongs
  // to one transport, and is read only while connecting that transport.
  fetcher.authorizationRequired = false;
  fetcher.close = () => owner.close();
  return fetcher;
}

// SDK close aborts request waiters, but an OAuth rotation already in progress
// must retain ownership through atomic storage commit and file-lock release.
function closeMcpState(state) {
  return state.closePromise ??= Promise.resolve().then(async () => {
    const oauth = state.oauth, client = state.client, transport = state.transport, fetchOwner = state.fetchOwner;
    const oauthClose = Promise.resolve().then(() => oauth?.close());
    const clientClose = Promise.resolve().then(() => client?.close());
    const transportClose = Promise.resolve().then(() => transport?.close());
    const fetchClose = Promise.resolve().then(() => fetchOwner?.close());
    try {
      const results = await Promise.allSettled([clientClose, transportClose, oauthClose, fetchClose]);
      if (results[2].status === "fulfilled" && state.oauth === oauth) state.oauth = null;
      if (results[3].status === "fulfilled" && state.fetchOwner === fetchOwner) state.fetchOwner = null;
      if (results[0].status === "fulfilled" && results[1].status === "fulfilled" && results[3].status === "fulfilled") {
        if (state.client === client) state.client = null;
        if (state.transport === transport) state.transport = null;
        state.connectFetch = null;
      }
      for (const result of results) if (result.status === "rejected") {
        throw new Error("[MCP_CLEANUP_UNCONFIRMED] MCP connection cleanup did not complete; its owner remains retained.");
      }
    } finally { state.closePromise = null; }
  });
}

function createTransport(config, state) {
  if (config.transport === "stdio") {
    const transport = new OwnedStdioTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      stderr: "pipe",
      maxBufferSize: 10 * 1024 * 1024,
    });
    transport.stderr?.on("data", (chunk) => {
      // Drain the pipe without retaining arbitrary server diagnostics/secrets.
      state.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, state.stderrBytes + chunk.length);
    });
    return transport;
  }
  const customFetch = fetchWithHeaders(config.headers, config.url, state.oauth);
  state.connectFetch = customFetch;
  state.fetchOwner = customFetch;
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
    this.registeredSchemas = new Map();
    this.searchIndex = new Map();
    this.closed = false;
    this.disposed = false;
    this.cleanupComplete = false;
    this.activeCalls = new Set();
    this.pendingCalls = 0;
    this.callsIdle = null;
    this.finishCalls = null;
    this.connectionController = new AbortController();
    this.closePromise = null;
    this.onToolsChanged = null;
  }

  addConfigured(config) {
    this.states.set(config.id, {
      config, status: "disconnected", catalogReady: false, error: null, stderr: "", stderrBytes: 0, client: null, transport: null, tools: new Map(), serverInfo: null,
    });
  }

  addCached(config, cached) {
    const state = {
      config, status: "cached", catalogReady: false, error: null, stderr: "", stderrBytes: 0, client: null, transport: null,
      tools: mapRemoteTools(cached.tools), serverInfo: cached.serverInfo,
    };
    this.states.set(config.id, state);
    for (const tool of cached.tools) this.registerRemoteTool(state, tool);
    state.catalogReady = true;
    return state;
  }

  addDisabled(config) {
    this.states.set(config.id, {
      config, status: "disabled", catalogReady: false, error: null, stderr: "", stderrBytes: 0, client: null, transport: null, tools: new Map(), serverInfo: null,
    });
  }

  connect(config, signal) {
    this.pi.assertExecutionCurrent?.();
    if (this.closed || signal?.aborted) return Promise.reject(new McpCallError("aborted"));
    if (!this.states.has(config.id)) this.addConfigured(config);
    const state = this.states.get(config.id);
    if (state.connectPromise) return waitForMcpReady(state.connectPromise, signal);
    const ownerSignal = signal ? AbortSignal.any([signal, this.connectionController.signal]) : this.connectionController.signal;
    const pending = this.connectState(config, ownerSignal).finally(() => {
      if (state.connectPromise === pending) state.connectPromise = null;
    });
    state.connectPromise = pending;
    return pending;
  }

  async waitForDiscovery(signal) {
    this.pi.assertExecutionCurrent?.();
    if (this.closed || signal?.aborted) throw new McpCallError("aborted");
    const pending = [];
    for (const state of this.states.values()) {
      if (state.connectPromise) pending.push(state.connectPromise);
      else if (state.config.enabled && !state.catalogReady && state.status === "disconnected") pending.push(this.connect(state.config));
    }
    await waitForMcpReady(Promise.allSettled(pending), signal);
    if (this.closed) throw new McpCallError("aborted");
  }

  async connectState(config, signal) {
    const state = this.states.get(config.id) ?? {
      config, status: "disconnected", catalogReady: false, error: null, stderr: "", stderrBytes: 0, client: null, transport: null, tools: new Map(), serverInfo: null,
    };
    state.config = config;
    state.status = "connecting";
    state.error = null;
    this.states.set(config.id, state);
    try {
      if (state.client || state.transport) await closeMcpState(state);
      if (this.closed || signal?.aborted) throw signal?.reason ?? new Error("MCP startup aborted");
      if (config.oauth && !state.oauth) {
        const { McpOAuth } = await import("./oauth.js");
        state.oauth = new McpOAuth(config);
      }
      if (this.closed || signal?.aborted) throw signal?.reason ?? new Error("MCP startup aborted");
      const client = createMcpClient();
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: pathToFileURL(this.workspace).href, name: sanitizeText(this.workspace, 200) }],
      }));
      const transport = createTransport(config, state);
      client.onclose = () => { if (!this.closed) state.status = "disconnected"; };
      client.onerror = () => { state.error = "MCP protocol error."; };
      state.client = client;
      state.transport = transport;
      const startup = timeoutSignal(signal, config.startupTimeoutMs);
      let listed;
      try {
        await client.connect(transport, { signal: startup.signal, timeout: config.startupTimeoutMs });
        if (this.closed || startup.signal.aborted) throw startup.signal.reason ?? new Error("MCP startup aborted");
        listed = await client.listAllTools(config.maxTools, { signal: startup.signal, timeout: config.startupTimeoutMs });
        if (this.closed || startup.signal.aborted) throw startup.signal.reason ?? new Error("MCP startup aborted");
      } finally {
        startup.dispose();
      }
      // Transport/discovery failures leave the last complete catalog retryable.
      // Once a replacement arrives, only a fully registered catalog is eligible.
      state.catalogReady = false;
      // Preflight the complete replacement before the first host registration.
      const names = new Set();
      for (const tool of listed.tools) {
        const name = piToolName(config.id, tool.name);
        const existing = this.registeredNames.get(name);
        if (names.has(name) || (existing && existing !== `${config.id}\0${tool.name}`)) throw new Error(`MCP tool-name collision: ${name}`);
        names.add(name);
      }
      state.serverInfo = client.getServerVersion() ?? null;
      state.tools = mapRemoteTools(listed.tools);
      state.status = "connected";
      state.connectFetch = null;
      for (const tool of listed.tools) this.registerRemoteTool(state, tool, tool.inputSchema);
      state.catalogReady = true;
      this.schemaCache?.put(config, this.workspace, listed.tools, state.serverInfo);
      this.onToolsChanged?.();
      return state;
    } catch (error) {
      const code = signal?.aborted || this.closed ? "aborted"
        : error instanceof McpAuthorizationRequiredError || state.connectFetch?.authorizationRequired ? "authorization-required" : "protocol-error";
      state.error = code === "authorization-required" ? `MCP authorization required. Run /mcp-login ${config.id}` : "MCP connection failed (protocol-error).";
      await closeMcpState(state);
      state.status = this.closed ? "closed" : "error";
      if (!this.closed) this.onToolsChanged?.();
      throw new McpCallError(code);
    }
  }

  registerRemoteTool(state, remoteTool, parameters = normalizeInputSchema(remoteTool.inputSchema)) {
    if (this.closed) throw new McpCallError("aborted");
    const name = piToolName(state.config.id, remoteTool.name);
    const existing = this.registeredNames.get(name);
    if (existing && existing !== `${state.config.id}\0${remoteTool.name}`) throw new Error(`MCP tool-name collision: ${name}`);
    // Destructive tools ask before execution even when every other hint is less privileged.
    const destructive = remoteTool.annotations?.destructiveHint === true;
    const signature = createHash("sha256").update(JSON.stringify(parameters)).update("\0").update(remoteTool.description ?? "")
      .update(destructive ? "\0destructive" : "").digest("hex");
    if (existing && this.registeredSchemas.get(name) === signature) return;
    this.registeredSchemas.set(name, signature);
    this.registeredNames.set(name, `${state.config.id}\0${remoteTool.name}`);
    this.registeredSchemaBytes.set(name, Buffer.byteLength(JSON.stringify(parameters), "utf8")
      + Buffer.byteLength(remoteTool.description ?? "", "utf8"));
    this.searchIndex.set(
      name,
      `${name} ${state.config.id} ${remoteTool.name} ${remoteTool.description ?? ""}`.toLowerCase(),
    );
    const runtime = this;
    const fullDescription = sanitizeText(remoteTool.description ?? `MCP tool ${remoteTool.name}`, MAX_TOOL_CATALOG_BYTES);
    this.pi.registerTool({
      name,
      requiresMcp: true,
      mcpDestructive: destructive,
      mcpServer: state.config.id,
      label: `MCP ${sanitizeText(state.config.id, 32)} / ${sanitizeText(remoteTool.name, 80)}`,
      description: sanitizeText(fullDescription, 1000),
      fullDescription,
      parameters,
      executionMode: "sequential",
      async execute(toolCallId, args, signal, onUpdate, ctx) {
        try {
          const result = await runtime.callRemoteTool(state, remoteTool.name, args, signal, onUpdate, destructive);
          const configured = ctx?.mcpResultInputConfigured === true;
          const content = convertMcpResult(result, configured);
          if (signal?.aborted || runtime.closed) return mcpFailureResult("aborted", ctx, toolCallId);
          if (configured) ctx.admitMcpResultInput(content, toolCallId);
          const details = { server: state.config.id, remoteTool: sanitizeText(remoteTool.name, 200) };
          if (result?.isError) details.mcpError = "server-tool-error";
          return { content, details };
        } catch (error) {
          return mcpFailureResult(error?.code, ctx, toolCallId);
        }
      },
    });
  }

  async callRemoteTool(state, remoteName, args, signal, onUpdate, authorizedDestructive) {
    if (this.closed || signal?.aborted) throw new McpCallError("aborted");
    this.pi.assertExecutionCurrent?.();
    if (this.pendingCalls >= 16) throw new Error("MCP has reached its limit of 16 admitted calls.");
    if (this.pendingCalls++ === 0) this.callsIdle = new Promise(resolve => { this.finishCalls = resolve; });
    const executionSignal = signal ? AbortSignal.any([signal, this.connectionController.signal]) : this.connectionController.signal;
    try { return await this.#performRemoteCall(state, remoteName, args, executionSignal, onUpdate, authorizedDestructive); }
    finally {
      if (--this.pendingCalls === 0) {
        const finish = this.finishCalls; this.finishCalls = null; this.callsIdle = null; finish?.();
      }
    }
  }

  async #performRemoteCall(state, remoteName, args, signal, onUpdate, authorizedDestructive) {
    if (state.connectPromise || ((state.status === "disconnected" || state.status === "cached" || !state.client) && !this.closed)) {
      if (signal?.aborted) throw new McpCallError("aborted");
      try {
        await waitForMcpReady(state.connectPromise ?? this.connect(state.config), signal);
      } catch (error) {
        if (this.closed || signal?.aborted) throw new McpCallError("aborted");
        throw error;
      }
    }
    if (this.closed || signal?.aborted) throw new McpCallError("aborted");
    if (state.status !== "connected" || !state.client) throw new Error(`MCP server ${state.config.id} is not connected; run /mcp-reload`);
    if (state.tools && !state.tools.has(remoteName)) throw new Error("MCP tool is no longer in the current server catalog");
    // A reconnect can replace the catalog this call was approved against. A newly
    // declared destructive tool is not run on the old approval; the next call asks.
    if (authorizedDestructive === false && state.tools?.get(remoteName)?.annotations?.destructiveHint === true) throw new McpCallError("approval-changed");
    const call = new McpCall(signal, onUpdate);
    this.activeCalls.add(call);
    try {
      const result = await state.client.callTool(
        { name: remoteName, arguments: args },
        undefined,
        { signal: call.controller.signal, onprogress: call.notify, timeout: state.config.toolTimeoutMs, maxTotalTimeout: state.config.toolTimeoutMs, resetTimeoutOnProgress: false },
      );
      if (call.controller.signal.aborted || this.closed) throw new McpCallError("aborted");
      return result;
    } catch (error) {
      const code = call.controller.signal.aborted || this.closed ? "aborted" : error instanceof McpAuthorizationRequiredError ? "authorization-required" : "protocol-error";
      state.error = code === "authorization-required" ? `MCP authorization required. Run /mcp-login ${state.config.id}` : code === "aborted" ? "MCP request aborted." : "MCP protocol error.";
      throw new McpCallError(code);
    } finally {
      call.finish();
      this.activeCalls.delete(call);
    }
  }

  toolNames() {
    const names = [];
    for (const name of this.registeredNames.keys()) { if (this.toolConfig(name)) names.push(name); }
    return names;
  }

  toolConfig(name) {
    const key = this.registeredNames.get(name);
    if (!key) return undefined;
    const separator = key.indexOf("\0");
    const state = this.states.get(key.slice(0, separator));
    if (this.closed || !state?.catalogReady || !state.tools.has(key.slice(separator + 1))) return undefined;
    return state.config;
  }

  toolSchemaBytes(name) {
    return this.registeredSchemaBytes.get(name) ?? 0;
  }

  searchTools(query, limit = 8, eligibleNames) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const matches = [];
    for (const [piName, haystack] of this.searchIndex) {
      if (eligibleNames !== undefined && !eligibleNames.has(piName)) continue;
      if (haystack.includes(needle) && this.toolConfig(piName)) {
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

  close() {
    this.disposed = true;
    if (this.cleanupComplete) this.clearCatalog();
    return this.suspend();
  }

  suspend() {
    return this.closePromise ??= this.closeRuntime().catch(error => { this.closePromise = null; throw error; });
  }

  resume() {
    if (this.disposed || !this.cleanupComplete || this.pendingCalls || this.activeCalls.size) throw new Error("MCP cleanup is not complete; admission remains closed.");
    for (const state of this.states.values()) {
      if (state.connectPromise || state.client || state.transport || state.fetchOwner || state.oauth) throw new Error("MCP still owns a connection awaiting cleanup.");
    }
    this.connectionController = new AbortController();
    this.closePromise = null;
    this.cleanupComplete = false;
    for (const state of this.states.values()) state.status = !state.config.enabled ? "disabled" : state.catalogReady ? "cached" : "disconnected";
    this.closed = false;
  }

  async closeRuntime() {
    this.closed = true;
    this.onToolsChanged = null;
    this.connectionController.abort(new McpCallError("aborted"));
    for (const call of this.activeCalls) call.abort();
    const closes = [];
    const connections = [];
    for (const state of this.states.values()) {
      state.status = "closed";
      if (state.connectPromise) connections.push(state.connectPromise);
      closes.push(closeMcpState(state));
    }
    const results = await Promise.allSettled(closes);
    await Promise.allSettled(connections);
    await this.callsIdle;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    // A connection may finish an import after the first close snapshot. Its
    // own catch must have released every late owner before cleanup is proven.
    for (const state of this.states.values()) {
      if (state.connectPromise || state.client || state.transport || state.fetchOwner || state.oauth) throw new Error("[MCP_CLEANUP_UNCONFIRMED] A connection still owns resources after shutdown.");
    }
    if (this.disposed) this.clearCatalog();
    this.cleanupComplete = true;
  }

  clearCatalog() {
    for (const state of this.states.values()) { state.catalogReady = false; state.tools?.clear(); state.serverInfo = null; }
    this.searchIndex.clear();
    this.registeredSchemaBytes.clear();
    this.registeredSchemas.clear();
    this.registeredNames.clear();
  }
}

function mcpFailureResult(code, ctx, toolCallId) {
  const category = code === "budget-not-configured" || code === "budget-too-small"
    ? "budget-not-configured"
    : code === "result-size-limit" || code === "invalid-typed-content" || code === "invalid-structured-content" || code === "aborted" || code === "server-tool-error" || code === "authorization-required" || code === "approval-changed"
      ? code : "protocol-error";
  const text = category === "budget-not-configured"
    ? "MCP result unavailable: configure tool-result presentation with a sufficient token budget for recovery."
    : category === "authorization-required" ? "MCP authorization required. Run /mcp-login <server-id>, then explicitly retry the tool."
      : category === "approval-changed" ? "MCP tool was not run: the server now declares it destructive. Call it again so it is approved first."
      : `MCP result unavailable (${category}).`;
  const failure = { content: [{ type: "text", text }], details: { mcpError: category } };
  try {
    if (ctx?.mcpResultInputConfigured === true) ctx.admitMcpResultInput(failure.content, toolCallId);
  } catch {
    // A positive configured budget can be smaller than any explanatory text.
    // Zero model text is admissible without overriding that budget. Canonical
    // details still carry the explicit configuration reason and tool error.
    return { content: [], details: { mcpError: category, configurationReason: text } };
  }
  return failure;
}
