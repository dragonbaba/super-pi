import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../packages/tui/src/keybindings.ts";
import type { Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../packages/tui/src/tui-alt-screen.ts";
import { STARTUP_DIALOG_SCREEN_OPTIONS } from "../packages/coding-agent/src/cli/startup-ui.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const RIGHT_CLICK = "\x1b[<2;5;3M";

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

class FocusedSelector implements Component {
	readonly received: string[] = [];
	focused = false;
	handleInput(data: string): void { this.received.push(data); }
	render(): string[] { return ["selector"]; }
	invalidate(): void {}
}

async function withScreen(
	options: TuiAltScreenOptions,
	run: (terminal: InputTerminal, selector: FocusedSelector) => void,
): Promise<void> {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const terminal = new InputTerminal(60, 10);
	const tui = new TuiAltScreen(terminal, false, undefined, options);
	try {
		tui.addChild({ render: () => Array.from({ length: 30 }, (_, row) => `row ${row}`), invalidate() {} });
		const selector = new FocusedSelector();
		tui.addChild(selector);
		tui.setFocus(selector);
		tui.start();
		tui.renderNow();
		run(terminal, selector);
	} finally {
		await tui.dispose();
		setKeybindings(previous);
	}
}

test("startup dialogs leave paging keys to the focused selector and the mouse to the terminal", async () => {
	assert.deepEqual({ ...STARTUP_DIALOG_SCREEN_OPTIONS }, { mouse: false, viewportKeys: false });
	await withScreen(STARTUP_DIALOG_SCREEN_OPTIONS, (terminal, selector) => {
		assert.doesNotMatch(terminal.writes.join(""), /\x1b\[\?100[0-6]h/, "no mouse reporting is enabled");
		terminal.onInput?.(PAGE_UP);
		terminal.onInput?.(PAGE_DOWN);
		assert.deepEqual(selector.received, [PAGE_UP, PAGE_DOWN]);
	});

	for (const path of ["packages/coding-agent/src/cli/startup-ui.ts", "packages/coding-agent/src/cli/config-selector.ts"]) {
		assert.match(readFileSync(path, "utf8"), /new TuiAltScreen\([\s\S]{0,160}STARTUP_DIALOG_SCREEN_OPTIONS\s*,?\s*\)/, path);
	}
});

test("the default fullscreen viewport still owns paging keys and mouse input", async () => {
	await withScreen({}, (terminal, selector) => {
		assert.match(terminal.writes.join(""), /\x1b\[\?1006h/);
		terminal.onInput?.(PAGE_UP);
		terminal.onInput?.(PAGE_DOWN);
		terminal.onInput?.(RIGHT_CLICK);
		assert.deepEqual(selector.received, []);
	});
});
