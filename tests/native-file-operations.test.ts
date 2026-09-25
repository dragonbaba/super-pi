import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { prepareNativeOperation, executeNativePlan } from "../packages/extensions/mutation-guard-write/native-file-core.ts";
import { collectStructuredMutationReceipts } from "../packages/extensions/mutation-guard-write/session-evidence.ts";
import { addedContentSummary, prepareFileCreation, executeFileCreation } from "../packages/extensions/mutation-guard-write/file-creation.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { classifyPlanModeTool } from "../packages/plan-mode/src/tool-policy.ts";
import ts from "typescript";
import { RELEASE_COMPONENT_RENDER_CACHE } from "@super-pi/tui";
const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<any>("../packages/extensions/mutation-guard-write/index.ts");
const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { MutationWriteGuard } = await jiti.import<any>("../packages/extensions/mutation-guard-write/core.ts");

async function fixture(t: test.TestContext, guard = true) {
  const cwd = mkdtempSync(join(tmpdir(), "sp-native-files-"));
  const session = SessionManager.create(cwd, join(cwd, "sessions"));
  const runtime = createExtensionRuntime();
  const extensions = [];
  for (const factory of guard ? [mutation, lifecycle] : [mutation]) extensions.push(await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime));
  const runner = new ExtensionRunner(extensions, runtime, cwd, session, {} as never);
  let approvals = 0;
  let approveHook = () => {};
  let failResult = false;
  const agent = new Agent({ streamFn: () => { throw new Error("No live model"); },
    beforeToolCall: ({ toolCall, args }) => runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never) });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => agent.state.tools.map(t => t.name),
    appendEntry: (kind: string, data: any) => { if (failResult && data.phase === "result") throw new Error("injected persistence failure"); session.appendCustomEntry(kind, data); },
  } as never, { getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model, isIdle: () => true, abort: () => agent.abort(), hasPendingMessages: () => false } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => { approvals++; approveHook(); return choices[0]; } }, "tui");
  await runner.emit({ type: "session_start" } as never);
  agent.state.tools = runner.getAllRegisteredTools().map(r => wrapToolDefinition(r.definition, () => runner.createContext()));
  t.after(async () => { agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, session, runner, agent, approvals: () => approvals, onApprove(fn: () => void) { approveHook = fn; }, failRecording() { failResult = true; },
    async call(name: string, input: any, id = name) {
      session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as never);
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name, arguments: input });
      session.appendMessage(result);
      return result;
    } };
}

test("native tools through Agent, permission, Session reopen: no read needed for binary move/delete", async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 137);
  writeFileSync(join(f.cwd, "source.bin"), bytes);
  const moved = await f.call("move", { path: "source.bin", destination: "dest.bin" });
  assert.equal(moved.isError, false, JSON.stringify(moved));
  assert.deepEqual(readFileSync(join(f.cwd, "dest.bin")), bytes);
  assert.equal(existsSync(join(f.cwd, "source.bin")), false);
  assert.ok(JSON.stringify(moved).length < 2000);
  const deleted = await f.call("delete", { path: "dest.bin", purpose: "delete synthetic data" });
  assert.equal(deleted.isError, false, JSON.stringify(deleted));
  assert.equal(existsSync(join(f.cwd, "dest.bin")), false);
  assert.equal(f.approvals(), 1);
  const restored = SessionManager.open(f.session.getSessionFile()!);
  const receipts = collectStructuredMutationReceipts(restored.getBranch());
  assert.equal(receipts.length, 2, "custom progress and final result counted once");
  assert.deepEqual(receipts.map((r: any) => r.status), ["succeeded", "succeeded"]);
});

test("missing guard, existing destination, strict fields and non-empty directory fail without mutation", async t => {
  const f = await fixture(t, false);
  writeFileSync(join(f.cwd, "a"), "a");
  assert.equal((await f.call("delete", { path: "a", approved: true })).isError, true);
  assert.equal((await f.call("delete", { path: "a" }, "no-grant")).isError, true);
  assert.equal(readFileSync(join(f.cwd, "a"), "utf8"), "a");
  writeFileSync(join(f.cwd, "b"), "b");
  await assert.rejects(prepareNativeOperation(f.cwd, "move", { path: "a", destination: "b" }), /destination_exists/);
  mkdirSync(join(f.cwd, "nonempty")); writeFileSync(join(f.cwd, "nonempty", "data"), "safe");
  await assert.rejects(prepareNativeOperation(f.cwd, "delete", { path: "nonempty" }), /directory_not_empty/);
});

