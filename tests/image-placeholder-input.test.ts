import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { setImmediate as turn } from "node:timers/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { AlphaInput, AlphaSink } from "./helpers/alpha-session.ts";
import { offlineImageRuntime } from "./helpers/offline-image-runtime.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";
import { InteractiveMode, createInteractiveTui } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { ProcessTerminal } from "../packages/tui/src/terminal.ts";
import { CURSOR_MARKER } from "../packages/tui/src/tui.ts";
import { CustomEditor } from "../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { snapshotImageSubmission } from "../packages/coding-agent/src/core/image-attachments.ts";
import { Editor } from "@super-pi/tui";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";

async function mounted(auxiliary = false, screen: "regular" | "fullscreen" = "regular", controls: Parameters<typeof offlineImageRuntime>[5] = {}) {
	const root = mkdtempSync(join(tmpdir(), "sp-placeholder-"));
	const f = await offlineImageRuntime(root, auxiliary, undefined, undefined, undefined, controls);
	initTheme("dark");
	const mode = new InteractiveMode(f.host, { tuiMode: screen }); const internal = mode as any;
	await internal.renderer.dispose({ preserveScreen: true });
	const input = new AlphaInput(), sink = new AlphaSink({ highWaterMark: 1024 });
	const painted = { unsent: false, selection: false };
	sink.physicalMarker = text => { if (text.includes("未发送")) painted.unsent = true; if (text.includes("▶ [图片")) painted.selection = true; };
	const resize = Object.assign(new EventEmitter(), { columns: 120, rows: 40 });
	const terminal = new ProcessTerminal(sink as unknown as NodeJS.WriteStream, {
		input: input as unknown as NodeJS.ReadStream, resizeSource: resize as unknown as NodeJS.WriteStream,
	});
	internal.renderer = createInteractiveTui({ tuiMode: screen, terminal, showHardwareCursor: true, logDirectory: root, onRightClickPaste: internal.onRightClickPaste });
	await mode.init();
	return { ...f, internal, input, sink, painted, resize, async release() {
		await mode.stop(); await f.close(); input.destroy(); sink.destroy(); rmSync(root, { recursive: true });
	} };
}

async function settled(f: Awaited<ReturnType<typeof mounted>>) {
	while (f.internal.imageDraft.busy || f.internal.clipboardPending) await turn();
}
async function frame(f: Awaited<ReturnType<typeof mounted>>) {
	f.internal.ui.renderNow(true); await f.internal.ui.flushTerminalFrames();
	return f.internal.defaultEditor.render(f.resize.columns).join("\n");
}

for (const auxiliary of [false, true]) for (const screen of ["regular", "fullscreen"] as const) {
	test(`placeholder deletion preserves text, IDs and submit projection (${screen}, auxiliary=${auxiliary})`, async () => {
		const f = await mounted(auxiliary, screen), png = pngFixture(8, 8);
		try {
			const path = join(f.root, "本地 🐉.png"); writeFileSync(path, png);
			f.input.write(`\x1b[200~"${path}" "${path}" "${path}"\x1b[201~`); await settled(f);
			const ids = f.internal.imageDraft.items.map((item: any) => item.id);
			assert.equal(ids.length, 3);
			f.input.write("question [图片 99]"); f.input.write("\x01\x1b[D\x1b[D");
			assert.equal(f.internal.defaultEditor.selectedAttachmentId, ids[1]);
			assert.match(await frame(f), /▶ \[图片 2/);
			assert.equal(f.internal.defaultEditor.render(30).join("\n").split(CURSOR_MARKER).length - 1, 1);
			f.input.write("\x1b[3~");
			assert.deepEqual(f.internal.imageDraft.items.map((item: any) => item.id), [ids[0], ids[2]]);
			assert.equal(f.internal.editor.getText(), "question [图片 99]");
			assert.doesNotMatch(await frame(f), /image-remove|image-clear/);
			f.input.write("\x1b[C"); // return from the surviving last image to text
			f.input.write("prefix ");
			assert.equal(f.internal.editor.getText(), "prefix question [图片 99]");
			f.resize.columns = 45; f.resize.emit("resize"); await frame(f);
			assert.equal(f.counts.main, 0); assert.equal(f.counts.vision, 0);
			let submitted: Promise<void> | undefined;
			const originalSubmit = f.internal.defaultEditor.onSubmit;
			f.internal.defaultEditor.onSubmit = (text: string) => submitted = originalSubmit(text);
			f.input.write("\r"); await submitted;
			assert.equal(f.counts.main, 1); assert.equal(f.counts.vision, auxiliary ? 1 : 0);
			const user = f.session.messages.find((m: any) => m.imageSubmission) as any;
			assert.equal(user.content[0].text, "prefix question [图片 99]");
			assert.deepEqual(user.imageSubmission.attachments.map((item: any) => item.id), [ids[0], ids[2]]);
			assert.equal(f.internal.imageDraft.items.length, 0);
			assert.equal(f.internal.defaultEditor.selectedAttachmentId, undefined);
			assert.deepEqual(readFileSync(path), png);
			await frame(f); assert.equal(f.painted.unsent, true); assert.equal(f.painted.selection, true);
		} finally { await f.release(); }
	});
}

test("Backspace deletes only the adjacent attachment; text and invented markers have no ownership", async () => {
	const f = await mounted();
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		f.input.write("x\x7f"); assert.equal(f.internal.imageDraft.items.length, 1);
		f.input.write("\x7f"); assert.equal(f.internal.imageDraft.items.length, 0);
		assert.doesNotMatch(await frame(f), /未发送/);
		f.input.write("[图片 1 · 截图.png · 已粘贴 · 未发送]");
		assert.equal(f.internal.imageDraft.items.length, 0);
		assert.equal(f.counts.main + f.counts.vision, 0);
	} finally { await f.release(); }
});

