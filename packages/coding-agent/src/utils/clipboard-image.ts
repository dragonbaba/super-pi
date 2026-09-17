import { execFile } from "node:child_process";
import { readFileSync } from "fs";

import { clipboard } from "./clipboard-native.ts";
import { loadPhoton } from "./photon.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

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
			(error, stdout) => { if (error) reject(new Error(`Clipboard helper failed (${error.code ?? "timeout/busy"}): ${error.message.slice(0, 300)}`)); else resolve(stdout); });
	});
}
async function runCommand(command: string, args: string[], options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<{ stdout: Buffer; ok: boolean }> {
	try { return { stdout: await runClipboardCommand(command, args, options), ok: true }; }
	catch (error) { if (options?.signal?.aborted) throw error; return { stdout: Buffer.alloc(0), ok: false }; }
}

async function readClipboardImageViaWlPaste(): Promise<ClipboardImage | null> {
	const list = await runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = await runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
const WINDOWS_IMAGE_SCRIPT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img=[System.Windows.Forms.Clipboard]::GetImage(); if ($null -ne $img) { try { if ([long]$img.Width*$img.Height -gt 24000000) { throw 'Image exceeds pixel limit' }; $stream=[System.IO.MemoryStream]::new(); try { $img.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png); if ($stream.Length -gt 10485760) { throw 'Image exceeds byte limit' }; [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray())) } finally { $stream.Dispose() } } finally { $img.Dispose() } }";
const WINDOWS_IMAGE_ENCODED_SCRIPT = Buffer.from(WINDOWS_IMAGE_SCRIPT, "utf16le").toString("base64");
async function readClipboardImageViaPowerShell(signal?: AbortSignal): Promise<ClipboardImage | null> {
	const output = await runClipboardCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", WINDOWS_IMAGE_ENCODED_SCRIPT],
		{ timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS, maxBufferBytes: 15 * 1024 * 1024, signal });
	if (!output.length) return null;
	return { bytes: Buffer.from(output.toString("ascii"), "base64"), mimeType: "image/png" };
}

async function readClipboardImageViaXclip(): Promise<ClipboardImage | null> {
	const targets = await runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = await runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	if (!clipboard || !clipboard.hasImage()) {
		return null;
	}

	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) {
		return null;
	}

	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	signal?: AbortSignal;
}): Promise<ClipboardImage | null> {
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
			image = (await readClipboardImageViaWlPaste()) ?? (await readClipboardImageViaXclip());
		}

		if (!image && wsl) {
			image = await readClipboardImageViaPowerShell(options?.signal);
		}

		if (!image && !wayland) {
			image = (await readClipboardImageViaNativeClipboard()) ?? (await readClipboardImageViaXclip());
		}
	} else if (platform === "win32") {
		// STA helper is bounded and cannot block the TUI on native hasImage().
		image = await readClipboardImageViaPowerShell(options?.signal);
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

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
