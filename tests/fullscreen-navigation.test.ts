import assert from "node:assert/strict";
import test from "node:test";
import { Input } from "../packages/tui/src/components/input.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingsConfig } from "../packages/tui/src/keybindings.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";
import { alphaSession } from "./helpers/alpha-session.ts";

class InputTerminal extends FakeTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput?: (data: string) => void): void {
		super.start();
		this.onInput = onInput;
	}
	override stop(): void {
		this.onInput = undefined;
		super.stop();
	}
}

async function withInput(
	fullscreen: boolean,
	bindings: KeybindingsConfig,
	run: (tui: TuiAltScreen | TuiMainScreen, terminal: InputTerminal, input: Input) => void,
	hint = false,
): Promise<void> {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
	const terminal = new InputTerminal(60, 10);
	const tui = fullscreen ? new TuiAltScreen(terminal, false, undefined, { scrollToBottomHint: hint }) : new TuiMainScreen(terminal);
	try {
		const input = new Input();
		input.handleInput("abcd");
		tui.addChild({ render: () => Array.from({ length: 24 }, (_, i) => `row ${i}`), invalidate() {} });
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		tui.renderNow();
		run(tui, terminal, input);
	} finally {
		await tui.dispose();
		setKeybindings(previous);
		assert.equal(terminal.started, false);
		assert.equal(terminal.onInput, undefined);
	}
}

test("bottom hint appears only above the tail, accepts clicks, adapts to width and releases its row", async () => {
	let owner: TuiAltScreen;
	await withInput(true, {}, (tui, terminal, input) => {
		assert.ok(tui instanceof TuiAltScreen); owner = tui;
		assert.equal(tui.getBottomHintDiagnostics().row, -1);
		tui.scrollToTop(); tui.renderNow();
		assert.match(terminal.writes.at(-1)!, /Back to bottom/);
		const first = tui.getBottomHintDiagnostics(); assert.ok(first.row >= 0); assert.equal(first.lineReferences, 1);
		for (let frame = 0; frame < 100; frame++) tui.renderNow();
		assert.equal(tui.getBottomHintDiagnostics().materializations, first.materializations);
		const overlay = tui.showOverlay({ render: () => ["dialog"], invalidate() {} }, { width: 12 });
		tui.renderNow(); assert.equal(tui.getBottomHintDiagnostics().lineReferences, 0);
		assert.equal(tui.scrollToBottomIfNeeded(), false); overlay.hide(); tui.renderNow();
		terminal.columns = 18; tui.renderNow(); assert.match(terminal.writes.at(-1)!, /End · Esc/);
		const button = tui.getBottomHintDiagnostics();
		terminal.onInput!(`\x1b[<0;${button.left + 2};${button.row + 1}M`);
		terminal.onInput!(`\x1b[<0;${button.left + 2};${button.row + 1}m`);
		assert.equal(tui.isFollowingOutput, true); tui.renderNow();
		assert.equal(tui.getBottomHintDiagnostics().lineReferences, 0); assert.equal(input.getValue(), "abcd");
		tui.scrollToTop(); terminal.columns = 8; tui.renderNow(); assert.equal(tui.getBottomHintDiagnostics().row, -1);
	}, true);
	assert.equal(owner!.getBottomHintDiagnostics().lineReferences, 0);
});

test("Escape returns to the tail before interrupting and keeps the editor draft", async () => {
	const fixture = await alphaSession({ mode: "fullscreen" });
	const tui = fixture.internal.renderer as TuiAltScreen;
	let interrupts = 0;
	try {
		fixture.internal.setupKeyHandlers();
		fixture.internal.restoreQueuedMessagesToEditor = () => { interrupts++; };
		Object.defineProperty(fixture.session, "isStreaming", { configurable: true, get: () => true });
		const lines = Array.from({ length: 90 }, (_, index) => `history ${index}`);
		tui.addChild({ render: () => lines, invalidate() {} }); tui.start(); tui.renderNow();
		tui.scrollToTop(); tui.renderNow();
		fixture.internal.defaultEditor.setText("unfinished draft");
		fixture.internal.defaultEditor.handleInput("\x1b");
		assert.equal(tui.isFollowingOutput, true); assert.equal(interrupts, 0);
		assert.equal(fixture.internal.defaultEditor.getText(), "unfinished draft");
		fixture.internal.defaultEditor.handleInput("\x1b"); assert.equal(interrupts, 1);
	} finally { await fixture.release(); }
});

