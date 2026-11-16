import assert from "node:assert/strict";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { Type } from "typebox";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { stream as streamCodex } from "../packages/ai/src/api/openai-codex-responses.ts";
import { alphaModelRuntime, alphaSession } from "./helpers/alpha-session.ts";
import { codexModel, codexToken, sseFrames, textEvents } from "./helpers/responses-sse-fixture.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";

const local = (name: string, description = name) => ({ name, label: name, description, parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }) });

test("tool activation, order and schema metadata never rewrite the CodeMode entry definition", async () => {
  const owner = new CodemodeController(() => {});
  const initial = owner.definition.description;
  let visits = 0;
  const schema = Type.Object({});
  Object.defineProperty(schema, "properties", { get() { visits++; return {}; } });
  const a = local("alpha"), b = { ...local("beta"), parameters: schema };
  try {
    for (const tools of [[a], [a, b], [b, a], [b], [{ ...b, description: "updated", parameters: Type.Object({ revised: Type.String() }) }],
      [a, { ...local("mcp__fixture__query"), parameters: schema }]]) {
      owner.setTools(tools);
      assert.ok(owner.definition.description === initial, "catalog changes must not change the provider-facing function definition");
    }
    assert.equal(visits, 0, "registering the active catalog must not eagerly render schemas");
  } finally { await owner.close(); }
});

test("real Codex request prefix stays stable across nested selection and MCP metadata changes", async t => {
  const sent: Array<{ tools: string; instructions: string; cacheKey: string; rawBytes: number; wireBytes: number }> = [];
  const runtime = alphaModelRuntime((_model, context, options) => streamCodex(codexModel, context, {
    ...options, apiKey: codexToken(), transport: "sse", maxRetries: 0,
    fetch: async (_url, init) => {
      assert.ok(typeof init?.body === "string" || init?.body instanceof Uint8Array);
      const wire = typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body);
      const encoding = new Headers(init.headers).get("content-encoding");
      const raw = encoding === "zstd" ? zstdDecompressSync(wire) : encoding === "gzip" ? gunzipSync(wire) : wire;
      const payload = JSON.parse(raw.toString("utf8"));
      sent.push({ tools: JSON.stringify(payload.tools), instructions: payload.instructions, cacheKey: payload.prompt_cache_key,
        rawBytes: raw.byteLength, wireBytes: wire.byteLength });
      return new Response(sseFrames(textEvents()), { headers: { "content-type": "text/event-stream" } });
    },
  }));
  const a = local("alpha"), b = local("beta");
  let bridge: any, api: ExtensionAPI;
  const extension = (pi: ExtensionAPI) => {
    api = pi;
    bridge = new McpBridgeRuntime(pi, "fixture");
    const state = { status: "connected", catalogReady: true, config: { id: "fixture" }, tools: new Map([["query", {}]]), client: { async close() {} } };
    bridge.states.set("fixture", state);
    bridge.registerRemoteTool(state, { name: "query", description: "Initial remote contract", inputSchema: { type: "object" } });
    pi.on("session_shutdown", () => bridge.close());
  };
  const control = { ...local("update_plan"), modelOnly: true, promptSnippet: "Update a plan" };
  const policy = { ...local("policy_probe"), promptGuidelines: ["An authoritative fixture guideline."] };
  const f = await alphaSession({ codemode: true, g2: false, runtime, customTools: [a, b, control, policy], extensions: [extension],
    settings: { compaction: { enabled: false }, retry: { enabled: false } } });
  t.after(() => f.release());
  const probe = async (names: string[]) => {
    f.session.setActiveToolsByName(names);
    const count = sent.length;
    await f.session.prompt("Observe current tools.");
    assert.ok(sent.length > count, `transport not reached: ${f.session.messages.filter(message => message.role === "assistant").at(-1)?.errorMessage}`);
    return sent.at(-1)!;
  };
  const first = await probe(["alpha"]);
  for (const names of [["alpha", "beta"], ["beta", "alpha"], ["alpha", "mcp__fixture__query"], ["mcp__fixture__query", "beta", "alpha"], ["alpha"]]) {
    const next = await probe(names);
    assert.ok(next.tools === first.tools, "actual serialized provider tool definitions changed");
    assert.equal(next.instructions, first.instructions);
    assert.equal(next.cacheKey, first.cacheKey);
    assert.ok(next.rawBytes > 0 && next.wireBytes > 0);
  }
  bridge.registerRemoteTool(bridge.states.get("fixture"), { name: "query", description: "Refreshed remote instructions", inputSchema: { type: "object", properties: { revised: { type: "string" } }, required: ["revised"] } });
  api!.registerTool({ ...b, description: "Replaced local instructions", parameters: Type.Object({ revised: Type.String() }) });
  const refreshed = await probe(["alpha", "beta", "mcp__fixture__query"]);
  assert.equal(refreshed.tools, first.tools);
  assert.equal(refreshed.instructions, first.instructions);
  assert.equal(refreshed.cacheKey, first.cacheKey);
  const direct = await probe(["alpha", "update_plan"]);
  assert.ok(direct.tools !== first.tools, "direct model control schemas must remain visible");
  const guided = await probe(["alpha", "policy_probe"]);
  assert.notEqual(guided.instructions, first.instructions, "authoritative custom guidelines must not be hidden for cache reuse");
  t.diagnostic(JSON.stringify({ requests: sent.length, stableNestedRequests: sent.length - 2, toolsUtf8Bytes: Buffer.byteLength(first.tools),
    requestBytes: sent.map(item => ({ raw: item.rawBytes, compressed: item.wireBytes })) }));
});

test("canonical catalog names resolve alias collisions for documentation and calls", async t => {
  const f = await sessionFixture(t, { g2: false, customTools: [local("foo-bar"), local("foo_bar")] });
  const result = (await f.run(`
const a=ALL_TOOLS.find(tool=>tool.toolName==="foo-bar"), b=ALL_TOOLS.find(tool=>tool.toolName==="foo_bar");
if(!a||!b||a.name===b.name) throw new Error("catalog identity missing");
text(await describeTools([a.toolName,b.toolName]));
await show((await callTool(a.toolName,{})).ref);await show((await callTool(b.toolName,{})).ref);
text((await callTool(a.toolName,{})).content[0].text === "foo-bar" && (await callTool(b.toolName,{})).content[0].text === "foo_bar" ? "CANONICAL_CALLS_OK" : "WRONG_ALIAS");
`)).result;
  assert.equal(result.isError, false, body(result.content));
  assert.match(body(result.content), /Tool: foo-bar/);
  assert.match(body(result.content), /Tool: foo_bar/);
  assert.match(body(result.content), /CANONICAL_CALLS_OK/);
});
