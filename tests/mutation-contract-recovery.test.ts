import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { getEncoding } from "js-tiktoken";
const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<any>("../packages/extensions/mutation-guard-write/index.ts");
const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: loop } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
const { assertNoNewSyntaxDiagnostics } = await jiti.import<any>("../packages/extensions/mutation-guard-write/snapshot-syntax-guard.ts");
const { failureRecoveryHint, callKey } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/core.ts");
const { createToolResultPresentationOwner } = await jiti.import<any>("../packages/coding-agent/src/core/tool-result-presentation.ts");
const { executeSnapshotLineEdit } = await jiti.import<any>("../packages/extensions/mutation-guard-write/snapshot-line-edit.ts");
const { AgentSession } = await jiti.import<any>("../packages/coding-agent/src/core/agent-session.ts");
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const snapshot = (r: any) => { const match = /snapshot=(snap_[\w-]+)/.exec(text(r)); assert.ok(match, text(r)); return match[1]; };
const anchor = (r: any, line: number) => new RegExp(`(?:^|\\n)(${line}#[A-F0-9]{4})\\|`).exec(text(r))![1];
const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });

async function fixture(t: test.TestContext, project = false) {
 const cwd = mkdtempSync(join(tmpdir(), "pi-mutation-recovery-"));
 t.after(() => rmSync(cwd, { recursive: true }));
 const runtime = createExtensionRuntime();
 const extensions = [];
 const advisories: any[] = [];
 for (const factory of [mutation, lifecycle, loop]) extensions.push(await loadExtensionFromFactory(pi => {
  pi.appendEntry = () => {}; pi.sendMessage = (m, options) => {
   advisories.push(m);
   // Exercise the real streaming custom-message ingestion and Agent steering path.
   void AgentSession.prototype.sendCustomMessage.call({ agent, isStreaming: true }, m, options);
  }; factory(pi);
 }, cwd, createEventBus(), runtime));
 const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), {} as never);
 let lastAssistant: any, processes = 0, transforms = 0, approvals = 0;
 const invocations = new Map<string, number>();
 const owner = project ? createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, runner.createContext().sessionManager.getSessionId()) : undefined;
 t.after(() => owner?.dispose());
 const agent = new Agent({ convertToLlm: messages => owner ? owner.projectMessagesForModel(convertToLlm(messages), undefined, undefined, undefined, 1_000_000, 384_000, true) : convertToLlm(messages), streamFn: () => { throw new Error("live provider forbidden"); }, beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
  if (lastAssistant !== assistantMessage) { lastAssistant = assistantMessage; await runner.emit({ type: "turn_start" } as never); }
  return runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never);
 }, afterToolCall: async ({ toolCall, args, result, isError }) => {
  transforms++;
  return runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args,
   content: result.content, details: result.details, isError } as never);
 } });
 runner.bindCore({ getThinkingLevel: () => "off" } as never, {
  getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
  getScopedModels: () => [], isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
 } as never);
 runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => { approvals++; return choices[0]; } }, "tui");
 await runner.emit({ type: "session_start" } as never);
 const registered = runner.getAllRegisteredTools();
 agent.state.tools = registered.map(r => {
  const tool = wrapToolDefinition(r.definition, () => runner.createContext());
  const execute = tool.execute;
  return { ...tool, execute: (...args: any[]) => { invocations.set(args[0], (invocations.get(args[0]) ?? 0) + 1); return (execute as any)(...args); } };
 });
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") processes++; } }); hook.enable();
 t.after(async () => { hook.disable(); agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); });
 return { cwd, sessionId: runner.createContext().sessionManager.getSessionId(), registered, invocations, advisories, counts: () => ({ processes, transforms, approvals }), async run(steps: ((messages: any[]) => any)[]) {
  let response = 0;
  let scriptError: unknown;
  const contexts: any[][] = [];
  agent.streamFunction = ((_model: any, context: any) => {
   contexts.push(context.messages);
   let next: any;
   try { next = steps[response++]?.(context.messages); } catch (error) { scriptError = error; throw error; }
   const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: next ? "toolUse" : "stop", content: next ? (Array.isArray(next) ? next : [next]) : [] };
   const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
   stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  }) as any;
  await runner.emit({ type: "agent_start" } as never);
  await agent.prompt("offline recovery fixture"); await agent.waitForIdle();
  if (scriptError) throw scriptError;
  assert.equal(response, steps.length + 1);
  assert.equal(agent.state.pendingToolCalls.size, 0);
  assert.equal((runner as any).finalAuthorizations?.size ?? 0, 0);
  for (const count of invocations.values()) assert.equal(count, 1, "no tool invocation replay");
  return { results: agent.state.messages.filter(m => m.role === "toolResult"), contexts };
 } };
}
const lastResult = (messages: any[]) => messages.filter(m => m.role === "toolResult").at(-1);

