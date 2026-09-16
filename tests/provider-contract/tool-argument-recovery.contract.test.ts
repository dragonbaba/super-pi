import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../../packages/agent/src/agent.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import { processResponsesStream } from "../../packages/ai/src/api/openai-responses-shared.ts";
import { hasIncompleteToolArguments } from "../../packages/ai/src/utils/json-parse.ts";

const model: any = { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const parameters = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ start: Type.String() })) });
const valid = '{"path":"fixture.txt","edits":[{"start":"1#1234"}]}';

for (const [name, fragments, finish, expected] of [
 ["truncated object", ['{"path":"fixture.txt"'], "tool_calls", "TOOL_ARGS_INCOMPLETE"],
 ["unfinished string", ['{"path":"secret'], "tool_calls", "TOOL_ARGS_INCOMPLETE"],
 ["empty stream", [""], "tool_calls", "TOOL_ARGS_INCOMPLETE"],
 ["missing path", ['{"edits":[]}'], "tool_calls", "TOOL_ARGS_INVALID"],
 ["nested field", ['{"path":"fixture.txt","edits":[{}]}'], "tool_calls", "TOOL_ARGS_INVALID"],
 ["legal fragments", ['{"pa', 'th":"fixture.txt","edits":[', '{"start":"1#1234"}]}'], "tool_calls", ""],
 ["output limit", ['{"path":"secret'], "length", "TOOL_ARGS_INCOMPLETE"],
 ["complete at limit", [valid], "length", "TOOL_RESPONSE_LIMIT"],
] as const) test(`actual Chat provider → Agent → next request: ${name}`, async () => {
 let requests = 0; const executed: string[] = []; const payloads: any[] = [];
 const fetch: typeof globalThis.fetch = async (_url, init) => {
  payloads.push(JSON.parse(String(init?.body))); requests++;
  const events: any[] = [];
  if (requests === 1) {
   for (let i = 0; i < fragments.length; i++) events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "target", type: "function", function: { name: "edit", arguments: fragments[i] } }] }, finish_reason: null }] });
   // A separate valid sibling must run exactly once on non-truncated responses.
   events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "sibling", type: "function", function: { name: "edit", arguments: valid } }] }, finish_reason: null }] });
  }
  events.push({ choices: [{ index: 0, delta: requests === 1 ? {} : { content: "done" }, finish_reason: requests === 1 ? finish : "stop" }] });
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
 };
 const agent = new Agent({ streamFn: (m, c, o) => streamSimple(m as any, c, { ...o, apiKey: "offline", fetch, maxRetries: 0 }) });
 agent.state.model = model;
 agent.state.tools = [{ name: "edit", label: "edit", description: "fixture", parameters, execute: async id => { executed.push(id); return { content: [{ type: "text", text: "done" }], details: {} }; } }];
 try {
  await agent.prompt("offline"); await agent.waitForIdle();
  const result: any = agent.state.messages.find(m => m.role === "toolResult" && m.toolCallId === "target");
  assert.ok(result, JSON.stringify(agent.state.messages)); const text = result.content[0].text;
  if (expected) { assert.equal(result.isError, true); assert.ok(text.startsWith(`[${expected}]`), text); assert.match(text, /not executed/); assert.equal(executed.includes("target"), false); }
  else { assert.equal(result.isError, false); assert.equal(executed.filter(x => x === "target").length, 1); }
  assert.equal(executed.filter(x => x === "sibling").length, finish === "length" ? 0 : 1);
  if (name === "missing path") assert.match(text, /Supply required fields "path"/);
  if (name === "nested field") assert.match(text, /edits\[0\]\.start/);
  if (finish === "length") assert.match(text, /output token limit.*\nRetry:.*smaller payload/);
  else assert.doesNotMatch(text, /output.*limit/);
  assert.doesNotMatch(text, /secret|received arguments|fixture.txt/);
  assert.equal(requests, 2); assert.ok(JSON.stringify(payloads[1]).includes(expected || "done"));
  assert.equal(agent.state.pendingToolCalls.size, 0);
 } finally { agent.abort(); }
});

for (const finalArgs of ["", "{}", valid]) test(`Responses finalization retains completeness for ${finalArgs || "empty"}`, async () => {
 const output: any = { role: "assistant", content: [], api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 0, stopReason: "stop", usage };
 const item = { type: "function_call", id: "fc", call_id: "target", name: "edit", arguments: finalArgs };
 async function* events() {
  yield { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } };
  if (finalArgs) { yield { type: "response.function_call_arguments.delta", output_index: 0, delta: finalArgs.slice(0, 4) }; yield { type: "response.function_call_arguments.delta", output_index: 0, delta: finalArgs.slice(4) }; }
  yield { type: "response.output_item.done", output_index: 0, item };
  yield { type: "response.completed", response: { id: "response", status: "completed", output: [item] } };
 }
 await processResponsesStream(events() as never, output, { push() {} } as never, { ...model, api: "openai-responses" });
 assert.equal(hasIncompleteToolArguments(output.content[0].arguments), finalArgs === "");
 assert.equal(output.content[0].partialJson, undefined);
});
