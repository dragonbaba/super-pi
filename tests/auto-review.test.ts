import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AutoReviewBreaker, autoReviewTranscript, parseAutoReviewVerdict } from "../packages/coding-agent/src/core/auto-review.ts";

test("auto review verdicts, breaker and trimmed transcript", () => {
  assert.deepEqual(parseAutoReviewVerdict("APPROVE: runs the tests the user asked for"), { approved: true, reason: "runs the tests the user asked for" });
  assert.deepEqual(parseAutoReviewVerdict("\n deny - deletes files\nmore"), { approved: false, reason: "deletes files" });
  assert.equal(parseAutoReviewVerdict("I think this is fine"), undefined);

  // Three consecutive rejections trip; an approval in between resets the run.
  const consecutive = new AutoReviewBreaker();
  assert.deepEqual([false, false, true, false, false].map(approved => consecutive.record(approved)), [false, false, false, false, false]);
  assert.equal(consecutive.record(false), true); assert.equal(consecutive.tripped, true);
  // Ten rejections in the last fifty trip without any run of three.
  const windowed = new AutoReviewBreaker();
  let trippedAt = -1;
  for (let index = 0; index < 40 && trippedAt < 0; index++) if (windowed.record(index % 2 === 1)) trippedAt = index;
  assert.equal(trippedAt, 18, "the tenth rejection");

  const manager = SessionManager.inMemory(os.tmpdir());
  manager.appendMessage({ role: "user", content: "run the tests", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "hidden plan" }, { type: "text", text: "Running them." },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], api: "x", provider: "x", model: "x",
    usage: {} as any, stopReason: "toolUse", timestamp: 2 } as any);
  const transcript = autoReviewTranscript(manager);
  assert.equal(transcript, "[user] run the tests\n\n[assistant] Running them.\n[tool call: bash]");
});

async function fixture(t: TestContext, mode: "host-auto" | "host-restricted", answers: string[], config = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-review-")));
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-review-outside-")));
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(root);
  runtime.appendEntry = (customType, data) => { manager.appendCustomEntry(customType, data); };
  const requests: string[] = [], dialogs: string[] = [], notes: string[] = [], statuses: (string | undefined)[] = [];
  runtime.withSupplementalSummary = (async (_signal: AbortSignal, run: (stream: any) => Promise<unknown>) => run(async (_model: unknown, context: any) => {
    requests.push(context.messages[0].content);
    const text = answers.length ? answers.shift()! : "APPROVE: ok";
    return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text }] }) };
  })) as any;
  const ctx: any = { cwd: root, hasUI: true, signal: new AbortController().signal, sessionManager: manager,
    model: { provider: "test", id: "reviewer", api: "test", maxTokens: 1000 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
    ui: { select: async (title: string) => { dialogs.push(title); return undefined; }, notify: (message: string) => { notes.push(message); },
      setStatus: (_key: string, text: string | undefined) => { statuses.push(text); } } };
  const owner = new SessionExecutionPolicy(runtime, "trusted-host", config, mode);
  t.after(async () => {
    owner.dispose(); await runtime.executionBoundary.dispose();
    await fs.rm(root, { recursive: true }); await fs.rm(outside, { recursive: true });
  });
  async function decide(name: string, input: object): Promise<string> {
    try { (await owner.authorize({ type: "tool_call", toolName: name, input, toolCallId: "c" } as any, ctx, { name } as any)).release(); return "allow"; }
    catch (error: any) { return /AUTO_REVIEW_DENIED/.test(error.message) ? "denied" : /APPROVAL_CANCELLED/.test(error.message) ? "asked" : error.message; }
  }
  return { root, outside, requests, dialogs, notes, statuses, decide };
}

test("host-auto reviews only what would ask; rule asks, outside deletes and a tripped breaker go back to the user", async t => {
  const f = await fixture(t, "host-auto", ["APPROVE: the user asked for tests", "DENY: pushes without being asked"],
    { rules: [{ tool: "bash", command: "git push --force", decision: "ask" }] });
  // Read-only and in-workspace file commands never ask, so they are never reviewed.
  assert.equal(await f.decide("bash", { command: "git status" }), "allow");
  assert.equal(f.requests.length, 0);
  assert.equal(await f.decide("bash", { command: "npm test" }), "allow");
  assert.equal(f.requests.length, 1); assert.match(f.requests[0]!, /"command": "npm test"/); assert.match(f.requests[0]!, /<transcript>/);
  assert.equal(await f.decide("bash", { command: "git push" }), "denied");
  assert.equal(f.dialogs.length, 0);
  assert.match(f.notes.join("\n"), /Auto 审查批准：bash — the user asked for tests/);

  // The user's own ask rule and a delete outside the workspaces are never answered by the reviewer.
  assert.equal(await f.decide("bash", { command: "git push --force" }), "asked");
  await fs.writeFile(path.join(f.outside, "b.txt"), "b");
  assert.equal(await f.decide("bash", { command: `rm ${path.join(f.outside, "b.txt").replaceAll("\\", "/")}` }), "asked");
  assert.equal(f.requests.length, 2); assert.equal(f.dialogs.length, 2);

  // Unparseable answers are rejections; with the earlier one, the third in a row trips the breaker.
  f.requests.length = 0;
  const g = await fixture(t, "host-auto", ["maybe", "DENY: no", "DENY: no"]);
  for (let index = 0; index < 3; index++) assert.equal(await g.decide("bash", { command: "npm install" }), "denied");
  assert.deepEqual(g.statuses, ["宿主机受限 · Auto 已暂停（改为询问）"]);
  assert.equal(await g.decide("bash", { command: "npm install" }), "asked");
  assert.equal(g.requests.length, 3);

  // host-restricted itself never calls the reviewer.
  const h = await fixture(t, "host-restricted", []);
  assert.equal(await h.decide("bash", { command: "npm test" }), "asked");
  assert.equal(h.requests.length, 0);
});