test("removing a preparing clipboard placeholder rejects late completion and does not send", async () => {
	const f = await mounted(); let finish!: (value: unknown) => void;
	const pending = new Promise(resolve => { finish = resolve; });
	try {
		f.internal.readClipboardImageForPaste = () => pending;
		f.input.write("\x16"); assert.match(await frame(f), /正在添加/);
		const signal = f.internal.clipboardAbort.signal;
		f.input.write("\r"); // early submit must never become deferred permission
		await turn(); assert.equal(f.counts.main, 0);
		f.input.write("\x7f"); assert.equal(f.internal.imageDraft.items.length, 0);
		assert.equal(signal.aborted, true);
		f.input.write("next draft"); finish({ bytes: pngFixture(8, 8), mimeType: "image/png" }); await settled(f);
		assert.equal(f.internal.editor.getText(), "next draft"); assert.equal(f.internal.imageDraft.items.length, 0);
		assert.equal(f.counts.main + f.counts.vision, 0); assert.doesNotMatch(await frame(f), /未发送/);
	} finally { finish(null); await f.release(); }
});

for (const auxiliary of [false, true]) for (const gesture of ["alt", "ctrl", "empty-paste", "right-click"] as const) {
	test(`Windows ${gesture}, auxiliary=${auxiliary}: real input/helper/owner, simulated clipboard transport`, { skip: process.platform !== "win32" }, async () => {
		const f = await mounted(auxiliary, gesture === "right-click" ? "fullscreen" : "regular");
		const cp = createRequire(import.meta.url)("node:child_process"), original = cp.execFile;
		let reads = 0;
		try {
			cp.execFile = (_command: string, args: string[], _options: unknown, callback: any) => {
				const script = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
				assert.match(script, /GetImage/); reads++; callback(null, Buffer.from(pngFixture(8, 8).toString("base64")));
			}; syncBuiltinESMExports();
			f.input.write(gesture === "alt" ? "\x1bv" : gesture === "ctrl" ? "\x16" : gesture === "right-click" ? "\x1b[<2;5;5M" : "\x1b[200~\x1b[201~");
			await settled(f);
			assert.equal(reads, 1); assert.equal(f.internal.imageDraft.items.length, 1);
			assert.match(await frame(f), /已粘贴 · 未发送/);
			assert.equal(f.counts.main + f.counts.vision, 0);
			f.input.write("\x7f"); assert.equal(f.internal.imageDraft.items.length, 0);
		} finally { cp.execFile = original; syncBuiltinESMExports(); await f.release(); }
	});
}

