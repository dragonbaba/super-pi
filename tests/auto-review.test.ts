import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AutoReviewBreaker, autoReviewSessionFiles, autoReviewTranscript, parseAutoReviewVerdict, runAutoReview } from "../packages/coding-agent/src/core/auto-review.ts";
import { nativeFileSession } from "./helpers/sandbox-file-session.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";

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
  // Like Claude Code: the user's words and the agent's tool calls with arguments; no agent prose or reasoning.
  assert.equal(transcript, '[user] run the tests\n\n[tool call] bash {"command":"npm test"}');

  // A user allowing a prompted action while tripped resumes Auto with clean counters.
  consecutive.reset();
  assert.equal(consecutive.tripped, false);
  assert.deepEqual([false, false].map(approved => consecutive.record(approved)), [false, false]);
});

test("auto review sees a session-written file that the request runs, and only while it is unchanged", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-review-files-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "build_scene.py"), other = path.join(root, "notes.txt");
  await fs.writeFile(script, "print('build')\n");
  await fs.writeFile(other, "private notes\n");
  const sha256 = (await import("node:crypto")).createHash("sha256").update("print('build')\n").digest("hex");
  const manager = SessionManager.inMemory(root);
  manager.appendCustomEntry("file-mutation-progress-v2", { phase: "result", status: "succeeded", target: script, sha256 });
  const request = (name: string) => ({ code: `exec(open('${name}').read())` });

  const absolute = await autoReviewSessionFiles(manager, request(script.replaceAll("\\", "/")), root);
  assert.match(absolute, /print\('build'\)/);
  assert.match(await autoReviewSessionFiles(manager, request("./build_scene.py"), root), /print\('build'\)/);
  assert.match(await autoReviewSessionFiles(manager, { nested: { code: 'exec(open("build_scene.py").read())' } }, root), /print\('build'\)/);
  assert.equal(await autoReviewSessionFiles(manager, request("build_scene.py"), undefined), "", "unknown remote cwd must not be guessed");
  assert.match(await autoReviewSessionFiles(manager, request(script), undefined), /print\('build'\)/);
  // Files the session did not write, and names that merely contain the file name, add nothing.
  assert.equal(await autoReviewSessionFiles(manager, request(other.replaceAll("\\", "/")), root), "");
  assert.equal(await autoReviewSessionFiles(manager, request("old_build_scene.py"), root), "");
  assert.equal(await autoReviewSessionFiles(manager, request("build_scene.py.bak"), root), "");
  assert.equal(await autoReviewSessionFiles(manager, request("build_scene.py-old"), root), "");
  assert.equal(await autoReviewSessionFiles(manager, request("build_scene.py~"), root), "");
  assert.equal(await autoReviewSessionFiles(manager, request("build_scene.py+other"), root), "");
  assert.equal(await autoReviewSessionFiles(manager, request("my build_scene.py"), root), "");

  await fs.writeFile(script, "import shutil\n");
  const changed = await autoReviewSessionFiles(manager, request("build_scene.py"), root);
  assert.match(changed, /changed or removed/);
  assert.doesNotMatch(changed, /shutil/);

  // An exact-limit file is eligible (with the prompt cap); one extra byte is not.
  const boundary = "x".repeat(256 * 1024);
  for (const content of [boundary, boundary + "x"]) {
    await fs.writeFile(script, content);
    const hash = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    manager.appendCustomEntry("file-mutation-progress-v2", { phase: "result", status: "succeeded", target: script, sha256: hash });
    const attachment = await autoReviewSessionFiles(manager, request("build_scene.py"), root);
    if (content.length === boundary.length) { assert.match(attachment, /truncated/); assert.ok(attachment.length < 49000); }
    else { assert.match(attachment, /too large/); assert.doesNotMatch(attachment, /xxxx/); }
  }
});

