import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { collectStructuredMutationReceipts } from "../packages/extensions/mutation-guard-write/session-evidence.ts";
const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<any>("../packages/extensions/mutation-guard-write/index.ts");
const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: loop } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/index.ts");

async function fixture(t: test.TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "sp-file-batch-"));
  const session = SessionManager.create(cwd, join(cwd, "sessions"));
  const runtime = createExtensionRuntime();
  const extensions = [];
  for (const factory of [mutation, lifecycle, loop]) extensions.push(await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime));
  const runner = new ExtensionRunner(extensions, runtime, cwd, session, {} as never);
  let approvals = 0, decision = "仅允许本次";
  let approvalHook = () => {};
  let recordHook = (_data: any) => {};
  const agent = new Agent({ streamFn: () => { throw new Error("No live model"); },
    beforeToolCall: async ({ toolCall, args }) => { await runner.emit({ type: "turn_start" } as never); return runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never); },
    afterToolCall: ({ toolCall, args, result, isError }) => runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: result.content, details: result.details, isError } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => agent.state.tools.map(t => t.name),
    appendEntry: (kind: string, data: any) => { if (kind === "file-mutation-progress-v2") recordHook(data); session.appendCustomEntry(kind, data); },
  } as never, { getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model, isIdle: () => true, abort: () => agent.abort(), hasPendingMessages: () => false } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; approvalHook(); return decision; } }, "tui");
  await runner.emit({ type: "session_start" } as never);
  agent.state.tools = runner.getAllRegisteredTools().map(r => wrapToolDefinition(r.definition, () => runner.createContext()));
  t.after(async () => { agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, session, runner, agent, approvals: () => approvals, deny() { decision = "拒绝"; }, onApprove(fn: () => void) { approvalHook = fn; }, onRecord(fn: (data: any) => void) { recordHook = fn; },
    async call(name: string, input: any, id = name) {
      session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as never);
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name, arguments: input });
      session.appendMessage(result);
      return result;
    } };
}

test("batch create shares missing parents, records Added and keeps one tool result", async t => {
  const f = await fixture(t);
  const result = await f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "new/deep/a.ts", content: "const a = 1;\n" },
    { operation: "write", mode: "create", path: "new/deep/b.ts", content: "" },
  ] });
  assert.equal(result.isError, false, JSON.stringify(result));
  const details = result.details as any;
  assert.equal(details.succeeded, 2);
  assert.equal(details.items[0].receipt.creation.createdDirectories.length, 2);
  assert.equal(details.items[1].receipt.creation.createdDirectories.length, 0);
  assert.equal(readFileSync(join(f.cwd, "new/deep/b.ts"), "utf8"), "");
  assert.ok(result.content[0].type === "text" && result.content[0].text.includes("Added"));
  assert.equal(f.approvals(), 0);
  assert.equal((f.runner as any).finalAuthorizations?.size ?? 0, 0);
});

test("every item is preflighted before any write, and mode/payload are strict", async t => {
  const f = await fixture(t);
  for (const last of [
    { operation: "write", path: "b", content: "missing mode" },
    { operation: "delete", path: "absent" },
    { operation: "write", mode: "overwrite", path: "absent", content: "no read" },
    { operation: "delete", path: "x", content: "extra" },
  ]) {
    const result = await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "must/not/exist", content: "x" }, last] }, `invalid-${last.operation}-${last.path}-${last.mode}`);
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(f.cwd, "must")), false);
  }
});

test("preview and denied approval leave files/directories untouched and release budgets", async t => {
  const f = await fixture(t);
  const operations = [{ operation: "write", mode: "create", path: "preview/deep/file", content: "hello" }];
  for (let i = 0; i < 28; i++) assert.equal((await f.call("file_batch", { operations, dryRun: true }, `preview-${i}`)).isError, false);
  assert.equal(existsSync(join(f.cwd, "preview")), false);
  await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never); f.deny();
  assert.equal((await f.call("file_batch", { operations })).isError, true);
  assert.equal(existsSync(join(f.cwd, "preview")), false);
  assert.equal((f.runner as any).finalAuthorizations?.size ?? 0, 0);
});

