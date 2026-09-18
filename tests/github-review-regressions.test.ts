import assert from "node:assert/strict";
import test from "node:test";
import { lazyStream } from "@super-pi/ai";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { offlineImageRuntime } from "./helpers/offline-image-runtime.ts";
import { pngFixture, oversizedHeader } from "./helpers/image-acceptance-fixtures.ts";
import { alphaSession, alphaModelRuntime, ALPHA_MODEL } from "./helpers/alpha-session.ts";
import { response } from "./helpers/selected-integration-fixture.ts";
import { parseImagePaths, snapshotImageSubmission } from "../packages/coding-agent/src/core/image-attachments.ts";
import { readFormsClipboardFixture } from "./helpers/windows-clipboard-data.ts";
import { SessionPermissionState } from "../packages/extensions/resource-lifecycle-guard/permission-state.ts";
import { createSessionAllowRule } from "../packages/extensions/resource-lifecycle-guard/permission-rule.ts";
import { SESSION_PERMISSION_STATE_TYPE } from "../packages/extensions/resource-lifecycle-guard/permission-contract.ts";
import { fixture } from "./helpers/evidence-ledger-fixture.ts";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { readClipboardImage } from "../packages/coding-agent/src/utils/clipboard-image.ts";
import { NativeClipboardError, readNativeClipboard } from "../packages/coding-agent/src/utils/clipboard-native-process.ts";
import { readClipboardText } from "../packages/coding-agent/src/utils/clipboard.ts";

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


test("rejected competing prompt cannot overwrite the admitted system prompt", async () => {
 const entered = deferred(), resume = deferred(), provider = deferred(), finish = deferred(); const prompts: (string | undefined)[] = [];
 const f = await alphaSession({ runtime: alphaModelRuntime((model, context) => lazyStream(model, async () => {
  prompts.push(context.systemPrompt); provider.resolve(); await finish.promise; return response(model, prompts.length === 1 ? [{ type: "toolCall", id: "probe", name: "probe", arguments: {} }] : []);
 })), extensions: [(pi: any) => pi.on("before_agent_start", async (e: any) => {
  if (e.prompt === "loser") { entered.resolve(); await resume.promise; return { systemPrompt: "LOSER" }; }
  return { systemPrompt: "WINNER" };
 })] });
 try {
  f.session.agent.state.tools.push({ name: "probe", label: "probe", description: "probe", parameters: { type: "object", properties: {} } as any, execute: async () => ({ content: [], details: {} }) });
  const losing = f.session.prompt("loser"); const rejected = assert.rejects(losing, /already processing/); await entered.promise;
  const winner = f.session.prompt("winner"); await provider.promise; resume.resolve(); await rejected;
  assert.equal((f.session as any)._systemPromptOverride, "WINNER"); assert.equal(f.session.agent.state.systemPrompt, "WINNER");
  assert.deepEqual(prompts, ["WINNER"]); finish.resolve(); await winner; assert.deepEqual(prompts, ["WINNER", "WINNER"]);
 } finally { resume.resolve(); finish.resolve(); await f.release(); }
});

