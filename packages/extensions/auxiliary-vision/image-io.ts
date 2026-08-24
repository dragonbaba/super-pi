import { open, realpath, stat, unlink } from "node:fs/promises";
import { detectImageMime, isPathInsideRoot } from "./core.ts";

export interface LoadedImage {
	data: Buffer;
	mimeType: string;
	resolvedPath: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

export async function resolveExistingRoots(roots: readonly string[]): Promise<string[]> {
	const resolvedRoots: string[] = [];
	for (const root of roots) {
		try {
			resolvedRoots.push(await realpath(root));
		} catch {
			// Ignore roots that disappeared before the operation started.
		}
	}
	return resolvedRoots;
}

function pathIsAllowed(path: string, resolvedAllowedRoots: readonly string[]): boolean {
	for (const resolvedRoot of resolvedAllowedRoots) {
		if (isPathInsideRoot(path, resolvedRoot)) return true;
	}
	return false;
}

export async function readBoundedImage(
	path: string,
	maxInputBytes: number,
	resolvedAllowedRoots: readonly string[],
): Promise<LoadedImage> {
	const resolvedPath = await realpath(path);
	if (!pathIsAllowed(resolvedPath, resolvedAllowedRoots)) {
		throw new Error("Image path is outside the workspace and system temporary directory.");
	}

	const handle = await open(resolvedPath, "r");
	try {
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) throw new Error("Image path is not a regular file.");

		// O_NOFOLLOW is ineffective on native Windows. Re-resolve after opening and
		// compare file identity so a path swapped between realpath() and open()
		// cannot redirect the descriptor outside an allowed root.
		const postOpenPath = await realpath(resolvedPath);
		if (!pathIsAllowed(postOpenPath, resolvedAllowedRoots)) {
			throw new Error("Image path changed outside an allowed directory while being opened.");
		}
		const currentStat = await stat(postOpenPath);
		if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
			throw new Error("Image path changed while being opened; retry the operation.");
		}

		if (openedStat.size > maxInputBytes) {
			throw new Error(`Image is too large: ${openedStat.size} bytes exceeds ${maxInputBytes}.`);
		}
		const data = await handle.readFile();
		if (data.byteLength > maxInputBytes) {
			throw new Error(`Image grew beyond the ${maxInputBytes}-byte limit while being read.`);
		}
		const mimeType = detectImageMime(data);
		if (!mimeType) throw new Error("Only PNG, JPEG, GIF, and WebP image content is supported.");
		return {
			data,
			mimeType,
			resolvedPath: postOpenPath,
			dev: openedStat.dev,
			ino: openedStat.ino,
			size: openedStat.size,
			mtimeMs: openedStat.mtimeMs,
		};
	} finally {
		await handle.close();
	}
}

export async function cleanupFiles(paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		try {
			await unlink(path);
		} catch {
			// Temporary-file cleanup is best effort.
		}
	}
}