test("auto review authenticates paged v3 writes and copy/move destinations", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-v3-"))), f = nativeFileSession(root), definitions: any = {};
  t.after(async () => { await f.close(); await disposeNativeFileWorker(); await fs.rm(root, { recursive: true, force: true }); });
  f.files.install(definitions);
  const operations = [];
  for (let index = 0; index < 70; index++) operations.push({ operation: "write", path: `build-${index}.py`, mode: "create", content: `print(${index})\n` });
  assert.equal((await f.invoke(definitions, "file_batch", { operations })).isError, false);
  assert.match(await autoReviewSessionFiles(f.manager, { command: "python build-0.py" }, root), /print\(0\)/);
  for (const operation of ["copy", "move"]) {
    const destination = `${operation}.py`;
    const result = await f.invoke(definitions, operation, { path: "build-69.py", destination });
    assert.equal(result.isError, false);
    const attachment = await autoReviewSessionFiles(f.manager, { command: `python ${destination}` }, root);
    if (!result.details.sha256) {
      assert.equal(attachment, "", "A native hard-link move without a content hash cannot authenticate an attachment");
      continue;
    }
    assert.match(attachment, /print\(69\)/, operation);
    await fs.writeFile(path.join(root, destination), "changed");
    assert.match(await autoReviewSessionFiles(f.manager, { command: `python ${destination}` }, root), /changed or removed/);
  }
  const entry = f.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "file-mutation-progress-v3");
  assert(entry?.type === "custom");
  (entry.data as any).hash = "0".repeat(64);
  await assert.rejects(autoReviewSessionFiles(f.manager, { command: "python build-0.py" }, root), /FILE_RESULT/);
});

test("auto attachment identities preserve case and non-regular handles are never read", async t => {
  const root = "/fixture", lower = "/fixture/build.py", upper = "/fixture/BUILD.py";
  const lowerBytes = Buffer.from("lower"), upperBytes = Buffer.from("upper");
  const { createHash } = await import("node:crypto");
  const manager = SessionManager.inMemory(root);
  for (const [target, bytes] of [[lower, lowerBytes], [upper, upperBytes]] as const)
    manager.appendCustomEntry("file-mutation-progress-v2", { phase: "result", status: "succeeded", target, sha256: createHash("sha256").update(bytes).digest("hex") });
  let reads = 0, closes = 0, regular = true;
  t.mock.method(fs, "open", async (target: string, flags: number) => {
    if (constants.O_NONBLOCK !== undefined) assert.ok(flags & constants.O_NONBLOCK);
    let position = 0;
    const bytes = target === lower ? lowerBytes : upperBytes;
    return {
      async stat() { return { isFile: () => regular }; },
      async read(buffer: Buffer, offset: number) { reads++; const count = bytes.length - position; bytes.copy(buffer, offset, position); position += count; return { bytesRead: count }; },
      async close() { closes++; },
    };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await autoReviewSessionFiles(manager, "python /fixture/build.py", root);
  assert.match(result, /\nlower\n/);
  assert.doesNotMatch(result, /upper|BUILD/);
  regular = false; reads = 0;
  await autoReviewSessionFiles(manager, "python /fixture/build.py", root);
  assert.equal(reads, 0);
  assert.equal(closes, 2);
});

test("cancelled auto review stops awaiting attachment IO and closes a late handle", async t => {
  const manager = SessionManager.inMemory("/fixture"), controller = new AbortController();
  manager.appendCustomEntry("file-mutation-progress-v2", { phase: "result", status: "succeeded", target: "/fixture/build.py", sha256: "unused" });
  let notifyStarted!: () => void, releaseOpen!: (handle: any) => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const pending = new Promise<any>(resolve => { releaseOpen = resolve; });
  let closes = 0, settled = false, modelRequests = 0;
  t.mock.method(fs, "open", () => { notifyStarted(); return pending; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = { withSupplementalSummary: async () => { modelRequests++; return { stopReason: "aborted" }; } };
  const ctx = { sessionManager: manager, cwd: "/fixture", model: { maxTokens: 100 }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) } };
  const reviewing = runAutoReview(runtime as any, ctx as any, "python /fixture/build.py", controller.signal, false, { command: "python /fixture/build.py" }, "/fixture");
  void reviewing.then(() => { settled = true; });
  await started;
  controller.abort();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, true, "cancel must not wait for an outstanding filesystem operation");
    assert.equal((await reviewing).failed, true);
    assert.equal(modelRequests, 0);
  } finally {
    releaseOpen({ async stat() { return { isFile: () => true }; }, async read() { return { bytesRead: 0 }; }, async close() { closes++; } });
    await reviewing;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closes, 1);
  }
});

