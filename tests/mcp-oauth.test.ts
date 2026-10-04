import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
// The bridge intentionally ships JavaScript; these tests exercise its public runtime contract.
// @ts-expect-error JavaScript extension has no declaration file
import { McpOAuth, createOAuthFetch } from "../packages/mcp-bridge/src/oauth.js";
// @ts-expect-error JavaScript extension has no declaration file
import mcpBridgeExtension from "../packages/mcp-bridge/src/index.js";
// @ts-expect-error JavaScript extension has no declaration file
import { fetchWithHeaders, McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension has no declaration file
import { parseScopeChallenge, mergeScopes } from "../packages/mcp-bridge/src/oauth-scope.js";
// @ts-expect-error JavaScript extension has no declaration file
import { loadMcpConfig } from "../packages/mcp-bridge/src/config.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FileAuthStorageBackend } from "../packages/coding-agent/src/core/auth-storage.ts";

function sendCallback(url: string) {
  const auth = new URL(url);
  return fetch(`${auth.searchParams.get("redirect_uri")}?state=${auth.searchParams.get("state")}&code=fixture-code`);
}

type OAuthFixtureOptions = {
  authorizationServer?: string;
  issuer?: string;
  issuerSupport?: unknown;
  noResourceMetadata?: boolean;
  noAuthorizationMetadata?: boolean;
  oidc?: boolean;
  clientId?: string;
  callbackPort?: number;
  tokenEndpoint?: string;
  tokenResponse?: Record<string, unknown>;
  refreshResponse?: Record<string, unknown>;
  authServerMetadataUrl?: string;
  metadataOverrides?: Record<string, unknown>;
  resourceMetadataOverrides?: Record<string, unknown>;
  scope?: string;
  serverUrl?: string;
};

function fixture(t: TestContext, options: OAuthFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "sp-mcp-oauth-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const path = join(root, "auth.json");
  const config = { id: "fixture", source: "global", url: options.serverUrl ?? "https://mcp.fixture.invalid/mcp", headers: { "X-Private-MCP": "fixture-private-header" },
    oauth: { ...(options.clientId ? { clientId: options.clientId, callbackPort: options.callbackPort } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.authServerMetadataUrl ? { authServerMetadataUrl: options.authServerMetadataUrl } : {}) } };
  let refreshes = 0, exchanges = 0, registrations = 0;
  let discoveryRequests = 0;
  const callbacks: string[] = [];
  const authorizationUrls: string[] = [];
  const metadataRequests: string[] = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(new Headers(init.headers).has("x-private-mcp"), false);
    assert.equal(init.redirect, "error");
    init.signal?.throwIfAborted();
    if (url.pathname.includes("oauth-protected-resource")) {
      discoveryRequests++;
      return options.noResourceMetadata ? new Response(null, { status: 404 }) : Response.json({ resource: config.url,
        authorization_servers: [options.authorizationServer ?? "https://auth.fixture.invalid"], ...options.resourceMetadataOverrides });
    }
    const configuredMetadata = url.href === options.authServerMetadataUrl;
    if (configuredMetadata || url.pathname.includes(".well-known")) {
      discoveryRequests++;
      metadataRequests.push(url.href);
      if (!configuredMetadata && (options.noAuthorizationMetadata || (options.oidc && url.pathname.includes("oauth-authorization-server")))) return new Response(null, { status: 404 });
      return Response.json({ issuer: options.issuer ?? options.authorizationServer ?? "https://auth.fixture.invalid", authorization_endpoint: "https://auth.fixture.invalid/authorize",
        token_endpoint: options.tokenEndpoint ?? "https://auth.fixture.invalid/token", registration_endpoint: "https://auth.fixture.invalid/register",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: options.issuerSupport,
        ...(options.oidc ? { jwks_uri: "https://auth.fixture.invalid/keys", subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] } : {}),
        ...options.metadataOverrides });
    }
    if (url.pathname === "/register") { registrations++; return Response.json({ ...JSON.parse(init.body as string), client_id: "fixture-client" }); }
    if (url.href === (options.tokenEndpoint ?? `${url.origin}/token`)) {
      const body = new URLSearchParams(init.body as string);
      if (body.get("grant_type") === "refresh_token") { refreshes++; assert.ok(body.get("refresh_token")); }
      else { exchanges++; assert.ok(body.get("code_verifier")); assert.equal(body.get("code"), "fixture-code"); }
      return Response.json({ token_type: "Bearer", access_token: `access-${exchanges}-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600,
        ...(body.get("grant_type") === "refresh_token" ? options.refreshResponse : options.tokenResponse) });
    }
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  };
  const owner = new McpOAuth(config, new FileAuthStorageBackend(path), fetchImpl);
  async function login(target = owner, parameters = new URLSearchParams("code=fixture-code")) {
    let callback = "";
    const requests: Promise<unknown>[] = [];
    const controller = new AbortController();
    try {
      await target.login((url: string) => {
        authorizationUrls.push(url);
        const auth = new URL(url); callback = auth.searchParams.get("redirect_uri")!;
        callbacks.push(callback);
        const request = (async () => {
          const wrongState = await fetch(`${callback}?state=wrong&code=bad`);
          await wrongState.text();
          assert.equal(wrongState.status, 400);
          const responseUrl = new URL(callback);
          responseUrl.search = parameters.toString();
          responseUrl.searchParams.set("state", auth.searchParams.get("state")!);
          const response = await fetch(responseUrl);
          await response.text();
          assert.equal(response.status, 200);
        })();
        void request.catch(() => controller.abort());
        requests.push(request);
      }, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
    } finally { controller.abort(); await Promise.all(requests); }
    return callback;
  }
  return { owner, config, root, path, fetchImpl, login, callbacks, authorizationUrls, metadataRequests,
    discoveryRequests: () => discoveryRequests, counts: () => ({ refreshes, exchanges, registrations }) };
}

const ISSUER = "https://auth.fixture.invalid";
const CONFIGURED_METADATA = "https://catalog.fixture.invalid/tenant/metadata.json?version=1";

async function scopeEndpoint(t: TestContext, rpc = false) {
  const replies = { status: 403, challenge: 'Bearer error="insufficient_scope", scope="tools.write"', firstUnauthorized: false,
    blockInitialization: false, beforeReply: undefined as (() => Promise<void>) | undefined };
  const requests: Array<{ body: string; token?: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", async () => {
      requests.push({ body, token: request.headers.authorization });
      const { status, challenge, beforeReply } = replies;
      await beforeReply?.();
      if (rpc) {
        if (request.method !== "POST") { response.writeHead(405).end(); return; }
        const message = JSON.parse(body);
        if (message.method?.startsWith("notifications/")) { response.writeHead(202).end(); return; }
        if (!replies.blockInitialization && message.method !== "tools/call") {
          const result = message.method === "initialize"
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "scope-fixture", version: "1" } }
            : { tools: [{ name: "mutate", inputSchema: { type: "object" } }] };
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          return;
        }
      }
      response.writeHead(replies.firstUnauthorized && requests.length === 1 ? 401 : status,
        { "WWW-Authenticate": replies.firstUnauthorized && requests.length === 1 ? 'Bearer error="invalid_token"' : challenge }).end("fixture response");
    });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { replies, requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

test("MCP OAuth step-up: a challenge survives reopen and expands explicit login without refresh or replay", async t => {
  const endpoint = await scopeEndpoint(t);
  const f = fixture(t, { serverUrl: endpoint.url, scope: "configured", tokenResponse: { scope: "tools.read configured" } });
  await f.login();
  const fetcher = fetchWithHeaders({}, endpoint.url, f.owner);
  await assert.rejects(fetcher(new Request(endpoint.url, { method: "POST", body: "mutation-once" })), /authorization required/i);
  assert.equal(endpoint.requests.length, 1);
  assert.equal(f.counts().refreshes, 0);
  const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
  assert.equal(saved.pendingScope, "tools.write");
  assert.equal(saved.tokens.access_token, "access-1-0");
  const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  await f.login(reopened);
  assert.equal(new URL(f.authorizationUrls.at(-1)!).searchParams.get("scope"), "configured tools.read tools.write");
  assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].tokens.scope, "tools.read configured", "an explicit narrower grant is never promoted to the requested scope");
  assert.equal(f.counts().refreshes, 0);
  assert.equal(endpoint.requests.length, 1, "only an explicit caller retry may replay the tool");
  endpoint.replies.status = 200;
  const response = await fetchWithHeaders({}, endpoint.url, reopened)(endpoint.url);
  await response.text();
  assert.equal(endpoint.requests.at(-1)?.token, "Bearer access-2-0");
});

test("MCP OAuth step-up: scopes omitted by token responses survive refresh and the next challenge", async t => {
  const endpoint = await scopeEndpoint(t);
  const f = fixture(t, { serverUrl: endpoint.url, resourceMetadataOverrides: { scopes_supported: ["tools.read"] } });
  await f.login();
  assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].tokens.scope, "tools.read");
  await f.owner.refresh("access-1-0");
  await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url), /authorization required/i);
  await f.login();
  const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
  assert.equal(new URL(f.authorizationUrls.at(-1)!).searchParams.get("scope"), "tools.read tools.write");
  assert.equal(saved.tokens.scope, "tools.read tools.write");
  assert.equal(saved.pendingScope, undefined);
  // The first dynamic client was registered for tools.read only.
  assert.equal(saved.client.scope, "tools.read tools.write");
  assert.deepEqual(f.counts(), { registrations: 2, exchanges: 2, refreshes: 1 });
});

for (const kind of ["narrow", "unrecorded", "covering", "fixed"] as const) {
  const replaced = kind === "narrow" || kind === "unrecorded";
  test(`MCP OAuth step-up: ${kind} client registration is ${replaced ? "replaced" : "kept"} for requested scopes`, async t => {
    const endpoint = await scopeEndpoint(t);
    const f = fixture(t, { serverUrl: endpoint.url, scope: kind === "covering" ? "read tools.write" : "read", ...(kind === "fixed" ? { clientId: "fixed-client" } : {}) });
    await f.login();
    if (kind === "unrecorded") {
      // Registration responses may omit scope; the registered limit is then unknown.
      const store = JSON.parse(readFileSync(f.path, "utf8"));
      delete store[f.owner.key].client.scope;
      writeFileSync(f.path, JSON.stringify(store));
    }
    await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url), /authorization required/i);
    await f.login();
    const auth = new URL(f.authorizationUrls.at(-1)!);
    const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
    const clientId = kind === "fixed" ? "fixed-client" : "fixture-client";
    assert.equal(auth.searchParams.get("scope"), "read tools.write");
    assert.equal(auth.searchParams.get("client_id"), clientId);
    assert.deepEqual(f.counts(), { registrations: kind === "fixed" ? 0 : replaced ? 2 : 1, exchanges: 2, refreshes: 0 });
    assert.deepEqual(saved.client, kind === "fixed" ? { client_id: clientId } : { ...saved.client, client_id: clientId, scope: "read tools.write" });
    assert.equal(saved.pendingScope, undefined);
  });
}

for (const [header, expected] of [
  ['Basic realm="scope=admin, Bearer error=insufficient_scope"', undefined],
  ['Basic error="insufficient_scope", scope="admin", Bearer error="invalid_token"', undefined],
  ['bEaReR realm="a,b", ERROR="insufficient_scope", SCOPE="read write read"', "read write"],
  ['Basic realm="one", Bearer error="insufficient_scope", scope="Read read", Digest realm="two"', "Read read"],
  ['Bearer error=insufficient_scope', ""],
  ['Bearer scope="tools.write", error="insufficient_scope"', "tools.write"],
  ['Bearer error="insufficient_scope", scope="tools\\.write"', "tools.write"],
] as const) {
  test(`MCP OAuth scope challenge isolates schemes: ${header}`, () => assert.equal(parseScopeChallenge(header), expected));
}

for (const header of [
  'Bearer error="insufficient_scope", scope="a", SCOPE="b"',
  'Bearer error="insufficient_scope", error="invalid_token"',
  'Bearer error="insufficient_scope", scope="a", Bearer error="insufficient_scope", scope="b"',
  'Bearer error="insufficient_scope", scope="unterminated',
  'Bearer error="insufficient_scope", scope="a\\\\b"',
  'Bearer error="insufficient_scope", scope="a\tb"',
  'Bearer error="insufficient_scope", scope="a", broken==',
  `Bearer error="insufficient_scope", scope="${"a".repeat(4097)}"`,
  "x".repeat(8193),
]) {
  test(`MCP OAuth rejects invalid scope challenge ${header.slice(0, 100)}`, () => assert.throws(() => parseScopeChallenge(header)));
}

test("MCP OAuth scope merge is bounded and retains case-sensitive order", () => {
  assert.equal(mergeScopes("read Read", "write read", "extra"), "read Read write extra");
  assert.throws(() => mergeScopes("a".repeat(3000), "b".repeat(2000)), /4096/);
  assert.throws(() => mergeScopes("read\nwrite"), /Invalid/);
});

for (const status of [401, 403]) {
  test(`MCP OAuth step-up: ${status} without a scope still requires explicit login`, async t => {
    const endpoint = await scopeEndpoint(t);
    endpoint.replies.status = status;
    endpoint.replies.challenge = 'Bearer error="insufficient_scope"';
    const f = fixture(t, { serverUrl: endpoint.url, scope: "configured" });
    await f.login();
    await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url), /authorization required/i);
    assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].pendingScope, "");
    await f.login();
    assert.equal(new URL(f.authorizationUrls.at(-1)!).searchParams.get("scope"), "configured");
    assert.equal(f.counts().refreshes, 0);
    assert.equal(endpoint.requests.length, 1);
  });
}

test("MCP OAuth step-up: only failed OAuth requests inspect or save challenges", async t => {
  const endpoint = await scopeEndpoint(t);
  const f = fixture(t, { serverUrl: endpoint.url });
  await f.login();
  const saved = readFileSync(f.path, "utf8");
  endpoint.replies.status = 200;
  endpoint.replies.challenge = 'Bearer error="insufficient_scope", scope="unterminated';
  await (await fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url)).text();
  endpoint.replies.status = 403;
  await (await fetchWithHeaders({}, endpoint.url)(endpoint.url)).text();
  endpoint.replies.challenge = 'Basic error="insufficient_scope", scope="admin"';
  const forbidden = await fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url);
  assert.equal(forbidden.status, 403);
  await forbidden.text();
  endpoint.replies.challenge = 'Bearer error="insufficient_scope", scope="a", scope="b"';
  const malformed = await fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url);
  assert.equal(malformed.status, 403);
  assert.equal(await malformed.text(), "fixture response");
  assert.equal(readFileSync(f.path, "utf8"), saved);
  assert.equal(f.counts().refreshes, 0);
});

for (const [label, header] of [
  ["unclosed realm", 'Bearer realm="x'],
  ["invalid non-scope parameter", 'Bearer error="invalid_token", =x'],
  ["oversized realm", `Bearer realm="${"x".repeat(8192)}"`],
  ["unclosed scope", 'Bearer error="insufficient_scope", scope="x'],
  ["ambiguous scope", 'Bearer error="insufficient_scope", scope="a", scope="b"'],
] as const) {
  for (const [initialStatus, finalStatus] of [[401, 200], [401, 401], [403, 403]] as const) {
    test(`MCP OAuth malformed challenge fallback: ${label}, ${initialStatus} to ${finalStatus}`, async t => {
      const endpoint = await scopeEndpoint(t);
      endpoint.replies.status = initialStatus;
      endpoint.replies.challenge = header;
      endpoint.replies.beforeReply = async () => { endpoint.replies.status = finalStatus; };
      const f = fixture(t, { serverUrl: endpoint.url });
      await f.login();
      const saved = readFileSync(f.path, "utf8");
      const fetcher = fetchWithHeaders({}, endpoint.url, f.owner);
      const request = new Request(endpoint.url, { method: "POST", body: "request-body" });
      const response = await fetcher(request);
      assert.equal(response.status, finalStatus);
      assert.equal(response.headers.get("www-authenticate"), header);
      assert.equal(await response.text(), "fixture response");
      assert.equal(fetcher.authorizationRequired, false);
      assert.equal(request.bodyUsed, true);
      assert.deepEqual(endpoint.requests, initialStatus === 401
        ? [{ body: "request-body", token: "Bearer access-1-0" }, { body: "request-body", token: "Bearer access-1-1" }]
        : [{ body: "request-body", token: "Bearer access-1-0" }]);
      assert.equal(f.counts().refreshes, initialStatus === 401 ? 1 : 0);
      assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].pendingScope, undefined);
      if (initialStatus === 403) assert.equal(readFileSync(f.path, "utf8"), saved);
    });
  }
}

for (const phase of ["scope persistence", "refresh"] as const) {
  test(`MCP OAuth challenge fallback never swallows ${phase} failures`, async t => {
    const endpoint = await scopeEndpoint(t);
    if (phase === "refresh") {
      endpoint.replies.status = 401;
      endpoint.replies.challenge = 'Bearer realm="x';
    }
    const f = fixture(t, { serverUrl: endpoint.url });
    await f.login();
    const saved = readFileSync(f.path, "utf8"), failure = new Error("fixture auth storage unavailable");
    // Fault at the storage boundary; the fetcher and OAuth owner are production implementations.
    f.owner.backend.withLockAsync = async () => { throw failure; };
    await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(new Request(endpoint.url, { method: "POST", body: "once" })), error => error === failure);
    assert.equal(endpoint.requests.length, 1);
    assert.equal(f.counts().refreshes, 0);
    assert.equal(readFileSync(f.path, "utf8"), saved);
  });
}

test("MCP OAuth step-up: challenge after the single 401 retry uses the refreshed token", async t => {
  const endpoint = await scopeEndpoint(t);
  endpoint.replies.firstUnauthorized = true;
  const f = fixture(t, { serverUrl: endpoint.url });
  await f.login();
  await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(new Request(endpoint.url, { method: "POST", body: "call" })), /authorization required/i);
  assert.deepEqual(endpoint.requests, [{ body: "call", token: "Bearer access-1-0" }, { body: "call", token: "Bearer access-1-1" }]);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].pendingScope, "tools.write");
  assert.equal(f.counts().refreshes, 1);
});

test("MCP OAuth step-up: concurrent owners merge needs without changing granted scopes", async t => {
  const endpoint = await scopeEndpoint(t);
  const f = fixture(t, { serverUrl: endpoint.url, scope: "read", authServerMetadataUrl: CONFIGURED_METADATA });
  await f.login();
  const other = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  const fetcher = fetchWithHeaders({}, endpoint.url, f.owner);
  const second = fetchWithHeaders({}, endpoint.url, other);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  endpoint.replies.beforeReply = async () => { entered(); await gate; };
  const first = assert.rejects(fetcher(endpoint.url), /authorization required/i);
  try {
    await ready;
    endpoint.replies.beforeReply = undefined;
    endpoint.replies.challenge = 'Bearer error="insufficient_scope", scope="extra"';
    await assert.rejects(second(endpoint.url), /authorization required/i);
  } finally { release(); await first; }
  const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
  assert.equal(saved.pendingScope, "extra tools.write");
  assert.equal(saved.tokens.scope, "read");
  await f.login();
  assert.equal(new URL(f.authorizationUrls.at(-1)!).searchParams.get("scope"), "read extra tools.write");
  assert.deepEqual(f.metadataRequests, [CONFIGURED_METADATA]);
});

test("MCP OAuth step-up: unsigned challenge survives first login but cannot select another issuer or identity", async t => {
  const endpoint = await scopeEndpoint(t);
  endpoint.replies.challenge += ', resource_metadata="https://untrusted.fixture.invalid/metadata"';
  const f = fixture(t, { serverUrl: endpoint.url, authServerMetadataUrl: CONFIGURED_METADATA });
  await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url), /authorization required/i);
  const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
  assert.equal(saved.tokens, undefined);
  assert.equal(saved.pendingScope, "tools.write");
  const isolated = new McpOAuth({ ...f.config, id: "another" }, new FileAuthStorageBackend(f.path), f.fetchImpl);
  assert.equal(await isolated.read(), undefined);
  const changed = new McpOAuth({ ...f.config, oauth: { scope: "changed" } }, new FileAuthStorageBackend(f.path), f.fetchImpl);
  assert.equal(await changed.read(), undefined);
  await f.login();
  assert.equal(new URL(f.authorizationUrls.at(-1)!).searchParams.get("scope"), "tools.write");
  assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].tokens.scope, "tools.write");
  assert.deepEqual(f.metadataRequests, [CONFIGURED_METADATA]);
  assert.deepEqual(f.counts(), { registrations: 1, exchanges: 1, refreshes: 0 });
  await f.owner.logout();
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
});

test("MCP OAuth step-up: Request-owned cancellation prevents saving a just-received challenge", async t => {
  const endpoint = await scopeEndpoint(t);
  const f = fixture(t, { serverUrl: endpoint.url });
  await f.login();
  const saved = readFileSync(f.path, "utf8"), originalFetch = globalThis.fetch;
  const controller = new AbortController(), reason = new Error("cancelled after headers");
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    controller.abort(reason);
    // Return an already-received response independent of the aborted upload.
    await response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 403, headers: { "WWW-Authenticate": endpoint.replies.challenge } });
  }) as typeof fetch;
  const request = new Request(endpoint.url, { signal: controller.signal });
  await assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(request), error => error === reason);
  assert.equal(readFileSync(f.path, "utf8"), saved);
  assert.equal(endpoint.requests.length, 1);
});

for (const outcome of ["denied", "aborted", "new-challenge"] as const) {
  test(`MCP OAuth step-up: ${outcome} during consent preserves the right credentials and pending scopes`, async t => {
    const endpoint = await scopeEndpoint(t);
    const f = fixture(t, { serverUrl: endpoint.url, scope: "read" });
    await f.login();
    const fetcher = fetchWithHeaders({}, endpoint.url, f.owner);
    await assert.rejects(fetcher(endpoint.url), /authorization required/i);
    const before = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
    const controller = new AbortController();
    let notify!: (url: string) => void;
    const ready = new Promise<string>(resolve => { notify = resolve; });
    const login = f.owner.login(notify, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
    void login.catch(() => undefined);
    try {
      const url = await ready;
      if (outcome === "aborted") {
        controller.abort();
        await assert.rejects(login, /cancelled|abort/i);
      } else if (outcome === "denied") {
        const auth = new URL(url);
        await (await fetch(`${auth.searchParams.get("redirect_uri")}?state=${auth.searchParams.get("state")}&error=access_denied`)).text();
        await assert.rejects(login);
      } else {
        endpoint.replies.challenge = 'Bearer error="insufficient_scope", scope="extra"';
        await assert.rejects(fetcher(endpoint.url), /authorization required/i);
        await (await sendCallback(url)).text(); await login;
      }
      const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
      if (outcome === "new-challenge") {
        assert.equal(saved.tokens.scope, "read tools.write");
        assert.equal(saved.pendingScope, "tools.write extra");
        await f.login();
        assert.equal(new URL(f.authorizationUrls.at(-1)!).searchParams.get("scope"), "read tools.write extra");
      } else assert.deepEqual(saved, before);
      await assert.rejects(fetch(new URL(url).searchParams.get("redirect_uri")!));
    } finally { controller.abort(); await login.catch(() => undefined); }
  });
}

for (const change of ["login", "logout"] as const) {
  test(`MCP OAuth step-up: late old-token challenge cannot overwrite ${change}`, async t => {
    const endpoint = await scopeEndpoint(t);
    const f = fixture(t, { serverUrl: endpoint.url });
    await f.login();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    endpoint.replies.beforeReply = async () => { entered(); await gate; };
    const pending = assert.rejects(fetchWithHeaders({}, endpoint.url, f.owner)(endpoint.url), /authorization required/i);
    const other = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
    let saved = "";
    try {
      await ready;
      if (change === "login") await f.login(other); else await other.logout();
      saved = readFileSync(f.path, "utf8");
    } finally { release(); await pending; }
    assert.equal(readFileSync(f.path, "utf8"), saved);
  });
}

for (const [transport, phase] of [["http", "initialize"], ["http", "tools/call"], ["sse", "initialize"]] as const) {
  test(`MCP OAuth step-up: real SDK ${transport} ${phase} reports authorization and releases runtime ownership`, async t => {
    const endpoint = await scopeEndpoint(t, transport === "http");
    endpoint.replies.blockInitialization = phase === "initialize";
    endpoint.replies.challenge += ', error_description="private-server-diagnostic"';
    const f = fixture(t, { serverUrl: endpoint.url });
    await f.login();
    const previous = process.env.SP_CODING_AGENT_DIR;
    t.after(() => { if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous; });
    process.env.SP_CODING_AGENT_DIR = f.root;
    writeFileSync(join(f.root, "mcp-auth.json"), readFileSync(f.path));
    let tool: any;
    const runtime = new McpBridgeRuntime({ registerTool(value: unknown) { tool = value; } }, f.root);
    t.after(() => runtime.close());
    const config = { ...f.config, transport, startupTimeoutMs: 3000, toolTimeoutMs: 3000, maxTools: 8 };
    if (phase === "initialize") {
      await assert.rejects(runtime.connect(config), { code: "authorization-required" });
      const state = runtime.states.get(config.id);
      assert.equal(state.client, null);
      assert.equal(state.transport, null);
      assert.equal(state.oauth, null);
      assert.equal(state.connectFetch, null);
    } else {
      await runtime.connect(config);
      const result = await tool.execute("call", {}, undefined, undefined, {});
      assert.equal(result.details.mcpError, "authorization-required");
      assert.match(result.content[0].text, /mcp-login/);
      assert.doesNotMatch(JSON.stringify(result), /private-server-diagnostic|access-1-0|tools.write/);
    }
    assert.equal(runtime.activeCalls.size, 0);
    assert.match(runtime.statusText(), /mcp-login fixture/);
    assert.doesNotMatch(runtime.statusText(), /private-server-diagnostic/);
    assert.equal(JSON.parse(readFileSync(join(f.root, "mcp-auth.json"), "utf8"))[f.owner.key].pendingScope, "tools.write");
    assert.equal(endpoint.requests.filter(request => transport === "sse" || request.body.includes(`"method":"${phase}"`)).length, 1);
    await runtime.close();
    for (const state of runtime.states.values()) assert.equal(state.oauth, null);
  });
}

test("MCP OAuth step-up: /mcp-login consumes the durable hint with a new owner before reload", async t => {
  const endpoint = await scopeEndpoint(t);
  const f = fixture(t, { serverUrl: endpoint.url, scope: "read" });
  const previous = process.env.SP_CODING_AGENT_DIR, entry = process.argv[1], originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch; process.argv[1] = entry!;
    if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous;
  });
  process.env.SP_CODING_AGENT_DIR = f.root;
  process.argv[1] = join(process.cwd(), "packages", "coding-agent", "src", "cli.ts");
  mkdirSync(join(f.root, "config"));
  writeFileSync(join(f.root, "config", "mcp.json"), JSON.stringify({ version: 1, servers: { fixture:
    { transport: "http", url: endpoint.url, oauth: { scope: "read" }, enabled: false } } }));
  const config = loadMcpConfig(f.root, false).servers[0];
  const owner = new McpOAuth(config, new FileAuthStorageBackend(join(f.root, "mcp-auth.json")), f.fetchImpl);
  await f.login(owner);
  await assert.rejects(fetchWithHeaders({}, endpoint.url, owner)(endpoint.url), /authorization required/i);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "auth.fixture.invalid") return f.fetchImpl(url, init);
    return originalFetch(input, init);
  }) as typeof fetch;
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  mcpBridgeExtension({ registerTool() {}, registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, command.handler); },
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { events.set(name, handler); }, getActiveTools: () => [], setActiveTools() {} });
  t.after(async () => { await events.get("session_shutdown")?.({}, {}); });
  await events.get("session_start")!({}, { cwd: f.root, isProjectTrusted: () => false, hasUI: false, ui: { notify() {} } });
  const notes: string[] = [], callbacks: Promise<unknown>[] = [];
  let reloaded = false;
  await commands.get("mcp-login")!("fixture", { signal: AbortSignal.timeout(5000),
    ui: { notify(text: string) {
      assert.equal(reloaded, false); notes.push(text);
      if (text.startsWith("Open this URL")) {
        const url = text.split("\n")[1];
        assert.equal(new URL(url).searchParams.get("scope"), "read tools.write");
        callbacks.push(sendCallback(url).then(response => response.text()));
      }
    } }, reload: async () => { reloaded = true; } });
  await Promise.all(callbacks);
  assert.equal(reloaded, true);
  assert.match(notes.at(-1)!, /login completed/);
  assert.equal(endpoint.requests.length, 1, "the command never replays the denied MCP call");
  assert.equal(JSON.parse(readFileSync(join(f.root, "mcp-auth.json"), "utf8"))[owner.key].pendingScope, undefined);
});

for (const failure of ["initial-fetch", "refresh", "retry-fetch"] as const) {
  test(`MCP OAuth request body cleanup preserves ${failure} error and closes both tee branches`, async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const primary = new Error("fixture primary failure");
    const requests: Request[] = [];
    let cancelled = 0;
    const request = new Request("https://mcp.fixture.invalid/mcp", { method: "POST", duplex: "half", body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("call")); }, cancel() { cancelled++; },
    }) } as RequestInit);
    globalThis.fetch = (async (input: Request) => {
      requests.push(input);
      if (failure === "initial-fetch" || requests.length === 2) throw primary;
      // A server may return 401 before consuming the entire streaming upload.
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    const oauth = { token: async () => "old", refresh: async () => { if (failure === "refresh") throw primary; return "new"; } };
    await assert.rejects(fetchWithHeaders({}, request.url, oauth)(request), error => error === primary);
    assert.equal(cancelled, 1);
    assert.equal(request.bodyUsed, true);
    for (const sent of requests) assert.equal(sent.bodyUsed, true);
  });
}

for (const mode of ["wrong", "missing", "OIDC"] as const) {
  test(`MCP OAuth configured metadata: overrides ${mode} advertised server and survives reopen`, async t => {
    const metadataUrl = mode === "OIDC" ? "https://catalog.fixture.invalid/.well-known/openid-configuration" : CONFIGURED_METADATA;
    const f = fixture(t, { authServerMetadataUrl: metadataUrl, authorizationServer: "https://wrong.fixture.invalid",
      issuer: ISSUER, issuerSupport: true, noResourceMetadata: mode === "missing", oidc: mode === "OIDC",
      resourceMetadataOverrides: { scopes_supported: ["tools.read"] } });
    const valid = new URLSearchParams({ code: "fixture-code", iss: ISSUER });
    await f.login(f.owner, valid);
    const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
    assert.equal(saved.discovery.authorizationServerUrl, ISSUER);
    assert.equal(saved.discovery.authorizationServerMetadata.authorization_response_iss_parameter_supported, true);
    if (mode !== "missing") {
      assert.deepEqual(saved.discovery.resourceMetadata.scopes_supported, ["tools.read"]);
      assert.equal(saved.client.scope, "tools.read");
    }
    const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
    assert.equal(await reopened.token(), "access-1-0");
    assert.equal(await reopened.refresh("access-1-0"), "access-1-1");
    await f.login(reopened, valid);
    assert.deepEqual(f.metadataRequests, [metadataUrl], "configured metadata is cached; no default AS discovery");
    assert.deepEqual(f.counts(), { registrations: 1, exchanges: 2, refreshes: 1 });
    for (const callback of f.callbacks) await assert.rejects(fetch(callback));
  });
}

test("MCP OAuth configured metadata: configuration validates URL and retains normalized setting", t => {
  const f = fixture(t);
  const previous = process.env.SP_CODING_AGENT_DIR;
  t.after(() => { if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous; });
  process.env.SP_CODING_AGENT_DIR = f.root;
  mkdirSync(join(f.root, "config"));
  const configPath = join(f.root, "config", "mcp.json");
  const write = (authServerMetadataUrl: unknown, transport = "http") => writeFileSync(configPath, JSON.stringify({ version: 1,
    servers: { fixture: { transport, url: f.config.url, oauth: { authServerMetadataUrl } } } }));
  for (const transport of ["http", "sse"]) {
    for (const url of [CONFIGURED_METADATA, "https://CATALOG.fixture.invalid:443", "http://localhost:8765/metadata", "http://127.0.0.1:8765/metadata", "http://[::1]:8765/metadata"]) {
      write(url, transport);
      assert.equal(loadMcpConfig(f.root, false).servers[0].oauth.authServerMetadataUrl, new URL(url).href);
    }
  }
  for (const url of [null, "", 7, {}, "/metadata", "http://remote.invalid/metadata", "ftp://localhost/metadata",
    "https://user:secret@host.invalid/metadata", `${CONFIGURED_METADATA}#fragment`, `${CONFIGURED_METADATA}\n`]) {
    write(url);
    assert.throws(() => loadMcpConfig(f.root, false), /authServerMetadataUrl/);
  }
});

test("MCP OAuth configured metadata: protected resource mismatch still prevents registration", async t => {
  const f = fixture(t, { authServerMetadataUrl: CONFIGURED_METADATA,
    resourceMetadataOverrides: { resource: "https://other.fixture.invalid/mcp" } });
  await assert.rejects(f.login(), /Protected resource .* does not match/);
  assert.deepEqual(f.counts(), { registrations: 0, exchanges: 0, refreshes: 0 });
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
});

test("MCP OAuth configured metadata: runtime URL checks reject unsafe endpoints before fetching", async t => {
  for (const url of ["http://remote.invalid/metadata", "https://user:secret@host.invalid/metadata", `${CONFIGURED_METADATA}#fragment`]) {
    const f = fixture(t, { authServerMetadataUrl: url });
    let calls = 0;
    const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), async (input: string | URL, init: RequestInit) => {
      calls++;
      return f.fetchImpl(input, init);
    });
    await assert.rejects(f.login(owner), /HTTPS|credentials|fragment/);
    assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
  }
});

