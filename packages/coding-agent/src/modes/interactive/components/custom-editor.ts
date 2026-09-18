import { Text, Editor, CURSOR_MARKER, type EditorOptions, type EditorTheme, type TUI } from "@super-pi/tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private readonly attachmentText = new Text("", 0, 0);
	private hasAttachments = false;
	// IDs only: the draft remains the sole owner of image bytes and preparation.
	private readonly attachmentIds: string[] = [];
	selectedAttachmentId: string | undefined;
	onAttachmentSelectionChange?: () => void;
	onRemoveAttachment?: (id: string) => void;
	setAttachmentIds(items: readonly { id: string }[]): void {
		this.attachmentIds.length = items.length;
		for (let i = 0; i < items.length; i++) this.attachmentIds[i] = items[i].id;
		if (this.selectedAttachmentId && !this.attachmentIds.includes(this.selectedAttachmentId)) this.selectedAttachmentId = undefined;
	}
	setAttachmentText(text: string): void { this.hasAttachments = text.length > 0; this.attachmentText.setText(text); }
	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.hasAttachments) return lines;
		const attachments = this.attachmentText.render(width);
		const result = attachments.concat(lines);
		// The host emits the cursor with the selected ID's UI projection. Never infer
		// cursor ownership from a filename or a wrapped line that resembles a marker.
		for (let i = 0; i < result.length; i++) {
			if (!this.focused || (this.selectedAttachmentId && i >= attachments.length)) result[i] = result[i].replace(CURSOR_MARKER, "");
		}
		return result;
	}
	override setText(text: string): void {
		this.selectAttachment(undefined);
		super.setText(text);
	}
	private selectAttachment(id: string | undefined): void {
		if (this.selectedAttachmentId === id) return;
		this.selectedAttachmentId = id;
		this.onAttachmentSelectionChange?.();
	}
	private handleAttachmentInput(data: string): boolean {
		if (this.attachmentIds.length === 0 || this.isShowingAutocomplete()) return false;
		const backward = this.keybindings.matches(data, "tui.editor.deleteCharBackward");
		const forward = this.keybindings.matches(data, "tui.editor.deleteCharForward");
		const left = this.keybindings.matches(data, "tui.editor.cursorLeft");
		const right = this.keybindings.matches(data, "tui.editor.cursorRight");
		const selected = this.selectedAttachmentId;
		if (selected) {
			const index = this.attachmentIds.indexOf(selected);
			if (backward || forward) {
				this.onRemoveAttachment?.(selected);
				this.selectAttachment(this.attachmentIds[Math.max(0, index - (backward ? 1 : 0))]);
				return true;
			}
			if (left || right) {
				this.selectAttachment(left ? this.attachmentIds[Math.max(0, index - 1)] : this.attachmentIds[index + 1]);
				return true;
			}
			if (this.keybindings.matches(data, "app.interrupt")) { this.selectAttachment(undefined); return true; }
			this.selectAttachment(undefined);
		} else if (this.isCursorAtStart()) {
			const last = this.attachmentIds[this.attachmentIds.length - 1];
			if (backward) { this.onRemoveAttachment?.(last); return true; }
			if (left) { this.selectAttachment(last); return true; }
		}
		return false;
	}
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		if (this.handleAttachmentInput(data)) return;

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Some terminals deliver a complete path paste without bracket markers.
		// Single keystrokes and escape sequences never enter the attachment parser.
		if (data.length > 1 && !data.includes("\x1b") && this.onPaste?.(data)) return;

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
