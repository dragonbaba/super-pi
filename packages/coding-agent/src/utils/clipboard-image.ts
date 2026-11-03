import { execFile, type ExecFileException } from "node:child_process";
import { readFileSync } from "fs";

import { clipboard, type ClipboardModule } from "./clipboard-native.ts";
import { ClipboardImageReadError, NativeClipboardError, readNativeClipboard } from "./clipboard-native-process.ts";
import { loadPhoton } from "./photon.ts";
import { CLIPBOARD_IMAGE_LIMIT_PATTERN, CLIPBOARD_LINE_BREAK_PATTERN, CLIPBOARD_WSL_RELEASE_PATTERN } from "./image-input-regex.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
export const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const WINDOWS_IMAGE_PRESENT_MARKER = "SP_CLIPBOARD_IMAGE_PRESENT";

class ClipboardCommandError extends Error {
	readonly exitCode: ExecFileException["code"];
	readonly imagePresent: boolean;
	constructor(error: ExecFileException, stderr?: Buffer) {
		const diagnostic = stderr?.subarray(0, 4096).toString("utf8") ?? "";
		const imagePresent = diagnostic === WINDOWS_IMAGE_PRESENT_MARKER || diagnostic.startsWith(`${WINDOWS_IMAGE_PRESENT_MARKER}\n`) || diagnostic.startsWith(`${WINDOWS_IMAGE_PRESENT_MARKER}\r\n`);
		const detail = (imagePresent ? diagnostic.slice(WINDOWS_IMAGE_PRESENT_MARKER.length) : diagnostic).trim();
		super(`Clipboard helper failed (${error.code ?? "timeout/busy"}): ${(detail || error.message).slice(0, 300)}`, { cause: error });
		this.exitCode = error.code;
		this.imagePresent = imagePresent;
	}
}

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