const baselineAnnotation = "[Snapshot edit] snapshot=snap_0000000000000000000000; editable lines=1-2. Copy LINE#ID anchors exactly. insert={kind,start,newLines} (omit end; start survives; only intended inserted lines, no copied locating context); replace={kind,start,end?,newLines}; delete={kind,start,end?}.";
const baselineHeredoc = "Blocked an uncertain/uninspectable shell lifecycle before execution.\n[Lifecycle recovery] Simplify the unsupported shell construct into an inspectable bounded foreground command. If using a heredoc for an otherwise authorized diagnostic, use native file creation/editing, then request separately authorized foreground execution. Each operation keeps its own read, path, permission and lifecycle requirements; missing files need no read. Broader permissions do not resolve parser limits, and changing tools or language cannot legalize denied behavior. No command was executed.";

test("registered snapshot lifecycle: old unused B rejects, fresh C batches once through model projection", async t => {
 const f = await fixture(t, true); const path = join(f.cwd, "lifecycle.txt"); writeFileSync(path, "one\ntwo\nthree\n");
 let a: any, b: any, c: any;
 const replace = (id: string, read: any, line: number, value: string) => call(id, "edit", { path, snapshot: snapshot(read), edits: [{ kind: "replace", start: anchor(read, line), newLines: [value] }] });
 const { results, contexts } = await f.run([
  () => call("A", "read", { path }),
  m => { a = lastResult(m); return call("B", "read", { path, offset: 2, limit: 1 }); },
  m => { b = lastResult(m); assert.notEqual(snapshot(a), snapshot(b)); return replace("edit-A", a, 1, "ONE"); },
  m => { assert.equal(lastResult(m).isError, false); assert.equal(readFileSync(path, "utf8"), "ONE\ntwo\nthree\n"); return replace("old-B", b, 2, "TWO"); },
  m => { assert.match(text(lastResult(m)), /SNAPSHOT_EDIT_STALE/); assert.equal(readFileSync(path, "utf8"), "ONE\ntwo\nthree\n"); return call("C", "read", { path, offset: 2, limit: 2 }); },
  m => { c = lastResult(m); assert.notEqual(snapshot(c), snapshot(b)); assert.equal(text(c).match(/\[Snapshot edit\]/g)?.length, 1); return call("edit-C-batch", "edit", { path, snapshot: snapshot(c), edits: [2, 3].map(line => ({ kind: "replace", start: anchor(c, line), newLines: [line === 2 ? "TWO" : "THREE"] })) }); },
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, false, false, true, false, false]);
 assert.equal(results.filter(r => (r.details as any)?.stateChanged).length, 2);
 assert.equal((results.at(-1)!.details as any).replacements, 2);
 assert.equal(readFileSync(path, "utf8"), "ONE\nTWO\nTHREE\n");
 for (const id of ["A", "B", "C"]) {
  const persisted = results.find(r => r.toolCallId === id)!;
  const delivered = contexts.flat().find(r => r.role === "toolResult" && r.toolCallId === id);
  assert.equal(text(delivered), text(persisted), "projection preserves this read's annotation and anchors");
 }
 assert.equal(f.advisories.length, 0); assert.equal(f.counts().processes, 0);
 const before = "[SNAPSHOT_EDIT_STALE] Target identity changed. Read the target again.", after = text(results[3]);
 const encoding = getEncoding("cl100k_base");
 t.diagnostic(`stale: chars ${before.length}->${after.length}; cl100k_base fixture tokens ${encoding.encode(before).length}->${encoding.encode(after).length}; explicit snapshot+anchor recovery adds necessary detail`);
 t.diagnostic(`platform=${process.platform}; successful atomic mutation receipts=2; rejected old-B commits=0; fresh-C operations=2`);
});

for (const writer of ["replacement", "content"] as const) test(`registered fresh snapshot rejects external ${writer} without commit`, async t => {
 const f = await fixture(t, true); const path = join(f.cwd, "external.txt"); writeFileSync(path, "one\ntwo\n");
 const { results } = await f.run([
  () => call("read", "read", { path }),
  m => { const r = lastResult(m); if (writer === "replacement") { const external = join(f.cwd, "replacement.txt"); writeFileSync(external, "one\ntwo\n"); renameSync(external, path); } else writeFileSync(path, "external\ntwo\n"); return call("stale", "edit", { path, snapshot: snapshot(r), edits: [{ kind: "replace", start: anchor(r, 1), newLines: ["forbidden"] }] }); },
 ]);
 assert.match(text(results.at(-1)), /SNAPSHOT_EDIT_STALE/);
 assert.equal(results.filter(r => (r.details as any)?.stateChanged).length, 0);
 assert.equal(readFileSync(path, "utf8"), writer === "replacement" ? "one\ntwo\n" : "external\ntwo\n");
 assert.equal(f.counts().processes, 0);
});

