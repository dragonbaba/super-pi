import assert from "node:assert/strict";
import test from "node:test";
import type { Message, Model } from "../../packages/ai/src/types.ts";
import { estimateContextTokensFromParts, estimateMessageTokens } from "../../packages/ai/src/utils/estimate.ts";
import { createToolResultPresentationOwner, type ToolResultPresentationContent } from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";
import { ALPHA_MODEL } from "../helpers/alpha-session.ts";
import { assistant, body, longText, sessionFixture, toolResult } from "./fixture.ts";

// These acceptance tests intentionally fail on b44dc096. They are run explicitly by
// test:codemode-recovery; rename/promote fixed cases into the ordinary suite in R1.
for (const [name, contextWindow, reportedTokens] of [
  ["spark first tool result", 128000, 0], ["272k context with 144k used", 272000, 144000],
] as const) {
  test(`F-B3/B4 ${name}: SDK prepares the next request without replay`, async t => {
    const f = await sessionFixture(t);
    const model = { ...ALPHA_MODEL, api: "openai-codex-responses", provider: "openai-codex",
      id: "r0-codex", contextWindow, maxTokens: 128000 } as Model<"openai-codex-responses">;
    const messages = [assistant(["completed"], reportedTokens), toolResult("completed", [{ type: "text", text: "completed once" }])];
    // Use SDK conversion, so changing the production API's planning policy fixes this test.
    const projected = await f.session.agent.convertToLlm(messages, undefined, undefined, model);
    assert.equal(projected.length, messages.length);
    assert.match(body(projected[1]!.content as never), /completed once/);
    assert.equal(f.session.messages.filter(m => m.role === "toolResult").length, 0, "conversion must not execute tools");
  });
}

const readMetadata = { type: "text", readBoundary: "metadata", text:
  "[Snapshot edit] snapshot=snap_0000000000000000000000; editable lines=1-1. Use this snapshot and its LINE#ID anchors together." } as const;
const longLine: ToolResultPresentationContent[] = [
  { type: "text", readBoundary: "lines", text: `1#1234|${"x".repeat(12000)}\n` }, readMetadata,
];

for (const count of [8, 20]) {
  test(`F-B8 ${count} parent results: both orders fit the same 1024 budget`, () => {
    const outcomes: { first: boolean; error?: string; tokens?: number }[] = [];
    for (const first of [true, false]) {
      const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, `order-${count}`)!;
      try {
        const ids = Array.from({ length: count }, (_, i) => `call-${i}`);
        const content = count === 8 ? longLine : [{ type: "text" as const, text: longText }];
        const messages = [assistant(ids), ...ids.map((id, i) => toolResult(id,
          (first ? i === 0 : i === count - 1) ? content : [{ type: "text", text: "ok" }]))];
        const projected = owner.projectMessagesForModel(messages, undefined, undefined, undefined, 128000, 4096);
        const tokens = projected.slice(1).reduce((sum, m) => sum + estimateToolOutputTokens(m.content as never).estimatedTokens, 0);
        outcomes.push({ first, tokens });
      } catch (error) { outcomes.push({ first, error: (error as Error).message }); }
      finally { owner.dispose(); }
    }
    assert.ok(outcomes.every(o => !o.error && o.tokens! <= 1024), JSON.stringify(outcomes));
  });
}

test("F-B9 historical expansion must be stable or included in context accounting", () => {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "history")!;
  try {
    const ids = Array.from({ length: 8 }, (_, i) => `old-${i}`);
    const original = [assistant(ids), ...ids.map(id => toolResult(id, [{ type: "text", text: longText }]))];
    const first = owner.projectMessagesForModel(original.slice(), undefined, undefined, undefined, 128000, 4096, true);
    const suffix = [assistant(["new"], 10000, 3), toolResult("new", [{ type: "text", text: "ok" }], 4)];
    const before = [...first, ...suffix];
    const after = owner.projectMessagesForModel([...original, ...suffix], undefined, undefined, undefined, 128000, 4096, true);
    const historySize = (messages: Message[]) => messages.slice(1, 9).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const growth = historySize(after) - historySize(before);
    const estimateBefore = estimateContextTokensFromParts(undefined, before, undefined).tokens;
    const estimateAfter = estimateContextTokensFromParts(undefined, after, undefined).tokens;
    assert.ok(growth <= 0 || estimateAfter - estimateBefore >= growth,
      JSON.stringify({ growth, estimateBefore, estimateAfter, before: historySize(before), after: historySize(after) }));
  } finally { owner.dispose(); }
});