test("custom deletion bindings and extension shortcuts retain precedence", async () => {
	const f = await mounted();
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		f.internal.keybindings.setUserBindings({ "tui.editor.deleteCharBackward": "ctrl+h", "app.clipboard.pasteImage": "alt+p" });
		f.internal.refreshImageDraft();
		assert.match(await frame(f), /ctrl\+h/);
		f.internal.defaultEditor.onExtensionShortcut = (data: string) => data === "\x08";
		f.input.write("\x08"); assert.equal(f.internal.imageDraft.items.length, 1);
		f.internal.defaultEditor.onExtensionShortcut = undefined;
		f.input.write("\x08"); assert.equal(f.internal.imageDraft.items.length, 0);
		let reads = 0; f.internal.readClipboardImageForPaste = async () => { reads++; return null; };
		f.internal.readClipboardTextForPaste = async () => "fallback";
		f.input.write("\x16"); assert.equal(reads, 0);
		f.input.write("\x1bp"); await settled(f); assert.equal(reads, 1); assert.equal(f.internal.editor.getText(), "fallback");
	} finally { await f.release(); }
});

function rightClick(f: Awaited<ReturnType<typeof mounted>>) {
	if (process.platform === "win32") f.input.write("\x1b[<2;5;5M");
	else f.internal.onRightClickPaste(); // host callback contract; Linux has no Windows right-click gesture
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

for (const auxiliary of [false, true]) test(`extension CustomEditor owns visible attachment projection (auxiliary=${auxiliary})`, async () => {
	const f = await mounted(auxiliary, "fullscreen", { extensions: [(pi: any) => {
		pi.registerCommand("swap-editor", { handler: async (_args: string, ctx: any) => ctx.ui.setEditorComponent((ui: any, theme: any, keys: any) => new CustomEditor(ui, theme, keys)) });
		pi.registerCommand("default-editor", { handler: async (_args: string, ctx: any) => ctx.ui.setEditorComponent(undefined) });
	}] });
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		await f.session.prompt("/swap-editor");
		assert.notEqual(f.internal.editor, f.internal.defaultEditor);
		assert.match(f.internal.editor.render(120).join("\n"), /已添加 · 未发送/);
		f.input.write("\x7f"); assert.equal(f.internal.imageDraft.items.length, 0);
		f.internal.readClipboardImageForPaste = async () => ({ bytes: pngFixture(8, 8) });
		f.input.write("\x1b[200~\x1b[201~"); await settled(f);
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		assert.equal(f.internal.imageDraft.items.length, 2);
		assert.match(f.internal.editor.render(120).join("\n"), /已粘贴 · 未发送/);
		f.input.write("\x1b[D\x1b[3~"); assert.equal(f.internal.imageDraft.items.length, 1);
		rightClick(f); await settled(f);
		assert.equal(f.internal.imageDraft.items.length, 2);
		f.input.write("\x7f"); assert.equal(f.internal.imageDraft.items.length, 1);
		await frame(f); assert.equal(f.painted.unsent, true); assert.equal(f.counts.main + f.counts.vision, 0);
		const id = f.internal.imageDraft.items[0].id;
		await f.session.prompt("/default-editor");
		assert.match(await frame(f), /已粘贴 · 未发送/);
		await f.internal.editor.onSubmit("remaining image");
		assert.equal(f.counts.main, 1); assert.equal(f.counts.vision, auxiliary ? 1 : 0);
		assert.equal((f.session.messages.find((m: any) => m.imageSubmission) as any).imageSubmission.attachments[0].id, id);
	} finally { await f.release(); }
});

test("non-CustomEditor keeps the host attachment fallback through dialog restoration", async () => {
	const f = await mounted(false, "fullscreen", { extensions: [(pi: any) => {
		pi.registerCommand("plain-editor", { handler: async (_args: string, ctx: any) => ctx.ui.setEditorComponent((ui: any, theme: any) => new Editor(ui, theme)) });
		pi.registerCommand("question-dialog", { handler: async (_args: string, ctx: any) => { await ctx.ui.select("Question", ["One", "Two"]); } });
	}] });
	let dialog: Promise<void> | undefined;
	try {
		await f.session.prompt("/plain-editor");
		f.internal.readClipboardImageForPaste = async () => ({ bytes: pngFixture(8, 8) });
		rightClick(f); await settled(f);
		await frame(f); assert.equal(f.painted.unsent, true);
		assert.match(f.internal.fallbackAttachmentText.render(120).join("\n"), /已粘贴 · 未发送/);
		dialog = f.session.prompt("/question-dialog"); await turn(); f.input.write("\x1b"); await dialog;
		assert.equal(f.internal.renderer.getFocusedComponent(), f.internal.editor);
		f.painted.unsent = false; await frame(f); assert.equal(f.painted.unsent, true);
		await f.internal.editor.onSubmit("/image-remove 1"); assert.equal(f.internal.imageDraft.items.length, 0);
		assert.equal(f.internal.fallbackAttachmentText.render(120).length, 0);
	} finally { f.input.write("\x1b"); await dialog; await f.release(); }
});

