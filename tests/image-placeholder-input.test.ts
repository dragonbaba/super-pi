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

async function mounted(auxiliary = false, screen: "regular" | "fullscreen" = "regular") {
	const root = mkdtempSync(join(tmpdir(), "sp-placeholder-"));
	const f = await offlineImageRuntime(root, auxiliary);
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