for (const cancel of [false, true]) test(`real overflow retry waits for asynchronous compaction input admission (cancel=${cancel})`, async () => {
 const compacting = deferred(), compactResume = deferred(), inputEntered = deferred(), inputResume = deferred(); let calls = 0; const requests: any[] = [];
 const old = await response(ALPHA_MODEL, [{ type: "text", text: "old answer" }]).result();
 const f = await alphaSession({ messages: [{ role: "user", content: "old context ".repeat(300), timestamp: 1 }, old],
  settings: { compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 128 }, retry: { enabled: false } },
  runtime: alphaModelRuntime((model, context) => {
   requests.push(context.messages); calls++;
   if (calls !== 1) return response(model, []);
   return lazyStream(model, async () => {
    const message = await response(model, []).result(); message.stopReason = "error"; message.errorMessage = "maximum context length exceeded"; message.timestamp = Date.now();
    const { AssistantMessageEventStream } = await import("../packages/ai/src/utils/event-stream.ts");
    const stream = new AssistantMessageEventStream(); stream.push({ type: "error", reason: "error", error: message }); return stream;
   });
  }), extensions: [(pi: any) => {
   pi.on("session_before_compact", async (e: any) => { compacting.resolve(); await compactResume.promise; return { compaction: { summary: "old summary", firstKeptEntryId: e.preparation.firstKeptEntryId, tokensBefore: e.preparation.tokensBefore } }; });
   pi.on("input", async (e: any) => { if (e.text === "queued image") { inputEntered.resolve(); await inputResume.promise; } });
  }] });
 try {
  await f.mode.init(); f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
  const run = f.session.prompt("overflow"); await compacting.promise;
  const path = join(f.root, "queued.png"); writeFileSync(path, pngFixture(8, 8));
  f.input.write(`\x1b[200~"${path}"\x1b[201~`); while (f.internal.imageDraft.busy) await turn(); f.input.write("queued image\r"); await turn();
  assert.equal(f.internal.compactionQueuedMessages.length, 1); compactResume.resolve(); await inputEntered.promise;
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(calls, 1, "no stale retry while ordinary input is awaiting");
  if (cancel) f.session.abortCompaction(); inputResume.resolve(); await run;
  if (cancel) { assert.equal(calls, 1); assert.equal(f.internal.compactionQueuedMessages.length, 1); }
  else { assert.equal(calls, 2); assert.match(JSON.stringify(requests[1]), /queued image/); assert.equal(f.internal.compactionQueuedMessages.length, 0); }
 } finally { compactResume.resolve(); inputResume.resolve(); await f.release(); }
});

for (const failure of ["ENOENT", "EACCES", "ETIMEDOUT"]) test(`Windows image helper ${failure} permits text fallback`, async () => {
 const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile;
 cp.execFile = (_command: string, _args: string[], _options: any, callback: any) => callback(Object.assign(new Error(failure), { code: failure }), Buffer.alloc(0)); syncBuiltinESMExports();
 try { assert.equal(await readClipboardImage({ platform: "win32", nativeClipboard: null }), null); }
 finally { cp.execFile = original; syncBuiltinESMExports(); }
});

test("Windows image read uses native fallback when STA helper returns no image", { skip: process.platform !== "win32" }, async () => {
 const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile; let helperCalls = 0;
 const bytes = pngFixture(8, 8);
 cp.execFile = (_command: string, _args: string[], _options: any, callback: any) => { helperCalls++; callback(null, Buffer.alloc(0)); }; syncBuiltinESMExports();
 try {
  const image = await readClipboardImage({ platform: "win32", nativeClipboard: {
   getText: async () => "",
   setText: async () => {},
   hasImage: () => true,
   getImageBinary: async () => Array.from(bytes),
  } });
  assert.deepEqual(Array.from(image?.bytes ?? []), Array.from(bytes)); assert.equal(image?.mimeType, "image/png"); assert.equal(helperCalls, 1);
 } finally { cp.execFile = original; syncBuiltinESMExports(); }
});

test("Windows image read also reaches native fallback after an ordinary STA error", { skip: process.platform !== "win32" }, async () => {
	const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile; let nativeCalls = 0, unavailable = 0;
	cp.execFile = (_command: string, _args: string[], _options: unknown, callback: any) => callback(Object.assign(new Error("clipboard busy"), { code: "EACCES" }), Buffer.alloc(0)); syncBuiltinESMExports();
	const bytes = pngFixture(8, 8);
	try {
		const image = await readClipboardImage({ platform: "win32", nativeClipboard: {
			getText: async () => "", setText: async () => {}, hasImage: () => { nativeCalls++; return true; }, getImageBinary: async () => Array.from(bytes),
		}, onUnavailable: () => unavailable++ });
		assert.equal(image?.bytes.length, bytes.length); assert.equal(nativeCalls, 1); assert.equal(unavailable, 0);
	} finally { cp.execFile = original; syncBuiltinESMExports(); }
});

