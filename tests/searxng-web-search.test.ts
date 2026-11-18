import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";
import webSearch from "../packages/extensions/web-search/index.ts";
import { recoverLocalSearxng } from "../packages/extensions/web-search/local-service.ts";
import toolClassification from "../packages/tool-classification/src/index.ts";
import { assistant, body } from "./codemode-recovery/fixture.ts";
import { alphaSession } from "./helpers/alpha-session.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

function withSearchBase<T>(base: string | undefined, initialize: () => T): T {
  const before = process.env.SP_SEARXNG_URL;
  try {
    if (base === undefined) delete process.env.SP_SEARXNG_URL;
    else process.env.SP_SEARXNG_URL = base;
    return initialize();
  } finally {
    if (before === undefined) delete process.env.SP_SEARXNG_URL;
    else process.env.SP_SEARXNG_URL = before;
  }
}

function makeTool(base?: string, localAppData?: string): ToolDefinition | undefined {
  let tool: ToolDefinition | undefined;
  const before = process.env.LOCALAPPDATA;
  try {
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
    withSearchBase(base, () => webSearch({
      on() {},
      registerTool: entry => { tool = entry as ToolDefinition; },
    } as Pick<ExtensionAPI, "on" | "registerTool"> as ExtensionAPI));
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = before;
  }
  return tool;
}

