import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ClientLease, LspClientPool } from "./client-pool.js";
import { EMPTY_READONLY_ARRAY } from "./collections.js";
import { resolveRoot, resolveSupportedFile } from "./files.js";
import { IDENTIFIER_CHARACTER_PATTERN, LINE_BREAK_PATTERN, SYMBOL_SPEC_PATTERN } from "./regex.js";
import { textResult } from "./runner.js";
import type {
	LspLocation,
	LspLocationLink,
	LspServerAdapter,
	LspSymbolInformation,
	StatusContext,
} from "./types.js";

export type NavigationAction = "definition" | "references" | "implementation" | "workspace_symbols";

const MAX_NAVIGATION_FILE_BYTES = 2 * 1024 * 1024;
const SYMBOL_LINE_DRIFT = 5;
const MAX_SYMBOL_LINE_HINTS = 10;

export interface NavigationParams {
	action: NavigationAction;
	root?: string;
	path: string;
	line?: number;
	symbol?: string;
	query?: string;
	includeDeclaration?: boolean;
	maxResults?: number;
}

export async function runNavigation(
	pool: LspClientPool,
	adapter: LspServerAdapter,
	params: NavigationParams,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const startedAt = performance.now();
	const root = resolveRoot(params.root);
	const file = resolveSupportedFile(adapter, root, params.path);
	const maxResults = Math.max(1, Math.min(200, Math.floor(params.maxResults ?? 50)));
	const uri = pathToFileURL(file).href;
	let text: string | undefined;
	let position: ResolvedSymbolPosition | undefined;
	let query: string | undefined;
	let resolvedLine: number | undefined;
	throwIfAborted(signal, adapter);
	if (params.action === "workspace_symbols") {
		query = params.query?.trim();
		if (!query) throw new Error("workspace_symbols requires a non-blank query.");
	} else {
		const fileBytes = statSync(file).size;
		if (fileBytes > MAX_NAVIGATION_FILE_BYTES) {
			throw new Error(`Navigation anchor exceeds ${MAX_NAVIGATION_FILE_BYTES} bytes: ${file}.`);
		}
		text = readFileSync(file, "utf8");
		position = resolveSymbolPosition(text, params.line, params.symbol);
		resolvedLine = position.line + 1;
	}
	throwIfAborted(signal, adapter);

	let lease: ClientLease | undefined;
	let aborted = false;
	const abort = () => {
		aborted = true;
		if (lease) void pool.discard(lease);
	};
	signal?.addEventListener("abort", abort, { once: true });

	try {
		ctx.ui.setStatus(statusKey, `${adapter.name} ${params.action}`);
		lease = await pool.acquire(adapter, root, timeoutMs);
		throwIfAborted(signal, adapter);
		if (text !== undefined) lease.client.didOpen(uri, text, adapter.languageIdFor(file));
		try {
			let items: readonly NormalizedNavigationItem[];
			if (params.action === "workspace_symbols") {
				const symbols = await lease.client.workspaceSymbols(query!);
				items = normalizeSymbols(symbols, root, query!);
			} else {
				const locations =
					params.action === "definition"
						? await lease.client.definition(uri, position!)
						: params.action === "implementation"
							? await lease.client.implementation(uri, position!)
							: await lease.client.references(uri, position!, params.includeDeclaration ?? true);
				items = normalizeLocations(locations, root);
			}
			const deduped = dedupe(items);
			const shown = deduped.slice(0, maxResults);
			const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
			const adjustment = resolvedLine !== undefined && resolvedLine !== params.line
				? `, line adjusted ${params.line}→${resolvedLine}`
				: "";
			const summary = `${adapter.name} ${params.action}: ${deduped.length} result(s)${deduped.length > shown.length ? `, showing ${shown.length}` : ""} (${lease.reused ? "warm" : "cold"}${adjustment}, ${elapsedMs} ms).`;
			return textResult([summary, ...shown.map(formatItem)].join("\n"), {
				action: params.action,
				server: adapter.name,
				root,
				path: path.relative(root, file) || file,
				requestedLine: params.line,
				resolvedLine,
				results: shown,
				total: deduped.length,
				truncated: deduped.length > shown.length,
				reusedClient: lease.reused,
				elapsedMs,
			});
		} finally {
			if (text !== undefined) lease.client.didClose(uri);
		}
	} finally {
		ctx.ui.setStatus(statusKey, undefined);
		signal?.removeEventListener("abort", abort);
		if (lease && !aborted) pool.release(lease);
	}
}

interface NormalizedNavigationItem {
	path: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	name?: string;
	kind?: number;
	container?: string;
}

function normalizeLocations(
	locations: readonly (LspLocation | LspLocationLink)[] | LspLocation | LspLocationLink | null,
	root: string,
): readonly NormalizedNavigationItem[] {
	if (!locations) return EMPTY_READONLY_ARRAY;
	const values = Array.isArray(locations) ? locations : [locations];
	const normalized: NormalizedNavigationItem[] = [];
	for (const value of values) {
		const uri = "targetUri" in value ? value.targetUri : value.uri;
		const range = "targetUri" in value ? value.targetSelectionRange ?? value.targetRange : value.range;
		try {
			normalized.push(normalizeLocation(uri, range, root));
		} catch {
			// Ignore malformed or unsupported result URIs independently.
		}
	}
	return normalized.length > 0 ? normalized : EMPTY_READONLY_ARRAY;
}