test("affected recovery is concise and repeated validation emits at most one steering note per result", async t => {
 const f = await fixture(t, true); const path = join(f.cwd, "concise.txt"); writeFileSync(path, "one\ntwo\n"); let read: any, bad: any;
 const { results, contexts } = await f.run([
  () => call("read", "read", { path }),
  m => { read = lastResult(m); const annotation = read.content.at(-1).text; assert.ok(annotation.length < 180, annotation); bad = { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 1), end: anchor(read, 2), newLines: ["inserted"] }] }; return call("bad-1", "edit", bad); },
  () => call("bad-2", "edit", bad),
  () => call("bad-3", "edit", bad),
  m => { assert.ok(f.advisories.length <= 1, JSON.stringify(f.advisories)); assert.equal(readFileSync(path, "utf8"), "one\ntwo\n"); return call("fixed", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 1), newLines: ["inserted"] }] }); },
  m => { assert.match(text(lastResult(m)), /pre-mutation snapshots/); return call("used", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "delete", start: anchor(read, 1) }] }); },
  m => { const failure = text(lastResult(m)); assert.match(failure, /SNAPSHOT_EDIT_UNKNOWN/); assert.equal(failure.split("\n").length, 2); assert.match(failure, /snapshot.*LINE#ID/); return call("unsupported", "bash", { command: "python - <<'PY'\nprint('diagnostic')\nPY" }); },
 ]);
 const refusal = text(lastResult(contexts.at(-1)!)); assert.ok(refusal.length < 330, refusal); assert.equal(refusal.split("\n").length, 2);
 assert.equal(text(results[1]), text(results[2]), "unchanged requests keep stable canonical validation failures");
 assert.match(text(results[3]), /REPEATED_CALL_BLOCKED/); assert.equal(f.invocations.has("bad-3"), false, "existing repetition guard blocks before execution");
 assert.equal(refusal.match(/\[Lifecycle recovery\]/g)?.length, 1); assert.equal(f.invocations.has("unsupported"), false);
 assert.equal(results.filter(r => (r.details as any)?.stateChanged).length, 1); assert.equal(f.counts().processes, 0);
 const steering = contexts[4].filter(m => m.role === "user" && Array.isArray(m.content) && m.content.some((c: any) => c.text?.startsWith("[Tool-loop")));
 assert.equal(steering.length, 1, "one hidden steering message reaches the next provider request");
 const guidance = f.registered.find(r => r.definition.name === "edit")!.definition.promptGuidelines!.join("\n");
 assert.match(guidance, /non-overlapping.*one call/); assert.match(guidance, /dependent same-file.*sibling/);
 const encoding = getEncoding("cl100k_base");
 const annotation = read.content.at(-1).text.replace(/snap_[\w-]+/, "snap_0000000000000000000000");
 const baselineInvalid = "[SNAPSHOT_EDIT_INVALID] edits[0] insertion uses one surviving start anchor; omit end. newLines must contain only intended inserted lines, not copied context used to locate insertion.\nNo change; retry a corrected request with this snapshot if still current. A stale or consumed snapshot requires read.";
 for (const [name, before, after] of [["read annotation", baselineAnnotation, annotation], ["invalid insertion", baselineInvalid, text(results[1])], ["immediate refusal", baselineHeredoc, refusal]]) {
  assert.ok(after.length < before.length);
  t.diagnostic(`${name}: chars ${before.length}->${after.length}; cl100k_base fixture tokens ${encoding.encode(before).length}->${encoding.encode(after).length}; one delivered annotation/hint, not live-model savings`);
 }
});

