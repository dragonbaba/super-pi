import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { offlineImageRuntime } from "./helpers/offline-image-runtime.ts";
import { pngFixture, oversizedHeader } from "./helpers/image-acceptance-fixtures.ts";
import { ImageAttachmentDraft } from "../packages/coding-agent/src/core/image-attachments.ts";
import { alphaSession, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { response } from "./helpers/selected-integration-fixture.ts";
import { loadConfig } from "../packages/extensions/auxiliary-vision/core.ts";
import { getImageDimensions } from "../packages/tui/src/terminal-image.ts";

test("post-submit work: explicit retry, text follow-ups, saved-session open/continue and config invalidation", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-image-reuse-"));
	const bytes = pngFixture(1280, 720); const data = bytes.toString("base64");
	const proto = Object.getPrototypeOf(createHash("sha256")), original = proto.update;
	const originalFrom = Buffer.from, originalString = Buffer.prototype.toString;
	let scans = 0, scanBytes = 0, encodes = 0, decodes = 0;
	proto.update = function (value: any, ...rest: any[]) { if (value === data) { scans++; scanBytes += Buffer.byteLength(value); } return original.call(this, value, ...rest); };
	(Buffer as any).from = function (...args: any[]) { if (args[1] === "base64") decodes++; return originalFrom.apply(Buffer, args as never); };
	Buffer.prototype.toString = function (...args: any[]) { if (args[0] === "base64") encodes++; return originalString.apply(this, args as never); };
	const rows: any[] = []; let f = await offlineImageRuntime(root, true);
	function snapshot(phase: string) { rows.push({ phase, scans, scanBytes, encodes, decodes, ...f.counts }); }
	try {
		const draft = new ImageAttachmentDraft(() => {}); const item = draft.begin("fixture.png", "clipboard"); await draft.finish(item, bytes);
		const submitted = draft.submit(); snapshot("local-ready");
		f.failMain(); await f.session.prompt("explain this image", submitted); snapshot("vision-success-main-failure");
		const first = scans;
		await f.session.prompt("explicit retry"); snapshot("retry");
		for (let i = 0; i < 3; i++) await f.session.prompt(`text follow-up ${i}`); snapshot("three-followups");
		assert.equal(f.counts.vision, 1); const live = scans;
		const saved = f.session.sessionManager.getSessionFile()!; await f.close();
		f = await offlineImageRuntime(root, true, saved); snapshot("open-without-submit");
		assert.equal(f.counts.main + f.counts.vision, 0); assert.equal(scans, live);
		await f.session.prompt("continue restored"); snapshot("restored-continue");
		assert.equal(f.counts.vision, 0, "persisted derivation must be reused");
		const restored = scans;
		await f.session.prompt("restored follow-up"); snapshot("restored-followup");
		writeFileSync(f.configPath, JSON.stringify({ model: "offline-input/vision", automatic: true, toolMode: "off", maxTokens: 1024 }));
		await f.session.prompt("changed settings"); snapshot("config-change"); assert.equal(f.counts.vision, 1);
		console.log(JSON.stringify({ imageReuse: rows }));
		assert.equal(live, first, "immutable committed images must not be rescanned on every live request");
		assert.equal(scans, restored, "config invalidation must recompute small request identity, not rescan unchanged image bytes");
	} finally { await f.close(); proto.update = original; Buffer.from = originalFrom; Buffer.prototype.toString = originalString; rmSync(root, { recursive: true }); }
});

test("nine-image queue: rejected whole restore preserves order and explicit continue is reachable from the editor", async () => {
	let calls = 0;
	const runtime = alphaModelRuntime(model => { calls++; return response(model, []); });
	const f = await alphaSession({ runtime, settings: { compaction: { enabled: false } } });
	try {
		await f.mode.init(); f.session.agent.state.model = { ...f.session.model!, input: ["text", "image"] };
		const image = { type: "image" as const, data: pngFixture(8, 8).toString("base64"), mimeType: "image/png" };
		await f.session.followUp("first five", Array(5).fill(image)); await f.session.followUp("second four", Array(4).fill(image));
		const before = JSON.stringify([f.session.getFollowUpMessages(), [...(f.session as any)._queuedImageMessages.values()]]);
		f.input.write("\x1b[1;3A"); await turn(); await f.internal.ui.flushTerminalFrames();
		assert.equal(JSON.stringify([f.session.getFollowUpMessages(), [...(f.session as any)._queuedImageMessages.values()]]), before);
		assert.equal(calls, 0); assert.equal(f.internal.imageDraft.items.length, 0);
		assert.match(f.internal.chatContainer.render(120).join("\n"), /超出单个草稿限制/);
		assert.doesNotMatch(f.internal.chatContainer.render(120).join("\n"), /No queued messages to restore/);
		const input = f.mode.getUserInput(); f.input.write("继续处理队列\r");
		const text = await input; assert.equal(text, "继续处理队列"); await f.session.prompt(text);
		assert.equal(f.session.pendingMessageCount, 0); assert.ok(calls > 0);
		const submitted = f.session.messages.filter((m: any) => m.role === "user" && m.imageSubmission) as any[];
		assert.deepEqual(submitted.map(m => [m.content[0].text, m.imageSubmission.attachments.length]), [["first five", 5], ["second four", 4]]);
	} finally { await f.release(); }
});