for (const item of [
  { name: "missing issuer", values: [], error: /callback issuer is missing/ },
  { name: "wrong issuer", values: ["https://other.fixture.invalid"], error: /callback issuer does not match/ },
  { name: "trailing slash alias", values: [`${ISSUER}/`], error: /callback issuer does not match/ },
]) {
  test(`MCP OAuth configured metadata: callback rejects ${item.name} before exchange`, async t => {
    const f = fixture(t, { authServerMetadataUrl: CONFIGURED_METADATA, issuerSupport: true });
    const parameters = new URLSearchParams({ code: "fixture-code" });
    for (const issuer of item.values) parameters.append("iss", issuer);
    await assert.rejects(f.login(f.owner, parameters), item.error);
    assert.equal(f.counts().exchanges, 0);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
    for (const callback of f.callbacks) await assert.rejects(fetch(callback));
  });
}

for (const item of [
  { name: "redirect", status: 302, body: "", error: /HTTP 302/ },
  { name: "not found", status: 404, body: "", error: /HTTP 404/ },
  { name: "server error", status: 500, body: "", error: /HTTP 500/ },
  { name: "invalid JSON", status: 200, body: "not-json", error: /JSON/ },
  { name: "missing required metadata", status: 200, body: "{}", error: /invalid_type/ },
  { name: "oversized body", status: 200, body: "x".repeat(1024 * 1024 + 1), error: /exceeds 1 MiB/ },
]) {
  test(`MCP OAuth configured metadata: ${item.name} fails without default discovery`, async t => {
    const f = fixture(t, { authServerMetadataUrl: CONFIGURED_METADATA });
    const requests: string[] = [];
    const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), async (input: string | URL, init: RequestInit) => {
      const url = new URL(input).href;
      requests.push(url);
      if (url !== CONFIGURED_METADATA) return f.fetchImpl(input, init);
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("Accept"), "application/json");
      assert.equal(new Headers(init.headers).has("x-private-mcp"), false);
      return new Response(item.body, { status: item.status });
    });
    await assert.rejects(f.login(owner), item.error);
    assert.deepEqual(requests, [CONFIGURED_METADATA]);
    assert.deepEqual(f.counts(), { registrations: 0, exchanges: 0, refreshes: 0 });
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
  });
}