test("snapshot authority remains isolated across files and sessions; newer receipt survives unrelated rejection", async t => {
 const f = await fixture(t, true), other = await fixture(t, true);
 const a = join(f.cwd, "a.txt"), b = join(f.cwd, "b.txt"); writeFileSync(a, "one\n"); writeFileSync(b, "two\n");
 let ra: any, rb: any, fresh: any;
 const edit = (id: string, path: string, r: any) => call(id, "edit", { path, snapshot: snapshot(r), edits: [{ kind: "replace", start: anchor(r, 1), newLines: ["changed " + id] }] });
 const first = await f.run([
  () => call("read-a", "read", { path: a }),
  m => { ra = lastResult(m); return call("read-b", "read", { path: b }); },
  m => { rb = lastResult(m); return edit("wrong-file", a, rb); },
  m => { assert.match(text(lastResult(m)), /SNAPSHOT_EDIT_PATH/); return edit("edit-a", a, ra); },
  () => edit("edit-b", b, rb),
  () => call("fresh-a", "read", { path: a }),
 ]);
 fresh = first.results.at(-1);
 const denied = await other.run([() => edit("wrong-session", a, fresh)]);
 assert.match(text(denied.results.at(-1)), /SNAPSHOT_EDIT_UNKNOWN/);
 const corrected = await f.run([() => edit("newer-still-valid", a, fresh)]);
 assert.equal(lastResult(corrected.contexts.at(-1)!).isError, false);
 assert.equal(corrected.results.filter(r => (r.details as any)?.stateChanged).length, 3);
 assert.equal(denied.results.filter(r => (r.details as any)?.stateChanged).length, 0);
});

test("dependent sibling snapshot calls cannot commit twice", async t => {
 const f = await fixture(t, true); const path = join(f.cwd, "sibling.txt"); writeFileSync(path, "one\ntwo\n");
 const { results } = await f.run([
  () => call("read", "read", { path }),
  m => { const r = lastResult(m); return [1, 2].map(line => call(`sibling-${line}`, "edit", { path, snapshot: snapshot(r), edits: [{ kind: "replace", start: anchor(r, line), newLines: ["changed"] }] })); },
 ]);
 assert.equal(results.filter(r => (r.details as any)?.stateChanged).length, 1);
 assert.match(text(results.at(-1)), /SNAPSHOT_EDIT_UNKNOWN/); assert.equal(readFileSync(path, "utf8"), "changed\ntwo\n");
});

test("precommit external writer is still rejected and temporary staging is released", async t => {
 const f = await fixture(t); const path = join(f.cwd, "race.txt"); writeFileSync(path, "one\ntwo\n");
 const { results } = await f.run([() => call("read", "read", { path })]); const r = results[0]; let commits = 0;
 await assert.rejects(executeSnapshotLineEdit(f.sessionId, f.cwd, path, snapshot(r), [{ kind: "replace", start: anchor(r, 1), newLines: ["forbidden"] }], undefined, {
  assertPathAllowed: () => realpath(path), beforeCommit: () => writeFileSync(path, "external\ntwo\n"), afterCommit: () => { commits++; },
 }), /SNAPSHOT_EDIT_STALE.*before commit/);
 assert.equal(commits, 0); assert.equal(readFileSync(path, "utf8"), "external\ntwo\n"); assert.deepEqual(readdirSync(f.cwd), ["race.txt"]);
});

test("anchor mismatch excerpts are bounded observed originals and same-snapshot correction succeeds", async t => {
 const f = await fixture(t); const path = join(f.cwd, "long.txt"); const long = "observed " + "x".repeat(8000); writeFileSync(path, `UNSEEN\n${long}\ntail\n`); let r: any;
 const { results } = await f.run([
  () => call("read", "read", { path, offset: 2, limit: 1 }),
  m => { r = lastResult(m); const wrong = anchor(r, 2).endsWith("0000") ? "2#FFFF" : "2#0000"; return call("bad-anchor", "edit", { path, snapshot: snapshot(r), edits: [{ kind: "replace", start: wrong, newLines: ["changed"] }] }); },
  m => { const failure = text(lastResult(m)); assert.match(failure, /SNAPSHOT_EDIT_MISMATCH/); assert.ok(failure.length < 600); assert.ok(failure.includes(anchor(r, 2))); assert.doesNotMatch(failure, /UNSEEN/); return call("fixed-anchor", "edit", { path, snapshot: snapshot(r), edits: [{ kind: "replace", start: anchor(r, 2), newLines: ["changed"] }] }); },
 ]);
 assert.equal(results.filter(r => (r.details as any)?.stateChanged).length, 1); assert.equal(readFileSync(path, "utf8"), "UNSEEN\nchanged\ntail\n");
});