test("clipboard text path fallback stays in its admitted operation", async () => {
	const f = await mounted();
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.internal.readClipboardImageForPaste = async () => null;
		f.internal.readClipboardTextForPaste = async () => `"${path}"`;
		f.input.write("\x16"); await settled(f);
		assert.equal(f.internal.imageDraft.items.length, 1);
		assert.equal(f.internal.imageDraft.items[0].state, "ready");
		assert.equal(f.internal.editor.getText(), ""); assert.equal(f.counts.main + f.counts.vision, 0);
	} finally { await f.release(); }
});

for (const withImage of [false, true]) test(`Enter during clipboard text fallback retains input (existing image=${withImage})`, async () => {
	const f = await mounted(); const text = deferred<string>();
	try {
		if (withImage) {
			const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
			f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		}
		f.internal.readClipboardImageForPaste = async () => null;
		f.internal.readClipboardTextForPaste = () => text.promise;
		let normalRun: Promise<void> | undefined;
		f.internal.onInputCallback = (value: string) => { normalRun = f.session.prompt(value); };
		f.input.write("question"); f.input.write("\x16"); await turn();
		let submitted: Promise<void> | undefined; const submit = f.internal.editor.onSubmit;
		f.internal.editor.onSubmit = (value: string) => submitted = submit(value);
		f.input.write("\r"); await submitted;
		assert.equal(f.counts.main, 0); assert.equal(f.internal.editor.getText(), "question");
		text.resolve(" clipboard text"); await settled(f);
		assert.equal(f.internal.editor.getText(), "question clipboard text");
		assert.equal(f.counts.main, 0);
		f.input.write("\r"); await submitted; await normalRun; assert.equal(f.counts.main, 1);
	} finally { text.resolve(""); await settled(f); await f.release(); }
});

for (const fallback of [false, true]) test(`right-click completion respects focus ownership (text=${fallback})`, async () => {
	const f = await mounted(false, "fullscreen"), image = deferred<any>(), text = deferred<string>();
	try {
		f.internal.readClipboardImageForPaste = () => image.promise;
		f.internal.readClipboardTextForPaste = () => text.promise;
		f.input.write("original"); rightClick(f);
		if (fallback) { image.resolve(null); await turn(); }
		const selector = { render: () => ["waiting for user"], handleInput() {} };
		f.internal.ui.setFocus(selector);
		image.resolve({ bytes: pngFixture(8, 8) }); text.resolve("unexpected"); await settled(f);
		assert.equal(f.internal.editor.getText(), "original");
		assert.equal(f.internal.imageDraft.items.length, 0);
		assert.equal(f.internal.renderer.getFocusedComponent(), selector);
		assert.equal(f.counts.main + f.counts.vision, 0);
	} finally { image.resolve(null); text.resolve(""); await settled(f); await f.release(); }
});

test("clipboard and local-file input share one bounded preparation admission", async () => {
	const f = await mounted(), image = deferred<any>(); let reads = 0;
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.internal.readClipboardImageForPaste = () => { reads++; return image.promise; };
		f.input.write(`\x1b[200~"${path}"\x1b[201~`);
		f.input.write("\x16"); assert.equal(reads, 0);
		await settled(f); assert.equal(f.internal.imageDraft.items[0].state, "ready");
		f.input.write("\x16"); assert.equal(reads, 1);
		f.input.write(`\x1b[200~"${path}"\x1b[201~`);
		await f.internal.editor.onSubmit(`/image "${path}"`);
		assert.equal(f.internal.imageDraft.items.length, 2);
		image.resolve({ bytes: pngFixture(8, 8) }); await settled(f);
		assert.deepEqual(f.internal.imageDraft.items.map((item: any) => item.state), ["ready", "ready"]);
		assert.equal(f.counts.main + f.counts.vision, 0);
	} finally { image.resolve(null); await settled(f); await f.release(); }
});