for (const metadataOverrides of [
  { issuer: "http://remote.invalid" }, { issuer: `${ISSUER}?tenant=one` },
  { authorization_response_iss_parameter_supported: null }, { token_endpoint: "not-a-url" },
]) {
  test(`MCP OAuth configured metadata: malformed document ${JSON.stringify(metadataOverrides)} is rejected`, async t => {
    const f = fixture(t, { authServerMetadataUrl: CONFIGURED_METADATA, metadataOverrides });
    await assert.rejects(f.login(), /HTTPS|Invalid MCP OAuth issuer|issuer support flag|Invalid URL/);
    assert.deepEqual(f.counts(), { registrations: 0, exchanges: 0, refreshes: 0 });
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
  });
}

for (const repair of ["missing metadata", "old validation version"]) {
  test(`MCP OAuth configured metadata: ${repair} reloads the configured document without changing cached issuer`, async t => {
    const options: OAuthFixtureOptions = { authServerMetadataUrl: CONFIGURED_METADATA, issuerSupport: true };
    const f = fixture(t, options);
    await f.login(f.owner, new URLSearchParams({ code: "fixture-code", iss: ISSUER }));
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    if (repair === "missing metadata") delete saved[f.owner.key].discovery.authorizationServerMetadata;
    else delete saved[f.owner.key].discovery.issuerValidationVersion;
    writeFileSync(f.path, JSON.stringify(saved));
    let unavailable = true;
    const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), async (input: string | URL, init: RequestInit) => {
      if (unavailable && new URL(input).href === CONFIGURED_METADATA) return new Response(null, { status: 404 });
      return f.fetchImpl(input, init);
    });
    await assert.rejects(owner.refresh("access-1-0"), /HTTP 404/);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved);
    unavailable = false;
    options.issuer = "https://other.fixture.invalid";
    await assert.rejects(owner.refresh("access-1-0"), /discovery issuer does not match/);
    assert.equal(f.counts().refreshes, 0, "cached refresh token cannot follow an issuer change");
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved);
    options.issuer = ISSUER;
    assert.equal(await owner.refresh("access-1-0"), "access-1-1");
    assert.deepEqual(f.metadataRequests, [CONFIGURED_METADATA, CONFIGURED_METADATA, CONFIGURED_METADATA]);
    assert.deepEqual(f.counts(), { registrations: 1, exchanges: 1, refreshes: 1 });
  });
}