test("oversized header rejects before decode; cancellation during worker decode awaits exit", async () => {
	const events: any[] = []; let draft: ImageAttachmentDraft;
	draft = new ImageAttachmentDraft(() => {}, event => { events.push(event); if (event.type === "decode-start") draft.clear(); });
	const huge = draft.begin("huge.png", "clipboard"); await draft.finish(huge, oversizedHeader());
	assert.equal(huge.state, "failed"); assert.equal(events.length, 0); draft.clear();
	const item = draft.begin("large.png", "clipboard"); await draft.finish(item, pngFixture(6000, 3999));
	assert.equal(draft.items.length, 0); assert.equal(events[0].type, "decode-start"); assert.equal(events.at(-1).type, "worker-exit");
	assert.equal((draft as any).decoding, undefined); assert.equal((draft as any).decodingRecord, undefined);
});

test("verified content is immutable; changed content/question invalidates and old derivations remain compatible", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-image-identity-"));
	let f = await offlineImageRuntime(root, true);
	try {
		const image = { type: "image" as const, data: pngFixture(16, 16).toString("base64"), mimeType: "image/png" };
		await f.session.prompt("original question", { images: [image] });
		const user = f.session.messages.find((m: any) => m.role === "user" && m.imageSubmission) as any;
		const block = user.content.find((c: any) => c.type === "image");
		assert.ok(Object.isFrozen(block)); assert.throws(() => { block.data = "different"; }, TypeError);
		const derived = f.session.sessionManager.getBranch().find((e: any) => e.type === "custom" && e.customType === "image-vision-result-v1") as any;
		const legacy = createHash("sha256").update(JSON.stringify(loadConfig(f.configPath, true))).update("original question").update(image.mimeType).update(image.data).digest("hex");
		derived.data = { ...derived.data, inputHash: legacy, digestVersion: 1 };
		await f.session.prompt("legacy follow-up"); await f.session.prompt("legacy follow-up again");
		assert.equal(f.counts.vision, 1, "a valid old persisted digest is not an excuse to re-upload");
		user.content[user.content.indexOf(block)] = { ...image, data: pngFixture(20, 20).toString("base64") };
		await f.session.prompt("changed content"); assert.equal(f.counts.vision, 2);
		user.content.find((c: any) => c.type === "text").text = "changed original question";
		await f.session.prompt("changed question"); assert.equal(f.counts.vision, 3);
		f.session.settingsManager.setBlockImages(true);
		await f.session.prompt("privacy setting changed"); assert.equal(f.counts.vision, 3);
		assert.match(JSON.stringify(f.session.messages), /Image submission blocked/);
		const saved = f.session.sessionManager.getSessionFile()!; await f.close();
		const entries = readFileSync(saved, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
		const old = entries.find(entry => entry.type === "custom" && entry.customType === "image-vision-result-v1");
		old.data = { ...old.data, inputHash: legacy }; delete old.data.digestVersion;
		writeFileSync(saved, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
		f = await offlineImageRuntime(root, true, saved);
		assert.equal(f.counts.main + f.counts.vision, 0);
		await f.session.prompt("continue actual pre-digest saved session"); assert.equal(f.counts.vision, 0);
	} finally { await f.close(); rmSync(root, { recursive: true }); }
});

test("nine-image queue stays paused after cancelled question; /new is a reachable cancellation path", async () => {
	let calls = 0, shown!: () => void, cancel!: () => void;
	const visible = new Promise<void>(resolve => { shown = resolve; });
	const runtime = alphaModelRuntime(model => { calls++; return response(model, [{ type: "toolCall", id: "q", name: "ask_user", arguments: { question: "Choose", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }]); });
	const { createAskUserToolDefinition } = await import("../packages/coding-agent/src/core/tools/ask-user.ts");
	const f = await alphaSession({ runtime, allowReplacements: true, customTools: [createAskUserToolDefinition()], settings: { compaction: { enabled: false } } });
	try {
		await f.mode.init();
		const runner = f.session.extensionRunner;
		runner.setUIContext({ ...runner.getUIContext(), select: async () => { shown(); return new Promise(resolve => { cancel = () => resolve(undefined); }); } }, "tui");
		const run = f.session.prompt("question"); await visible;
		const image = { type: "image" as const, data: pngFixture(8, 8).toString("base64"), mimeType: "image/png" };
		await f.session.followUp("five", Array(5).fill(image)); await f.session.followUp("four", Array(4).fill(image));
		cancel(); await run; assert.equal(calls, 1);
		const before = JSON.stringify([f.session.getFollowUpMessages(), [...(f.session as any)._queuedImageMessages.values()]]);
		f.input.write("\x1b[1;3A"); await turn();
		assert.equal(JSON.stringify([f.session.getFollowUpMessages(), [...(f.session as any)._queuedImageMessages.values()]]), before); assert.equal(calls, 1);
		f.input.write("/new\r");
		for (let i = 0; i < 100 && f.runtime.session === f.session; i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.notEqual(f.runtime.session, f.session); assert.equal(f.runtime.session.pendingMessageCount, 0); assert.equal(calls, 1);
		assert.deepEqual(f.session.getQueuedImageSize(), { count: 0, bytes: 0 });
	} finally { await f.release(); }
});

test("an image-processing input transform cannot reuse the host proof for different bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-image-transform-")); let replacement: any;
	const f = await offlineImageRuntime(root, true, undefined, undefined, undefined, { extensions: [(pi: any) => {
		pi.on("input", (event: any) => {
			if (event.submissionId && replacement) return { action: "transform", text: event.text, images: [replacement] };
		}, { phase: "image-processing" });
	}] });
	try {
		const image = { type: "image" as const, data: pngFixture(10, 10).toString("base64"), mimeType: "image/png" };
		await f.session.prompt("original", { images: [image] }); assert.equal(f.counts.vision, 1);
		replacement = { ...image, data: pngFixture(30, 30).toString("base64") };
		await f.session.prompt("transform active"); assert.equal(f.counts.vision, 2);
		await f.session.prompt("same transformed input"); assert.equal(f.counts.vision, 2);
		const derived = f.session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "image-vision-result-v1") as any[];
		assert.deepEqual(derived.map(e => e.data.digestVersion), [2, 1]);
	} finally { await f.close(); rmSync(root, { recursive: true }); }
});