test("legacy image-remove aborts the same clipboard operation as placeholder deletion", async () => {
	const f = await mounted();
	try {
		let signal!: AbortSignal;
		f.internal.readClipboardImageForPaste = () => new Promise(resolve => {
			signal = f.internal.clipboardAbort.signal; signal.addEventListener("abort", () => resolve(null), { once: true });
		});
		f.input.write("\x16"); await f.internal.editor.onSubmit("/image-remove 1");
		assert.equal(signal.aborted, true); await settled(f);
		assert.equal(f.internal.imageDraft.items.length, 0);
		f.internal.readClipboardImageForPaste = async () => ({ bytes: pngFixture(8, 8) });
		f.input.write("\x16"); await settled(f); assert.equal(f.internal.imageDraft.items[0].state, "ready");
	} finally { f.internal.clipboardAbort?.abort(); await settled(f); await f.release(); }
});

for (const compacting of [false, true]) test(`Alt+Enter extension command retains image draft (compacting=${compacting})`, async () => {
	const entered = deferred<void>(), resume = deferred<void>(); let commands = 0;
	const f = await mounted(false, "regular", { beforeWireResponse: async () => { entered.resolve(); await resume.promise; }, extensions: [(pi: any) => {
		pi.registerCommand("draft-command", { handler: async () => { commands++; } });
	}] });
	let running: Promise<void> | undefined;
	try {
		running = f.session.prompt("running"); await entered.promise;
		if (compacting) Object.defineProperty(f.session, "isCompacting", { configurable: true, get: () => true });
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		const id = f.internal.imageDraft.items[0].id;
		let followed: Promise<void> | undefined; const followUp = f.internal.handleFollowUp.bind(f.internal);
		f.internal.handleFollowUp = () => followed = followUp();
		f.input.write("/draft-command"); f.input.write("\x1b\r"); await followed;
		assert.equal(commands, 1); assert.equal(f.internal.imageDraft.items[0]?.id, id);
		assert.equal(f.session.pendingMessageCount, 0); assert.equal(f.internal.compactionQueuedMessages.length, 0);
		assert.equal(f.internal.imageSubmissionRecovery, undefined); assert.match(await frame(f), /未发送/);
	} finally { if (compacting) delete (f.session as any).isCompacting; resume.resolve(); await running; await f.release(); }
});

for (const id of ["", "  ", 42, null, "duplicate"]) test(`SDK rejects invalid attachment identity ${JSON.stringify(id)} before queue admission`, async () => {
	const f = await mounted();
	try {
		const image = { type: "image" as const, mimeType: "image/png", data: pngFixture(8, 8).toString("base64") };
		const submitted = snapshotImageSubmission([image, image]);
		(submitted.submission.attachments[0] as any).id = id;
		if (id === "duplicate") submitted.submission.attachments[1].id = id;
		await assert.rejects(f.session.prompt("invalid IDs", submitted), /attachment ID/i);
		assert.equal(f.counts.main + f.counts.vision, 0); assert.equal(f.session.pendingMessageCount, 0);
		assert.equal(f.session.messages.filter(m => m.role === "user").length, 0);
	} finally { await f.release(); }
});