test("MCP OAuth configured metadata: cancellation during loading releases the login reservation", async t => {
  const f = fixture(t, { authServerMetadataUrl: CONFIGURED_METADATA });
  const controller = new AbortController();
  const reason = new Error("fixture metadata fetch cancelled");
  let calls = 0;
  const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), async (input: string | URL, init: RequestInit) => {
    calls++;
    assert.equal(new URL(input).href, CONFIGURED_METADATA);
    controller.abort(reason);
    init.signal!.throwIfAborted();
  });
  await assert.rejects(owner.login(() => assert.fail("no authorization notification after cancelled discovery"), controller.signal), error => error === reason);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
  await f.login();
});

test("MCP OAuth configured metadata: changing or removing the override isolates stored credentials", async t => {
  const f = fixture(t, { authServerMetadataUrl: CONFIGURED_METADATA });
  await f.login();
  for (const oauth of [{ authServerMetadataUrl: "https://catalog.fixture.invalid/another.json" }, {}]) {
    const other = new McpOAuth({ ...f.config, oauth }, new FileAuthStorageBackend(f.path), f.fetchImpl);
    assert.notEqual(other.key, f.owner.key);
    assert.equal(await other.token(), undefined);
    await assert.rejects(other.refresh("access-1-0"), /mcp-login fixture/);
  }
  assert.deepEqual(f.counts(), { registrations: 1, exchanges: 1, refreshes: 0 });
  assert.equal(await f.owner.token(), "access-1-0");
});

