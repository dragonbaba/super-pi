import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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

export function resolveRoot(root?: string) {
	const resolvedRoot = path.resolve(root?.trim() || process.cwd());
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
	if (!Number.isFinite(limit) || limit < 1 || limit > MAX_COLLECTED_FILES) {
		throw new Error(`LSP file limit must be between 1 and ${MAX_COLLECTED_FILES}.`);
	}
	if ((requestedPaths?.length ?? 0) > MAX_REQUESTED_PATHS) {
		throw new Error(`LSP paths accepts at most ${MAX_REQUESTED_PATHS} entries.`);
	}
	const cappedLimit = Math.floor(limit);
	const files: string[] = [];
	const seen = new Set<string>();
	const visitedDirectories = new Set<string>();
	const budget: ScanBudget = { scannedPaths: 0, visitedDirectories: 0 };
	const realRoot = realpathSync(root);
	const inputs = requestedPaths?.length ? requestedPaths : [root];

	for (const input of inputs) {
		const targetPath = resolveWorkspacePath(root, input, "Requested path");
		if (!existsSync(targetPath)) throw new Error(`Requested path does not exist: ${targetPath}`);
		if (!isInsidePath(realRoot, realpathSync(targetPath))) {
			throw new Error(`Requested path resolves outside workspace root: ${targetPath}`);
		}
		collectPath(adapter, targetPath, files, seen, visitedDirectories, realRoot, cappedLimit, budget);
		if (files.length >= cappedLimit) break;
	}

	return files;
}

function collectPath(
	adapter: LspServerAdapter,
	targetPath: string,
	files: string[],
	seen: Set<string>,
	visitedDirectories: Set<string>,
	realRoot: string,
	limit: number,
	budget: ScanBudget,
) {
	budget.scannedPaths += 1;
	if (budget.scannedPaths > MAX_SCANNED_PATHS) {
		throw new Error(`LSP file scan exceeded ${MAX_SCANNED_PATHS} paths; narrow the requested paths.`);
	}
	if (files.length >= limit || !existsSync(targetPath)) return;
	if (!isInsidePath(realRoot, realpathSync(targetPath))) return;

	const stats = statSync(targetPath);
	if (stats.isFile()) {
		if (adapter.isSupportedFile(targetPath) && !seen.has(targetPath)) {
			seen.add(targetPath);
			files.push(targetPath);
		}
		return;
	}

	if (!stats.isDirectory()) return;
	const directoryKey = realpathSync(targetPath);
	if (visitedDirectories.has(directoryKey)) return;
	budget.visitedDirectories += 1;
	if (budget.visitedDirectories > MAX_VISITED_DIRECTORIES) {
		throw new Error(`LSP file scan exceeded ${MAX_VISITED_DIRECTORIES} directories; narrow the requested paths.`);
	}
	visitedDirectories.add(directoryKey);

	const entries = readdirSync(targetPath, { withFileTypes: true }).sort(compareDirectoryEntries);
	for (const entry of entries) {
		if (files.length >= limit) break;
		if ((entry.isDirectory() || entry.isSymbolicLink()) && adapter.skipDirectories.has(entry.name))
			continue;
		collectPath(
			adapter,
			path.join(targetPath, entry.name),
			files,
			seen,
			visitedDirectories,
			realRoot,
			limit,
			budget,
		);
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