test("control: a genuinely insufficient result budget is not silently bypassed", () => {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1 }, "insufficient")!;
  try {
    assert.throws(() => owner.projectMessagesForModel([assistant(["one"]), toolResult("one", [{ type: "text", text: longText }])],
      undefined, undefined, undefined, 128000, 4096), (error: unknown) => (error as { code: string }).code === "budget-too-small");
  } finally { owner.dispose(); }
});

test("control: ordinary bounded text is recoverable exactly without replay", () => {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "ordinary-text")!;
  try {
    const source = toolResult("source", [{ type: "text", text: longText }]);
    const p = owner.create(source.content, "source")!; owner.release();
    assert.equal(p.version, 2); if (p.version !== 2) return;
    let cursor: string | undefined = p.continuation.cursor, restored = "", count = 0;
    while (cursor) {
      assert.ok(++count < 100);
      const chunk = owner.readContinuation(cursor, [source], 1024);
      assert.ok(chunk.estimatedTokens <= 1024); assert.notEqual(chunk.nextCursor, cursor);
      restored += chunk.content.filter(b => b.type === "text").map(b => b.text).join(""); cursor = chunk.nextCursor;
    }
    const index = p.truncation.noticeBlockIndex;
    const text = (blocks: readonly { type: string; text?: string }[]) => blocks.filter(b => b.type === "text").map(b => b.text).join("");
    assert.equal(text(p.modelContent.slice(0, index)) + restored + text(p.modelContent.slice(index + 1)), longText);
  } finally { owner.dispose(); }
});

test("F-B11 a long source line can be recovered exactly through bounded historical chunks", () => {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "long-line")!;
  try {
    const source = toolResult("read", longLine);
    const p = owner.create(source.content, "read")!; owner.release();
    assert.equal(p.version, 2); if (p.version !== 2) return;
    const recovered: ToolResultPresentationContent[] = [];
    const seen = new Set<string>(); let cursor: string | undefined = p.continuation.cursor;
    while (cursor) {
      assert.ok(!seen.has(cursor) && seen.size < 100, "recovery must make bounded forward progress"); seen.add(cursor);
      const chunk = owner.readContinuation(cursor, [source], 1024);
      assert.ok(chunk.estimatedTokens <= 1024);
      assert.equal(chunk.content.some(b => "readBoundary" in b), false, "historical chunks do not grant edit authority");
      recovered.push(...chunk.content); cursor = chunk.nextCursor;
    }
    const index = p.truncation.noticeBlockIndex;
    const text = (blocks: readonly { type: string; text?: string }[]) => blocks.filter(b => b.type === "text").map(b => b.text).join("");
    assert.equal(text([...p.modelContent.slice(0, index), ...recovered, ...p.modelContent.slice(index + 1)]), text(source.content));
  } finally { owner.dispose(); }
});