test("registered insertion failure reaches fake model with complete bounded guidance; same snapshot correction commits once", async t => {
 const f = await fixture(t); const path = join(f.cwd, "note.txt"); writeFileSync(path, "heading\ntail\n");
 let read: any, bad: any, corrected: any;
 const { results } = await f.run([
  () => call("read", "read", { path }),
  m => { read = lastResult(m); bad = { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 1), end: anchor(read, 2), newLines: ["bad\nline"] }] }; return call("bad", "edit", bad); },
  m => { const failure = text(lastResult(m)); assert.match(failure, /omit end/); assert.match(failure, /only intended inserted lines/); assert.match(failure, /one physical line/); assert.match(failure, /this snapshot/); assert.ok(failure.length < 1600); assert.equal(readFileSync(path, "utf8"), "heading\ntail\n"); return call("same-bad", "edit", bad); },
  m => { assert.equal(text(lastResult(m)), text(m.filter(x => x.role === "toolResult").at(-2))); corrected = { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 1), newLines: ["inserted"] }] }; assert.notEqual(callKey("edit", bad), callKey("edit", corrected)); return call("corrected", "edit", corrected); },
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, true, true, false]);
 assert.equal(readFileSync(path, "utf8"), "heading\ninserted\ntail\n");
 assert.equal(results.filter(r => (r.details as any)?.stateChanged).length, 1);
 assert.equal(f.counts().processes, 0); assert.deepEqual(readdirSync(f.cwd), ["note.txt"]);
 const edit = f.registered.find(r => r.definition.name === "edit")!.definition;
 assert.match(JSON.stringify(edit.parameters), /only intended inserted lines/);
});

test("repeated-line intent is never repaired away; explicit covered replacement retains both copies", async t => {
 const f = await fixture(t); const path = join(f.cwd, "repeat.txt"); writeFileSync(path, "repeat\ntail\n"); let read: any;
 const { results } = await f.run([
  () => call("read", "read", { path }),
  m => { read = lastResult(m); return call("ambiguous", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 1), newLines: ["repeat"] }] }); },
  m => { assert.match(text(lastResult(m)), /equal text may be intentional/); assert.equal(readFileSync(path, "utf8"), "repeat\ntail\n"); return call("explicit", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "replace", start: anchor(read, 1), newLines: ["repeat", "repeat"] }] }); },
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, true, false]); assert.equal(readFileSync(path, "utf8"), "repeat\nrepeat\ntail\n");
});

test("real preflight heredoc veto reaches next model once without result transforms or process/file effects", async t => {
 const f = await fixture(t);
 const { results, contexts } = await f.run([
  () => call("heredoc", "bash", { command: "cat > diagnostic.js <<'EOF'\nconsole.log('never');\nEOF\nnode diagnostic.js", timeout: 60000 }),
 ]);
 const delivered = lastResult(contexts.at(-1)!);
 assert.equal(delivered.isError, true); assert.equal(text(delivered).match(/\[Lifecycle recovery\]/g)?.length, 1);
 assert.match(text(delivered), /separately authorized foreground execution/);
 // The final fake-provider request is captured even when it returns no tools.
 assert.equal(results.length, 1); assert.match(text(results[0]), /\[Lifecycle recovery\]/);
 assert.equal(f.invocations.has("heredoc"), false); assert.deepEqual(f.counts(), { processes: 0, transforms: 0, approvals: 0 }); assert.deepEqual(readdirSync(f.cwd), []);
 assert.equal(await failureRecoveryHint("bash", {}, text(results[0]), f.cwd), undefined);
});

test("syntax guard reports bounded candidate coordinates, keeps CRLF, and allows valid same-snapshot correction", async t => {
 const f = await fixture(t); const path = join(f.cwd, "module.js"); const original = "export class A {\r\n  start() {\r\n    const saved = load();\r\n    if (saved) {\r\n      work();\r\n    }\r\n  }\r\n  next() {}\r\n}\r\n"; writeFileSync(path, original); let read: any;
 const { results } = await f.run([
  () => call("read", "read", { path, offset: 2, limit: 4 }),
  m => { read = lastResult(m); return call("syntax", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "replace", start: anchor(read, 3), newLines: ["    const saved = load();", "    if (saved && enabled) {"] }] }); },
  m => { const failure = text(lastResult(m)); assert.match(failure, /candidate line \d+, column \d+: TS\d+/); assert.match(failure, /edits\[0\] original lines 3-3/); assert.doesNotMatch(failure, /next\(\)|#\w{4}/); assert.ok(failure.length < 1400); assert.equal(readFileSync(path, "utf8"), original); return call("valid", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "replace", start: anchor(read, 3), end: anchor(read, 4), newLines: ["    const saved = load();", "    if (saved && enabled) {"] }] }); },
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, true, false]); assert.equal(readFileSync(path, "utf8"), original.replace("if (saved)", "if (saved && enabled)"));
 assert.deepEqual(readdirSync(f.cwd), ["module.js"]);
});

for (const [path, source] of [["valid.jsx", "const view = <div/>;"], ["valid.tsx", "const view = <div/>;"], ["valid.js", "const mask = value << 2;"], ["valid.ts", "const value: number = 1;"]]) test(`ScriptKind control ${path}`, async () => {
 await assertNoNewSyntaxDiagnostics(path, "", source);
});