const callbackCases = [
  { name: "matching root", issuer: ISSUER, values: [ISSUER] },
  { name: "matching tenant", issuer: `${ISSUER}/tenant`, values: [`${ISSUER}/tenant`] },
  { name: "matching tenant slash", issuer: `${ISSUER}/tenant/`, values: [`${ISSUER}/tenant/`] },
  { name: "discovery resource root slash", authorizationServer: `${ISSUER}/`, issuer: ISSUER, values: [ISSUER] },
  { name: "discovery metadata root slash", authorizationServer: ISSUER, issuer: `${ISSUER}/`, values: [`${ISSUER}/`] },
  { name: "discovery resource tenant slash", authorizationServer: `${ISSUER}/tenant/`, issuer: `${ISSUER}/tenant`, values: [`${ISSUER}/tenant`] },
  { name: "discovery metadata tenant slash", authorizationServer: `${ISSUER}/tenant`, issuer: `${ISSUER}/tenant/`, values: [`${ISSUER}/tenant/`] },
  { name: "OIDC discovery tenant slash", authorizationServer: `${ISSUER}/tenant/`, issuer: `${ISSUER}/tenant`, values: [`${ISSUER}/tenant`], oidc: true },
  { name: "callback cannot use resource slash alias", authorizationServer: `${ISSUER}/tenant/`, issuer: `${ISSUER}/tenant`, values: [`${ISSUER}/tenant/`], error: /callback issuer does not match/ },
  { name: "encoded issuer decoded once", issuer: `${ISSUER}/tenant%2Fone`, values: [`${ISSUER}/tenant%2Fone`] },
  { name: "unadvertised matching issuer", issuer: ISSUER, values: [ISSUER], support: false },
  { name: "legacy absent issuer", issuer: ISSUER, values: [], support: false },
  { name: "OIDC matching issuer", issuer: ISSUER, values: [ISSUER], oidc: true },
  { name: "OIDC missing required issuer", issuer: ISSUER, values: [], oidc: true, error: /callback issuer is missing/ },
  { name: "wrong server", issuer: ISSUER, values: ["https://other.fixture.invalid"], error: /callback issuer does not match/ },
  { name: "missing required issuer", issuer: ISSUER, values: [], error: /callback issuer is missing/ },
  { name: "empty issuer", issuer: ISSUER, values: [""], error: /callback issuer does not match/ },
  { name: "duplicate issuer", issuer: ISSUER, values: [ISSUER, ISSUER], error: /multiple issuer/ },
  { name: "root slash differs", issuer: ISSUER, values: [`${ISSUER}/`], error: /callback issuer does not match/ },
  { name: "tenant slash differs", issuer: `${ISSUER}/tenant`, values: [`${ISSUER}/tenant/`], error: /callback issuer does not match/ },
  { name: "path case differs", issuer: `${ISSUER}/tenant`, values: [`${ISSUER}/Tenant`], error: /callback issuer does not match/ },
  { name: "host case differs", issuer: ISSUER, values: ["https://AUTH.fixture.invalid"], error: /callback issuer does not match/ },
  { name: "encoded path differs", issuer: `${ISSUER}/tenant%2Fone`, values: [`${ISSUER}/tenant/one`], error: /callback issuer does not match/ },
  { name: "denial checks issuer first", issuer: ISSUER, values: ["https://other.fixture.invalid"], denial: true, error: /callback issuer does not match/ },
  { name: "valid denial", issuer: ISSUER, values: [ISSUER], denial: true, error: /authorization was declined/ },
];
for (const item of callbackCases) {
  test(`MCP OAuth issuer callback: ${item.name}`, async t => {
    const f = fixture(t, { authorizationServer: item.authorizationServer ?? item.issuer, issuer: item.issuer,
      issuerSupport: item.support ?? true, oidc: item.oidc });
    const parameters = new URLSearchParams(item.denial ? "error=access_denied" : "code=fixture-code");
    for (const issuer of item.values) parameters.append("iss", issuer);
    if (item.error) {
      await assert.rejects(f.login(f.owner, parameters), item.error);
      assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 0, registrations: 1 });
      assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
      assert.equal(await f.owner.token(), undefined);
    } else {
      await f.login(f.owner, parameters);
      assert.equal(await f.owner.token(), "access-1-0");
      assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 1, registrations: 1 });
      const discoveries = f.discoveryRequests();
      const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
      await f.login(reopened, parameters);
      assert.equal(await reopened.token(), "access-2-0");
      if (item.oidc) {
        const cached = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
        await assert.rejects(f.login(cached), /callback issuer is missing/);
        assert.equal(f.counts().exchanges, 2, "OIDC support flag survives reopening the cache");
      }
      assert.equal(f.discoveryRequests(), discoveries, "cached login needs no rediscovery");
    }
    assert.ok(f.callbacks.length > 0);
    for (const callback of f.callbacks) await assert.rejects(fetch(callback));
  });
}