test("native clipboard cancellation stops the isolated child before the next read", { skip: process.platform !== "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-native-clipboard-"));
	const marker = join(root, "started");
	const fixture = join(root, "clipboard-fixture.cjs");
	writeFileSync(fixture, `const fs = require('node:fs'); module.exports = { hasImage() { return true; }, async getImageBinary() { fs.writeFileSync(${JSON.stringify(marker)}, 'started'); await new Promise(() => {}); }, async getText() { return ''; } };`);
	const abort = new AbortController(); const startedAt = Date.now();
	const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile;
	try {
		cp.execFile = (_command: string, _args: string[], _options: unknown, callback: any) => callback(null, Buffer.alloc(0)); syncBuiltinESMExports();
		const pending = readClipboardImage({ platform: "win32", signal: abort.signal, nativeModulePath: fixture });
		while (!existsSync(marker)) await turn();
		abort.abort();
		await assert.rejects(pending, /取消|停止/);
		assert.ok(Date.now() - startedAt < 2500, "cancel settles after child termination");
		const valid = join(root, "valid.cjs");
		writeFileSync(valid, `module.exports = { hasImage() { return true; }, async getImageBinary() { return [${Array.from(pngFixture(8, 8)).join(",")}]; }, async getText() { return ''; } };`);
		const bytes = await readNativeClipboard("image", undefined, undefined, valid);
		assert.equal(bytes?.length, pngFixture(8, 8).length);
	} finally { cp.execFile = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("native clipboard timeout kills a child that never returns from hasImage", { skip: process.platform !== "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-native-clipboard-timeout-"));
	const fixture = join(root, "clipboard-fixture.cjs");
	writeFileSync(fixture, "module.exports = { hasImage() { while (true) {} }, async getImageBinary() { return []; }, async getText() { return ''; } };");
	try { await assert.rejects(readNativeClipboard("image", undefined, undefined, fixture), /超时|停止/); }
	finally { rmSync(root, { recursive: true, force: true }); }
});