test("auto attachment rejects an actual POSIX FIFO without waiting for a writer", { skip: process.platform === "win32", timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-fifo-")), target = path.join(root, "build.py");
  t.after(async () => {
    // Also release a blocking reader if a regression reintroduces the old open flags.
    const writer = await fs.open(target, constants.O_RDWR | constants.O_NONBLOCK);
    await writer.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await promisify(execFile)("mkfifo", [target]);
  const manager = SessionManager.inMemory(root);
  manager.appendCustomEntry("file-mutation-progress-v2", { phase: "result", status: "succeeded", target, sha256: "unused" });
  assert.match(await autoReviewSessionFiles(manager, JSON.stringify({ path: target }), root), /unavailable/);
});

async function fixture(t: TestContext, mode: "host-auto" | "host-restricted", answers: string[], config = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-review-")));
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-auto-review-outside-")));
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(root);
  runtime.appendEntry = (customType, data) => { manager.appendCustomEntry(customType, data); };
  const requests: string[] = [], dialogs: string[] = [], notes: string[] = [], statuses: (string | undefined)[] = [], choices: (string | undefined)[] = [];
  runtime.withSupplementalSummary = (async (_signal: AbortSignal, run: (stream: any) => Promise<unknown>) => run(async (_model: unknown, context: any) => {
    requests.push(context.messages[0].content);
    const text = answers.length ? answers.shift()! : "APPROVE: ok";
    return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text }] }) };
  })) as any;
  const ctx: any = { cwd: root, hasUI: true, signal: new AbortController().signal, sessionManager: manager,
    model: { provider: "test", id: "reviewer", api: "test", maxTokens: 1000 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
    ui: { select: async (title: string) => { dialogs.push(title); return choices.shift(); }, notify: (message: string) => { notes.push(message); },
      setStatus: (_key: string, text: string | undefined) => { statuses.push(text); } } };
  const owner = new SessionExecutionPolicy(runtime, "trusted-host", config, mode);
  t.after(async () => {
    owner.dispose(); await runtime.executionBoundary.dispose();
    await fs.rm(root, { recursive: true }); await fs.rm(outside, { recursive: true });
  });
  async function decide(name: string, input: object, review = false, definition: any = { name }): Promise<string> {
    try { (await owner.authorize({ type: "tool_call", toolName: name, input, toolCallId: "c", review } as any, ctx, definition)).release(); return "allow"; }
    catch (error: any) { return /AUTO_REVIEW_DENIED/.test(error.message) ? "denied" : /APPROVAL_CANCELLED/.test(error.message) ? "asked" : error.message; }
  }
  return { root, outside, requests, dialogs, notes, statuses, choices, decide, owner, ctx };
}

test("risk-selective Auto does not review ordinary commands or unmarked MCP queries", async t => {
  const f = await fixture(t, "host-auto", ["DENY: this reviewer should not be called"]);
  assert.equal(await f.decide("bash", { command: "npm test" }), "allow");
  assert.equal(await f.decide("mcp__fixture__query", {}, false, { name: "mcp__fixture__query", mcpServer: "fixture" }), "allow");
  assert.equal(f.requests.length, 0); assert.equal(f.dialogs.length, 0);
});