test("write recovery distinguishes complete overwrite, range edit, stale evidence and exclusive creation", async t => {
 const f = await fixture(t); const path = join(f.cwd, "existing.txt"); const created = join(f.cwd, "created.txt"); writeFileSync(path, "one\ntwo\n"); let range: any;
 const { results } = await f.run([
  () => call("unread", "write", { path, content: "forbidden" }),
  m => { assert.match(text(lastResult(m)), /qualifying complete content/); assert.equal(readFileSync(path, "utf8"), "one\ntwo\n"); return call("range", "read", { path, offset: 1, limit: 1 }); },
  m => { range = lastResult(m); return call("partial", "write", { path, content: "forbidden" }); },
  m => { assert.equal(lastResult(m).isError, true); return call("range-edit", "edit", { path, snapshot: snapshot(range), edits: [{ kind: "replace", start: anchor(range, 1), newLines: ["changed"] }] }); },
  m => { assert.equal(lastResult(m).isError, false); return call("complete", "read", { path }); },
  () => call("overwrite", "write", { path, content: "whole\n" }),
  m => { assert.equal(lastResult(m).isError, false); writeFileSync(path, "external\n"); return call("stale", "write", { path, content: "forbidden" }); },
  m => { assert.equal(lastResult(m).isError, true); assert.equal(readFileSync(path, "utf8"), "external\n"); return call("new", "write", { path: created, content: "new" }); },
  m => { assert.equal(lastResult(m).isError, false); return call("reread", "read", { path }); },
  () => call("recovered", "write", { path, content: "recovered" }),
 ]);
 assert.deepEqual(results.map(r => r.isError), [true, false, true, false, false, false, true, false, false, false]);
 assert.equal((results[7].details as any).created, true); assert.equal(readFileSync(created, "utf8"), "new"); assert.equal(readFileSync(path, "utf8"), "recovered"); assert.equal(f.counts().processes, 0);
});

test("same-turn complete read cannot authorize overwrite, but next-turn corrected write can", async t => {
 const f = await fixture(t); const path = join(f.cwd, "same-turn.txt"); writeFileSync(path, "original");
 const { results } = await f.run([
  () => [call("read", "read", { path }), call("same-turn", "write", { path, content: "replacement" })],
  m => { assert.equal(lastResult(m).isError, true); assert.equal(readFileSync(path, "utf8"), "original"); return call("later", "write", { path, content: "replacement" }); },
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, true, false]); assert.equal(readFileSync(path, "utf8"), "replacement");
});

for (const compact of [false]) test(`snapshot prerequisites and intentional blank-line control: compact=${compact}`, async t => {
 const f = await fixture(t); const path = join(f.cwd, "bounded.txt"); const original = "heading\n\ntail\n" + (compact ? "filler\n".repeat(320_000) : ""); writeFileSync(path, original); let read: any;
 const { results } = await f.run([
  () => call("read", "read", { path, offset: 1, limit: 3 }),
  m => { read = lastResult(m); return call("invalid", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 2), end: anchor(read, 3), newLines: [""] }] }); },
  m => { assert.match(text(lastResult(m)), /only intended inserted lines/); assert.equal(readFileSync(path, "utf8"), original); return call("blank-intent", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "replace", start: anchor(read, 2), newLines: ["", ""] }] }); },
  m => { assert.equal(lastResult(m).isError, false); return call("consumed", "edit", { path, snapshot: snapshot(read), edits: [{ kind: "insert_after", start: anchor(read, 1), newLines: ["not-applied"] }] }); },
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, true, false, true]); assert.match(text(results.at(-1)), /consumed[\s\S]*Read the needed range again/);
 assert.equal(readFileSync(path, "utf8"), "heading\n\n\ntail\n" + (compact ? "filler\n".repeat(320_000) : ""));
});

test("truncated default read is not complete overwrite evidence", async t => {
 const f = await fixture(t); const path = join(f.cwd, "large.txt"); const original = "a line\n".repeat(4000); writeFileSync(path, original);
 const { results } = await f.run([
  () => call("truncated", "read", { path }),
  m => { assert.match(text(lastResult(m)), /more lines|Showing lines/); return call("overwrite", "write", { path, content: "forbidden" }); },
 ]);
 assert.equal(results.at(-1)!.isError, true); assert.match(text(results.at(-1)), /truncated read\(path\) is not complete/); assert.equal(readFileSync(path, "utf8"), original);
});