test("native clipboard timeout is fatal before text fallback", { skip: process.platform !== "win32" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-native-clipboard-timeout-image-"));
	const fixture = join(root, "clipboard-fixture.cjs");
	writeFileSync(fixture, "module.exports = { hasImage() { while (true) {} }, async getImageBinary() { return []; }, async getText() { return 'must not be read'; } };");
	const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile; let textFallbackCalls = 0;
	try {
		cp.execFile = (_command: string, _args: string[], _options: unknown, callback: any) => callback(null, Buffer.alloc(0)); syncBuiltinESMExports();
		await assert.rejects(readClipboardImage({ platform: "win32", nativeModulePath: fixture, onUnavailable: () => { textFallbackCalls++; } }), /超时|停止/);
		assert.equal(textFallbackCalls, 0);
	} finally { cp.execFile = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});


test("real Windows Alt+V dispatch falls back to text after image helper failure", { skip: process.platform !== "win32" }, async () => {
 const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile; const f = await alphaSession(); const calls: string[] = [];
 try {
  await f.mode.init();
  f.internal.readClipboardImageForPaste = () => readClipboardImage({ platform: "win32", nativeClipboard: null });
  cp.execFile = (_command: string, args: string[], _options: any, callback: any) => {
   const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
   if (script.includes("GetImage")) { calls.push("image"); callback(Object.assign(new Error("image helper blocked"), { code: "EACCES" }), Buffer.alloc(0)); }
   else { assert.ok(script.includes("DataFormats]::UnicodeText")); calls.push("text"); callback(null, Buffer.from("clipboard fallback text")); }
  }; syncBuiltinESMExports();
  f.input.write("\x1bv"); while (f.internal.clipboardPending) await turn();
  assert.deepEqual(calls, ["image", "text"]); assert.equal(f.internal.editor.getText(), "clipboard fallback text"); assert.equal(f.internal.imageDraft.items.length, 0);
 } finally { cp.execFile = original; syncBuiltinESMExports(); await f.release(); }
});

for (const failure of ["abort", "quota"]) test(`Windows helper ${failure} remains a failure instead of text fallback`, async () => {
 const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile, abort = new AbortController(); let unavailable = 0, nativeCalls = 0;
 cp.execFile = (_command: string, _args: string[], _options: any, callback: any) => {
  if (failure === "abort") abort.abort();
  callback(new Error(failure === "abort" ? "aborted" : `Command failed: powershell ${"encoded-script".repeat(60)}`), Buffer.alloc(0), failure === "quota" ? Buffer.from("Image exceeds pixel limit") : Buffer.alloc(0));
 }; syncBuiltinESMExports();
 const native = { getText: async () => "", setText: async () => {}, hasImage: () => { nativeCalls++; return true; }, getImageBinary: async () => Array.from(pngFixture(8, 8)) };
 try { await assert.rejects(readClipboardImage({ platform: "win32", nativeClipboard: native, signal: abort.signal, onUnavailable: () => unavailable++ })); assert.equal(unavailable, 0); assert.equal(nativeCalls, 0); }
 finally { cp.execFile = original; syncBuiltinESMExports(); }
});


test("headless WSL uses the Windows text clipboard with no native provider", () => {
 const cp = createRequire(import.meta.url)("node:child_process");
 const utility = new URL("../packages/coding-agent/src/utils/clipboard.ts", import.meta.url).href;
 const native = new URL("../packages/coding-agent/src/utils/clipboard-native.ts", import.meta.url).href;
 const code = `import assert from 'node:assert/strict'; import {createRequire,syncBuiltinESMExports} from 'node:module';
  Object.defineProperty(process,'platform',{value:'linux'}); delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY; process.env.WSL_DISTRO_NAME='offline-fixture';
  const require=createRequire(import.meta.url); require('node:os').platform=()=> 'linux'; let calls=0;
  require('node:child_process').execFile=(command,args,options,callback)=>{assert.equal(command,'powershell.exe');calls++;callback(null,Buffer.from('WSL text'));}; syncBuiltinESMExports();
  assert.equal((await import(${JSON.stringify(native)})).clipboard,null);
  const {readClipboardText}=await import(${JSON.stringify(utility)}); assert.equal(await readClipboardText(),'WSL text');assert.equal(calls,1);`;
 cp.execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { timeout: 10000, windowsHide: true, stdio: "pipe" });
});

test("Windows text paste retries the loaded provider after isolated helper failure", async () => {
	let nativeCalls = 0;
	const text = await readClipboardText(undefined, {
		platform: "win32",
		powerShellRead: async () => { throw new Error("STA helper unavailable"); },
		nativeRead: async () => { nativeCalls++; throw new Error("isolated helper unavailable"); },
		directClipboard: { getText: async () => "clipboard text", setText: async () => {}, hasImage: () => false, getImageBinary: async () => [] },
	});
	assert.equal(nativeCalls, 1);
	assert.equal(text, "clipboard text");
});

test("Windows text paste does not bypass a fatal isolated-read result", async () => {
	let directCalls = 0;
	await assert.rejects(readClipboardText(undefined, {
		platform: "win32",
		powerShellRead: async () => { throw new Error("STA helper unavailable"); },
		nativeRead: async () => { throw new NativeClipboardError("bounded read failed", true); },
		directClipboard: { getText: async () => { directCalls++; return "must not be used"; }, setText: async () => {}, hasImage: () => false, getImageBinary: async () => [] },
	}), /bounded read failed/);
	assert.equal(directCalls, 0);
});

test("Windows Forms file-list serialization preserves Unicode, order and literal shell characters", { skip: process.platform !== "win32" }, async () => {
	const paths = ["D:\\outside workspace\\截图 中文🐉.png", "D:\\literal & ` $(echo nope) ' file.webp"];
	const text = await readFormsClipboardFixture(paths);
	assert.deepEqual(parseImagePaths(text!), paths);
});

