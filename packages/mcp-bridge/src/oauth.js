import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileAuthStorageBackend } from "@super-pi/coding-agent";
import { agentDir } from "./config.js";

const MAX_STORE_CHARS = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 1024 * 1024;
const REFRESH_SKEW_MS = 30_000;
const FLOW_TIMEOUT_MS = 180_000;

function secureUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("MCP OAuth requires HTTPS or loopback HTTP without URL credentials");
  }
  return url;
}

function parseStore(text) {
  if (text && text.length > MAX_STORE_CHARS) throw new Error("MCP OAuth storage exceeds 2 MiB");
  const parsed = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid MCP OAuth storage");
  return parsed;
}

function serializeStore(store) {
  const text = JSON.stringify(store);
  if (text.length > MAX_STORE_CHARS) throw new Error("MCP OAuth storage exceeds 2 MiB");
  return text;
}

/** OAuth discovery/token fetches never inherit MCP headers or follow redirects. */
export function createOAuthFetch(fetchImpl, signal) {
  return async (input, init = {}) => {
    secureUrl(input instanceof Request ? input.url : input);
    const timeout = AbortSignal.timeout(15_000);
    const combined = AbortSignal.any([timeout, ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]);
    const response = await fetchImpl(input, { ...init, signal: combined, redirect: "error" });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_AUTH_BYTES) throw new Error("MCP OAuth response exceeds 1 MiB");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return new Response(Buffer.concat(chunks, bytes), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function callbackReceiver(port, state, signal) {
  let resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The callback may arrive before SDK discovery completes.
  void code.catch(() => undefined);
  const server = createServer((request, response) => {
    if ((request.url?.length ?? 0) > 8192) { response.writeHead(414).end(); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      response.writeHead(400).end("Invalid authorization callback."); return;
    }
    const value = url.searchParams.get("code");
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Return to Super Pi.");
    if (!value || url.searchParams.has("error")) rejectCode(new Error("MCP OAuth authorization was declined"));
    else resolveCode(value);
  });
  const abort = () => rejectCode(new Error("MCP OAuth cancelled or timed out"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", abort); server.closeAllConnections(); server.close(); throw error;
  }
  return { code, url: `http://127.0.0.1:${server.address().port}/callback`, async close() {
    signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

/** Owns one server's cache. FileAuthStorageBackend locks the entire refresh transaction across processes. */
export class McpOAuth {
  constructor(config, backend = new FileAuthStorageBackend(join(agentDir(), "mcp-auth.json")), fetchImpl = fetch) {
    this.config = config;
    this.backend = backend;
    this.fetchImpl = fetchImpl;
    this.key = createHash("sha256").update(JSON.stringify([config.id, config.url, config.source, config.oauth])).digest("hex");
    this.cached = undefined;
    this.loaded = false;
  }

  authorizationRequired() { return new Error(`MCP authorization required. Run /mcp-login ${this.config.id}`); }

  read() {
    if (!this.loaded) {
      this.cached = this.backend.withLock(text => ({ result: parseStore(text)[this.key] }));
      this.loaded = true;
    }
    return this.cached;
  }

  async transact(operation, signal) {
    return this.backend.withLockAsync(async text => {
      signal?.throwIfAborted();
      const store = parseStore(text);
      const entry = store[this.key] ?? {};
      const result = await operation(entry);
      signal?.throwIfAborted();
      store[this.key] = entry;
      const next = serializeStore(store);
      // Publish the cache only after the atomic file write succeeds.
      return { result: { value: result, entry }, next };
    }, { signal }).then(result => { this.cached = result.entry; this.loaded = true; return result.value; });
  }

  async authorize(entry, signal, receiver, notify) {
    let verifier;
    const state = randomBytes(32).toString("hex");
    const provider = {
      redirectUrl: receiver?.url ?? entry.redirectUrl ?? "http://127.0.0.1/callback",
      clientMetadata: { client_name: "Super Pi MCP", redirect_uris: [receiver?.url ?? entry.redirectUrl ?? "http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: this.config.oauth?.scope },
      state: () => receiver?.state ?? state,
      clientInformation: () => entry.client ?? (this.config.oauth?.clientId ? { client_id: this.config.oauth.clientId } : undefined),
      saveClientInformation: value => { if (!receiver) throw this.authorizationRequired(); entry.client = value; },
      tokens: () => entry.tokens,
      saveTokens: value => {
        entry.tokens = { ...value, refresh_token: value.refresh_token ?? entry.tokens?.refresh_token };
        entry.expiresAt = Number.isFinite(value.expires_in) ? Date.now() + value.expires_in * 1000 : undefined;
      },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => { if (!verifier) throw new Error("Missing MCP PKCE verifier"); return verifier; },
      redirectToAuthorization: url => {
        if (!receiver) throw this.authorizationRequired();
        secureUrl(url); notify(url.href);
      },
      discoveryState: () => entry.discovery,
      saveDiscoveryState: value => { entry.discovery = value; },
      invalidateCredentials: scope => {
        if (scope === "all" || scope === "tokens") entry.tokens = undefined;
        if (scope === "all" || scope === "client") entry.client = undefined;
        if (scope === "all" || scope === "discovery") entry.discovery = undefined;
        if (scope === "all" || scope === "verifier") verifier = undefined;
      },
    };
    const options = { serverUrl: this.config.url, scope: this.config.oauth?.scope, fetchFn: createOAuthFetch(this.fetchImpl, signal) };
    let result = await auth(provider, options);
    if (result === "REDIRECT") {
      if (!receiver) throw this.authorizationRequired();
      const authorizationCode = await receiver.code;
      signal.throwIfAborted();
      result = await auth(provider, { ...options, authorizationCode });
    }
    if (result !== "AUTHORIZED" || !entry.tokens?.access_token) throw this.authorizationRequired();
    entry.client ??= provider.clientInformation();
    return entry.tokens.access_token;
  }

  async refresh(failedToken, signal) {
    return this.transact(async entry => {
      const token = entry.tokens?.access_token;
      if (token && token !== failedToken && (!entry.expiresAt || entry.expiresAt > Date.now() + REFRESH_SKEW_MS)) return token;
      if (!entry.tokens?.refresh_token || !entry.client) throw this.authorizationRequired();
      return this.authorize(entry, signal);
    }, signal);
  }

  async token(signal) {
    const entry = this.read();
    if (entry?.expiresAt && entry.expiresAt <= Date.now() + REFRESH_SKEW_MS) return this.refresh(entry.tokens?.access_token, signal);
    return entry?.tokens?.access_token;
  }

  async login(notify, parentSignal) {
    const signal = AbortSignal.any([AbortSignal.timeout(FLOW_TIMEOUT_MS), ...(parentSignal ? [parentSignal] : [])]);
    const attempt = randomBytes(32).toString("hex");
    // Reserve only this server's attempt. Keep existing credentials usable while
    // the user is in the browser; no network or callback wait holds the file lock.
    const entry = await this.backend.withLockAsync(async text => {
      signal.throwIfAborted();
      const store = parseStore(text), previous = store[this.key] ?? {};
      if (previous.loginAttempt && previous.loginUntil > Date.now()) throw new Error("MCP OAuth login is already pending for this server");
      const draft = { ...previous, loginAttempt: attempt, loginUntil: Date.now() + FLOW_TIMEOUT_MS };
      store[this.key] = draft;
      return { result: draft, next: serializeStore(store) };
    }, { signal });
    let receiver, committed = false;
    try {
      const state = randomBytes(32).toString("hex");
      const previousPort = entry.redirectUrl ? Number(new URL(entry.redirectUrl).port) : 0;
      receiver = await callbackReceiver(this.config.oauth?.callbackPort ?? previousPort, state, signal);
      receiver.state = state;
      entry.redirectUrl = receiver.url;
      entry.tokens = undefined;
      const token = await this.authorize(entry, signal, receiver, notify);
      await this.backend.withLockAsync(async text => {
        signal.throwIfAborted();
        const store = parseStore(text);
        if (store[this.key]?.loginAttempt !== attempt) throw new Error("MCP OAuth login was cancelled or superseded; credentials were not saved");
        entry.loginAttempt = undefined; entry.loginUntil = undefined;
        store[this.key] = entry;
        return { result: undefined, next: serializeStore(store) };
      }, { signal });
      committed = true;
      this.cached = entry; this.loaded = true;
      return token;
    } finally {
      try { await receiver?.close(); }
      finally {
        if (!committed) {
          this.cached = undefined; this.loaded = false;
          // Cleanup has its own bounded deadline; an aborted caller signal must
          // not leave an attempt blocking new logins until the full flow timeout.
          // Only failed logins reach here. A cleanup failure must not replace that
          // primary error; the unreleased attempt still expires at loginUntil.
          try {
            await this.backend.withLockAsync(async text => {
              const store = parseStore(text), current = store[this.key];
              if (current?.loginAttempt !== attempt) return { result: undefined };
              current.loginAttempt = undefined; current.loginUntil = undefined;
              let hasData = false;
              for (const key of Object.keys(current)) if (current[key] !== undefined) { hasData = true; break; }
              if (!hasData) store[this.key] = undefined;
              return { result: undefined, next: serializeStore(store) };
            }, { signal: AbortSignal.timeout(1_000) });
          } catch {}
        }
      }
    }
  }

  async logout(signal) {
    await this.backend.withLockAsync(async text => {
      const store = parseStore(text), next = {};
      for (const key of Object.keys(store)) if (key !== this.key) next[key] = store[key];
      return { result: undefined, next: serializeStore(next) };
    }, { signal });
    this.cached = undefined; this.loaded = true;
  }
}