for (const operation of ["compaction", "retry"] as const) test(`Escape returns to the tail before cancelling ${operation}`, async t => {
	const fixture = await alphaSession({ mode: "fullscreen" });
	const tui = fixture.internal.renderer as TuiAltScreen; let cancelled = 0;
	try {
		fixture.internal.setupKeyHandlers();
		t.mock.method(fixture.session, operation === "compaction" ? "abortCompaction" : "abortRetry", () => { cancelled++; });
		const lines = Array.from({ length: 90 }, (_, index) => `history ${index}`);
		tui.addChild({ render: () => lines, invalidate() {} }); tui.start(); tui.renderNow();
		await fixture.internal.handleEvent(operation === "compaction"
			? { type: "compaction_start", reason: "manual" }
			: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 });
		tui.scrollToTop(); tui.renderNow();
		fixture.internal.defaultEditor.handleInput("\x1b");
		assert.equal(tui.isFollowingOutput, true); assert.equal(cancelled, 0);
		fixture.internal.defaultEditor.handleInput("\x1b"); assert.equal(cancelled, 1);
	} finally {
		await fixture.internal.handleEvent(operation === "compaction" ? { type: "compaction_end", reason: "manual", aborted: true }
			: { type: "auto_retry_end", success: true });
		await fixture.release();
	}
});

for (const fullscreen of [false, true]) {
	test(`${fullscreen ? "fullscreen" : "main"} Home/End edit the focused input`, async () => {
		await withInput(fullscreen, {}, (_tui, terminal, input) => {
			terminal.onInput!("\x1b[H");
			terminal.onInput!("x");
			assert.equal(input.getValue(), "xabcd");
			terminal.onInput!("\x1b[F");
			terminal.onInput!("y");
			assert.equal(input.getValue(), "xabcdy");
		});
	});
}

test("fullscreen Ctrl+Home/End move the transcript without moving the editor", async () => {
	await withInput(true, {}, (tui, terminal, input) => {
		assert.ok(tui instanceof TuiAltScreen);
		const bottom = tui.viewportTop;
		assert.ok(bottom > 0);
		terminal.onInput!("\x1b[1;5H");
		assert.equal(tui.viewportTop, 0);
		terminal.onInput!("\x1b[1;5F");
		assert.equal(tui.viewportTop, bottom);
		terminal.onInput!("x");
		assert.equal(input.getValue(), "abcdx");
	});
});

test("fullscreen navigation honors explicit legacy key overrides", async () => {
	await withInput(true, {
		"tui.altScreen.top": "home", "tui.altScreen.bottom": "end",
		"tui.editor.cursorLineStart": "ctrl+home", "tui.editor.cursorLineEnd": "ctrl+end",
	}, (tui, terminal, input) => {
		assert.ok(tui instanceof TuiAltScreen);
		const bottom = tui.viewportTop;
		terminal.onInput!("\x1b[H");
		assert.equal(tui.viewportTop, 0);
		terminal.onInput!("\x1b[F");
		assert.equal(tui.viewportTop, bottom);
		terminal.onInput!("\x1b[1;5H");
		terminal.onInput!("x");
		assert.equal(input.getValue(), "xabcd");
		terminal.onInput!("\x1b[1;5F");
		terminal.onInput!("y");
		assert.equal(input.getValue(), "xabcdy");
	});
});

test("explicit editor overrides win without also rebinding viewport defaults", async () => {
	for (const bindings of [{
		"tui.editor.cursorLineStart": "ctrl+home", "tui.editor.cursorLineEnd": "ctrl+end",
	}, JSON.parse('{"tui.editor.cursorLineStart":"CTRL+HOME","tui.editor.cursorLineEnd":"CTRL+END"}')]) {
		await withInput(true, bindings, (tui, terminal, input) => {
			assert.ok(tui instanceof TuiAltScreen);
			const bottom = tui.viewportTop;
			terminal.onInput!("\x1b[1;5H");
			terminal.onInput!("x");
			assert.equal(input.getValue(), "xabcd");
			assert.equal(tui.viewportTop, bottom);
			terminal.onInput!("\x1b[1;5F");
			terminal.onInput!("y");
			assert.equal(input.getValue(), "xabcdy");
		});
	}
});

test("Windows Console Ctrl+Up/Down sequences keep transcript boundaries reachable", async () => {
	await withInput(true, {}, (tui, terminal, input) => {
		assert.ok(tui instanceof TuiAltScreen);
		const bottom = tui.viewportTop;
		assert.ok(bottom > 0);
		terminal.onInput!("\x1b[1;5A");
		assert.equal(tui.viewportTop, 0);
		terminal.onInput!("\x1b[1;5B");
		assert.equal(tui.viewportTop, bottom);
		terminal.onInput!("x");
		assert.equal(input.getValue(), "abcdx");
	});
});