test("independent mixed operations use the existing edit/write cores", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "edit.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(f.cwd, "overwrite.txt"), "before");
  writeFileSync(join(f.cwd, "delete.bin"), Buffer.alloc(256));
  writeFileSync(join(f.cwd, "move.bin"), Buffer.alloc(256, 1));
  await f.call("read", { path: "edit.txt" }, "read-edit");
  await f.call("read", { path: "overwrite.txt" }, "read-write");
  const result = await f.call("file_batch", { operations: [
    { operation: "edit", path: "edit.txt", edits: [{ oldText: "one", newText: "ONE" }, { oldText: "two", newText: "TWO" }] },
    { operation: "write", mode: "overwrite", path: "overwrite.txt", content: "after" },
    { operation: "write", mode: "create", path: "new.txt", content: "new" },
    { operation: "delete", path: "delete.bin" },
    { operation: "move", path: "move.bin", destination: "moved.bin" },
  ] });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal((result.details as any).succeeded, 5);
  assert.equal(readFileSync(join(f.cwd, "edit.txt"), "utf8"), "ONE\r\nTWO\r\n");
  assert.equal(readFileSync(join(f.cwd, "overwrite.txt"), "utf8"), "after");
  assert.equal(existsSync(join(f.cwd, "delete.bin")), false);
  assert.equal(readFileSync(join(f.cwd, "moved.bin")).length, 256);
  assert.equal(f.approvals(), 1, "one high-risk batch approval");
});

test("runtime failure after successful item retains it and stops later items", async t => {
  const f = await fixture(t);
  for (const path of ["a", "b", "c"]) writeFileSync(join(f.cwd, path), path);
  f.onRecord(data => { if (data.phase === "result" && data.itemId === "file_batch:0") writeFileSync(join(f.cwd, "b"), "external-change"); });
  const result = await f.call("file_batch", { operations: ["a", "b", "c"].map(path => ({ operation: "delete", path })) });
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as any).items.map((i: any) => i.status), ["succeeded", "failed_no_change", "not_started"]);
  assert.equal(existsSync(join(f.cwd, "a")), false);
  assert.equal(readFileSync(join(f.cwd, "b"), "utf8"), "external-change");
  assert.equal(readFileSync(join(f.cwd, "c"), "utf8"), "c");
  const receipts = collectStructuredMutationReceipts(SessionManager.open(f.session.getSessionFile()!).getBranch());
  assert.ok(receipts.some((r: any) => r.itemId === "file_batch:0" && r.status === "succeeded"));
});

test("move chains, same paths, hard links and ancestor conflicts fail before execution", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "a"), "a"); linkSync(join(f.cwd, "a"), join(f.cwd, "alias"));
  for (const operations of [
    [{ operation: "move", path: "a", destination: "b" }, { operation: "move", path: "b", destination: "c" }],
    [{ operation: "delete", path: "a" }, { operation: "delete", path: "a" }],
    [{ operation: "delete", path: "a" }, { operation: "delete", path: "alias" }],
    [{ operation: "write", mode: "create", path: "new", content: "file" }, { operation: "write", mode: "create", path: "new/a", content: "child" }],
  ]) {
    assert.equal((await f.call("file_batch", { operations }, `conflict-${JSON.stringify(operations).length}`)).isError, true);
    assert.equal(readFileSync(join(f.cwd, "a"), "utf8"), "a");
    assert.equal(existsSync(join(f.cwd, "new")), false);
  }
});

test("1, 4, 16 file batches execute; file budget and oversized list reject before mutation", async t => {
  const f = await fixture(t);
  for (const count of [1, 4, 16, 17]) {
    const operations = Array.from({ length: count }, (_, i) => ({ operation: "write", mode: "create", path: `n${count}/file${i}`, content: "x" }));
    const result = await f.call("file_batch", { operations }, `count-${count}`);
    assert.equal(result.isError, count > 16, JSON.stringify(result));
    assert.equal(existsSync(join(f.cwd, `n${count}`)), count <= 16);
  }
});
