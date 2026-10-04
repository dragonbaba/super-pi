import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { auth, discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { FileAuthStorageBackend } from "@super-pi/coding-agent";
import { agentDir } from "./config.js";
import { McpAuthorizationRequiredError, mergeScopes, scopeCovers } from "./oauth-scope.js";

const MAX_STORE_CHARS = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 1024 * 1024;
const REFRESH_SKEW_MS = 30_000;
const FLOW_TIMEOUT_MS = 180_000;
const ISSUER_VALIDATION_VERSION = 1;
const AUTH_METADATA_PATH = /\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(?:\/|$)/;
const OPTIONAL_TOKEN_FIELDS = ["scope", "expires_in", "refresh_token", "id_token"];
const METADATA_REQUEST = { headers: { Accept: "application/json", "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION } };

class OAuthTokenResponse extends Response {
  async json() {
    const value = await super.json();
    // Match upstream's absent optional fields before the SDK validates strings
    // or coerces expiry (null/"" would otherwise become zero). Required fields
    // and all non-empty values still go through the SDK's original validation.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const field of OPTIONAL_TOKEN_FIELDS) {
        if (value[field] === null || value[field] === "") value[field] = undefined;
      }
    }
    return value;
  }
}

// The SDK's OIDC schema strips the RFC 9207 support flag. Observe the same JSON
// parse the SDK requests, keeping only the issuer and flag for saveDiscoveryState.
class OAuthMetadataResponse extends Response {
  constructor(body, init, observation) {
    super(body, init);
    this.observation = observation;
  }

  async json() {
    const value = await super.json();
    this.observation.issuer = value?.issuer;
    this.observation.issuerSupport = value?.authorization_response_iss_parameter_supported;
    return value;
  }
}

function secureUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("MCP OAuth requires HTTPS or loopback HTTP without URL credentials");
  }
  return url;
}

function validateIssuer(value) {
  if (typeof value !== "string" || !value || value.includes("?") || value.includes("#")) {
    throw new Error("Invalid MCP OAuth issuer");
  }
  secureUrl(value);
}

function trimIssuerTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Run before the SDK uses either fresh or cached discovery for registration/token requests. */
function validateDiscovery(discovery, authorizationIssuer) {
  if (!discovery) return discovery;
  const expected = discovery.authorizationServerUrl;
  validateIssuer(expected);
  const metadata = discovery.authorizationServerMetadata;
  const issuer = metadata?.issuer ?? expected;
  if (metadata) {
    validateIssuer(metadata.issuer);
    // Match upstream discovery compatibility: remove at most one trailing '/'
    // from each identifier. Keep the original metadata issuer for exact callback
    // validation and flow binding; no other URL normalization is permitted.
    if (issuer !== expected && trimIssuerTrailingSlash(issuer) !== trimIssuerTrailingSlash(expected)) {
      throw new Error("MCP OAuth discovery issuer does not match the authorization server");
    }
    const supported = metadata.authorization_response_iss_parameter_supported;
    if (supported !== undefined && typeof supported !== "boolean") throw new Error("Invalid MCP OAuth issuer support flag");
  }
  // auth() can invalidate a client and rediscover after receiving a code. The
  // code must stay bound to the issuer that started this authorization flow.
  if (authorizationIssuer !== undefined && issuer !== authorizationIssuer) {
    throw new Error("MCP OAuth authorization issuer changed during login");
  }
  return discovery;
}

function authorizationCodeFromCallback(parameters, issuer, issuerRequired) {
  const issuers = parameters.getAll("iss");
  if (issuers.length > 1) throw new Error("MCP OAuth callback has multiple issuer parameters");
  if (issuers.length === 1 && issuers[0] !== issuer) throw new Error("MCP OAuth callback issuer does not match the authorization server");
  if (issuers.length === 0 && issuerRequired) throw new Error("MCP OAuth callback issuer is missing");
  // Validate issuer even for an error response before attributing it to this server.
  const code = parameters.get("code");
  if (!code || parameters.has("error")) throw new Error("MCP OAuth authorization was declined");
  return code;
}