test("shared dimension parser accepts offset byte views without a base64 round-trip", () => {
	// Header fixtures exercise dimensions only, not full pixel decoding.
	const gif = Buffer.from("47494638396103000200", "hex");
	const jpeg = Buffer.from("ffd8ffc00011080002000303011100021100031100", "hex");
	const webp = Buffer.alloc(30); webp.write("RIFF"); webp.write("WEBPVP8X", 8); webp[24] = 2; webp[27] = 1;
	for (const [mime, bytes] of [["image/png", pngFixture(3, 2)], ["image/gif", gif], ["image/jpeg", jpeg], ["image/webp", webp]] as const) {
		const backing = Buffer.concat([Buffer.alloc(9), bytes, Buffer.alloc(7)]);
		const view = new Uint8Array(backing.buffer, backing.byteOffset + 9, bytes.length);
		assert.deepEqual(getImageDimensions(view, mime), { widthPx: 3, heightPx: 2 });
		assert.deepEqual(getImageDimensions(view, mime), getImageDimensions(bytes.toString("base64"), mime));
		assert.equal(getImageDimensions(view.subarray(0, 2), mime), null);
	}
});

test("clear keeps the file-operation slot until its own read and cleanup settle", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-image-read-owner-")); const path = join(root, "fixture.png");
	writeFileSync(path, pngFixture(8, 8));
	const draft = new ImageAttachmentDraft(() => {});
	try {
		const first = draft.addFiles([path], root); draft.clear();
		assert.equal(draft.busy, true);
		await assert.rejects(draft.addFiles([path], root), /正在添加/);
		await first; assert.equal(draft.busy, false); assert.equal(draft.items.length, 0);
		await draft.addFiles([path], root); assert.equal(draft.items[0].state, "ready");
	} finally { draft.clear(); rmSync(root, { recursive: true }); }
});