test("ordinary cat, quoted/arithmetic text and authorized native-create/foreground sequence retain behavior", async t => {
 const f = await fixture(t); writeFileSync(join(f.cwd, "input.txt"), "READ_CONTROL\n");
 const { results } = await f.run([
  () => call("cat", "bash", { command: "cat input.txt", cwd: f.cwd, timeout: 60 }),
  m => { assert.match(text(lastResult(m)), /READ_CONTROL/); return call("quoted", "bash", { command: "printf '%s\\n' 'literal <<EOF'; echo $((1 << 2))", cwd: f.cwd, timeout: 60 }); },
  m => { assert.match(text(lastResult(m)), /literal <<EOF\r?\n4/); return call("create", "write", { path: join(f.cwd, "diagnostic.js"), content: "console.log('DIAGNOSTIC_CONTROL');\n" }); },
  () => call("execute", "bash", { command: "node diagnostic.js", cwd: f.cwd, timeout: 60, purpose: "Run this temporary fixture diagnostic in foreground" }),
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, false, false, false]); assert.match(text(results.at(-1)), /DIAGNOSTIC_CONTROL/); assert.equal(f.counts().processes, 3);
 assert.match(JSON.stringify(f.registered.find(r => r.definition.name === "bash")!.definition.parameters), /60 means one minute/);
});

test("compact snapshot field validation uses stable observed legacy read projection; no synthetic authority", async t => {
 const { createReadToolDefinition } = await import("../packages/coding-agent/src/core/tools/read.ts");
 const { access, readFile, realpath } = await import("node:fs/promises");
 const { issueSnapshotForRead, executeSnapshotLineEdit, resetSnapshotLineStore } = await jiti.import<any>("../packages/extensions/mutation-guard-write/snapshot-line-edit.ts");
 const cwd = mkdtempSync(join(tmpdir(), "pi-compact-recovery-"));
 t.after(() => { resetSnapshotLineStore(); rmSync(cwd, { recursive: true }); });
 const path = join(cwd, "large.txt"); const original = "heading\n\ntail\n" + "filler\n".repeat(320_000); writeFileSync(path, original);
 // Native custom-I/O read preserves the legacy projection required by compact receipts.
 // Default local window/cursor reads currently do not mint compact receipts; do not change eligibility here.
 const read = createReadToolDefinition(cwd, { operations: { access: async p => access(p), readFile: p => readFile(p), detectImageMimeType: async () => null } });
 const input = { path, offset: 1, limit: 3 };
 const result: any = await read.execute("read", input, undefined, undefined, {} as never);
 const annotation = await issueSnapshotForRead("compact-fixture", cwd, input, result); assert.ok(annotation); result.content.push({ type: "text", text: annotation });
 let commits = 0;
 const hooks = { assertPathAllowed: () => realpath(path), beforeCommit: () => { commits++; } };
 const id = snapshot(result), start = anchor(result, 2);
 await assert.rejects(executeSnapshotLineEdit("compact-fixture", cwd, path, id, [{ kind: "insert_after", start, end: anchor(result, 3), newLines: ["bad\nline"] }], undefined, hooks), /omit end.*only intended inserted lines[\s\S]*physical line/);
 assert.equal(commits, 0); assert.equal(readFileSync(path, "utf8"), original);
 await assert.rejects(executeSnapshotLineEdit("compact-fixture", cwd, path, id, [{ kind: "insert_after", start, newLines: [""] }], undefined, hooks), /equal text may be intentional/);
 assert.equal(commits, 0);
 await executeSnapshotLineEdit("compact-fixture", cwd, path, id, [{ kind: "replace", start, newLines: ["", ""] }], undefined, hooks);
 assert.equal(commits, 1); assert.equal(readFileSync(path, "utf8"), "heading\n\n\ntail\n" + "filler\n".repeat(320_000));
});

test("independent public anchor and insertion-field problems aggregate without creating the target", async t => {
 const f = await fixture(t);
 const { results } = await f.run([
  () => call("fields", "edit", { path: join(f.cwd, "absent.txt"), snapshot: "snap_1234567890123456789012", edits: [{ kind: "insert_after", start: "source text", end: "unseen text", newLines: ["bad\nline"] }] }),
 ]);
 const failure = text(results[0]); assert.match(failure, /edits\[0\]\.start/); assert.match(failure, /omit end/); assert.match(failure, /physical line/); assert.ok(failure.length < 1600); assert.deepEqual(readdirSync(f.cwd), []);
});

test("Bash text is not mutation evidence; dedicated range read permits guarded exact mode", async t => {
 const f = await fixture(t); const path = join(f.cwd, "exact.txt"); writeFileSync(path, "alpha\nbeta\n");
 const { results } = await f.run([
  () => call("cat", "bash", { command: "cat exact.txt", cwd: f.cwd }),
  () => call("blind-write", "write", { path, content: "forbidden" }),
  () => call("blind-edit", "edit", { path, edits: [{ oldText: "alpha", newText: "updated" }] }),
  m => { assert.equal(lastResult(m).isError, true); assert.equal(readFileSync(path, "utf8"), "alpha\nbeta\n"); return call("range", "read", { path, offset: 1, limit: 1 }); },
  () => call("exact", "edit", { path, edits: [{ oldText: "alpha", newText: "updated" }] }),
 ]);
 assert.deepEqual(results.map(r => r.isError), [false, true, true, false, false]); assert.equal(readFileSync(path, "utf8"), "updated\nbeta\n");
 assert.equal(f.counts().processes, 1);
});

