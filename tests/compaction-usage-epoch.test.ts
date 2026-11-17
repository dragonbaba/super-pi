import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
import { compactionEpochFixture, epochAssistant } from "./helpers/compaction-epoch-fixture.ts";

test("retained pre-checkpoint usage stays unverified until a current-epoch response", async t => {
  const f = await compactionEpochFixture(); t.after(() => f.release());
  const before = f.session.getContextUsage()!;
  assert.equal(before.source, "materialized");
  assert.equal(before.epochVerified, false);
  assert.ok(before.tokens !== null && before.tokens < 19708);
  const current = epochAssistant(512307, 2);
  f.sessionManager.appendMessage(current);
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  const after = f.session.getContextUsage()!;
  assert.equal(after.source, "provider");
  assert.equal(after.epochVerified, true);
  assert.equal(after.tokens, 512307);
  await f.session.reload();
  assert.equal(f.session.getContextUsage()!.tokens, 512307, "reload revalidates persisted current-epoch usage");
  const latest = f.sessionManager.getBranch().find(entry => entry.type === "compaction")!;
  await f.session.navigateTree(latest.id);
  assert.equal(f.session.getContextUsage()!.source, "materialized");
  assert.equal(f.session.getContextUsage()!.epochVerified, false);
});

test("disabled automatic compaction remains disabled after a local budget block", async t => {
  const f = await compactionEpochFixture({ settings: { compaction: { enabled: false } } }); t.after(() => f.release());
  f.sessionManager.appendMessage(epochAssistant(512307, Date.now() + 1000));
  const blocked = epochAssistant(0, Date.now() + 2000);
  blocked.stopReason = "error"; blocked.errorMessage = "Request preparation blocked: context-headroom fixture";
  f.sessionManager.appendMessage(blocked);
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  assert.equal(f.session.getContextUsage()!.epochVerified, true);
  assert.equal(await (f.session as any)._checkCompaction(blocked, false), false);
});

test("current-epoch usage compacts between real tool turns without replay", async t => {
  let summaries = 0, effects = 0, requests = 0;
  const f = await compactionEpochFixture({ customTools: [{ name: "probe", label: "Probe", description: "Isolated completion probe",
    parameters: Type.Object({}), execute: async () => { effects++; return { content: [{ type: "text", text: "completed once" }], details: {} }; } }],
    extensions: [(pi: ExtensionAPI) => { pi.on("session_before_compact", event => {
      summaries++; return { compaction: { summary: "new checkpoint", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore } };
    }); }] });
  t.after(() => f.release());
  f.session.agent.streamFunction = (_model, context) => {
    const first = requests++ === 0;
    if (!first) {
      assert.equal(summaries, 1, "threshold compaction must precede the next request");
      assert.match(JSON.stringify(context.messages), /new checkpoint/);
    }
    const message = epochAssistant(first ? 512307 : 1024, Date.now() + 1000);
    message.content = first ? [{ type: "toolCall", id: "current-call", name: "codemode", arguments: { code: "await tools.probe({});" } }]
      : [{ type: "text", text: "finished" }];
    message.stopReason = first ? "toolUse" : "stop";
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  };
  await f.session.prompt("Run the isolated completion probe.");
  assert.equal(effects, 1); assert.equal(requests, 2); assert.equal(summaries, 1);
  assert.equal(f.session.getContextUsage()!.epochVerified, true);
});

test("local preparation failure stops its run but a new prompt can use enabled threshold compaction", async t => {
  let summaries = 0;
  const f = await compactionEpochFixture({ extensions: [(pi: ExtensionAPI) => {
    pi.on("session_before_compact", event => {
      summaries++; return { compaction: { summary: "explicit prompt checkpoint", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore } };
    });
  }] });
  t.after(() => f.release());
  const current = epochAssistant(512307, 2);
  f.sessionManager.appendMessage(current);
  const blocked = epochAssistant(0, 3);
  blocked.stopReason = "error"; blocked.errorMessage = "Request preparation blocked: context-headroom synthetic fixture";
  f.sessionManager.appendMessage(blocked);
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  assert.equal(await (f.session as any)._checkCompaction(blocked), false);
  assert.equal(summaries, 0, "local failure cannot authorize paid same-run recovery");
  let requests = 0;
  f.session.agent.streamFunction = (_model, context) => {
    requests++;
    assert.equal(summaries, 1);
    assert.match(JSON.stringify(context.messages), /explicit prompt checkpoint/);
    const message = epochAssistant(1024, Date.now() + 3000);
    const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); return stream;
  };
  await f.session.prompt("Continue after the local preparation block.");
  assert.equal(summaries, 1);
  assert.equal(requests, 1);
  assert.equal(f.session.getContextUsage()!.tokens, 1024);
});

test("wrong-model, failed and uncommitted usage cannot trigger threshold compaction", async t => {
  const f = await compactionEpochFixture(); t.after(() => f.release());
  for (const kind of ["wrong-model", "wrong-provider", "wrong-api", "error", "aborted"] as const) {
    const message = epochAssistant(512307, Date.now() + 1000);
    if (kind === "wrong-model") message.model = "other-model";
    else if (kind === "wrong-provider") message.provider = "other-provider";
    else if (kind === "wrong-api") message.api = "openai-completions";
    else message.stopReason = kind;
    f.sessionManager.appendMessage(message);
  }
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  assert.equal(f.session.getContextUsage()!.epochVerified, false);
  const current = epochAssistant(512307, Date.now() + 2000);
  f.sessionManager.appendMessage(current);
  f.sessionManager.appendCustomEntry("compaction-usage-ledger-v2", { schemaVersion: 2, component: "remote_compaction",
    status: "provider_completed", model: `${current.provider}/${current.model}`, operationId: "uncommitted-fixture" });
  f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
  assert.equal(f.session.getContextUsage()!.automaticCompactionBlocked, "paid-boundary-uncommitted");
  assert.equal(await (f.session as any)._checkCompaction(current), false);
});
