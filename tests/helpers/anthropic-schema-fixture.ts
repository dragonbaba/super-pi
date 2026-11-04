import type { Context, Model, Tool } from "../../packages/ai/src/types.ts";
import { conservativeModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";

export function schemaModel(inline = false): Model<"anthropic-messages"> {
  return { id: "schema-fixture", name: "Schema fixture", api: "anthropic-messages", provider: "fixture",
    baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    capabilities: { ...conservativeModelCapabilities(1_000_000, 1024), toolCalling: true, strictToolSchema: true, deferredTools: true },
    compat: { supportsStrictTools: true, supportsToolReferences: true,
      supportsMidConvoSystemMessages: inline, supportsMidConvoToolChanges: inline } };
}

export function definitionTool(kind: "$defs" | "definitions" | "both", prefer = false): Tool {
  const definitions = { Entry: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const root = kind === "definitions" ? "definitions" : "$defs";
  return { name: "lookup", description: "Look up fixture entries",
    parameters: { type: "object", properties: {
      entries: { type: "array", items: { $ref: `#/${root}/Entry` } },
      nested: { type: "object", properties: { entry: { $ref: `#/${kind === "both" ? "definitions" : root}/Entry` } } },
    }, required: ["entries"],
    ...(kind !== "definitions" ? { $defs: definitions } : {}),
    ...(kind !== "$defs" ? { definitions } : {}),
    // These root keywords are deliberately outside the compatibility allowlist.
    allOf: [{ type: "object" }], "x-fixture": "not forwarded",
    }, ...(prefer ? { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } } : {}) };
}

export function schemaContext(tools: Tool[]): Context {
  return { messages: [{ role: "user", content: "Use the fixture tools", timestamp: 0 }], tools };
}

export function freezeSchemaInput(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeSchemaInput(child);
  Object.freeze(value);
}

export const schemaResponse = [
  ["message_start", { type: "message_start", message: { id: "fixture", usage: { input_tokens: 1, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