export function runClipboardCommand(command: string, args: string[], options: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "buffer", windowsHide: true, timeout: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
			maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES, env: options.env, signal: options.signal },
			(error, stdout, stderr) => { if (error) reject(new ClipboardCommandError(error, stderr)); else resolve(stdout); });
	});
}
async function runCommand(command: string, args: string[], options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<{ stdout: Buffer; ok: boolean }> {
	try { return { stdout: await runClipboardCommand(command, args, options), ok: true }; }
	catch (error) { if (options?.signal?.aborted) throw error; return { stdout: Buffer.alloc(0), ok: false }; }
}

async function readClipboardImageViaWlPaste(signal?: AbortSignal): Promise<ClipboardImage | null> {
	const list = await runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS, signal });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(CLIPBOARD_LINE_BREAK_PATTERN)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = await runCommand("wl-paste", ["--type", selectedType, "--no-newline"], { signal });
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return CLIPBOARD_WSL_RELEASE_PATTERN.test(release);
	} catch {
		return false;
	}
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
// Keep binary image evidence even if extraction hangs and the helper is killed.
// Use one IDataObject for format detection and reading; clipboard text is never
// executable input. PNG streams need not be convertible to Forms' Bitmap format.
const WINDOWS_IMAGE_SCRIPT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$knownImage=$false; $img=$null; $rawStream=$null; $readError=$null
try {
 $data=[System.Windows.Forms.Clipboard]::GetDataObject()
 if ($null -eq $data) { exit 0 }
 foreach ($format in @([System.Windows.Forms.DataFormats]::Bitmap,[System.Windows.Forms.DataFormats]::Dib,([System.Windows.Forms.DataFormats]::GetFormat(17).Name),'PNG','image/png')) {
  if ($data.GetDataPresent($format,$false)) { $knownImage=$true; break }
 }
 if ($knownImage) { [Console]::Error.WriteLine('${WINDOWS_IMAGE_PRESENT_MARKER}'); [Console]::Error.Flush() }
 try { $img=$data.GetData([System.Windows.Forms.DataFormats]::Bitmap,$true) -as [System.Drawing.Image] }
 catch { $readError=$_.Exception }
 if ($null -ne $img -and -not $knownImage) {
  $knownImage=$true; [Console]::Error.WriteLine('${WINDOWS_IMAGE_PRESENT_MARKER}'); [Console]::Error.Flush()
 }
 if ($null -eq $img) {
  foreach ($format in @('PNG','image/png')) {
   if (-not $data.GetDataPresent($format,$false)) { continue }
   try {
    $raw=$data.GetData($format,$false)
    if ($raw -is [byte[]]) {
     if ($raw.LongLength -gt 10485760) { throw 'Image exceeds byte limit' }
     $rawStream=[System.IO.MemoryStream]::new([byte[]]$raw,$false)
    } elseif ($raw -is [System.IO.Stream]) { $rawStream=$raw }
    else { throw 'Clipboard PNG data is not an image stream' }
    if (-not $rawStream.CanSeek) { throw 'Clipboard PNG stream is not seekable' }
    if ($rawStream.Length -gt 10485760) { throw 'Image exceeds byte limit' }
    $rawStream.Position=0
    $img=[System.Drawing.Image]::FromStream($rawStream)
    break
   } catch {
    if ($null -ne $rawStream) { $rawStream.Dispose(); $rawStream=$null }
    if ($_.Exception.Message.Contains('Image exceeds byte limit')) { throw }
    $readError=$_.Exception
   }
  }
 }
 if ($null -eq $img) {
  if ($null -ne $readError) { throw $readError }
  if ($knownImage) { throw 'Clipboard advertises image data but returned no image' }
  exit 0
 }
 if ([long]$img.Width*$img.Height -gt 24000000) { throw 'Image exceeds pixel limit' }
 $pngStream=[System.IO.MemoryStream]::new()
 try {
  $img.Save($pngStream,[System.Drawing.Imaging.ImageFormat]::Png)
  if ($pngStream.Length -gt 10485760) { throw 'Image exceeds byte limit' }
  [Console]::Out.Write([Convert]::ToBase64String($pngStream.ToArray()))
 } finally { $pngStream.Dispose() }
} catch {
 if ($knownImage) { [Console]::Error.WriteLine($_.Exception.Message); exit 4 }
 throw
} finally {
 if ($null -ne $img) { $img.Dispose() }
 if ($null -ne $rawStream) { $rawStream.Dispose() }
}
`;
const WINDOWS_IMAGE_ENCODED_SCRIPT = Buffer.from(WINDOWS_IMAGE_SCRIPT, "utf16le").toString("base64");
async function readClipboardImageViaPowerShell(signal?: AbortSignal, onUnavailable?: (error: unknown) => void): Promise<ClipboardImage | null> {
	let output: Buffer;
	try { output = await runClipboardCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", WINDOWS_IMAGE_ENCODED_SCRIPT],
		{ timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS, maxBufferBytes: 15 * 1024 * 1024, signal }); }
	catch (error) {
		// Cancellation and actual image quota failures remain failures, not text probes.
		if (signal?.aborted || (error instanceof Error && CLIPBOARD_IMAGE_LIMIT_PATTERN.test(error.message))) throw error;
		if (error instanceof ClipboardCommandError && (error.exitCode === 4 || error.imagePresent)) {
			throw new ClipboardImageReadError(`已检测到剪贴板图片，但 Windows 图片读取失败：${error.message}`, { cause: error });
		}
		onUnavailable?.(error); return null;
	}
	if (!output.length) return null;
	return { bytes: Buffer.from(output.toString("ascii"), "base64"), mimeType: "image/png" };
}

async function readClipboardImageViaXclip(signal?: AbortSignal): Promise<ClipboardImage | null> {
	const targets = await runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS, signal,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(CLIPBOARD_LINE_BREAK_PATTERN)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = await runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"], { signal });
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

async function readClipboardImageViaNativeClipboard(signal?: AbortSignal, source: ClipboardModule | null = clipboard): Promise<ClipboardImage | null> {
	signal?.throwIfAborted();
	if (!source) {
		return null;
	}

	try {
		const hasImage = source.hasImage();
		signal?.throwIfAborted();
		if (!hasImage) {
			return null;
		}

		const imageData = await source.getImageBinary();
		signal?.throwIfAborted();
		if (!imageData || imageData.length === 0) {
			return null;
		}

		const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
		return { bytes, mimeType: "image/png" };
	} catch (error) {
		if (signal?.aborted) throw error;
		// Non-Windows platforms retain their existing optional backend fallback.
		return null;
	}
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	signal?: AbortSignal;
	onUnavailable?: (error: unknown) => void;
	/** Test-only replacement for the bottom native provider; production omits it. */
	nativeClipboard?: ClipboardModule | null;
	/** Test-only isolated-child fixture; production omits it. */
	nativeModulePath?: string;
}): Promise<ClipboardImage | null> {
	options?.signal?.throwIfAborted();
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux") {
		const wsl = isWSL(env);
		const wayland = isWaylandSession(env);

		if (wayland || wsl) {
			image = (await readClipboardImageViaWlPaste(options?.signal)) ?? (await readClipboardImageViaXclip(options?.signal));
		}

		if (!image && wsl) {
			image = await readClipboardImageViaPowerShell(options?.signal, options?.onUnavailable);
		}

		if (!image && !wayland) {
			image = (await readClipboardImageViaNativeClipboard(options?.signal, options?.nativeClipboard)) ?? (await readClipboardImageViaXclip(options?.signal));
		}
	} else if (platform === "win32") {
		// Forms may not obtain an image from every clipboard source. Native is
		// supplemental; actual Windows format compatibility needs desktop tests.
		let helperError: unknown;
		try { image = await readClipboardImageViaPowerShell(options?.signal, error => { helperError = error; }); }
		catch (error) {
			if (!(error instanceof ClipboardImageReadError)) throw error;
			helperError = error;
		}
		let nativeError: unknown;
		if (!image) {
			try {
				const bytes = await readNativeClipboard("image", options?.signal, options?.nativeClipboard, options?.nativeModulePath);
				if (bytes) image = { bytes, mimeType: "image/png" };
			} catch (error) {
				if (options?.signal?.aborted || (error instanceof NativeClipboardError && error.fatal)) throw error;
				nativeError = error;
			}
		}
		if (!image && helperError instanceof ClipboardImageReadError) throw helperError;
		if (!image && nativeError instanceof ClipboardImageReadError) throw nativeError;
		if (!image && (nativeError ?? helperError)) options?.onUnavailable?.(nativeError ?? helperError);
	} else {
		image = await readClipboardImageViaNativeClipboard(options?.signal, options?.nativeClipboard);
	}

	options?.signal?.throwIfAborted();
	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., BMP from WSLg) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
