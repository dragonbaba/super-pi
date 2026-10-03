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
import { fetchWithHeaders } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension has no declaration file
import { loadMcpConfig } from "../packages/mcp-bridge/src/config.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FileAuthStorageBackend } from "../packages/coding-agent/src/core/auth-storage.ts";

function sendCallback(url: string) {
  const auth = new URL(url);
  return fetch(`${auth.searchParams.get("redirect_uri")}?state=${auth.searchParams.get("state")}&code=fixture-code`);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sp-mcp-oauth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "auth.json");
  const config = { id: "fixture", source: "global", url: "https://mcp.fixture.invalid/mcp", oauth: {} };
  let refreshes = 0, exchanges = 0, registrations = 0;
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(new Headers(init.headers).has("x-private-mcp"), false);
    assert.equal(init.redirect, "error");
    init.signal?.throwIfAborted();
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: config.url, authorization_servers: ["https://auth.fixture.invalid"] });
    if (url.pathname.includes(".well-known")) return Response.json({ issuer: "https://auth.fixture.invalid", authorization_endpoint: "https://auth.fixture.invalid/authorize",
      token_endpoint: "https://auth.fixture.invalid/token", registration_endpoint: "https://auth.fixture.invalid/register",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/register") { registrations++; return Response.json({ ...JSON.parse(init.body as string), client_id: "fixture-client" }); }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(init.body as string);
      if (body.get("grant_type") === "refresh_token") { refreshes++; assert.ok(body.get("refresh_token")); }
      else { exchanges++; assert.ok(body.get("code_verifier")); assert.equal(body.get("code"), "fixture-code"); }
      return Response.json({ token_type: "Bearer", access_token: `access-${exchanges}-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600 });
    }
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  };
  const owner = new McpOAuth(config, new FileAuthStorageBackend(path), fetchImpl);
  async function login(target = owner) {
    let callback = "";
    const requests: Promise<unknown>[] = [];
    await target.login((url: string) => {
      const auth = new URL(url); callback = auth.searchParams.get("redirect_uri")!;
      requests.push((async () => {
        assert.equal((await fetch(`${callback}?state=wrong&code=bad`)).status, 400);
        assert.equal((await fetch(`${callback}?state=${auth.searchParams.get("state")}&code=fixture-code`)).status, 200);
      })());
    });
    await Promise.all(requests);
    return callback;
  }
  return { owner, config, path, fetchImpl, login, counts: () => ({ refreshes, exchanges, registrations }) };
}

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