test("F-B12 session recovery still works after the source is compacted out of model context", async t => {
  const f = await sessionFixture(t);
  f.sessionManager.appendMessage(assistant(["saved"]));
  f.sessionManager.appendMessage(toolResult("saved", [{ type: "text", text: longText }]));
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  const projected = await f.session.agent.convertToLlm(f.session.messages, undefined, undefined, ALPHA_MODEL);
  const cursor = body(projected[1]!.content as never).match(/cursor (tr1\.[^.]+(?:\.[^\s.]+)+)\./)?.[1];
  assert.ok(cursor, "fixture must produce a real model-visible recovery cursor");
  const expected = f.session.readToolResultContinuation(cursor, 1024);
  const keep = f.sessionManager.appendMessage({ role: "user", content: "retained turn", timestamp: 3 });
  f.sessionManager.appendCompaction("earlier result summarized", keep, 5000);
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  assert.ok(f.sessionManager.getEntries().some(e => e.type === "message" && e.message.role === "toolResult"));
  assert.ok(!f.session.messages.some(m => m.role === "toolResult"));
  // Compaction clears resident projection records. Public idle reconfiguration
  // also removes that cache, preventing a cached source from hiding a missing persistent lookup.
  f.session.configureToolResultBudget({ enabled: true, budgetTokens: 1024 });
  const chunk = f.session.readToolResultContinuation(cursor, 1024);
  assert.deepEqual(chunk, expected, "recover the original content, not a replacement notice or the compaction summary");
});

test("F-B10 the model has a callable route for the recovery cursor it receives", async t => {
  let executions = 0;
  const f = await sessionFixture(t, { customTools: [{ name: "large_probe", label: "large", description: "offline fixture",
    parameters: { type: "object", properties: {} }, execute: async () => {
      executions++; return { content: [{ type: "text", text: longText }], details: {} };
    } }] });
  const { requests } = await f.run('await show((await tools.large_probe({})).ref);');
  const result = requests.at(-1)?.find(m => m.role === "toolResult");
  assert.ok(result && /tr1\./.test(body(result.content as never)), "fixture must deliver a truncated model result");
  const cursor = body(result.content as never).match(/cursor (tr1\.[^.]+(?:\.[^\s.]+)+)\./)?.[1];
  assert.ok(cursor);
  const recovery = f.session.getAllTools().find(tool => tool.available &&
    (tool.parameters as { properties?: Record<string, unknown> }).properties?.cursor &&
    /tr1\./.test(`${tool.description} ${JSON.stringify(tool.parameters)}`));
  assert.ok(recovery, "no advertised model tool accepts the tr1 recovery cursor (a mention in codemode's code description is not an API)");
  const expected = body(f.session.readToolResultContinuation(cursor, 512).content).match(/ROW_\d+/)?.[0];
  assert.ok(expected && !body(result.content as never).includes(expected), "the oracle must identify previously omitted text");
  const recovered = await f.run(`await show((await callTool(${JSON.stringify(recovery.name)}, ${JSON.stringify({ cursor })})).ref);`);
  assert.equal(recovered.result.isError, false);
  assert.ok(body(recovered.requests.at(-1)!.filter(m => m.role === "toolResult").at(-1)!.content as never).includes(expected));
  assert.equal(executions, 1, "recovering a saved result must not replay the original tool");
});

test("F-B13 D1: two affordable child results remain visible in one CodeMode script", async t => {
  let executions = 0;
  const payload = (id: string) => `${id}_BEGIN\n${Array.from({ length: 45 }, (_, i) => `${id}_${i}: meaningful source line`).join("\n")}\n${id}_END`;
  const f = await sessionFixture(t, { customTools: [{ name: "read_probe", label: "read probe", description: "offline fixture",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (_id: string, args: { id: string }) => { executions++; return { content: [{ type: "text", text: payload(args.id) }], details: {} }; } }] });
  for (const id of ["ONE", "TWO"]) assert.ok(estimateToolOutputTokens([{ type: "text", text: payload(id) }]).estimatedTokens < 1024);
  const { result, requests } = await f.run('await show((await tools.read_probe({id:"ONE"})).ref); await show((await tools.read_probe({id:"TWO"})).ref);');
  assert.equal(executions, 2); assert.equal(result.isError, false);
  const visible = body(requests.at(-1)!.find(m => m.role === "toolResult")!.content as never);
  for (const id of ["ONE", "TWO"]) assert.ok(visible.includes(payload(id)), `${id} was cut although each child fits its configured budget`);
});
