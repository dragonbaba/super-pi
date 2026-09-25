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
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { getEncoding } from "js-tiktoken";
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
  const agent = new Agent({ convertToLlm, streamFn: () => { throw new Error("No live model"); },
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

test("snapshot batch preserves original coordinates across multiple edits and files", async t => {
  const f = await fixture(t); const operations = [];
  for (const path of ["one.txt", "two.txt"]) {
    writeFileSync(join(f.cwd, path), "first\nsecond\nthird\n");
    const read = await f.call("read", { path }, `read-${path}`);
    const content = read.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const snapshotStart = content.indexOf("snapshot=") + 9;
    const snapshot = content.slice(snapshotStart, snapshotStart + 27);
    const rows = content.split("\n");
    const first = rows.find(row => row.startsWith("1#"))!.split("|")[0];
    const third = rows.find(row => row.startsWith("3#"))!.split("|")[0];
    operations.push({ operation: "edit", path, snapshot, edits: [{ kind: "insert_before", start: first, newLines: ["inserted"] }, { kind: "replace", start: third, newLines: ["THIRD"] }] });
  }
  const result = await f.call("file_batch", { operations }); assert.equal(result.isError, false, JSON.stringify({result, operations}));
  for (const path of ["one.txt", "two.txt"]) assert.equal(readFileSync(join(f.cwd, path), "utf8"), "inserted\nfirst\nsecond\nTHIRD\n");
});

test("multi-move uses no-overwrite primitive and counts both ends before changing anything", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) writeFileSync(join(f.cwd, `s${i}`), Buffer.alloc(1024, i));
  const operations = Array.from({ length: 9 }, (_, i) => ({ operation: "move", path: `s${i}`, destination: `d${i}` }));
  assert.equal((await f.call("file_batch", { operations }, "over-budget")).isError, true);
  for (let i = 0; i < 9; i++) { assert.equal(existsSync(join(f.cwd, `s${i}`)), true); assert.equal(existsSync(join(f.cwd, `d${i}`)), false); }
  const result = await f.call("file_batch", { operations: operations.slice(0, 4) }); assert.equal(result.isError, false, JSON.stringify(result));
  for (let i = 0; i < 4; i++) { assert.equal(existsSync(join(f.cwd, `s${i}`)), false); assert.deepEqual(readFileSync(join(f.cwd, `d${i}`)), Buffer.alloc(1024, i)); }
});

test("create target appearing at approval rejects whole batch and shared Chinese parents remain literal", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "remove"), "old");
  f.onApprove(() => writeFileSync(join(f.cwd, "new"), "external"));
  const result = await f.call("file_batch", { operations: [{ operation: "delete", path: "remove" }, { operation: "write", mode: "create", path: "new", content: "forbidden" }] });
  assert.equal(result.isError, true); assert.equal(readFileSync(join(f.cwd, "remove"), "utf8"), "old"); assert.equal(readFileSync(join(f.cwd, "new"), "utf8"), "external");
  f.onApprove(() => {});
  const paths = ["中文 space/New/a", process.platform === "win32" ? "中文 space/new/b" : "中文 space/New/b"];
  const created = await f.call("file_batch", { operations: paths.map(path => ({ operation: "write", mode: "create", path, content: "" })) }, "shared");
  assert.equal(created.isError, false, JSON.stringify(created));
});

test("failed durable result marks unknown, stops following items and never replays on reopen", async t => {
  const f = await fixture(t); let records = 0;
  f.onRecord(data => { if (data.phase === "result") { records++; throw new Error("injected Session append failure"); } });
  const result = await f.call("file_batch", { operations: ["a", "b"].map(path => ({ operation: "write", mode: "create", path: `parents/${path}`, content: path })) });
  assert.equal(result.isError, true); assert.equal((result.details as any).items[0].status, "state_unknown");
  assert.equal((result.details as any).items[1].status, "not_started"); assert.equal(records, 1);
  assert.equal(readFileSync(join(f.cwd, "parents/a"), "utf8"), "a"); assert.equal(existsSync(join(f.cwd, "parents/b")), false);
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  const receipts = collectStructuredMutationReceipts(reopened.getBranch());
  assert.equal(receipts.filter((r: any) => r.itemId === "file_batch:0").length, 1);
  assert.equal((receipts.find((r: any) => r.itemId === "file_batch:0") as any).status, "state_unknown");
  assert.equal(existsSync(join(f.cwd, "parents/b")), false);
});

test("offline task cost includes real Agent requests, schema and cumulative model serialization", async t => {
  const encoding = getEncoding("o200k_base");
  for (const count of [1, 4, 16]) for (const batch of [false, true]) {
    const f = await fixture(t); let requests = 0, inputTokens = 0, outputTokens = 0;
    const schema = JSON.stringify(f.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    const schemaTokens = encoding.encode(schema).length;
    const operations = Array.from({ length: count }, (_, i) => ({ operation: "write", mode: "create", path: `cost/file${i}`, content: `content ${i}\n` }));
    const calls = batch ? [{ type: "toolCall", id: "batch-cost", name: "file_batch", arguments: { operations } }]
      : operations.map((op, i) => ({ type: "toolCall", id: `single-${i}`, name: "write", arguments: { path: op.path, content: op.content } }));
    f.agent.streamFunction = ((_model: any, context: any) => {
      inputTokens += schemaTokens + encoding.encode(JSON.stringify(context.messages)).length;
      const call = calls[requests++];
      const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: call ? "toolUse" : "stop", content: call ? [call] : [] };
      outputTokens += encoding.encode(JSON.stringify(message.content)).length;
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
    }) as any;
    const heapBefore = process.memoryUsage().heapUsed; const cpu = process.cpuUsage(); const start = performance.now();
    await f.agent.prompt("Create the requested synthetic text files."); await f.agent.waitForIdle();
    const elapsedMs = performance.now() - start; const used = process.cpuUsage(cpu);
    const results = f.agent.state.messages.filter(message => message.role === "toolResult");
    assert.equal(results.length, batch ? 1 : count); for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    for (let i = 0; i < count; i++) assert.equal(readFileSync(join(f.cwd, `cost/file${i}`), "utf8"), `content ${i}\n`);
    assert.equal(requests, calls.length + 1); assert.equal(f.agent.state.pendingToolCalls.size, 0);
    t.diagnostic(JSON.stringify({ benchmark: "file-task-offline", count, batch, requests, toolCalls: calls.length, preflightItems: count, approvals: f.approvals(), retries: 0, supplementalReads: 0, schemaTokens, inputTokens, outputTokens, elapsedMs, cpuUs: used.user + used.system, heapDelta: process.memoryUsage().heapUsed - heapBefore, pendingTools: f.agent.state.pendingToolCalls.size }));
  }
});