test("risk-selective Auto reviews native file changes before they can execute", async t => {
  const f = await fixture(t, "host-auto", ["DENY: review the requested change"]);
  const target = path.join(f.root, "existing.txt"); await fs.writeFile(target, "original");
  assert.equal(await f.decide("edit", { path: target, edits: [{ oldText: "original", newText: "changed" }] }), "denied");
  assert.equal(f.requests.length, 1); assert.equal(await fs.readFile(target, "utf8"), "original");
});

test("risk-selective Auto honors the main model's explicit review request", async t => {
  const f = await fixture(t, "host-auto", ["DENY: high-risk effect"]);
  assert.equal(await f.decide("opaque_action", { code: "opaque data" }, true), "denied");
  assert.equal(f.requests.length, 1);
});

test("risk-selective Auto retains an exact call's selected risk when its review flag is omitted on retry", async t => {
  const f = await fixture(t, "host-auto", ["DENY: high-risk effect", "DENY: still high-risk", "APPROVE: user allowed a reviewed retry"]);
  const input = { code: "opaque data" };
  assert.equal(await f.decide("opaque_action", input, true), "denied");
  assert.equal(await f.decide("opaque_action", input), "denied");
  const denial = f.owner.listAutoDenials(f.ctx)[0]!;
  assert.equal(f.owner.allowAutoRetry(f.ctx, denial.key), true);
  assert.equal(await f.decide("opaque_action", input), "allow");
  assert.equal(f.requests.length, 3); assert.match(f.requests[2]!, /<user-retry>/);
  assert.equal(await f.decide("different_query", {}), "allow");
  assert.equal(f.requests.length, 3);
});

test("risk-selective Auto preserves external read authorization and explicit denials", async t => {
  const f = await fixture(t, "host-auto", ["DENY: must not be called"], { rules: [{ tool: "forbidden", decision: "deny" }] });
  const outside = path.join(f.outside, "read.txt"); await fs.writeFile(outside, "outside");
  assert.equal(await f.decide("read", { path: outside }), "asked");
  assert.match(await f.decide("forbidden", {}, true), /Explicitly denied/);
  assert.equal(f.requests.length, 0); assert.equal(f.dialogs.length, 1);
});

test("risk-selective Auto reviews declared destructive MCP calls and recognized shell mutations", async t => {
  const f = await fixture(t, "host-auto", ["DENY: destructive tool", "DENY: file mutation"]);
  const name = "mcp__fixture__delete";
  assert.equal(await f.decide(name, {}, false, { name, mcpServer: "fixture", mcpDestructive: true }), "denied");
  const target = path.join(f.root, "keep.txt"); await fs.writeFile(target, "original");
  assert.equal(await f.decide("bash", { command: "rm keep.txt" }), "denied");
  assert.equal(f.requests.length, 2); assert.equal(await fs.readFile(target, "utf8"), "original");
});

for (const override of [false, true]) test(`auto review uses decoded shell arguments and invocation cwd: override=${override}`, async t => {
  const f = await fixture(t, "host-auto", []);
  const sub = path.join(f.root, "sub"); await fs.mkdir(sub);
  const { createHash } = await import("node:crypto");
  for (const [dir, content] of [[f.root, "ROOT_SCRIPT"], [sub, "SUB_SCRIPT"]]) {
    const target = path.join(dir!, "build.py"); await fs.writeFile(target, content!);
    f.ctx.sessionManager.appendCustomEntry("file-mutation-progress-v2", { phase: "result", status: "succeeded", target, sha256: createHash("sha256").update(content!).digest("hex") });
  }
  for (const tool of ["bash", "powershell"]) {
    const input = override ? { command: "python build.py --verbose", cwd: tool === "bash" ? "sub" : sub } : { command: "python build.py" };
    assert.equal(await f.decide(tool, input, true), "allow");
    const reviewed = f.requests.at(-1)!;
    assert.match(reviewed, new RegExp(override ? "SUB_SCRIPT" : "ROOT_SCRIPT"));
    assert.doesNotMatch(reviewed, new RegExp(override ? "ROOT_SCRIPT" : "SUB_SCRIPT"));
  }
});

