import assert from "node:assert/strict";
import test from "node:test";
import { lazyStream } from "@super-pi/ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { offlineImageRuntime } from "./helpers/offline-image-runtime.ts";
import { pngFixture, oversizedHeader } from "./helpers/image-acceptance-fixtures.ts";
import { alphaSession, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { response } from "./helpers/selected-integration-fixture.ts";
import { snapshotImageSubmission } from "../packages/coding-agent/src/core/image-attachments.ts";
import { SessionPermissionState } from "../packages/extensions/resource-lifecycle-guard/permission-state.ts";
import { createSessionAllowRule } from "../packages/extensions/resource-lifecycle-guard/permission-rule.ts";
import { SESSION_PERMISSION_STATE_TYPE } from "../packages/extensions/resource-lifecycle-guard/permission-contract.ts";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { readClipboardImage } from "../packages/coding-agent/src/utils/clipboard-image.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const image = () => ({ type: "image" as const, mimeType: "image/png", data: pngFixture(8, 8).toString("base64") });

test("TUI retains failed admission while a competing ordinary prompt is active", async () => {
 const entered = deferred(), resume = deferred(), provider = deferred(), finish = deferred();
 const runtime = alphaModelRuntime(model => lazyStream(model, async () => { provider.resolve(); await finish.promise; return response(model, []); }));
 const f = await alphaSession({ runtime, extensions: [(pi: any) => pi.on("before_agent_start", async (e: any) => { if (e.prompt === "old image") { entered.resolve(); await resume.promise; } })] });
 try {
  await f.mode.init(); f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
  const path = join(f.root, "image.png"); writeFileSync(path, pngFixture(8, 8));
  f.input.write(`\x1b[200~"${path}"\x1b[201~`); while (f.internal.imageDraft.busy) await turn();
  const id = f.internal.imageDraft.items[0].id;
  let oldRun: Promise<void> | undefined; const submit = f.internal.defaultEditor.onSubmit;
  f.internal.defaultEditor.onSubmit = (text: string) => oldRun = submit(text);
  f.input.write("old image\r"); await entered.promise;
  const competing = f.session.prompt("competing text"); await provider.promise;
  resume.resolve(); await oldRun;
  assert.equal(f.internal.imageSubmissionRecovery?.state, "failed");
  assert.equal(f.internal.imageSubmissionRecovery.submission.attachments[0].id, id);
  assert.match(f.internal.imageSubmissionRecovery.error, /already processing/);
  assert.equal(f.session.isStreaming, true); assert.equal(f.session.messages.filter(m => m.role === "user").length, 1);
  finish.resolve(); await competing;
 } finally { resume.resolve(); finish.resolve(); await f.release(); }
});

for (const bad of ["mime", "pixels", "corrupt"]) test(`SDK supplied metadata cannot bypass ${bad} validation`, async () => {
 const root = mkdtempSync(join(tmpdir(), "sp-forged-meta-")); const f = await offlineImageRuntime(root, false);
 try {
  const valid = snapshotImageSubmission([image()]);
  const bytes = bad === "pixels" ? oversizedHeader() : bad === "corrupt" ? pngFixture(8, 8).subarray(0, 38) : Buffer.from("not an image");
  const data = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
  valid.submission.attachments[0].bytes = bytes.length;
  await f.session.prompt("invalid", { images: [data], submission: valid.submission }).catch(() => {});
  assert.equal(f.counts.main, 0); assert.equal(f.counts.vision, 0);
 } finally { await f.close(); rmSync(root, { recursive: true }); }
});

test("extension image source remains extension through real auxiliary processing", async () => {
 const root = mkdtempSync(join(tmpdir(), "sp-image-source-")); const f = await offlineImageRuntime(root, true);
 try { await f.session.prompt("extension image", { images: [image()], source: "extension" }); assert.equal(f.counts.vision, 0); assert.equal(f.counts.main, 0); }
 finally { await f.close(); rmSync(root, { recursive: true }); }
});

test("scoped permission rules use a downgrade-rejectable schema and preserve legacy exact rules", async () => {
 const root = mkdtempSync(join(tmpdir(), "sp-rule-version-"));
 try {
  const state = new SessionPermissionState(); await state.restore(root, []);
  const rule = createSessionAllowRule("exact", "ls", { backend: "bash", cwd: root }); state.addAllowRule(rule);
  assert.equal(state.serialized().schemaVersion, 4);
  const restored = new SessionPermissionState(); await restored.restore(root, [{ type: "custom", customType: SESSION_PERMISSION_STATE_TYPE, data: state.serialized() }]);
  assert.deepEqual(restored.serialized().allowRules, [rule]);
  const legacy = createSessionAllowRule("exact", "ls");
  await restored.restore(root, [{ type: "custom", customType: SESSION_PERMISSION_STATE_TYPE, data: { ...state.serialized(), schemaVersion: 3, allowRules: [legacy] } }]);
  assert.equal(restored.serialized().allowRules[0].kind, "exact"); assert.equal(restored.serialized().allowRules[0].cwd, undefined);
 } finally { rmSync(root, { recursive: true }); }
});

for (const invalid of ["schema", "duplicates"]) test(`ask_user ${invalid} error replans without pausing or executing stale batch`, async () => {
 const f = await fixture(false, false); let calls = 0, effects = 0, shown = 0;
 const runner = f.session.extensionRunner;
 runner.setUIContext({ ...runner.getUIContext(), select: async () => { shown++; return undefined; } }, "tui");
 f.session.agent.state.tools.push({ name: "effect", label: "effect", description: "fixture", parameters: { type: "object", properties: {} } as any,
  execute: async () => { effects++; return { content: [], details: {} }; } });
 f.session.agent.streamFunction = (model, context) => {
  calls++;
  if (calls > 1) { assert.match(JSON.stringify(context.messages), /Not executed: user interaction boundary/); return response(model, []); }
  return response(model, [{ type: "toolCall", id: "e", name: "effect", arguments: {} }, { type: "toolCall", id: "q", name: "ask_user", arguments: {
   question: invalid === "schema" ? "" : "Choose", options: [{ id: "a", label: "A" }, { id: "a", label: "B" }],
  } }]);
 };
 try { await f.session.prompt("question"); assert.equal(calls, 2); assert.equal(shown, 0); assert.equal(effects, 0); }
 finally { f.close(); }
});

for (const quota of ["count", "bytes"]) test(`queue ${quota} bound counts canonical and transformed images`, async () => {
 const root = mkdtempSync(join(tmpdir(), "sp-projection-quota-")); const entered = deferred(), resume = deferred();
 const replacement = quota === "count" ? image() : { ...image(), data: pngFixture(1600, 1600, true).toString("base64") };
 const f = await offlineImageRuntime(root, true, undefined, undefined, event => event.images?.length
  ? { action: "transform", text: event.text, images: Array(quota === "count" ? 8 : 4).fill(replacement) } : undefined,
  { beforeWireResponse: async vision => { if (!vision) { entered.resolve(); await resume.promise; } } });
 try {
  const run = f.session.prompt("active"); await entered.promise;
  for (let i = 0; i < 3; i++) await f.session.prompt(`queued ${i}`, { images: [image()], streamingBehavior: "followUp" });
  const before = JSON.stringify(f.session.getFollowUpMessages());
  await assert.rejects(f.session.prompt("overflow", { images: [image()], streamingBehavior: "followUp" }), /queue/);
  assert.equal(JSON.stringify(f.session.getFollowUpMessages()), before); assert.equal(f.counts.vision, 0);
  assert.equal(f.session.getQueuedImageSize().count, quota === "count" ? 27 : 15);
  assert.equal(f.session.getQueuedImageSize(false).count, 3);
  f.session.clearQueue(); assert.deepEqual(f.session.getQueuedImageSize(), { count: 0, bytes: 0 }); resume.resolve(); await run;
 } finally { resume.resolve(); await f.close(); rmSync(root, { recursive: true }); }
});

test("queue restore aligns mode order and puts current draft images last", async () => {
 const f = await alphaSession();
 try {
  await f.mode.init();
  const a = snapshotImageSubmission([image()]), b = snapshotImageSubmission([image()]);
  await f.session.followUp("follow A", a.images, a.submission); await f.session.steer("steer B", b.images, b.submission);
  const path = join(f.root, "current.png"); writeFileSync(path, pngFixture(8, 8));
  f.input.write(`\x1b[200~"${path}"\x1b[201~`); while (f.internal.imageDraft.busy) await turn();
  const current = f.internal.imageDraft.items[0].id; f.input.write("current text");
  f.input.write("\x1b[1;3A"); await turn();
  assert.equal(f.internal.editor.getText(), "steer B\n\nfollow A\n\ncurrent text");
  assert.deepEqual(f.internal.imageDraft.items.map((i: any) => i.id), [b.submission.attachments[0].id, a.submission.attachments[0].id, current]);
 } finally { await f.release(); }
});

for (const willRetry of [false, true]) test(`all compaction image submissions cross ordinary input once (retry=${willRetry})`, async () => {
 let calls = 0, compacting = true; const hooks: string[] = [];
 const f = await alphaSession({ runtime: alphaModelRuntime(model => { calls++; return response(model, []); }), extensions: [(pi: any) => {
  pi.on("input", (e: any) => { if (!e.images?.length) return; hooks.push(e.text);
   return e.text === "handled" ? { action: "handled" } : e.text === "transform" ? { action: "transform", text: "changed" } : undefined;
  });
 }] });
 try {
  await f.mode.init(); f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
  Object.defineProperty(f.session, "isCompacting", { get: () => compacting, configurable: true });
  const path = join(f.root, "queued.png"); writeFileSync(path, pngFixture(8, 8));
  for (const text of ["handled", "transform", "third"]) {
   f.input.write(`\x1b[200~"${path}"\x1b[201~`); while (f.internal.imageDraft.busy) await turn();
   f.input.write(`${text}\r`); await turn();
  }
  assert.deepEqual(hooks, []); assert.equal(calls, 0); assert.equal(f.internal.compactionQueuedMessages.length, 3);
  compacting = false; await f.internal.flushCompactionQueue({ willRetry });
  if (willRetry) { assert.equal(calls, 0); assert.equal(f.session.pendingMessageCount, 2); await f.session.prompt("explicit continue"); }
  await f.session.waitForIdle();
  assert.deepEqual(hooks, ["handled", "transform", "third"]); assert.equal(f.internal.compactionQueuedMessages.length, 0);
  const users = f.session.messages.filter((m: any) => m.imageSubmission) as any[];
  assert.deepEqual(users.map(m => m.content[0].text), ["transform", "third"]);
 } finally { await f.release(); }
});

for (const helper of ["wl-paste", "xclip"]) for (const phase of ["list", "read"]) test(`${helper} ${phase} propagates cancellation and stops fallbacks`, async () => {
 const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile, abort = new AbortController(), entered = deferred();
 const calls: any[] = [];
 cp.execFile = (command: string, args: string[], options: any, callback: any) => {
  calls.push({ command, signal: options.signal });
  if (command === "wl-paste" && helper === "xclip") { callback(new Error("unavailable"), Buffer.alloc(0)); return; }
  assert.equal(command, helper);
  const listing = args.includes("--list-types") || args.includes("TARGETS");
  if (listing && phase === "read") { callback(null, Buffer.from("image/png")); return; }
  options.signal?.addEventListener("abort", () => callback(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }), Buffer.alloc(0)), { once: true });
  entered.resolve();
 };
 syncBuiltinESMExports();
 try {
  const pending = readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "fixture" }, signal: abort.signal });
  await entered.promise; assert.ok(calls.every(c => c.signal === abort.signal)); const count = calls.length;
  abort.abort(); await assert.rejects(pending, /aborted/); assert.equal(calls.length, count);
 } finally { cp.execFile = original; syncBuiltinESMExports(); }
});
