import assert from "node:assert/strict";
import test from "node:test";
import { stream } from "../../packages/ai/src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../../packages/ai/src/types.ts";
import { definitionTool, freezeSchemaInput, schemaContext, schemaModel, schemaResponse } from "../helpers/anthropic-schema-fixture.ts";

interface WireTool { name: string; input_schema: Record<string, unknown>; strict?: boolean; defer_loading?: boolean }
interface WireBody { tools: WireTool[]; messages: Array<{ role: string; content: Array<{ type: string; tool?: { definition?: WireTool } }> }> }

async function capture(context: Context, model = schemaModel()) {
  const before = structuredClone(context);
  freezeSchemaInput(context);
  let requests = 0, body: WireBody | undefined;
  const events = stream(model, context, { apiKey: "offline-fixture", maxRetries: 0, cacheRetention: "none",
    fetch: async (_url, init) => {
      requests++;
      assert.equal(typeof init?.body, "string");
      body = JSON.parse(init!.body as string) as WireBody;
      return new Response(schemaResponse, { headers: { "content-type": "text/event-stream" } });
    } });
  for await (const _event of events) { /* Drain production events. */ }
  const result = await events.result();
  assert.deepEqual(context, before);
  return { body, requests, result };
}

function assertDefinitions(wire: WireTool, source: Tool): void {
  const schema = source.parameters as { $defs?: unknown; definitions?: unknown; properties?: unknown; required?: unknown };
  for (const key of ["$defs", "definitions", "properties", "required"] as const) assert.deepEqual(wire.input_schema[key], schema[key]);
  assert.equal(wire.input_schema.type, "object");
  assert.equal(wire.input_schema.allOf, undefined);
  assert.equal(wire.input_schema["x-fixture"], undefined);
  assert.equal(wire.strict, undefined);
}

for (const kind of ["$defs", "definitions", "both"] as const) for (const prefer of [false, true]) {
  test(`Anthropic preserves ${kind} references, prefer=${prefer}`, async () => {
    const tool = definitionTool(kind, prefer);
    const { body, requests, result } = await capture(schemaContext([tool]));
    assert.equal(requests, 1);
    assert.equal(result.stopReason, "stop");
    assertDefinitions(body!.tools[0]!, tool);
  });
}

test("Anthropic no-definition and strict schemas keep their established contracts", async () => {
  const plain: Tool = { name: "plain", description: "plain", parameters: { type: "object" } };
  const strict: Tool = { name: "strict", description: "strict", parameters: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"],
  }, constrainedSampling: { type: "json_schema", strict: "require" } };
  const { body, requests, result } = await capture(schemaContext([plain, strict]));
  assert.equal(requests, 1);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(body!.tools[0]!.input_schema, { type: "object", properties: {}, required: [] });
  assert.equal(body!.tools[1]!.strict, true);
  assert.deepEqual(body!.tools[1]!.input_schema, { ...strict.parameters, additionalProperties: false });
});

test("Anthropic required strict references fail before dispatch without relaxing strict", async () => {
  const tool = definitionTool("$defs");
  tool.constrainedSampling = { type: "json_schema", strict: "require" };
  const { requests, result } = await capture(schemaContext([tool]));
  assert.equal(requests, 0);
  assert.equal(result.stopReason, "error");
  assert.ok(result.errorMessage?.includes("requires JSON-schema constrained sampling"));
});

test("Anthropic inline initial and changed definitions remain resolvable", async () => {
  const model: Model<"anthropic-messages"> = schemaModel(true);
  const firstTool = definitionTool("$defs");
  const first = await capture(schemaContext([firstTool]), model);
  assert.equal(first.requests, 1);
  assert.equal(first.result.stopReason, "stop");
  assertDefinitions(first.body!.tools[0]!, firstTool);
  assert.ok(first.result.anthropicContext);
  const changed = definitionTool("definitions");
  const context = schemaContext([changed]);
  context.messages.push(first.result, { role: "user", content: "Continue", timestamp: 2 });
  const second = await capture(context, model);
  assert.equal(second.requests, 1);
  assert.equal(second.result.stopReason, "stop");
  assertDefinitions(second.body!.tools[0]!, firstTool);
  const update = second.body!.messages.flatMap(message => message.content).find(block => block.type === "tool_addition");
  assert.ok(update?.tool?.definition);
  assertDefinitions(update.tool.definition, changed);
});

test("Anthropic deferred tool definitions retain root references", async () => {
  const tool = definitionTool("both");
  const context = schemaContext([{ name: "loader", description: "loader", parameters: { type: "object" } }, tool]);
  context.messages.push({ role: "toolResult", toolCallId: "loaded", toolName: "loader", isError: false,
    content: [{ type: "text", text: "Tool loaded" }], addedToolNames: [tool.name], timestamp: 1 });
  const { body, requests, result } = await capture(context);
  assert.equal(requests, 1);
  assert.equal(result.stopReason, "stop");
  const deferred = body!.tools.find(entry => entry.name === tool.name)!;
  assert.equal(deferred.defer_loading, true);
  assertDefinitions(deferred, tool);
});
