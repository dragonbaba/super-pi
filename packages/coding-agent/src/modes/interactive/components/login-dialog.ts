import { stripVTControlCharacters } from "node:util";
import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@super-pi/ai";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@super-pi/tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

const LOGIN_URL_CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const LOGIN_TEXT_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const LOGIN_NEWLINE_PATTERN = /\r\n?/g;

/** Validate once at the login boundary, before display, copy or launch. */
function parseLoginUrl(value: string): string {
	if (LOGIN_URL_CONTROL_PATTERN.test(value)) {
		throw new Error("Login URL must not contain control characters.");
	}
	const url = URL.parse(value);
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
		throw new Error("Login URL must be an absolute HTTP or HTTPS URL.");
	}
	return url.href;
}

/** Provider text is plain text; application styling is added afterwards. */
function sanitizeLoginText(value: string): string {
	return stripVTControlCharacters(value).replace(LOGIN_NEWLINE_PATTERN, "\n").replace(LOGIN_TEXT_CONTROL_PATTERN, "");
}

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: ((success: boolean, message?: string) => void) | undefined;
	private authUrl: string | undefined;
	private authUrlHint: Text | undefined;
	private copyInProgress = false;
	private readonly copyText: (text: string) => Promise<void>;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
		copyText: (text: string) => Promise<void> = copyToClipboard,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;
		this.copyText = copyText;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(sanitizeLoginText(title))), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private replaceInputWithSubmittedText(value: string): void {
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	cancel(): void {
		this.clearAuthUrl();
		if (this.abortController.signal.aborted) return;
		const onComplete = this.onComplete;
		this.onComplete = undefined;
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		onComplete?.(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		url = parseLoginUrl(url);
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.setAuthUrl(url);

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", sanitizeLoginText(instructions)), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		const url = parseLoginUrl(info.verificationUri);
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.setAuthUrl(url);
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${sanitizeLoginText(info.userCode)}`), 1, 0));

		this.tui.requestRender();
	}

	/** Release the copy target when the login owner finishes or replaces this step. */
	clearAuthUrl(): void {
		this.authUrl = undefined;
		this.authUrlHint = undefined;
	}

	private setAuthUrl(url: string): void {
		this.authUrl = url;
		this.authUrlHint = new Text(theme.fg("dim", keyHint("app.message.copy", "to copy login URL")), 1, 0);
		this.contentContainer.addChild(this.authUrlHint);
	}

	private async copyAuthUrl(): Promise<void> {
		const url = this.authUrl;
		const hint = this.authUrlHint;
		if (!url || !hint) return;
		this.copyInProgress = true;
		let copied = false;
		try {
			await this.copyText(url);
			copied = true;
		} catch {
			// Clipboard failure must not abort the authentication flow.
		} finally {
			this.copyInProgress = false;
		}
		if (this.authUrlHint !== hint || this.signal.aborted) return;
		hint.setText(theme.fg(copied ? "dim" : "warning", copied ? "Login URL copied." : "Could not copy login URL."));
		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.input.setValue("");
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", sanitizeLoginText(prompt)), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", sanitizeLoginText(message)), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${sanitizeLoginText(placeholder)}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** Show informational text before another login step. */
	showDetails(lines: string[]): void {
		this.clearAuthUrl();
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.tui.requestRender();
	}

	/** Show provider-owned information and links without starting an auth callback flow. */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", sanitizeLoginText(message)), 1, 0));
		for (const link of links) {
			const url = parseLoginUrl(link.url);
			const text = link.label ? `${sanitizeLoginText(link.label)}: ${url}` : url;
			const hyperlink = `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", sanitizeLoginText(message)), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", sanitizeLoginText(message)), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.signal.aborted) return;
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		if (this.authUrl && kb.matches(data, "app.message.copy")) {
			if (!this.copyInProgress) void this.copyAuthUrl();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