test("empty directory delete and default no recursive traversal", async t => {
  const f = await fixture(t);
  mkdirSync(join(f.cwd, "empty"));
  assert.equal((await f.call("delete", { path: "empty" })).isError, false);
  assert.equal(existsSync(join(f.cwd, "empty")), false);
});

test("source changed during approval and revoked permission invalidate grants", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "a"), "before");
  f.onApprove(() => writeFileSync(join(f.cwd, "a"), "after"));
  const result = await f.call("delete", { path: "a" });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /STALE_STATE/);
  assert.equal(readFileSync(join(f.cwd, "a"), "utf8"), "after");
  f.onApprove(() => {});
  const input = { path: "a" };
  await f.runner.emitToolCall({ type: "tool_call", toolName: "delete", toolCallId: "stale-permission", input } as never);
  await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never);
  await assert.rejects(f.agent.state.tools.find(t => t.name === "delete")!.execute("stale-permission", input), /Permission authority changed/);
});

test("no-replace race and link/unlink partial completion preserve data", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "a"), "source");
  const plan = await prepareNativeOperation(f.cwd, "move", { path: "a", destination: "b" });
  const result = await executeNativePlan(plan, () => writeFileSync(join(f.cwd, "b"), "competitor"));
  assert.equal(result.status, "failed_no_change");
  assert.equal(readFileSync(join(f.cwd, "b"), "utf8"), "competitor");
  const partialPlan = await prepareNativeOperation(f.cwd, "move", { path: "a", destination: "c" });
  let checks = 0;
  const partial = await executeNativePlan(partialPlan, () => { if (++checks === 2) throw new Error("revoked after link"); });
  assert.equal(partial.status, "partial");
  assert.equal(partial.requiresVerification, true);
  assert.equal(readFileSync(join(f.cwd, "c"), "utf8"), "source");
  assert.equal(readFileSync(join(f.cwd, "a"), "utf8"), "source");
});

test("recording failure after mutation leaves durable intent requiring verification", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "a"), "source"); f.failRecording();
  const result = await f.call("delete", { path: "a" });
  assert.equal((result.details as any).status, "state_unknown");
  assert.equal(existsSync(join(f.cwd, "a")), false);
  const receipts = collectStructuredMutationReceipts(SessionManager.open(f.session.getSessionFile()!).getBranch());
  assert.equal(receipts.length, 1);
  assert.equal((receipts[0] as any).requiresVerification, true);
});

test("prior read mismatch, move budget and cancellation release reservations", async t => {
  const f = await fixture(t); const guard = new MutationWriteGuard();
  writeFileSync(join(f.cwd, "a"), "before");
  await guard.recordCompleteRead(f.cwd, "a", "before", "read", 1);
  writeFileSync(join(f.cwd, "a"), "after");
  const plan = await prepareNativeOperation(f.cwd, "delete", { path: "a" });
  await assert.rejects(guard.assertNativeEvidence(plan.source.canonical), /STALE_STATE/);
  for (let i = 0; i < 8; i++) guard.reserveNativeMutation(2, `a${i}`, `b${i}`);
  assert.throws(() => guard.reserveNativeMutation(2, "overflow"), /MUTATION_BUDGET_EXCEEDED/);
  const signal = AbortSignal.abort();
  assert.equal((await executeNativePlan(plan, () => {}, signal)).status, "cancelled");
  assert.equal(existsSync(join(f.cwd, "a")), true);
});

