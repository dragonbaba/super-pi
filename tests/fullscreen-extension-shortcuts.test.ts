import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";
import { KEYBINDINGS, type KeybindingsManager as AppKeybindingsManager } from "../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingsConfig } from "../packages/tui/src/keybindings.ts";
import type { KeyId } from "../packages/tui/src/keys.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class InputTerminal extends FakeTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput?: (data: string) => void): void { super.start(); this.onInput = onInput; }
	override stop(): void { this.onInput = undefined; super.stop(); }
}

class HostKeybindings extends KeybindingsManager {
	getEffectiveConfig(): KeybindingsConfig { return this.getResolvedBindings(); }
}

for (const explicitViewport of [false, true]) {
	test(`accepted extension shortcuts reach the fullscreen editor (${explicitViewport ? "explicit" : "default"} viewport keys)`, async () => {
		initTheme("dark", false);
		const previous = getKeybindings();
		const config: KeybindingsConfig = explicitViewport ? {
			"tui.altScreen.top": ["ctrl+home", "ctrl+up"],
			"tui.altScreen.bottom": ["ctrl+end", "ctrl+down"],
		} : {};
		const keybindings = new HostKeybindings({ ...KEYBINDINGS, ...TUI_KEYBINDINGS }, config);
		const baseline = keybindings.getResolvedBindings();
		setKeybindings(keybindings);
		const terminal = new InputTerminal(60, 10);
		const tui = new TuiAltScreen(terminal);
		const editor = new CustomEditor(tui, getEditorTheme(), keybindings as unknown as AppKeybindingsManager);
		const calls: string[] = [];
		const sequences: [KeyId, string][] = [
			["ctrl+home", "\x1b[1;5H"], ["ctrl+end", "\x1b[1;5F"],
			["ctrl+up", "\x1b[1;5A"], ["ctrl+down", "\x1b[1;5B"], ["pageUp", "\x1b[5~"],
		];
		const shortcuts = new Map([...sequences.map(([key]) => [key, {
			key, extensionPath: "fixture.ts", handler: () => { calls.push(key); },
		}] as const), ["ctrl+c", { key: "ctrl+c", extensionPath: "fixture.ts", handler: () => { calls.push("reserved"); } }] as const]);
		// Exercise real conflict resolution and UI setup without loading an extension file/session.
		const runner: ExtensionRunner = Object.assign(Object.create(ExtensionRunner.prototype), {
			extensions: [{ path: "fixture.ts", shortcuts }], uiContext: {}, modelRegistry: {},
		});
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			keybindings, defaultEditor: editor, createExtensionUIContext: () => ({}),
			runtimeHost: { session: {
				sessionManager: { getCwd: () => process.cwd() }, agent: { signal: AbortSignal.abort() },
			} },
		}) as { setupExtensionShortcuts(runner: ExtensionRunner): void };
		try {
			editor.setText("abcd");
			tui.addChild({ render: () => Array.from({ length: 24 }, (_, i) => `row ${i}`), invalidate() {} });
			tui.addChild(editor); tui.setFocus(editor); tui.start(); tui.renderNow();
			const bottom = tui.viewportTop;
			assert.ok(bottom > 0);
			mode.setupExtensionShortcuts(runner);
			assert.ok(runner.getShortcutDiagnostics().some(item => item.message.includes("'ctrl+c'") && item.message.includes("Skipping")));
			assert.equal(editor.onExtensionShortcut!("\x03"), false, "reserved shortcut was rejected");
			for (const [, data] of sequences) terminal.onInput!(data);
			assert.deepEqual(calls, sequences.map(([key]) => key));
			assert.equal(tui.viewportTop, bottom);
			assert.equal(editor.getText(), "abcd");
			assert.deepEqual(keybindings.getUserBindings(), config);
			// Repeated setup must resolve against unclaimed bindings, with no stale diagnostics.
			mode.setupExtensionShortcuts(runner);
			assert.ok(runner.getShortcutDiagnostics().some(item => item.message.includes("tui.altScreen.top")));
			shortcuts.clear();
			mode.setupExtensionShortcuts(runner);
			assert.equal(editor.onExtensionShortcut, undefined);
			assert.deepEqual(keybindings.getResolvedBindings(), baseline);
			terminal.onInput!("\x1b[1;5H"); assert.equal(tui.viewportTop, 0);
			terminal.onInput!("\x1b[1;5F"); assert.equal(tui.viewportTop, bottom);
		} finally {
			shortcuts.clear(); mode.setupExtensionShortcuts(runner);
			await tui.dispose(); setKeybindings(previous);
			assert.equal(terminal.onInput, undefined);
		}
	});
}