test("boundary error classification explains ambiguous intent without mandating deletion", async () => {
 const { classifyToolFailure } = await jiti.import<any>("../packages/extensions/session-tool-errors/core.ts");
 const result = classifyToolFailure("edit", "[SNAPSHOT_EDIT_BOUNDARY] edits[0].newLines repeats its surviving anchor");
 assert.equal(result.category, "input_validation"); assert.match(result.cause, /意图不明确/); assert.doesNotMatch(result.cause, /应从 newLines 移除/);
});

for (const command of ['bash -c "$SCRIPT"', 'echo "$(time echo safe)"', 'echo $((1 << 2)']) test(`generic lifecycle uncertainty has a generic next step: ${command}`, async t => {
 const f = await fixture(t);
 const { contexts } = await f.run([() => call("uncertain", "bash", { command })]);
 const failure = text(lastResult(contexts.at(-1)!));
 assert.match(failure, /Use an inspectable foreground command/);
 assert.match(failure, /for a heredoc diagnostic/);
 assert.doesNotMatch(failure, /Actual heredocs are unsupported/);
 assert.equal(failure.match(/\[Lifecycle recovery\]/g)?.length, 1);
 assert.deepEqual(f.counts(), { processes: 0, transforms: 0, approvals: 0 });
 assert.equal(f.invocations.size, 0); assert.deepEqual(readdirSync(f.cwd), []);
});

test("syntax parser resolves the pinned host dependency without a global Node-directory parser", async t => {
 const { spawnSync } = await import("node:child_process");
 const { fileURLToPath } = await import("node:url");
 const cwd = mkdtempSync(join(tmpdir(), "pi-parser-resolution-")); t.after(() => rmSync(cwd, { recursive: true }));
 const module = new URL("../packages/extensions/mutation-guard-write/snapshot-syntax-guard.ts", import.meta.url).href;
 const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  Object.defineProperty(process, 'execPath', {value: ${JSON.stringify(join(cwd, "missing-node", "node"))}});
  const {assertNoNewSyntaxDiagnostics} = await import(${JSON.stringify(module)});
  await assertNoNewSyntaxDiagnostics('valid.ts', '', 'const value: number = 1;');
  await assert.rejects(assertNoNewSyntaxDiagnostics('invalid.js', '', 'const = ;'), /candidate line 1, column/);
  console.log('pinned parser: valid accepted, malformed rejected');
 `], { cwd, encoding: "utf8", timeout: 10_000 });
 assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /valid accepted, malformed rejected/);
 // A copy outside the host dependency tree must still fail closed; never accept unchecked edits.
 const detached = join(cwd, "detached.mts"); writeFileSync(detached, readFileSync(fileURLToPath(module)));
 const { pathToFileURL } = await import("node:url");
 const standalone = await import(pathToFileURL(detached).href);
 await assert.rejects(standalone.assertNoNewSyntaxDiagnostics("valid.js", "", "const x = 1;"), /parser is unavailable/);
});

test("ordinary stderr marker cannot suppress actual runtime recovery in next model context", async t => {
 const f = await fixture(t);
 writeFileSync(join(f.cwd, "diagnostic.mjs"), "console.error('[Lifecycle recovery]'); await import('./invalid.mjs');\n");
 writeFileSync(join(f.cwd, "invalid.mjs"), "const = ;\n");
 const { contexts, results } = await f.run([() => call("runtime", "bash", { command: "node diagnostic.mjs", cwd: f.cwd, timeout: 60 })]);
 const delivered = lastResult(contexts.at(-1)!);
 assert.equal(delivered.isError, true); assert.match(text(delivered), /\[Lifecycle recovery\]/);
 assert.equal(text(delivered).match(/\[Node script recovery\]/g)?.length, 1);
 assert.equal(results.length, 1); assert.equal(f.counts().processes, 1); assert.equal(f.invocations.get("runtime"), 1);
});

test("ordinary marker text does not suppress missing-module guidance", async () => {
 const hint = await failureRecoveryHint("bash", { command: "node missing.mjs" }, "[Lifecycle recovery]\nError: Cannot find module 'missing.mjs'", process.cwd());
 assert.match(hint, /\[Node module recovery\]/);
});
