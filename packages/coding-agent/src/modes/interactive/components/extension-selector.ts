/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, RELEASE_COMPONENT_RENDER_CACHE, Spacer, Text, type TUI, wrapTextWithAnsi, truncateToWidth } from "@super-pi/tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	details?: string;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private details: string | undefined;
	private detailHeader = "";
	private detailChoices: string[] = [];
	private detailLines: string[] = [];
	private detailWidth = -1;
	private detailOffset = 0;
	private viewportRows = 0;
	private terminal: TUI["terminal"] | undefined;
	private disposed = false;
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.details = opts?.details === undefined ? undefined : sanitizeDialogText(opts.details);
		this.terminal = opts?.tui?.terminal;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = this.details === undefined ? title : sanitizeDialogText(title);
		if (this.details !== undefined) {
			this.detailHeader = this.baseTitle.split("\n", 1)[0]!;
			this.detailChoices = options.map(sanitizeDialogText);
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	render(width: number): string[] {
		if (this.details === undefined) return super.render(width);
		const rows = Math.max(1, this.terminal?.rows ?? 24);
		if (rows < 6 || width < 16) {
			this.viewportRows = 0;
			return [truncateToWidth("Terminal too small; Esc cancels", Math.max(1, width))];
		}
		if (width !== this.detailWidth) {
			this.detailLines = wrapTextWithAnsi(this.details, Math.max(1, width - 2));
			this.detailWidth = width;
		}
		this.viewportRows = Math.max(1, rows - 5);
		this.detailOffset = Math.max(0, Math.min(this.detailOffset, this.detailLines.length - this.viewportRows));
		const lines = [truncateToWidth(this.detailHeader, width)];
		for (let i = this.detailOffset; i < Math.min(this.detailLines.length, this.detailOffset + this.viewportRows); i++) {
			lines.push(` ${this.detailLines[i]}`);
		}
		lines.push(truncateToWidth(`Details ${this.detailOffset + 1}/${this.detailLines.length} PgUp/PgDn`, width));
		lines.push(truncateToWidth(`→ ${this.detailChoices[this.selectedIndex] ?? ""} (${this.selectedIndex + 1}/${this.options.length})`, width));
		lines.push(truncateToWidth("↑↓ choice; Enter select; Esc cancel", width));
		return lines;
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		if (this.disposed) return;
		if (this.details !== undefined) {
			if (keyData === "\x1b[5~" || keyData === "\x1b[6~") {
				this.detailOffset = Math.max(0, this.detailOffset + (keyData === "\x1b[5~" ? -1 : 1) * Math.max(1, this.viewportRows));
				return;
			}
			if ((this.terminal?.rows ?? 24) < 6 || (this.terminal?.columns ?? 80) < 16) {
				if (getKeybindings().matches(keyData, "tui.select.cancel")) this.onCancelCallback();
				return;
			}
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			if (this.details === undefined) this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			if (this.details === undefined) this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		this.onSelectCallback = ignoreClosedDialog;
		this.onCancelCallback = ignoreClosedDialog;
		this.titleText.setText("");
		this.baseTitle = "";
		this.disposed = true;
		this.details = undefined;
		this.detailLines = [];
		this.detailChoices = [];
		this.detailHeader = "";
		this.options = [];
		this.terminal = undefined;
		this.onToggleToolsExpanded = undefined;
	}

	cancel(): void {
		const cancel = this.onCancelCallback;
		this.dispose();
		cancel();
	}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.dispose();
	}
}

// Keep newlines for inspection, escape terminal/control and bidi instructions.
function sanitizeDialogText(value: string): string {
	return value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function ignoreClosedDialog(): void {}
