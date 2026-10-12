import assert from "node:assert/strict";
import test from "node:test";
import { Input } from "../packages/tui/src/components/input.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingsConfig } from "../packages/tui/src/keybindings.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

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
): Promise<void> {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
	const terminal = new InputTerminal(60, 10);
	const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
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
