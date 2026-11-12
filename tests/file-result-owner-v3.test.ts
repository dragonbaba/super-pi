import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { FileResultWriter } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { mutationRequestHash, nativeItemRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";

async function fixture(t: any, deny = false) {
  const runtime = createExtensionRuntime(), session = SessionManager.inMemory(), owner = new SessionFiles(runtime, createEventBus());
  runtime.appendFileEntry = (kind, data) => session.appendCustomEntry(kind, data);
  const definitions: any = {}; owner.installResultTool(definitions);
  const policy = new SessionExecutionPolicy(runtime, "sandbox", deny ? { rules: [{ tool: "file_result", decision: "deny" }] } : {}, "read-only");
  policy.registerDefinition(definitions.file_result);
  const ctx: any = { cwd: process.cwd(), sessionManager: session, hasUI: false, ui: {} };
  const input = { paths: ["a", "b"] };
  const callEntryId = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", name: "delete", id: "mutation", arguments: input }], timestamp: 0 } as any);
  const writer = new FileResultWriter({ callEntryId, operation: "delete", toolCallId: "mutation", requestHash: mutationRequestHash("delete", input), itemCount: 2 }, owner.appendFileEntry, session);
  const ids = [];
  for (let index = 0; index < 2; index++) ids.push(writer.prepare(index, { operation: "delete", target: resolve(input.paths[index]), inputHash: nativeItemRequestHash("delete", input, index) }));
  writer.ready();
  for (let index = 0; index < 2; index++) { writer.intent(index, ids[index]); writer.result(index, { operation: "delete", target: resolve(input.paths[index]), status: "succeeded", stateChanged: true }); }
  const ref = writer.finish();
  t.after(async () => { writer.dispose(); policy.dispose(); await owner.dispose(); await runtime.executionBoundary.dispose(); });
  return { owner, policy, session, ctx, ref, definition: definitions.file_result };
}
test("sandbox file_result reads the current journal without file service revisions or backend grants", async t => {
  const f = await fixture(t), input = { ref: f.ref, limit: 1 };
  const authorization = await f.policy.authorize({ type: "tool_call", toolName: "file_result", toolCallId: "query", input } as any, f.ctx, f.definition);
  authorization.consume(input, "query", "file_result"); authorization.release();
  const result = await f.definition.execute("query", input, undefined, undefined, f.ctx);
  assert.equal(result.details.records.length, 1); assert(result.details.nextCursor);
  assert.equal(f.owner.getDiagnostics().revisions, 0); assert.equal(f.owner.getDiagnostics().pending, 0);
  assert.equal(f.session.getSessionFile(), undefined);
  await assert.rejects(f.definition.execute("query", { ref: "C:/arbitrary/host/path" }, undefined, undefined, f.ctx), /Expected a session resultRef/);
});
test("metadata queries still obey explicit tool denials in sandbox read-only mode", async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.policy.authorize({ type: "tool_call", toolName: "file_result", toolCallId: "query", input: { ref: f.ref } } as any, f.ctx, f.definition), /Explicitly denied/);
});
test("session owner disposal refuses further queries and releases reader references", async t => {
  const f = await fixture(t);
  await f.definition.execute("query", { ref: f.ref }, undefined, undefined, f.ctx);
  await f.owner.dispose();
  await assert.rejects(f.definition.execute("query", { ref: f.ref }, undefined, undefined, f.ctx), /STALE_STATE/);
  assert.equal(f.owner.getDiagnostics().closed, true); assert.equal(f.owner.getDiagnostics().pending, 0);
});
test("a lifecycle reset invalidates prior cursors while permitting a fresh branch-bound query", async t => {
  const f = await fixture(t), first = await f.definition.execute("query", { ref: f.ref, limit: 1 }, undefined, undefined, f.ctx);
  await f.owner.emit({ type: "session_before_tree" });
  await assert.rejects(f.definition.execute("query", { ref: f.ref, cursor: first.details.nextCursor }, undefined, undefined, f.ctx), /CURSOR/);
  const reopened = await f.definition.execute("query", { ref: f.ref }, undefined, undefined, f.ctx);
  assert.equal(reopened.details.callComplete, true); assert.equal(f.owner.getDiagnostics().revisions, 0);
});
