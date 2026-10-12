import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, rmdirSync, unlinkSync, writeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ImageContent, TextContent } from "@super-pi/ai";
import { privateOutputFileSystem } from "../utils/private-output-file.ts";

const MAX_IMAGES = 16;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const writeFileAsync = promisify(writeFile);

export interface CodemodeImageFiles {
	directory?: string;
	manifestPath?: string;
	saved: number;
	omitted: number;
	notice: string;
	/** Completion-owned cleanup records; cleared before session persistence. */
	ownedFiles?: { image: number; path: string; bytes: number }[];
}

/** Strict bounded base64, without a second complete encoded string. */
function validBase64(data: string): boolean {
	if (!data.length || data.length % 4 !== 0 || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return false;
	let end = data.length;
	if (data.charCodeAt(end - 1) === 61) end--;
	if (data.charCodeAt(end - 1) === 61) end--;
	for (let i = 0; i < end; i++) {
		const c = data.charCodeAt(i);
		if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47)) return false;
	}
	return end > 0;
}

function extension(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] !== 0xf7) return "jpg";
	if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) return "gif";
	if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0x52494646 && bytes.readUInt32BE(8) === 0x57454250) return "webp";
	return undefined;
}

/** Completion-only boundary. The opener establishes privacy before writing. */
async function writePrivate(path: string, data: Buffer | string): Promise<void> {
	const fd = privateOutputFileSystem.openSync(path);
	try {
		try { await writeFileAsync(fd, data); }
		finally { closeSync(fd); }
	} catch (error) {
		// Only this exact, exclusively created file belongs to this failed write.
		try { unlinkSync(path); } catch {}
		throw error;
	}
}

/** No state survives the call except private files and small returned metadata.
 * Images remain in the ordinary result even if storage is unavailable.
 */
export function saveCodemodeImages(content: readonly (TextContent | ImageContent)[]): Promise<CodemodeImageFiles> | undefined {
	let count = 0;
	for (const block of content) if (block.type === "image") count++;
	if (count === 0) return undefined;
	return persistImages(content, count);
}

async function persistImages(content: readonly (TextContent | ImageContent)[], count: number): Promise<CodemodeImageFiles> {
	const images: { image: number; path: string; bytes: number }[] = [];
	const hashes = new Map<string, string>();
	let directory: string | undefined, manifestPath: string | undefined;
	let inputBytes = 0, index = 0, failure = "";
	try {
		for (const block of content) {
			if (block.type !== "image") continue;
			if (++index > MAX_IMAGES) break;
			if (!validBase64(block.data)) continue;
			const size = block.data.length / 4 * 3 - (block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0);
			if (size > MAX_IMAGE_BYTES || size > MAX_TOTAL_BYTES - inputBytes) continue;
			inputBytes += size;
			const bytes = Buffer.from(block.data, "base64");
			const ext = extension(bytes);
			if (!ext) continue;
			const digest = createHash("sha256").update(bytes).digest("hex");
			let path = hashes.get(digest);
			if (!path) {
				directory ??= mkdtempSync(join(resolve(tmpdir()), "sp-codemode-images-"));
				path = join(directory, `${index}.${ext}`);
				await writePrivate(path, bytes);
				hashes.set(digest, path);
			}
			images.push({ image: index, path, bytes: size });
		}
		if (directory) {
			const path = join(directory, "images.json");
			await writePrivate(path, JSON.stringify({ version: 1, images, omitted: count - images.length }) + "\n");
			manifestPath = path;
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		failure = code === "ENOSPC" ? "disk full" : code === "EACCES" || code === "EPERM" ? "access denied" : "file write failed";
		if (directory && images.length === 0) {
			try { rmdirSync(directory); directory = undefined; } catch {}
		}
	}
	const omitted = count - images.length;
	const location = manifestPath ? `Image files: read ${manifestPath}. Temporary.`
		: directory ? `Image files: list ${directory}; manifest unavailable.` : "Image files unavailable.";
	// Keep optional metadata small: repeated generic advice can displace native
	// read evidence in the later model projection. The tool description explains retention.
	const warning = failure ? ` ${failure}; do not repeat tools.` : omitted ? ` ${omitted} skipped (format/size/count).` : "";
	return { directory, manifestPath, saved: images.length, omitted, ownedFiles: images,
		notice: `[${location}${warning}]` };
}

/** ENOSPC fallback: reclaim this completion's optional files, never replay tools. */
export function reclaimCodemodeImages(files: CodemodeImageFiles): boolean {
	let reclaimed = false, failed = false;
	if (files.ownedFiles) for (const image of files.ownedFiles) {
		try { unlinkSync(image.path); reclaimed = true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
	}
	if (files.manifestPath) {
		try { unlinkSync(files.manifestPath); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
	}
	if (files.directory && !failed) {
		try { rmdirSync(files.directory); files.directory = undefined; } catch { failed = true; }
	}
	files.omitted += files.saved;
	files.saved = 0;
	files.manifestPath = undefined;
	files.ownedFiles = undefined;
	files.notice = `[Image files reclaimed for text recovery.${failed ? " Some cleanup failed." : ""} Images remain attached; do not repeat tools.]`;
	return reclaimed;
}