test("auto review keeps the latest user instruction after tool history fills either budget", async t => {
  const f = await fixture(t, "host-auto", []);
  const manager = f.ctx.sessionManager;
  for (const size of [8, 1800]) {
    manager.appendMessage({ role: "user", content: "Inspect the project, then run npm test. Do not push.", timestamp: 1 });
    for (let index = 0; index < 16; index++) manager.appendMessage({ role: "assistant", content: [
      { type: "toolCall", id: `r${index}`, name: "read", arguments: { path: `src/${index}-${"x".repeat(size)}.ts` } },
    ], api: "x", provider: "x", model: "x", usage: {} as any, stopReason: "toolUse", timestamp: index + 2 } as any);
    assert.equal(await f.decide("bash", { command: "npm test" }, true), "allow");
    assert.match(f.requests.at(-1)!, /\[user\] Inspect the project, then run npm test\. Do not push\./);
    const transcript = autoReviewTranscript(manager);
    assert.ok(transcript.length <= 12000);
    assert.ok(transcript.split("\n\n").length <= 16);
    assert.match(transcript, /src\/15-/);
  }
});

test("risk-selected Auto retains explicit asks, outside deletion, breaker and exact retry ownership", async t => {
  const f = await fixture(t, "host-auto", ["APPROVE: the user asked for tests", "DENY: pushes without being asked"],
    { rules: [{ tool: "bash", command: "git push --force", decision: "ask" }] });
  // Ordinary reads never ask. The main model can request review of an opaque command.
  assert.equal(await f.decide("bash", { command: "git status" }), "allow");
  assert.equal(f.requests.length, 0);
  assert.equal(await f.decide("bash", { command: "npm test" }, true), "allow");
  assert.equal(f.requests.length, 1); assert.match(f.requests[0]!, /"command": "npm test"/); assert.match(f.requests[0]!, /<transcript>/);
  assert.equal(await f.decide("bash", { command: "git push" }, true), "denied");
  assert.equal(f.dialogs.length, 0);
  assert.match(f.notes.join("\n"), /Auto 审查批准：bash — the user asked for tests/);
  assert.doesNotMatch(f.notes.join("\n"), /Auto 审查拒绝/, "the tool error already presents the rejection; do not also render a warning");

  // The user's own ask rule and a delete outside the workspaces are never answered by the reviewer.
  assert.equal(await f.decide("bash", { command: "git push --force" }, true), "asked");
  await fs.writeFile(path.join(f.outside, "b.txt"), "b");
  assert.equal(await f.decide("bash", { command: `rm ${path.join(f.outside, "b.txt").replaceAll("\\", "/")}` }), "asked");
  assert.equal(f.requests.length, 2); assert.equal(f.dialogs.length, 2);

  // A review without a verdict is not a denial: the user is asked, and the breaker does not count it.
  const g = await fixture(t, "host-auto", ["maybe", "DENY: no", "DENY: no", "DENY: no"]);
  assert.equal(await g.decide("bash", { command: "npm install" }, true), "asked");
  assert.match(g.notes.join("\n"), /Auto 审查未完成，改为询问你/);
  for (let index = 0; index < 3; index++) assert.equal(await g.decide("bash", { command: "npm install" }, true), "denied");
  assert.deepEqual(g.statuses, ["宿主机受限 · Auto 已暂停（改为询问）"]);
  // Tripped: the user is asked; allowing once resumes Auto, so the next ask is reviewed again.
  g.choices.push("允许一次");
  assert.equal(await g.decide("bash", { command: "npm install" }, true), "allow");
  assert.equal(g.requests.length, 4);
  assert.deepEqual(g.statuses, ["宿主机受限 · Auto 已暂停（改为询问）", "宿主机受限 · Auto 审查"]);
  assert.equal(await g.decide("bash", { command: "npm install" }, true), "allow");
  assert.equal(g.requests.length, 5);

  // Without a UI, an unfinished review says it is not a finding of unsafety.
  const headless = await fixture(t, "host-auto", ["maybe"]);
  headless.ctx.hasUI = false;
  assert.match(await headless.decide("bash", { command: "npm test" }, true), /APPROVAL_REQUIRED.*not a finding/);

  // `/permissions auto`: the user allows one retry of a recent denial; the identical request is reviewed
  // once more with the reviewer told so, and only that once.
  const r = await fixture(t, "host-auto", ["DENY: pushes without being asked", "APPROVE: the user allowed it", "DENY: again"]);
  assert.equal(await r.decide("bash", { command: "git push" }, true), "denied");
  const denials = r.owner.listAutoDenials(r.ctx);
  assert.equal(denials.length, 1); assert.equal(denials[0]!.tool, "bash"); assert.equal(denials[0]!.reason, "pushes without being asked");
  assert.equal(r.owner.allowAutoRetry(r.ctx, denials[0]!.key), true);
  assert.equal(r.owner.listAutoDenials(r.ctx).length, 0);
  assert.equal(await r.decide("bash", { command: "git push" }, true), "allow");
  assert.match(r.requests[1]!, /<user-retry>/); assert.doesNotMatch(r.requests[0]!, /<user-retry>/);
  assert.equal(await r.decide("bash", { command: "git push" }, true), "denied");
  assert.doesNotMatch(r.requests[2]!, /<user-retry>/);

  // The grant binds the full invocation: a write with other content shows the reviewer the same text but is not covered.
  const w = await fixture(t, "host-auto", ["DENY: not asked for"]);
  const target = path.join(w.outside, "new.txt");
  assert.equal(await w.decide("write", { path: target, content: "a" }), "denied");
  assert.equal(w.owner.allowAutoRetry(w.ctx, w.owner.listAutoDenials(w.ctx)[0]!.key), true);
  assert.equal(await w.decide("write", { path: target, content: "b" }), "allow");
  assert.equal(w.requests.length, 2); assert.equal(w.requests[0], w.requests[1]);
  // Batch-level arguments count too: a grant for a preview does not cover applying it.
  const b = await fixture(t, "host-auto", ["DENY: not asked for"]);
  const operations = [{ operation: "write", path: path.join(b.outside, "batch.txt"), content: "a" }];
  assert.equal(await b.decide("file_batch", { operations, dryRun: true }), "denied");
  assert.equal(b.owner.allowAutoRetry(b.ctx, b.owner.listAutoDenials(b.ctx)[0]!.key), true);
  assert.equal(await b.decide("file_batch", { operations, dryRun: false }), "allow");
  assert.equal(b.requests.length, 2); assert.doesNotMatch(b.requests[1]!, /<user-retry>/);

  // A grant is used up when the identical call is asked of the user (breaker tripped) instead of reviewed.
  const q = await fixture(t, "host-auto", ["DENY: no", "DENY: no", "DENY: no"]);
  for (let index = 0; index < 3; index++) assert.equal(await q.decide("bash", { command: "git push" }, true), "denied");
  assert.equal(q.owner.allowAutoRetry(q.ctx, q.owner.listAutoDenials(q.ctx)[0]!.key), true);
  q.choices.push("允许一次");
  assert.equal(await q.decide("bash", { command: "git push" }, true), "allow");
  assert.equal(q.requests.length, 3);
  assert.equal(await q.decide("bash", { command: "git push" }, true), "allow");
  assert.doesNotMatch(q.requests[3]!, /<user-retry>/);

  // host-restricted itself never calls the reviewer.
  const h = await fixture(t, "host-restricted", []);
  assert.equal(await h.decide("bash", { command: "npm test" }), "asked");
  assert.equal(h.requests.length, 0);
});