test("Windows Forms text takes precedence over file-list data; empty and nonimage lists stay text", { skip: process.platform !== "win32" }, async () => {
	const text = "文字 🐉\r\nnormal text";
	assert.equal(await readFormsClipboardFixture(["D:\\image.png"], text), text);
	assert.equal(await readFormsClipboardFixture([]), null);
	const mixed = await readFormsClipboardFixture(["D:\\image.png", "D:\\video.mp4"]);
	assert.equal(mixed, '"D:\\image.png" "D:\\video.mp4"');
	assert.equal(parseImagePaths(mixed!), undefined, "do not partially import mixed file lists");
});

test("WSL translates Explorer FileDrop paths before the existing image-path pipeline", async () => {
	const winPaths = ["C:\\Users\\me\\截图 中文🐉.png", "D:\\Pictures\\second image.webp"];
	const wslPaths = ["/mnt/c/Users/me/截图 中文🐉.png", "/mnt/d/Pictures/second image.webp"];
	const calls: string[] = [];
	const text = await readClipboardText(undefined, {
		platform: "linux",
		env: { ...process.env, WSL_DISTRO_NAME: "offline-fixture", WAYLAND_DISPLAY: "" },
		powerShellRead: async () => Buffer.from(winPaths.map(path => `"${path}"`).join(" "), "utf8"),
		wslPathRead: async (_command, args) => { calls.push(args[1]!); return Buffer.from(`${wslPaths[calls.length - 1]}\n`, "utf8"); },
	});
	assert.deepEqual(calls, winPaths);
	assert.deepEqual(parseImagePaths(text!), wslPaths);
});

test("full image draft still accepts ordinary clipboard text through the paste key", async () => {
 const f = await alphaSession(); let textReads = 0, imageReads = 0;
 try {
  await f.mode.init(); const path = join(f.root, "full.png"); writeFileSync(path, pngFixture(8, 8));
  for (let i = 0; i < 8; i++) { f.input.write(`\x1b[200~"${path}"\x1b[201~`); while (f.internal.imageDraft.busy) await turn(); }
  const ids = f.internal.imageDraft.items.map((item: any) => item.id); f.input.write("question ");
  f.internal.readClipboardTextForPaste = async () => { textReads++; return "more text"; };
  f.internal.readClipboardImageForPaste = async () => { imageReads++; throw new Error("unexpected unreserved image read"); };
  f.input.write(process.platform === "win32" ? "\x1bv" : "\x16"); while (f.internal.clipboardPending) await turn();
  assert.equal(textReads, 1); assert.equal(imageReads, 0); assert.equal(f.internal.editor.getText(), "question more text"); assert.deepEqual(f.internal.imageDraft.items.map((item: any) => item.id), ids);
  assert.equal(f.session.messages.length, 0);
 } finally { await f.release(); }
});

for (const id of ["", "   "]) test(`SDK rejects blank submission ID ${JSON.stringify(id)} without orphaning queue images`, async () => {
 const root = mkdtempSync(join(tmpdir(), "sp-empty-id-")); const entered = deferred(), resume = deferred(); let first = true;
 const f = await offlineImageRuntime(root, false, undefined, undefined, undefined, { beforeWireResponse: async () => { if (first) { first = false; entered.resolve(); await resume.promise; } } });
 let active: Promise<void> | undefined;
 try {
  active = f.session.prompt("active"); await entered.promise;
  const invalid = snapshotImageSubmission([image()]); invalid.submission.id = id;
  await assert.rejects(f.session.prompt("invalid", { ...invalid, streamingBehavior: "followUp" }), /submission.*id/i);
  assert.equal(f.session.pendingMessageCount, 0); assert.deepEqual(f.session.getQueuedImageSize(), { count: 0, bytes: 0 });
  await f.session.prompt("valid", { images: [image()], streamingBehavior: "followUp" }); resume.resolve(); await active;
  assert.equal(f.session.pendingMessageCount, 0); assert.deepEqual(f.session.getQueuedImageSize(), { count: 0, bytes: 0 }); assert.deepEqual(f.session.clearQueue().imageMessages, []);
 } finally { resume.resolve(); await active; await f.close(); rmSync(root, { recursive: true }); }
});