const discoveryCases = [
  { name: "different server", authorizationServer: ISSUER, issuer: "https://other.fixture.invalid" },
  { name: "different tenant", authorizationServer: `${ISSUER}/one`, issuer: `${ISSUER}/two` },
  { name: "extra root slash remains distinct", authorizationServer: `${ISSUER}//`, issuer: `${ISSUER}/` },
  { name: "extra tenant slash remains distinct", authorizationServer: `${ISSUER}/tenant//`, issuer: `${ISSUER}/tenant/` },
  { name: "path case differs", authorizationServer: `${ISSUER}/Tenant`, issuer: `${ISSUER}/tenant` },
  { name: "encoded path differs", authorizationServer: `${ISSUER}/tenant%2Fone`, issuer: `${ISSUER}/tenant/one` },
  { name: "OIDC issuer mismatch", authorizationServer: ISSUER, issuer: "https://other.fixture.invalid", oidc: true },
];
for (const item of discoveryCases) {
  test(`MCP OAuth discovery issuer: ${item.name}`, async t => {
    const f = fixture(t, item);
    await assert.rejects(f.login(), /discovery issuer does not match/);
    assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 0, registrations: 0 });
    assert.deepEqual(f.callbacks, []);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
  });
}

for (const options of [{ issuerSupport: "true" }, { issuerSupport: null }, { issuerSupport: "true", oidc: true }]) {
  test(`MCP OAuth rejects malformed issuer support flag: ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await assert.rejects(f.login(), /issuer support flag/);
    assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 0, registrations: 0 });
    assert.deepEqual(f.callbacks, []);
  });
}

for (const issuer of [`${ISSUER}?tenant=one`, `${ISSUER}#tenant`]) {
  test(`MCP OAuth rejects issuer query/fragment: ${issuer}`, async t => {
    const f = fixture(t, { authorizationServer: issuer });
    await assert.rejects(f.login(), /Invalid MCP OAuth issuer/);
    assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 0, registrations: 0 });
    assert.deepEqual(f.callbacks, []);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
  });
}

test("MCP OAuth synthesised fallback origin and metadata-free legacy discovery remain usable", async t => {
  for (const noAuthorizationMetadata of [false, true]) {
    const f = fixture(t, { noResourceMetadata: true, noAuthorizationMetadata, issuer: "https://mcp.fixture.invalid" });
    await f.login();
    assert.equal(await f.owner.token(), "access-1-0");
    for (const callback of f.callbacks) await assert.rejects(fetch(callback));
  }
});

test("MCP OAuth cached issuer mismatch blocks both relogin and refresh without network requests", async t => {
  const f = fixture(t);
  await f.login();
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  saved[f.owner.key].discovery.authorizationServerMetadata.issuer = "https://other.fixture.invalid";
  writeFileSync(f.path, JSON.stringify(saved));
  const discoveries = f.discoveryRequests();
  const counts = f.counts();
  for (const action of ["login", "refresh"]) {
    const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
    await assert.rejects(action === "login" ? f.login(owner) : owner.refresh("access-1-0"), /discovery issuer does not match/);
    assert.equal(f.discoveryRequests(), discoveries);
    assert.deepEqual(f.counts(), counts);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved, "previous credentials and discovery remain intact");
  }
});

test("MCP OAuth upgrades legacy OIDC cache before accepting a callback, then reuses it", async t => {
  const options: OAuthFixtureOptions = { oidc: true, issuerSupport: true };
  const f = fixture(t, options);
  const valid = new URLSearchParams({ code: "fixture-code", iss: ISSUER });
  await f.login(f.owner, valid);
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  // Old SDK OIDC parsing dropped this field before the discovery was persisted.
  delete saved[f.owner.key].discovery.issuerValidationVersion;
  delete saved[f.owner.key].discovery.authorizationServerMetadata.authorization_response_iss_parameter_supported;
  writeFileSync(f.path, JSON.stringify(saved));
  const discoveries = f.discoveryRequests();
  const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  await assert.rejects(f.login(owner), /callback issuer is missing/);
  assert.equal(f.discoveryRequests(), discoveries + 2, "OAuth miss plus OIDC discovery, without a second resource request");
  assert.equal(f.counts().exchanges, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved, "failed migration does not replace existing credentials");
  options.noAuthorizationMetadata = true;
  await assert.rejects(owner.refresh("access-1-0"), /metadata unavailable for issuer validation/);
  assert.equal(f.counts().refreshes, 0, "unavailable discovery cannot downgrade the old cache");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved);
  options.noAuthorizationMetadata = false;
  await f.login(owner, valid);
  const refreshed = f.discoveryRequests();
  const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  await f.login(reopened, valid);
  assert.equal(f.discoveryRequests(), refreshed, "successful migration restores discovery reuse");
  assert.equal(f.counts().registrations, 1, "migration preserves the registered client");
  for (const callback of f.callbacks) await assert.rejects(fetch(callback));
});

test("MCP OAuth validates metadata added to an incomplete discovery cache before refreshing", async t => {
  const options: OAuthFixtureOptions = {};
  const f = fixture(t, options);
  await f.login();
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  delete saved[f.owner.key].discovery.authorizationServerMetadata;
  writeFileSync(f.path, JSON.stringify(saved));
  options.issuer = "https://other.fixture.invalid";
  const counts = f.counts();
  const discoveries = f.discoveryRequests();
  const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  await assert.rejects(owner.refresh("access-1-0"), /discovery issuer does not match/);
  assert.equal(f.discoveryRequests(), discoveries + 1);
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved);
});

for (const [clientKind, metadataUrl] of [["dynamic", undefined], ["fixed", undefined],
  ["dynamic", CONFIGURED_METADATA], ["fixed", CONFIGURED_METADATA]] as const) {
  test(`MCP OAuth SDK rediscovery binds issuer with a ${clientKind} client${metadataUrl ? " and configured metadata" : ""}`, async t => {
    const options: OAuthFixtureOptions = { issuerSupport: true, authServerMetadataUrl: metadataUrl };
    if (clientKind === "fixed") {
      // Reserve a valid loopback port for this pre-registered client, then release
      // it to the production callback receiver. No listener survives initialization.
      const reservation = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          reservation.once("error", reject);
          reservation.listen(0, "127.0.0.1", resolve);
        });
        options.callbackPort = (reservation.address() as AddressInfo).port;
        options.clientId = "configured-client";
      } finally {
        reservation.closeAllConnections();
        await new Promise<void>(resolve => reservation.close(() => resolve()));
      }
    }
    const f = fixture(t, options);
    const tokenRequests: Array<{ url: string; code: string | null; clientId: string | null }> = [];
    let rediscovered = false;
    const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.origin === "https://other.fixture.invalid" && url.pathname.includes(".well-known")) rediscovered = true;
      if (metadataUrl && url.href === metadataUrl && tokenRequests.length > 0) rediscovered = true;
      if (url.pathname === "/token") {
        const body = new URLSearchParams(init.body as string);
        tokenRequests.push({ url: url.href, code: body.get("code"), clientId: body.get("client_id") });
        options.authorizationServer = "https://other.fixture.invalid";
        options.tokenEndpoint = "https://other.fixture.invalid/token";
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return f.fetchImpl(input, init);
    };
    const owner = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), fetchImpl);
    let failure: unknown;
    try {
      await f.login(owner, new URLSearchParams({ code: "fixture-code", iss: ISSUER }));
    } catch (error) {
      failure = error;
    }
    assert.equal(rediscovered, true, "the actual SDK retries discovery after invalid_client");
    if (metadataUrl) assert.deepEqual(f.metadataRequests, [metadataUrl, metadataUrl]);
    assert.deepEqual(tokenRequests, [{ url: `${ISSUER}/token`, code: "fixture-code", clientId: options.clientId ?? "fixture-client" }]);
    assert.equal(f.counts().registrations, clientKind === "fixed" ? 0 : 1);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
    for (const callback of f.callbacks) await assert.rejects(fetch(callback));
    // Assert this guard's error, not merely rejection: removing issuer binding
    // still fails later (missing client information or a cleared PKCE verifier).
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /authorization issuer changed during login/);
  });
}

