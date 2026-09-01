/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@super-pi/tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private externalEditorCommand: string;
	private onExternalEditorError: ((error: unknown) => void) | undefined;
	private lifecycleGeneration = 0;
	private nextExternalEditorGeneration = 0;
	private activeExternalEditorGeneration = 0;
	private settled = false;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
		externalEditorCommand?: string,
		onExternalEditorError?: (error: unknown) => void,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.externalEditorCommand =
			externalEditorCommand ||
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "nano");
		this.onExternalEditorError = onExternalEditorError;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Create editor
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			if (this.settled) return;
			this.settled = true;
			this.lifecycleGeneration++;
			this.activeExternalEditorGeneration = 0;
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			`  ${keyHint("app.editor.external", "external editor")}`;
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// External editor (app keybinding)
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			void this.handleOpenExternalEditor();
			return;
		}

		// Forward to editor
		this.editor.handleInput(keyData);
	}

	cancel(): void {
		if (this.settled) return;
		this.settled = true;
		this.lifecycleGeneration++;
		this.activeExternalEditorGeneration = 0;
		this.onCancelCallback();
	}

	protected openExternalEditor(content: string): ReturnType<typeof editInExternalEditor> {
		return editInExternalEditor({
			command: this.externalEditorCommand,
			content,
		});
	}

	private async handleOpenExternalEditor(): Promise<void> {
		if (this.settled || this.activeExternalEditorGeneration !== 0) return;
		const lifecycleGeneration = this.lifecycleGeneration;
		const taskGeneration = ++this.nextExternalEditorGeneration;
		this.activeExternalEditorGeneration = taskGeneration;
		const content = this.editor.getText();
		let terminalStopped = false;
		try {
			await this.tui.stop();
			terminalStopped = true;
			if (
				this.settled ||
				lifecycleGeneration !== this.lifecycleGeneration ||
				taskGeneration !== this.activeExternalEditorGeneration
			) return;
			const result = await this.openExternalEditor(content);
			if (
				this.settled ||
				lifecycleGeneration !== this.lifecycleGeneration ||
				taskGeneration !== this.activeExternalEditorGeneration
			) return;
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} catch (error) {
			if (
				!this.settled &&
				lifecycleGeneration === this.lifecycleGeneration &&
				taskGeneration === this.activeExternalEditorGeneration
			) {
				this.onExternalEditorError?.(error);
			}
		} finally {
			if (
				!this.settled &&
				lifecycleGeneration === this.lifecycleGeneration &&
				taskGeneration === this.activeExternalEditorGeneration
			) {
				this.activeExternalEditorGeneration = 0;
				if (terminalStopped) {
					this.tui.start();
					this.tui.requestRender(true);
				}
			}
		}
	}
}