test("write creates multiple missing parents and emits actual Added and empty-file summaries", async t => {
  const f = await fixture(t);
  const path = "docs/新建 空格/native.md";
  const result = await f.call("write", { path, content: "one\r\ntwo\r\n" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /Added.*\+2 -0/);
  assert.equal((result.details as any).creation.createdDirectories.length, 2);
  assert.equal(readFileSync(join(f.cwd, path), "utf8"), "one\r\ntwo\r\n");
  const empty = await f.call("write", { path: "empty", content: "" }, "empty-write");
  assert.match(JSON.stringify(empty.content), /\+0 -0/);
  assert.equal((empty.details as any).creation.createdDirectories.length, 0);
  assert.deepEqual(addedContentSummary("a\0b"), { bytes: 3 });
  initTheme("dark");
  const definition = f.runner.getAllRegisteredTools().find(r => r.definition.name === "write")!.definition;
  const component = new ToolExecutionComponent("write", "write", { path, content: "one\r\ntwo\r\n" }, {}, definition, { requestRender() {} } as never, f.cwd);
  component.updateResult(result);
  assert.ok(component.render(100).join("\n").includes("Added"));
  component[RELEASE_COMPONENT_RENDER_CACHE]();
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  assert.equal(collectStructuredMutationReceipts(reopened.getBranch()).length, 2);
});

test("Plan blocks native tools even with extension metadata and discovery does not add aliases", async t => {
  const f = await fixture(t);
  for (const name of ["delete", "move"]) assert.equal(classifyPlanModeTool({ name, sourceInfo: { source: "extension" } } as never), "blocked");
  const names = f.agent.state.tools.map(t => t.name);
  assert.equal(names.filter(n => n === "write").length, 1);
  assert.equal(names.filter(n => n === "edit").length, 1);
  assert.equal(names.includes("create"), false);
  const packages = JSON.parse(readFileSync("packages/extensions/package.json", "utf8"));
  assert.ok(packages.pi.extensions.includes("./mutation-guard-write/index.ts"));
  assert.ok(packages.pi.extensions.includes("./resource-lifecycle-guard/index.ts"));
});

test("parent replacement and junction targets refuse without deleting linked data", async t => {
  const f = await fixture(t);
  mkdirSync(join(f.cwd, "parent")); writeFileSync(join(f.cwd, "parent", "a"), "original");
  const plan = await prepareNativeOperation(f.cwd, "delete", { path: "parent/a" });
  renameSync(join(f.cwd, "parent"), join(f.cwd, "original-parent"));
  mkdirSync(join(f.cwd, "parent")); writeFileSync(join(f.cwd, "parent", "a"), "replacement");
  assert.equal((await executeNativePlan(plan, () => {})).status, "failed_no_change");
  symlinkSync(join(f.cwd, "original-parent"), join(f.cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareNativeOperation(f.cwd, "delete", { path: "linked" }), /unsupported/);
  assert.equal(readFileSync(join(f.cwd, "original-parent", "a"), "utf8"), "original");
});

test("native render and Added scan contain no per-render callbacks, arrays, promises or regex creation", () => {
  for (const [path, functionName] of [
    ["packages/extensions/mutation-guard-write/native-tools.ts", "renderFileMutationResult"],
    ["packages/extensions/mutation-guard-write/file-creation.ts", "addedContentSummary"],
  ]) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    let found = 0;
    function inspect(node: ts.Node) {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node) || ts.isRegularExpressionLiteral(node), false);
      if (ts.isNewExpression(node)) assert.equal(["Promise", "AbortController", "Map", "Set", "RegExp"].includes(node.expression.getText(source)), false);
      ts.forEachChild(node, inspect);
    }
    function find(node: ts.Node) {
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === functionName) { found++; inspect(node.body!); }
      else ts.forEachChild(node, find);
    }
    find(source); assert.equal(found, 1);
  }
});

test("create-only preflight is side-effect free and rejects existing targets and parent files", async t => {
  const f = await fixture(t);
  const target = join(f.cwd, "new", "deep", "file");
  const plan = await prepareFileCreation(target, true);
  assert.equal(plan!.directories.length, 2);
  assert.equal(existsSync(join(f.cwd, "new")), false);
  writeFileSync(join(f.cwd, "parent-file"), "data");
  await assert.rejects(prepareFileCreation(join(f.cwd, "parent-file", "child"), true));
  await assert.rejects(prepareFileCreation(join(f.cwd, "parent-file"), true), /TARGET_APPEARED/);
});

test("create target appears after approval: conflict, never converts to overwrite", async t => {
  const f = await fixture(t);
  await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never);
  f.onApprove(() => writeFileSync(join(f.cwd, "new-file"), "competitor"));
  const result = await f.call("write", { path: "new-file", content: "requested" });
  assert.equal(result.isError, true);
  assert.equal(readFileSync(join(f.cwd, "new-file"), "utf8"), "competitor");
});

test("cancel after mkdir cleans only owned empty directories; concurrent content is retained", async t => {
  const f = await fixture(t);
  const target = join(f.cwd, "new", "deep", "file");
  const plan = (await prepareFileCreation(target, true))!;
  const abort = new AbortController();
  await assert.rejects(executeFileCreation(plan, "data", async () => plan.canonicalTarget, abort.signal, () => abort.abort()), /cancelled/);
  assert.equal(existsSync(join(f.cwd, "new")), false);
  const second = (await prepareFileCreation(target, true))!;
  const otherAbort = new AbortController();
  await assert.rejects(executeFileCreation(second, "data", async () => second.canonicalTarget, otherAbort.signal, () => {
    writeFileSync(join(f.cwd, "new", "deep", "other"), "concurrent"); otherAbort.abort();
  }), /PARTIAL_MUTATION/);
  assert.equal(readFileSync(join(f.cwd, "new", "deep", "other"), "utf8"), "concurrent");
  assert.equal(existsSync(target), false);
});
