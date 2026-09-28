import { type Dirent, type Stats, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { compareStrings } from "./collections.js";
import { MAX_COLLECTED_FILES, MAX_REQUESTED_PATHS } from "./limits.js";
import type { LspServerAdapter } from "./types.js";
const MAX_SCANNED_PATHS = 100_000;
const MAX_VISITED_DIRECTORIES = 10_000;

interface ScanBudget {
	scannedPaths: number;
	visitedDirectories: number;
}

interface FileCollection {
	adapter: LspServerAdapter;
	files: string[];
	seen: Set<string>;
	visitedDirectories: Set<string>;
	scopeLimited: boolean;
}

export function resolveRoot(root?: string, cwd = process.cwd()) {
	const resolvedRoot = path.resolve(cwd, root && root.trim() ? root : ".");
	if (!existsSync(resolvedRoot)) throw new Error(`Workspace root does not exist: ${resolvedRoot}`);
	if (!statSync(resolvedRoot).isDirectory()) {
		throw new Error(`Expected workspace root to be a directory: ${resolvedRoot}`);
	}
	return resolvedRoot;
}

export function directoryUri(directory: string) {
	return pathToFileURL(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`).href;
}

export function resolveSupportedFile(adapter: LspServerAdapter, root: string, filePath: string) {
	const resolvedPath = resolveWorkspacePath(root, filePath, "File path");
	if (!existsSync(resolvedPath))
		throw new Error(`${adapter.name} file does not exist: ${resolvedPath}`);
	if (!isInsidePath(realpathSync(root), realpathSync(resolvedPath))) {
		throw new Error(`File resolves outside workspace root: ${resolvedPath}`);
	}
	if (!statSync(resolvedPath).isFile()) throw new Error(`Expected a file: ${resolvedPath}`);
	if (!adapter.isSupportedFile(resolvedPath)) {
		throw new Error(`Expected a ${adapter.name} supported file: ${resolvedPath}`);
	}
	return resolvedPath;
}

export function collectSupportedFiles(
	adapter: LspServerAdapter,
	root: string,
	requestedPaths: readonly string[] | undefined,
	limit: number,
) {
	return collectSupportedFilesByAdapter([adapter], root, requestedPaths, limit).get(adapter)!.files;
}

/** Share directory IO while retaining each route's limit and exclusion policy. */
export function collectSupportedFilesByAdapter(
	adapters: readonly LspServerAdapter[],
	root: string,
	requestedPaths: readonly string[] | undefined,
	limit: number,
) {
	if (!Number.isFinite(limit) || limit < 1 || limit > MAX_COLLECTED_FILES) {
		throw new Error(`LSP file limit must be between 1 and ${MAX_COLLECTED_FILES}.`);
	}
	if ((requestedPaths?.length ?? 0) > MAX_REQUESTED_PATHS) {
		throw new Error(`LSP paths accepts at most ${MAX_REQUESTED_PATHS} entries.`);
	}
	const cappedLimit = Math.floor(limit);
	const collections: FileCollection[] = adapters.map(adapter => ({
		adapter, files: [], seen: new Set<string>(), visitedDirectories: new Set<string>(), scopeLimited: false,
	}));
	const budget: ScanBudget = { scannedPaths: 0, visitedDirectories: 0 };
	const realRoot = realpathSync(root);
	const inputs = requestedPaths?.length ? requestedPaths : [root];

	for (const input of inputs) {
		const targetPath = resolveWorkspacePath(root, input, "Requested path");
		if (!existsSync(targetPath)) throw new Error(`Requested path does not exist: ${targetPath}`);
		const realTarget = realpathSync(targetPath);
		if (!isInsidePath(realRoot, realTarget)) {
			throw new Error(`Requested path resolves outside workspace root: ${targetPath}`);
		}
		let stats: Stats | undefined;
		for (const collection of collections) {
			if (collection.files.length >= cappedLimit && !collection.seen.has(targetPath) &&
				!collection.visitedDirectories.has(realTarget)) {
				stats ??= statSync(targetPath);
				if (stats.isDirectory() || (stats.isFile() && collection.adapter.isSupportedFile(targetPath))) {
					collection.scopeLimited = true;
				}
			}
		}
		const pending = collections.filter(collection => collection.files.length < cappedLimit);
		if (pending.length === 0) continue;
		collectPath(pending, targetPath, realRoot, cappedLimit, budget);
	}

	return new Map(collections.map(collection => [collection.adapter, {
		files: collection.files, scopeLimited: collection.scopeLimited,
	}]));
}

function collectPath(
	collections: readonly FileCollection[],
	targetPath: string,
	realRoot: string,
	limit: number,
	budget: ScanBudget,
) {
	budget.scannedPaths += 1;
	if (budget.scannedPaths > MAX_SCANNED_PATHS) {
		throw new Error(`LSP file scan exceeded ${MAX_SCANNED_PATHS} paths; narrow the requested paths.`);
	}
	if (!existsSync(targetPath)) return;
	if (!isInsidePath(realRoot, realpathSync(targetPath))) return;

	const stats = statSync(targetPath);
	if (stats.isFile()) {
		for (const collection of collections) {
			if (collection.adapter.isSupportedFile(targetPath) && !collection.seen.has(targetPath)) {
				collection.seen.add(targetPath);
				collection.files.push(targetPath);
			}
		}
		return;
	}

	if (!stats.isDirectory()) return;
	const directoryKey = realpathSync(targetPath);
	const pending = collections.filter(collection => !collection.visitedDirectories.has(directoryKey));
	if (pending.length === 0) return;
	budget.visitedDirectories += 1;
	if (budget.visitedDirectories > MAX_VISITED_DIRECTORIES) {
		throw new Error(`LSP file scan exceeded ${MAX_VISITED_DIRECTORIES} directories; narrow the requested paths.`);
	}
	for (const collection of pending) collection.visitedDirectories.add(directoryKey);

	const entries = readdirSync(targetPath, { withFileTypes: true }).sort(compareDirectoryEntries);
	// Synchronous recursion: this directory owns one scratch array, bounded by
	// its pending adapter count. Children finish before it is reused; never pooled.
	const childCollections: FileCollection[] = [];
	try {
		for (const entry of entries) {
			const childPath = path.join(targetPath, entry.name);
			let cappedStats: Stats | undefined;
			let cappedRealPath: string | undefined;
			childCollections.length = 0;
			for (const collection of pending) {
				if ((entry.isDirectory() || entry.isSymbolicLink()) && collection.adapter.skipDirectories.has(entry.name)) continue;
				if (collection.files.length >= limit) {
					if (entry.isSymbolicLink()) {
						if (!existsSync(childPath)) continue;
						cappedRealPath ??= realpathSync(childPath);
						if (!isInsidePath(realRoot, cappedRealPath)) continue;
						cappedStats ??= statSync(childPath);
					}
					const childStats = cappedStats ?? entry;
					if (childStats.isDirectory()) cappedRealPath ??= realpathSync(childPath);
					if ((childStats.isDirectory() && !collection.visitedDirectories.has(cappedRealPath!)) ||
						(childStats.isFile() && collection.adapter.isSupportedFile(childPath) && !collection.seen.has(childPath))) {
						collection.scopeLimited = true;
					}
				} else childCollections.push(collection);
			}
			if (childCollections.length === 0) continue;
			collectPath(childCollections, childPath, realRoot, limit, budget);
		}
	} finally {
		childCollections.length = 0;
	}
}

function compareDirectoryEntries(left: Dirent, right: Dirent) {
	return compareStrings(left.name, right.name);
}

function resolveWorkspacePath(root: string, inputPath: string, label: string) {
	const resolvedPath = path.resolve(root, inputPath);
	const realRoot = realpathSync(root);
	const isLexicallyInsideRoot = isInsidePath(root, resolvedPath);

	if (existsSync(resolvedPath)) {
		const realResolvedPath = realpathSync(resolvedPath);
		if (!isInsidePath(realRoot, realResolvedPath)) {
			throw new Error(`${label} resolves outside workspace root: ${resolvedPath}`);
		}
		return isLexicallyInsideRoot
			? resolvedPath
			: path.join(root, path.relative(realRoot, realResolvedPath));
	}

	if (!isLexicallyInsideRoot && !isInsidePath(realRoot, resolvedPath)) {
		throw new Error(`${label} escapes workspace root: ${resolvedPath}`);
	}
	return resolvedPath;
}

function isInsidePath(parent: string, child: string) {
	const relativePath = path.relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