test("MCP OAuth issuer rejection preserves previous credentials and permits immediate retry", async t => {
  const f = fixture(t, { issuerSupport: true });
  const valid = new URLSearchParams({ code: "fixture-code", iss: ISSUER });
  await f.login(f.owner, valid);
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  await assert.rejects(f.login(f.owner, new URLSearchParams({ code: "fixture-code", iss: "https://other.fixture.invalid" })), /callback issuer does not match/);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), saved);
  assert.equal(await f.owner.token(), "access-1-0");
  assert.equal(f.counts().exchanges, 1);
  await f.login(f.owner, valid);
  assert.equal(await f.owner.token(), "access-2-0");
  for (const callback of f.callbacks) await assert.rejects(fetch(callback));
});

test("MCP OAuth explicit PKCE login, state validation, durable credentials and closed callback", async t => {
  const f = fixture(t);
  const callback = await f.login();
  assert.equal(await f.owner.token(), "access-1-0");
  assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 1, registrations: 1 });
  const saved = readFileSync(f.path, "utf8");
  assert.doesNotMatch(saved, /code_verifier|fixture-code/);
  await assert.rejects(fetch(callback));
  const other = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  assert.equal(await other.token(), "access-1-0");
  await other.logout();
  assert.equal(await other.token(), undefined);
});

const optionalTokenFields = ["scope", "expires_in", "refresh_token", "id_token"] as const;
for (const value of [null, ""] as const) {
  for (const field of optionalTokenFields) {
    test(`MCP OAuth token compatibility: ${field} ${value === null ? "null" : "empty"} is absent after login and reopen`, async t => {
      const f = fixture(t, { tokenEndpoint: `${ISSUER}/tenant/credentials`, tokenResponse: { [field]: value } });
      const callback = await f.login();
      const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
      assert.equal(Object.hasOwn(saved.tokens, field), false);
      if (field === "expires_in") assert.equal(Object.hasOwn(saved, "expiresAt"), false);
      assert.equal(await f.owner.token(), "access-1-0");
      const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
      assert.equal(await reopened.token(), "access-1-0");
      assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 1, registrations: 1 });
      await assert.rejects(fetch(callback));
    });
  }

  test(`MCP OAuth token compatibility: ${value === null ? "null" : "empty"} refresh fields preserve the previous refresh token`, async t => {
    const f = fixture(t, { tokenEndpoint: `${ISSUER}/tenant/credentials`,
      refreshResponse: { scope: value, expires_in: value, refresh_token: value, id_token: value } });
    await f.login();
    assert.equal(await f.owner.refresh("access-1-0"), "access-1-1");
    const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
    assert.deepEqual(saved.tokens, { token_type: "Bearer", access_token: "access-1-1", refresh_token: "refresh-0" });
    assert.equal(Object.hasOwn(saved, "expiresAt"), false);
    const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), async (input: string | URL, init: RequestInit) => {
      assert.equal(new URLSearchParams(init.body as string).get("refresh_token"), "refresh-0");
      return f.fetchImpl(input, init);
    });
    assert.equal(await reopened.token(), "access-1-1");
    assert.equal(await reopened.refresh("access-1-1"), "access-1-2");
    assert.deepEqual(f.counts(), { refreshes: 2, exchanges: 1, registrations: 1 });
  });
}

test("MCP OAuth token compatibility: absent expiry without a refresh token stays usable", async t => {
  const f = fixture(t, { tokenResponse: { expires_in: null, refresh_token: null } });
  await f.login();
  assert.equal(await f.owner.token(), "access-1-0");
  const reopened = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  assert.equal(await reopened.token(), "access-1-0");
  assert.equal(f.counts().refreshes, 0);
});

for (const expires of [0, "3600"] as const) {
  test(`MCP OAuth token compatibility: preserves expiry ${JSON.stringify(expires)}`, async t => {
    const f = fixture(t, { tokenResponse: { expires_in: expires, scope: "read write", id_token: "fixture-id" } });
    const before = Date.now();
    await f.login();
    const saved = JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key];
    assert.equal(saved.tokens.expires_in, Number(expires));
    assert.equal(saved.tokens.scope, "read write");
    assert.equal(saved.tokens.id_token, "fixture-id");
    assert.ok(saved.expiresAt >= before + Number(expires) * 1000 && saved.expiresAt <= Date.now() + Number(expires) * 1000);
    assert.equal(await f.owner.token(), expires === 0 ? "access-1-1" : "access-1-0");
    assert.equal(f.counts().refreshes, expires === 0 ? 1 : 0);
  });
}

const invalidTokenCases = [
  { access_token: null }, { access_token: "" }, { access_token: undefined },
  { token_type: null }, { token_type: undefined },
  { scope: 7 }, { id_token: {} }, { refresh_token: false }, { expires_in: "not-a-number" },
];
for (const [index, tokenResponse] of invalidTokenCases.entries()) {
  test(`MCP OAuth token compatibility: invalid response ${index + 1} cannot replace saved credentials`, async t => {
    const options: OAuthFixtureOptions = {};
    const f = fixture(t, options);
    await f.login();
    const saved = readFileSync(f.path, "utf8");
    options.tokenResponse = tokenResponse;
    await assert.rejects(f.login());
    assert.equal(readFileSync(f.path, "utf8"), saved);
    assert.equal(await f.owner.token(), "access-1-0");
    options.refreshResponse = tokenResponse;
    await assert.rejects(f.owner.refresh("access-1-0"));
    assert.equal(readFileSync(f.path, "utf8"), saved);
    for (const callback of f.callbacks) await assert.rejects(fetch(callback));
  });
}

test("MCP OAuth concurrent owners share the file-locked refresh and preserve token rotation", async t => {
  const f = fixture(t); await f.login();
  const second = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  const tokens = await Promise.all([f.owner.refresh("access-1-0"), second.refresh("access-1-0")]);
  assert.deepEqual(tokens, ["access-1-1", "access-1-1"]);
  assert.equal(f.counts().refreshes, 1);
  const entries = JSON.parse(readFileSync(f.path, "utf8"));
  entries[f.owner.key].expiresAt = 1;
  writeFileSync(f.path, JSON.stringify(entries));
  const expired = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  assert.equal(await expired.token(), "access-1-2");
});

test("MCP OAuth token compatibility: other OAuth responses keep their original JSON", async () => {
  const value = { issuer: ISSUER, authorization_response_iss_parameter_supported: null,
    scope: null, expires_in: "", refresh_token: null, id_token: "" };
  const cases = [
    { path: "/.well-known/openid-configuration", status: 200, init: {} },
    { path: "/register", status: 200, init: { method: "POST", body: JSON.stringify({ scope: null }) } },
    { path: "/tenant/credentials", status: 400, init: { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code" }) } },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetcher = createOAuthFetch(async () => { calls++; return Response.json(value, { status: item.status }); }, undefined, {});
    const response = await fetcher(`${ISSUER}${item.path}`, item.init);
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), value);
    assert.equal(calls, 1);
  }
});

test("MCP OAuth ordinary connections require explicit login; server identity isolates credentials", async t => {
  const f = fixture(t);
  await assert.rejects(f.owner.refresh(undefined), /mcp-login fixture/);
  assert.deepEqual(f.counts(), { refreshes: 0, exchanges: 0, registrations: 0 });
  await f.login();
  const other = new McpOAuth({ ...f.config, url: "https://different.invalid/mcp" }, new FileAuthStorageBackend(f.path), f.fetchImpl);
  assert.equal(await other.token(), undefined);
});

test("MCP OAuth cancellation closes callback and does not persist partial authorization", async t => {
  const f = fixture(t), controller = new AbortController();
  let callback = "";
  await assert.rejects(f.owner.login((url: string) => {
    callback = new URL(url).searchParams.get("redirect_uri")!; controller.abort();
  }, controller.signal), /cancelled|abort/i);
  await assert.rejects(fetch(callback));
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
});

test("MCP OAuth bounds metadata and rejects unsafe URL schemes before fetching", async () => {
  let calls = 0;
  const fetcher = createOAuthFetch(async () => { calls++; return new Response("x".repeat(1024 * 1024 + 1)); });
  await assert.rejects(fetcher("http://remote.invalid"), /HTTPS/);
  await assert.rejects(fetcher("https://user:password@host.invalid"), /credentials/);
  assert.equal(calls, 0);
  await assert.rejects(fetcher("https://host.invalid"), /exceeds 1 MiB/);
});