async function endpoint(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/`;
}

function search(tool: ToolDefinition, query: string, limit?: number, signal?: AbortSignal, fresh?: boolean) {
  return tool.execute("fixture", { query, limit, fresh }, signal, undefined, {} as ExtensionContext);
}

test("a managed Windows installation registers search without an inherited endpoint", { skip: process.platform !== "win32" }, async t => {
  const owned = createOwnedTaskFixture("searxng-installed-default-");
  t.after(() => owned.cleanup());
  assert.equal(makeTool(undefined, owned.root), undefined);
  const install = join(owned.root, "SuperPi", "SearXNG");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "install.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:8888", source: "https://github.com/searxng/searxng", upstream: "b".repeat(40),
  }));
  const fetcher = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ results: [] })));
  const local = makeTool(undefined, owned.root);
  assert.ok(local, "the local installation should expose web_search even without SP_SEARXNG_URL");
  await search(local, "fixture");
  await search(makeTool("https://search.example.test", owned.root)!, "fixture");
  assert.deepEqual(fetcher.mock.calls.map(call => String(call.arguments[0])), [
    "http://127.0.0.1:8888/search", "https://search.example.test/search",
  ]);
});

test("SearXNG search is opt-in and posts encoded keywords with no API key", async t => {
  assert.equal(makeTool(), undefined);
  assert.throws(() => makeTool("https://user:dummy@example.test"), /without credentials/);
  const requests: unknown[] = [];
  const base = await endpoint(t, async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk.toString();
    requests.push({ method: req.method, path: req.url, body: Object.fromEntries(new URLSearchParams(data)), auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      results: [
        { title: "Sample\nTitle", url: "https://example.org/results", content: "多语言   answer" },
        { title: "Duplicate", url: "https://example.org/results" },
        { title: "Different protocol", url: "file:///tmp/no" },
        { url: "https://example.org/second" },
        { title: "Limit hit", url: "https://example.org/third" },
      ],
      unresponsive_engines: [["test_engine", "timeout"]],
    }));
  });
  const tool = makeTool(base)!;
  const result = await search(tool, "  中文 & C++  ", 2);
  assert.deepEqual(requests, [{ method: "POST", path: "/prefix/search", body: { q: "中文 & C++", format: "json" }, auth: undefined }]);
  assert.deepEqual(result.details, {
    results: [
      { title: "Sample Title", url: "https://example.org/results", snippet: "多语言 answer" },
      { title: "example.org", url: "https://example.org/second", snippet: "" },
    ],
    failedEngines: 1,
  });
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Untrusted search results:[\s\S]+1 upstream engine failures/);
  await assert.rejects(search(tool, "  "), /Enter search keywords/);
  assert.equal(requests.length, 1);
});

test("SearXNG fails openly on an API error, a redirect, or an unusable response", async t => {
  let redirected = false;
  const base = await endpoint(t, async (req, res) => {
    if (req.url === "/redirected") { redirected = true; res.end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk.toString();
    switch (new URLSearchParams(data).get("q")) {
      case "forbidden": res.writeHead(403).end(); return;
      case "redirect": res.writeHead(302, { Location: "/redirected" }).end(); return;
      case "html": res.end("<html>Service proxy</html>"); return;
      case "oversize": res.end(" ".repeat(1024 * 1024 + 1)); return;
      case "degraded": res.end(JSON.stringify({ results: [], unresponsive_engines: [["engine", "blocked"]] })); return;
      default: res.end(JSON.stringify({ results: [] }));
    }
  });
  const tool = makeTool(base)!;
  await assert.rejects(search(tool, "forbidden"), /HTTP 403.*search\.formats/);
  await assert.rejects(search(tool, "redirect"), /HTTP 302/);
  assert.equal(redirected, false);
  await assert.rejects(search(tool, "html"), /invalid JSON/);
  await assert.rejects(search(tool, "oversize"), /search response budget/);
  await assert.rejects(search(tool, "degraded"), /1 upstream engine failures/);
  const result = await search(tool, "empty");
  assert.deepEqual(result.details, { results: [], failedEngines: 0 });
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(search(tool, "cancel", undefined, controller.signal), /caller cancelled/);
});

test("local recovery shares readiness and skips non-refusal and unrelated endpoints", async t => {
  const local = new URL("http://127.0.0.1:8888/search");
  const connectionFailure = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  const controller = new AbortController();
  let sendHealth!: (response: Response) => void;
  const waiting = new Promise<Response>(resolve => { sendHealth = resolve; });
  const health = t.mock.method(globalThis, "fetch", () => waiting);
  assert.equal(await recoverLocalSearxng(new URL("http://127.0.0.1:18888/search"), connectionFailure, controller.signal), false);
  assert.equal(await recoverLocalSearxng(local, new TypeError("socket interrupted", { cause: { code: "ECONNRESET" } }), controller.signal), false);
  assert.equal(health.mock.callCount(), 0);

  const first = recoverLocalSearxng(local, connectionFailure, controller.signal);
  const second = recoverLocalSearxng(local, connectionFailure, new AbortController().signal);
  assert.equal(health.mock.callCount(), 1);
  assert.equal(health.mock.calls[0]?.arguments[0], "http://127.0.0.1:8888/healthz");
  controller.abort(new Error("cancelled search"));
  await assert.rejects(first, /cancelled search/);
  sendHealth(new Response("OK", { headers: { "content-length": "2" } }));
  assert.equal(await second, true);
  assert.equal(health.mock.callCount(), 1);
});

test("a session reuses its recent successful query, with isolated results and explicit refresh", async t => {
  let requests = 0;
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  const base = await endpoint(t, async (req, res) => {
    requests++;
    let data = "";
    for await (const chunk of req) data += chunk.toString();
    const query = new URLSearchParams(data).get("q");
    res.end(JSON.stringify({
      results: query === "empty" ? [] : [{ title: `Result ${requests}`, url: "https://example.org" }],
      unresponsive_engines: query === "partial" ? [["fixture", "timeout"]] : [],
    }));
  });
  const tool = makeTool(base)!;
  const first = await search(tool, "original");
  (first.details as { results: { title: string }[] }).results[0]!.title = "changed by the caller";
  const reused = await search(tool, "  original  ", 5);
  assert.match(body(reused.content), /Result 1/);
  assert.equal((reused.details as { results: { title: string }[] }).results[0]!.title, "Result 1");
  assert.equal(requests, 1);
  const fresh = await search(tool, "original", undefined, undefined, true);
  assert.match(body(fresh.content), /Result 2/);
  assert.equal(requests, 2);
  assert.match(body((await search(makeTool(base)!, "original")).content), /Result 3/);
  await search(tool, "original", 1);
  assert.equal(requests, 4);
  now += 60_000;
  assert.match(body((await search(tool, "original", 1)).content), /Result 5/);
  const cancelled = AbortSignal.abort(new Error("cancelled before reuse"));
  await assert.rejects(search(tool, "original", 1, cancelled), /cancelled before reuse/);
  assert.equal(requests, 5);
  for (const query of ["partial", "empty"]) {
    await search(tool, query);
    await search(tool, query);
  }
  assert.equal(requests, 9);
});

test("a late search completion cannot overwrite a newer refreshed result", async t => {
  let signalFirstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
  const firstResponseGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let requests = 0;
  const base = await endpoint(t, async (req, res) => {
    req.resume();
    const number = ++requests;
    if (number === 1) {
      signalFirstStarted();
      await firstResponseGate;
    }
    res.end(JSON.stringify({ results: [{ title: `Result ${number}`, url: "https://example.org" }] }));
  });
  const tool = makeTool(base)!;
  const first = search(tool, "same query");
  try {
    await firstStarted;
    const refreshed = await search(tool, "same query", undefined, undefined, true);
    assert.match(body(refreshed.content), /Result 2/);
  } finally {
    releaseFirst();
  }
  assert.match(body((await first).content), /Result 1/);
  assert.match(body((await search(tool, "same query")).content), /Result 2/);
  assert.equal(requests, 2);
});

test("the normal Codemode dispatcher discovers and runs direct SearXNG search", async t => {
  let requests = 0;
  const base = await endpoint(t, (_req, res) => {
    requests++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ results: [{ title: "Fixture source", url: "https://example.org/official", content: "Fixture snippet" }] }));
  });
  const f = await alphaSession({
    g2: false,
    codemode: true,
    customTools: [{ name: "read", label: "Read", description: "Fixture read", parameters: Type.Object({}),
      async execute() { throw new Error("Unexpected read."); } }],
    extensions: [toolClassification, (pi: ExtensionAPI) => withSearchBase(base, () => webSearch(pi))],
  });
  t.after(() => f.release());
  f.session.setActiveToolsByName(["codemode", "tool_search"]);
  const sources = [
    'await show((await tools.tool_search({query: "web search"})).ref);',
    'const search = await callTool("web_search", {query: "official source"}); text(search.details.results);',
  ];
  let turn = 0;
  const prefixes: string[] = [];
  f.session.agent.streamFunction = (_model, context) => {
    prefixes.push(JSON.stringify([context.systemPrompt, context.tools]));
    const message = assistant([`web-search-${turn}`]);
    const code = sources[turn++];
    const reason = code ? "toolUse" : "stop";
    if (code) message.content = [{ type: "toolCall", id: `web-search-${turn}`, name: "codemode", arguments: { code } }];
    else message.content = [{ type: "text", text: "Done" }];
    message.stopReason = reason;
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason, message });
    return stream;
  };
  await f.session.prompt("Find the official fixture source.");
  const results = f.session.messages.filter(message => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.match(body(results[0]!.content), /Activated conditional tools: web_search/);
  assert.equal(results[1]!.isError, false, body(results[1]!.content));
  assert.match(body(results[1]!.content), /\[\{"title":"Fixture source","url":"https:\/\/example\.org\/official","snippet":"Fixture snippet"\}\]/);
  assert.equal(requests, 1);
  assert.equal(new Set(prefixes).size, 1, "tool discovery and results must preserve the provider entry prefix");
  assert.ok(!f.session.getActiveToolNames().includes("browser_exec"));
});