for (const change of ["focus", "editor", "clear"] as const) test(`clipboard path fallback releases only its own files after ${change}`, async () => {
	const f = await mounted(false, "fullscreen"), entered = deferred<void>(), resume = deferred<void>();
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		const original = f.internal.imageDraft.items[0];
		// Gate actual file I/O, leaving the clipboard/owner/Worker chain intact.
		const fs = createRequire(import.meta.url)("node:fs/promises"); const open = fs.open;
		let gated = false;
		fs.open = async (...args: any[]) => {
			const handle = await open(...args); const read = handle.read;
			handle.read = async function (...values: any[]) { if (!gated) { gated = true; entered.resolve(); await resume.promise; } return read.apply(this, values); };
			return handle;
		}; syncBuiltinESMExports();
		try {
			f.internal.readClipboardImageForPaste = async () => null;
			f.internal.readClipboardTextForPaste = async () => `"${path}" "${path}"`;
			f.input.write("keep text"); rightClick(f); await entered.promise;
			if (change === "focus") f.internal.ui.setFocus({ render: () => ["dialog"], handleInput() {} });
			if (change === "editor") f.internal.setCustomEditorComponent((ui: any, theme: any, keys: any) => new CustomEditor(ui, theme, keys));
			if (change === "clear") { f.internal.clipboardAbort.abort(); f.internal.imageDraft.clear(); f.input.write(" next"); }
			resume.resolve(); await settled(f);
			assert.deepEqual(f.internal.imageDraft.items.map((i: any) => i.id), change === "clear" ? [] : [original.id]);
			assert.equal(f.internal.editor.getText(), change === "clear" ? "keep text next" : "keep text");
			assert.equal(f.counts.main + f.counts.vision, 0); assert.deepEqual(readFileSync(path), pngFixture(8, 8));
		} finally { resume.resolve(); fs.open = open; syncBuiltinESMExports(); await settled(f); }
	} finally { resume.resolve(); await f.release(); }
});

test("real auxiliary description preserves safe line breaks live and from saved entries", async () => {
	const f = await mounted(true, "regular", { visionText: "OCR row one\r\nOCR row two\n\x1b[2J\x9b31m\u202eunsafe" });
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(8, 8));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		await f.internal.editor.onSubmit("read rows");
		const entry: any = f.session.sessionManager.getBranch().find((e: any) => e.customType === "image-vision-result-v1");
		assert.match(entry.data.description, /OCR row one\r\nOCR row two/);
		for (const saved of [entry, SessionManager.open(f.session.sessionManager.getSessionFile()!).getBranch().find((e: any) => e.customType === "image-vision-result-v1")]) {
			f.internal.chatContainer.clear(); f.internal.addCustomEntryToChat(saved);
			const lines: string[] = f.internal.chatContainer.render(200);
			const first = lines.findIndex(line => line.includes("OCR row one"));
			assert.ok(first >= 0); assert.ok(lines.findIndex(line => line.includes("OCR row two")) > first);
			assert.doesNotMatch(lines.join("\n"), /\x1b\[2J|\x9b|\u202e/);
		}
		assert.equal(f.counts.vision, 1); assert.equal(f.counts.main, 1);
	} finally { await f.release(); }
});

for (const change of ["focus", "editor", "clear"] as const) test(`clipboard path fallback rechecks ${change} across actual Worker decoding`, async () => {
	const f = await mounted(false, "fullscreen"); let changed = false, exits = 0;
	try {
		const path = join(f.root, "fixture.png"); writeFileSync(path, pngFixture(1920, 1080));
		f.input.write(`\x1b[200~"${path}"\x1b[201~`); await settled(f);
		const original = f.internal.imageDraft.items[0];
		const project = f.internal.imageDraft.changed;
		f.internal.imageDraft.changed = () => {
			if (changed) assert.ok(f.internal.imageDraft.items.every((item: any) => item === original || item.state !== "ready"), "stale attachments never publish ready state");
			project();
		};
		f.internal.imageDraft.decodeObserver = (event: any) => {
			if (event.type === "worker-exit") { assert.equal(event.active, 0); exits++; }
			if (event.type !== "decode-start" || changed) return;
			changed = true;
			if (change === "focus") f.internal.ui.setFocus({ render: () => ["dialog"], handleInput() {} });
			if (change === "editor") f.internal.setCustomEditorComponent((ui: any, theme: any, keys: any) => new CustomEditor(ui, theme, keys));
			if (change === "clear") { f.internal.clipboardAbort.abort(); f.internal.imageDraft.clear(); f.input.write("next draft"); }
		};
		f.internal.readClipboardImageForPaste = async () => null;
		f.internal.readClipboardTextForPaste = async () => `"${path}" "${path}"`;
		rightClick(f); await settled(f);
		assert.equal(changed, true); assert.equal(exits, 1);
		assert.deepEqual(f.internal.imageDraft.items.map((i: any) => i.id), change === "clear" ? [] : [original.id]);
		assert.equal(f.internal.editor.getText(), change === "clear" ? "next draft" : "");
		assert.equal(f.counts.main + f.counts.vision, 0);
	} finally { await f.release(); }
});