test("MCP configured headers never cross endpoint origins", async () => {
  const fetcher = fetchWithHeaders({ "X-Private-MCP": "fixture-secret" }, "https://mcp.fixture.invalid/mcp");
  await assert.rejects(fetcher("https://other.invalid/endpoint"), /cross-origin/);
});

test("MCP configured headers merge with, not replace, a Request input's own headers", async t => {
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((request, response) => { seen.push(request.headers); response.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const fetcher = fetchWithHeaders({ "X-Private-MCP": "fixture-secret" }, url);
  const response = await fetcher(new Request(url, { headers: { "Mcp-Session-Id": "session-1", "X-Overlay": "request" } }), { headers: { "X-Overlay": "init" } });
  assert.equal(await response.text(), "ok");
  assert.equal(seen[0]?.["mcp-session-id"], "session-1");
  assert.equal(seen[0]?.["x-overlay"], "init");
  assert.equal(seen[0]?.["x-private-mcp"], "fixture-secret");
});

test("MCP OAuth retry after a 401 resends an unused copy of a Request body", async t => {
  const seen: Array<{ authorization?: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => {
      seen.push({ authorization: request.headers.authorization, body });
      response.statusCode = seen.length === 1 ? 401 : 200;
      response.end(seen.length === 1 ? "expired" : "ok");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const oauth = { token: async () => "old", refresh: async (token: string) => `${token}-refreshed` };
  const fetcher = fetchWithHeaders({}, url, oauth);
  const response = await fetcher(new Request(url, { method: "POST", body: '{"jsonrpc":"2.0","id":1}' }));
  assert.equal(await response.text(), "ok");
  assert.deepEqual(seen, [
    { authorization: "Bearer old", body: '{"jsonrpc":"2.0","id":1}' },
    { authorization: "Bearer old-refreshed", body: '{"jsonrpc":"2.0","id":1}' },
  ]);
  // Without a 401 the spare copy is released, and the single attempt still carries the body.
  seen.length = 1;
  const direct = await fetcher(new Request(url, { method: "POST", body: "second" }));
  assert.equal(await direct.text(), "ok");
  assert.deepEqual(seen.at(-1), { authorization: "Bearer old", body: "second" });
});

test("MCP HTTP config accepts the bracketed IPv6 loopback and still rejects remote HTTP", t => {
  const root = mkdtempSync(join(tmpdir(), "sp-mcp-config-"));
  const previous = process.env.SP_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.SP_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"));
  const write = (url: string) => writeFileSync(join(root, "config", "mcp.json"), JSON.stringify({ version: 1, servers: { local: { transport: "http", url } } }));
  write("http://[::1]:8080/mcp");
  assert.equal(loadMcpConfig(root, false).servers[0]?.url, "http://[::1]:8080/mcp");
  write("http://remote.invalid/mcp");
  assert.throws(() => loadMcpConfig(root, false), /HTTPS/);
});

test("interactive OAuth leaves the file unlocked and merges another process's committed entry", async t => {
  const f = fixture(t), controller = new AbortController();
  let notify!: (url: string) => void;
  const ready = new Promise<string>(resolve => { notify = resolve; });
  const login = f.owner.login(notify, controller.signal);
  void login.catch(() => undefined);
  try {
    const url = await ready;
    const other = new McpOAuth({ ...f.config, id: "other" }, new FileAuthStorageBackend(f.path), f.fetchImpl);
    assert.equal(await other.read(), undefined, "read succeeds while browser authorization is pending");
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ["tests/fixtures/oauth-lock-writer.mjs", f.path], { windowsHide: true, timeout: 10000 }, error => error ? reject(error) : resolve());
    });
    assert.equal(JSON.parse(readFileSync(f.path, "utf8")).crossProcess.reviewMarker, "committed");
    await sendCallback(url); await login;
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    assert.equal(saved.crossProcess.reviewMarker, "committed");
    assert.equal(saved[f.owner.key].loginAttempt, undefined);
    assert.ok(await f.owner.token());
  } finally { controller.abort(); await login.catch(() => undefined); }
});

test("logout while OAuth waits prevents late credentials from being resurrected", async t => {
  const f = fixture(t), controller = new AbortController();
  let notify!: (url: string) => void;
  const ready = new Promise<string>(resolve => { notify = resolve; });
  const login = f.owner.login(notify, controller.signal);
  void login.catch(() => undefined);
  try {
    const url = await ready;
    const other = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
    await other.logout();
    await sendCallback(url);
    await assert.rejects(login, /cancelled or superseded/);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
    assert.equal(await f.owner.token(), undefined);
    await assert.rejects(fetch(new URL(url).searchParams.get("redirect_uri")!));
  } finally { controller.abort(); await login.catch(() => undefined); }
});

test("concurrent login is rejected without cancelling the first; cancellation releases reservation", async t => {
  const f = fixture(t), controller = new AbortController();
  let notify!: (url: string) => void;
  const ready = new Promise<string>(resolve => { notify = resolve; });
  const login = f.owner.login(notify, controller.signal);
  void login.catch(() => undefined);
  try {
    await ready;
    const other = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
    await assert.rejects(other.login(() => {}), /already pending/);
    controller.abort();
    await assert.rejects(login, /cancelled|abort/i);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
    await f.login(other);
    assert.ok(await other.token());
  } finally { controller.abort(); await login.catch(() => undefined); }
});

test("sync auth access cannot steal an async lease aged beyond the old 10-second default", async t => {
  const f = fixture(t), backend = new FileAuthStorageBackend(f.path);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = backend.withLockAsync(async () => { entered(); await gate; return { result: undefined, next: '{"owner":"preserved"}' }; });
  try {
    await ready;
    const old = new Date(Date.now() - 11500);
    utimesSync(f.path + ".lock", old, old);
    assert.throws(() => new FileAuthStorageBackend(f.path).withLock(() => ({ result: undefined })), { code: "ELOCKED" });
  } finally { release(); await held; }
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).owner, "preserved");
});

test("a failed login reports its own error when attempt cleanup cannot take the lock", async t => {
  const f = fixture(t), backend = new FileAuthStorageBackend(f.path);
  let release!: () => void, held: Promise<unknown> | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.owner.authorize = async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    held = backend.withLockAsync(async () => { entered(); await gate; return { result: undefined }; });
    await ready;
    throw new Error("fixture authorization declined");
  };
  try {
    await assert.rejects(f.owner.login(() => {}), /fixture authorization declined/);
  } finally { release(); await held; }
  // The unreleased reservation is bounded by loginUntil rather than lost silently.
  assert.ok(JSON.parse(readFileSync(f.path, "utf8"))[f.owner.key].loginAttempt);
});

test("a successful logout reports before reload and never uses the replaced command context", async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-mcp-logout-"));
  const previous = process.env.SP_CODING_AGENT_DIR, entry = process.argv[1];
  process.env.SP_CODING_AGENT_DIR = root;
  // The bridge discovers its host version from the entry script's package.
  process.argv[1] = join(process.cwd(), "packages", "coding-agent", "src", "cli.ts");
  t.after(() => {
    process.argv[1] = entry!;
    if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "mcp.json"), JSON.stringify({ version: 1, servers: { fixture: { transport: "http", url: "https://example.test/mcp", oauth: true, enabled: false } } }));
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  mcpBridgeExtension({ registerTool() {}, registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, command.handler); },
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { events.set(name, handler); }, getActiveTools: () => [], setActiveTools() {} });
  await events.get("session_start")!({}, { cwd: root, isProjectTrusted: () => false, hasUI: false, ui: { notify() {} } });
  const notes: string[] = [];
  let reloaded = false;
  const ctx = { get ui() { if (reloaded) throw new Error("stale command context"); return { notify: (text: string, level: string) => { notes.push(`${level}: ${text}`); } }; },
    reload: async () => { reloaded = true; } };
  await commands.get("mcp-logout")!("fixture", ctx);
  assert.equal(reloaded, true);
  assert.deepEqual(notes, ["info: MCP logout completed for fixture. Reloading MCP servers."]);
});

test("a cold token read waits for another process's refresh lease and uses its committed token", async t => {
  const f = fixture(t), backend = new FileAuthStorageBackend(f.path);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const committed = { [f.owner.key]: { tokens: { access_token: "fresh-token" }, expiresAt: Date.now() + 3_600_000 } };
  // Held well past the old ~200 ms synchronous retry window, as an OAuth network refresh would be.
  const held = backend.withLockAsync(async () => { entered(); await gate; return { result: undefined, next: JSON.stringify(committed) }; });
  await ready;
  const cold = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl);
  const token = cold.token();
  const cancelled = new AbortController();
  const aborted = new McpOAuth(f.config, new FileAuthStorageBackend(f.path), f.fetchImpl).token(cancelled.signal);
  await new Promise(resolve => setTimeout(resolve, 600));
  cancelled.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  release(); await held;
  assert.equal(await token, "fresh-token");
});