async function configuredDiscovery(metadataUrl, previous, fetchFn) {
  if (metadataUrl.includes("#")) throw new Error("MCP OAuth metadata URL must not contain a fragment");
  const response = await fetchFn(metadataUrl, METADATA_REQUEST);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading configured MCP OAuth metadata`);
  const metadata = OAuthMetadataSchema.parse(await response.json());
  // A configured document supplies the initial issuer, independently of the
  // resource's advertised server or the document's host/path. On cache repair,
  // retain the old issuer so new metadata cannot redirect existing credentials.
  return { ...previous, authorizationServerUrl: previous?.authorizationServerUrl ?? metadata.issuer,
    authorizationServerMetadata: metadata };
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
export function createOAuthFetch(fetchImpl, signal, discoveryObservation) {
  return async (input, init = {}) => {
    const url = secureUrl(input instanceof Request ? input.url : input);
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
    const body = Buffer.concat(chunks, bytes);
    const responseInit = { status: response.status, statusText: response.statusText, headers: response.headers };
    // The SDK uses URLSearchParams for both token grants. Identify the request,
    // not an assumed /token path; never normalize discovery, registration or errors.
    if (response.ok && init.method === "POST" && init.body instanceof URLSearchParams) {
      const grant = init.body.get("grant_type");
      if (grant === "authorization_code" || grant === "refresh_token") return new OAuthTokenResponse(body, responseInit);
    }
    return discoveryObservation && response.ok && AUTH_METADATA_PATH.test(url.pathname)
      ? new OAuthMetadataResponse(body, responseInit, discoveryObservation)
      : new Response(body, responseInit);
  };
}

async function callbackReceiver(port, state, signal) {
  let resolveCallback, rejectCallback;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // The callback may arrive before SDK discovery completes.
  void callback.catch(() => undefined);
  const server = createServer((request, response) => {
    if ((request.url?.length ?? 0) > 8192) { response.writeHead(414).end(); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      response.writeHead(400).end("Invalid authorization callback."); return;
    }
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Return to Super Pi.");
    resolveCallback(url.searchParams);
  });
  const abort = () => rejectCallback(new Error("MCP OAuth cancelled or timed out"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", abort); server.closeAllConnections(); server.close(); throw error;
  }
  return { callback, url: `http://127.0.0.1:${server.address().port}/callback`, async close() {
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

  authorizationRequired() { return new McpAuthorizationRequiredError(this.config.id); }

  async recordScopeChallenge(scope, failedToken, signal) {
    // Persist the hint for the command's new owner/process, without changing the
    // granted scope. A late response must not recreate logged-out credentials or
    // overwrite a newer login. Concurrent hints union under the same file lock.
    await this.backend.withLockAsync(async text => {
      signal?.throwIfAborted();
      const store = parseStore(text), current = store[this.key];
      if (current?.tokens?.access_token !== failedToken || (!current && this.cached)) return { result: undefined };
      const pendingScope = mergeScopes(current?.pendingScope, scope) ?? "";
      if (current?.pendingScope === pendingScope) return { result: undefined };
      store[this.key] = { ...current, pendingScope };
      return { result: undefined, next: serializeStore(store) };
    }, { signal });
  }

  /**
   * A refresh in another process holds the async lease across OAuth requests, so the cold read
   * waits for that commit (abortably) instead of the short synchronous retry window.
   */
  async read(signal) {
    if (!this.loaded) {
      const entry = await this.backend.withLockAsync(async text => ({ result: parseStore(text)[this.key] }), { signal });
      // A transaction that committed meanwhile is newer than this read.
      if (!this.loaded) { this.cached = entry; this.loaded = true; }
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

  async authorize(entry, signal, receiver, notify, requestedScope = this.config.oauth?.scope) {
    let verifier, authorizationIssuer, authorizedScope, issuerRequired = false;
    const metadataUrl = this.config.oauth?.authServerMetadataUrl;
    const discoveryObservation = {};
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
        // An omitted scope means the scope requested at authorization, or the
        // previous grant on refresh. An explicit narrower response stays narrow.
        entry.tokens = { ...value, scope: value.scope ?? authorizedScope ?? entry.tokens?.scope,
          refresh_token: value.refresh_token ?? entry.tokens?.refresh_token };
        entry.expiresAt = Number.isFinite(value.expires_in) ? Date.now() + value.expires_in * 1000 : undefined;
      },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => { if (!verifier) throw new Error("Missing MCP PKCE verifier"); return verifier; },
      redirectToAuthorization: url => {
        if (!receiver) throw this.authorizationRequired();
        authorizationIssuer = entry.discovery.authorizationServerMetadata?.issuer ?? entry.discovery.authorizationServerUrl;
        issuerRequired = entry.discovery.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true;
        authorizedScope = url.searchParams.get("scope") || undefined;
        secureUrl(url); notify(url.href);
      },
      discoveryState: async () => {
        validateDiscovery(entry.discovery, authorizationIssuer);
        if (metadataUrl && (!entry.discovery?.authorizationServerMetadata || entry.discovery.issuerValidationVersion !== ISSUER_VALIDATION_VERSION)) {
          provider.saveDiscoveryState(await configuredDiscovery(metadataUrl, entry.discovery, options.fetchFn));
        }
        return entry.discovery;
      },
      saveDiscoveryState: value => {
        const metadata = value.authorizationServerMetadata;
        if (metadata && metadata.issuer === discoveryObservation.issuer && discoveryObservation.issuerSupport !== undefined) {
          metadata.authorization_response_iss_parameter_supported = discoveryObservation.issuerSupport;
        }
        entry.discovery = validateDiscovery(value, authorizationIssuer);
        entry.discovery.issuerValidationVersion = ISSUER_VALIDATION_VERSION;
      },
      invalidateCredentials: scope => {
        if (scope === "all" || scope === "tokens") entry.tokens = undefined;
        if (scope === "all" || scope === "client") entry.client = undefined;
        if (scope === "all" || scope === "discovery") entry.discovery = undefined;
        if (scope === "all" || scope === "verifier") verifier = undefined;
      },
    };
    const options = { serverUrl: this.config.url, scope: requestedScope, fetchFn: createOAuthFetch(this.fetchImpl, signal, discoveryObservation) };
    // Pre-fix OIDC caches may have lost the support flag. Refresh just the server
    // metadata once, retaining resource discovery and client registration. Do not
    // downgrade a previously discovered server to metadata-free legacy behavior
    // if discovery is temporarily unavailable during this upgrade.
    if (!metadataUrl && entry.discovery?.authorizationServerMetadata && entry.discovery.issuerValidationVersion !== ISSUER_VALIDATION_VERSION) {
      validateDiscovery(entry.discovery);
      const metadata = await discoverAuthorizationServerMetadata(entry.discovery.authorizationServerUrl, { fetchFn: options.fetchFn });
      if (!metadata) throw new Error("MCP OAuth discovery metadata unavailable for issuer validation");
      provider.saveDiscoveryState({ ...entry.discovery, authorizationServerMetadata: metadata });
    }
    let result = await auth(provider, options);
    if (result === "REDIRECT") {
      if (!receiver) throw this.authorizationRequired();
      const callback = await receiver.callback;
      signal.throwIfAborted();
      const authorizationCode = authorizationCodeFromCallback(callback, authorizationIssuer, issuerRequired);
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
    const entry = await this.read(signal);
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
    const pendingScope = entry.pendingScope;
    let receiver, committed = false;
    try {
      const requestedScope = pendingScope === undefined ? this.config.oauth?.scope : mergeScopes(
        this.config.oauth?.scope, entry.tokens?.scope,
        pendingScope || this.config.oauth?.scope || entry.discovery?.resourceMetadata?.scopes_supported?.join(" "),
      );
      // A dynamic registration may limit the client to its registered scope
      // (RFC 7591). Register again for a step-up it does not cover; only this
      // draft changes, so a failed login keeps the stored client and tokens.
      if (pendingScope !== undefined && !this.config.oauth?.clientId && !scopeCovers(entry.client?.scope, requestedScope)) entry.client = undefined;
      const state = randomBytes(32).toString("hex");
      const previousPort = entry.redirectUrl ? Number(new URL(entry.redirectUrl).port) : 0;
      receiver = await callbackReceiver(this.config.oauth?.callbackPort ?? previousPort, state, signal);
      receiver.state = state;
      entry.redirectUrl = receiver.url;
      entry.tokens = undefined;
      const token = await this.authorize(entry, signal, receiver, notify, requestedScope);
      await this.backend.withLockAsync(async text => {
        signal.throwIfAborted();
        const store = parseStore(text);
        if (store[this.key]?.loginAttempt !== attempt) throw new Error("MCP OAuth login was cancelled or superseded; credentials were not saved");
        // A new challenge received while the browser was open belongs to the
        // next explicit login; completing this one must not erase it.
        entry.pendingScope = store[this.key].pendingScope === pendingScope ? undefined : store[this.key].pendingScope;
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