function normalizeSymbols(
	symbols: readonly LspSymbolInformation[],
	root: string,
	query: string,
): readonly NormalizedNavigationItem[] {
	const needle = query.toLowerCase();
	const normalized: NormalizedNavigationItem[] = [];
	for (const symbol of symbols) {
		if (!symbol.name.toLowerCase().includes(needle)) continue;
		try {
			normalized.push({
				...normalizeLocation(symbol.location.uri, symbol.location.range, root),
				name: symbol.name,
				kind: symbol.kind,
				container: symbol.containerName,
			});
		} catch {
			// Ignore malformed or unsupported result URIs independently.
		}
	}
	return normalized.length > 0 ? normalized : EMPTY_READONLY_ARRAY;
}

function normalizeLocation(uri: string, range: LspLocation["range"], root: string): NormalizedNavigationItem {
	const file = fileURLToPath(uri);
	const relative = path.relative(root, file);
	return {
		path: relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file,
		line: range.start.line + 1,
		column: range.start.character + 1,
		endLine: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

function dedupe(items: readonly NormalizedNavigationItem[]) {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = `${item.path}\0${item.line}\0${item.column}\0${item.name ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function formatItem(item: NormalizedNavigationItem) {
	const symbol = item.name ? `${item.name}${item.container ? ` (${item.container})` : ""}: ` : "";
	return `${symbol}${item.path}:${item.line}:${item.column}`;
}

export interface ResolvedSymbolPosition {
	line: number;
	character: number;
}

export function resolveSymbolPosition(
	text: string,
	requestedLine: number | undefined,
	symbolSpec: string | undefined,
): ResolvedSymbolPosition {
	const lines = text.split(LINE_BREAK_PATTERN);
	const line = requireLine(requestedLine, lines.length);
	const parsed = parseSymbolSpec(symbolSpec);
	const exactCharacter = symbolColumn(lines[line] ?? "", parsed.name, parsed.occurrence);
	if (exactCharacter !== undefined) return { line, character: exactCharacter };

	const nearby = symbolLineCandidates(lines, parsed.name, parsed.occurrence, line, SYMBOL_LINE_DRIFT);
	if (nearby.length === 1) return nearby[0];
	if (nearby.length > 1) {
		throw symbolLineError(parsed.display, line, nearby, false);
	}
	const allCandidates = symbolLineCandidates(lines, parsed.name, parsed.occurrence, line, lines.length);
	throw symbolLineError(parsed.display, line, allCandidates, allCandidates.length > MAX_SYMBOL_LINE_HINTS);
}

function requireLine(line: number | undefined, lineCount: number) {
	if (!Number.isInteger(line) || (line ?? 0) < 1) {
		throw new Error("definition, references, and implementation require a 1-indexed line.");
	}
	const zeroBased = (line as number) - 1;
	if (zeroBased >= lineCount) throw new Error(`Line ${line} is outside the file (${lineCount} lines).`);
	return zeroBased;
}

function parseSymbolSpec(symbolSpec: string | undefined) {
	const display = symbolSpec?.trim();
	if (!display) throw new Error("definition, references, and implementation require a symbol.");
	const match = SYMBOL_SPEC_PATTERN.exec(display);
	const name = match?.[1]?.trim() ?? display;
	const occurrence = Number(match?.[2] ?? "1");
	if (!name) throw new Error("Symbol must not be blank.");
	return { display, name, occurrence };
}

function symbolColumn(lineText: string, name: string, occurrence: number): number | undefined {
	let found = 0;
	for (let from = 0; from <= lineText.length - name.length;) {
		const index = lineText.indexOf(name, from);
		if (index < 0) return undefined;
		const before = lineText[index - 1];
		const after = lineText[index + name.length];
		if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after) && ++found === occurrence) return index;
		from = index + Math.max(1, name.length);
	}
	return undefined;
}

function symbolLineCandidates(
	lines: readonly string[],
	name: string,
	occurrence: number,
	requestedLine: number,
	distance: number,
): ResolvedSymbolPosition[] {
	const candidates: ResolvedSymbolPosition[] = [];
	const start = Math.max(0, requestedLine - distance);
	const end = Math.min(lines.length - 1, requestedLine + distance);
	for (let line = start; line <= end; line++) {
		if (line === requestedLine) continue;
		const character = symbolColumn(lines[line] ?? "", name, occurrence);
		if (character === undefined) continue;
		candidates.push({ line, character });
		if (candidates.length > MAX_SYMBOL_LINE_HINTS) break;
	}
	return candidates;
}

function symbolLineError(
	symbol: string,
	requestedLine: number,
	candidates: readonly ResolvedSymbolPosition[],
	truncated: boolean,
) {
	const shown = candidates.slice(0, MAX_SYMBOL_LINE_HINTS);
	const candidateText = shown.length
		? ` Candidate line(s): ${shown.map((candidate) => candidate.line + 1).join(", ")}${truncated ? ", …" : ""}.`
		: " No identifier-boundary match exists in the file.";
	return new Error(
		`Symbol '${symbol}' was not found on line ${requestedLine + 1}.${candidateText} ` +
			"Retry with an exact line; use name#N only for repeated occurrences on that line.",
	);
}

function isIdentifierCharacter(character: string | undefined) {
	return character !== undefined && IDENTIFIER_CHARACTER_PATTERN.test(character);
}

function throwIfAborted(signal: AbortSignal | undefined, adapter: LspServerAdapter) {
	if (signal?.aborted) throw new Error(`${adapter.name} LSP request aborted.`);
}
