import { type ExecFileSyncOptionsWithStringEncoding, execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { runClipboardCommand, isWaylandSession, isWSL } from "./clipboard-image.ts";
import { clipboard, type ClipboardModule } from "./clipboard-native.ts";
import { NativeClipboardError, readNativeClipboard } from "./clipboard-native-process.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;
const WSL_FILE_PATH_TIMEOUT_MS = 1000;
const WSL_FILE_PATH_MAX_BYTES = 32768;
// Explorer's Copy stores FileDrop (CF_HDROP), often without text or bitmap data.
// Serialize that list for the existing path-paste parser; never evaluate its contents.
const WINDOWS_TEXT_SCRIPT = [
	"$ErrorActionPreference='Stop'",
	"Add-Type -AssemblyName System.Windows.Forms",
	"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
	"$data=[System.Windows.Forms.Clipboard]::GetDataObject()",
	"if ($null -eq $data) { return }",
	"$text=[string]$data.GetData([System.Windows.Forms.DataFormats]::UnicodeText)",
	"if ($text.Length -gt 0) { [Console]::Out.Write($text); return }",
	"if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $quote=[string][char]34; $paths=@($data.GetData([System.Windows.Forms.DataFormats]::FileDrop)); $quoted=$paths | ForEach-Object { $value=[string]$_; $quote + $value.Replace($quote, $quote + $quote) + $quote }; [Console]::Out.Write($quoted -join ' ') }",
].join("; ");
const WINDOWS_TEXT_COMMAND = Buffer.from(WINDOWS_TEXT_SCRIPT, "utf16le").toString("base64");

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

type ClipboardReadResult = { ok: true; text: string | null } | { ok: false };

type ClipboardTextReadOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	powerShellRead?: typeof runClipboardCommand;
	wslPathRead?: typeof runClipboardCommand;
	nativeRead?: typeof readNativeClipboard;
	directClipboard?: ClipboardModule | null;
};

const READ_CLIPBOARD_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	maxBuffer: 50 * 1024 * 1024,
	timeout: 5000,
};

function readWaylandClipboardText(): ClipboardReadResult {
	try {
		const text = execFileSync("wl-paste", ["--no-newline", "--type", "text"], READ_CLIPBOARD_OPTIONS);
		return { ok: true, text: text || null };
	} catch {
		return { ok: false };
	}
}

function splitQuotedFileDropPaths(text: string): string[] | null {
	if (!text || text.length > 32768) return null;
	const paths: string[] = [];
	let offset = 0;
	while (offset < text.length) {
		while (text[offset] === " " || text[offset] === "\t") offset++;
		if (offset === text.length || text[offset] !== '"') return null;
		offset++;
		let value = "";
		let closed = false;
		while (offset < text.length) {
			const char = text[offset++];
			if (char === '"') {
				if (text[offset] === '"') { value += '"'; offset++; continue; }
				closed = true;
				break;
			}
			value += char;
		}
		if (!closed || !value) return null;
		paths.push(value);
		if (paths.length > 8) return null;
	}
	return paths.length ? paths : null;
}

function trimLineEnd(value: string): string {
	let end = value.length;
	while (end > 0 && (value[end - 1] === "\r" || value[end - 1] === "\n")) end--;
	return value.slice(0, end);
}

async function translateWslFileDropPaths(text: string, signal: AbortSignal | undefined, readPath: typeof runClipboardCommand): Promise<string> {
	const paths = splitQuotedFileDropPaths(text);
	if (!paths) return text;
	const translated: string[] = [];
	try {
		for (const path of paths) {
			signal?.throwIfAborted();
			const output = await readPath("wslpath", ["-u", path], { timeoutMs: WSL_FILE_PATH_TIMEOUT_MS, maxBufferBytes: WSL_FILE_PATH_MAX_BYTES, signal });
			const translatedPath = trimLineEnd(output.toString("utf8"));
			if (!translatedPath || translatedPath.includes("\r") || translatedPath.includes("\n")) return text;
			translated.push(`"${translatedPath.replaceAll('"', '""')}"`);
		}
		return translated.join(" ");
	} catch (error) {
		if (signal?.aborted) throw error;
		return text;
	}
}

/** Read text, or a quoted Windows file list for the existing path-paste fallback. */
export async function readClipboardText(signal?: AbortSignal, options: ClipboardTextReadOptions = {}): Promise<string | null> {
	signal?.throwIfAborted();
	const currentPlatform = options.platform ?? platform();
	const environment = options.env ?? process.env;
	const powerShellRead = options.powerShellRead ?? runClipboardCommand;
	const wslPathRead = options.wslPathRead ?? runClipboardCommand;
	const nativeRead = options.nativeRead ?? readNativeClipboard;
	const directClipboard = options.directClipboard ?? clipboard;
	const wsl = currentPlatform === "linux" && isWSL(environment);
	if (currentPlatform === "linux" && isWaylandSession(environment) && environment.WAYLAND_DISPLAY) {
		const result = readWaylandClipboardText();
		if (result.ok) {
			return result.text;
		}
	}

	if (currentPlatform === "win32" || wsl) {
		try {
			const bytes = await powerShellRead("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", WINDOWS_TEXT_COMMAND], { maxBufferBytes: 1024 * 1024, signal });
			const text = bytes.toString("utf8");
			return text ? wsl ? await translateWslFileDropPaths(text, signal, wslPathRead) : text : null;
		} catch (error) { if (signal?.aborted) throw error; }
	}
	if (currentPlatform === "win32") {
		try { return (await nativeRead("text", signal))?.toString("utf8") || null; }
		catch (error) { if (signal?.aborted || (error instanceof NativeClipboardError && error.fatal)) throw error; }
	}
	if (!directClipboard) return null;

	try {
		const text = await directClipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// Verify wl-copy exists (spawn errors are async and won't be caught)
							execSync("which wl-copy", { stdio: "ignore" });
							// wl-copy with execSync hangs due to fork behavior; use spawn instead.
							// Await the exit code and only claim success on a clean exit, so a
							// failed wl-copy falls through to the xclip/OSC 52 fallbacks.
							const wlCopyExit = await new Promise<number>((resolve) => {
								const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
								proc.on("error", () => resolve(1));
								proc.on("close", (code) => resolve(code ?? 1));
								proc.stdin.on("error", () => {
									// Ignore EPIPE errors if wl-copy exits early
								});
								proc.stdin.write(text);
								proc.stdin.end();
							});
							if (wlCopyExit === 0) {
								copied = true;
							} else if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
