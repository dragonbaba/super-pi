import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@super-pi/agent-core";
import { Text } from "@super-pi/tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	GREP_BACKSLASH_PATTERN,
	GREP_CARRIAGE_RETURN_PATTERN,
	GREP_CONTROL_CHARACTER_PATTERN,
	GREP_CRLF_PATTERN,
	GREP_TRAILING_LINE_FEED_PATTERN,
} from "./grep-regex.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;
const GREP_TREE_MAX_LINES = 12;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

interface GrepTreeNode {
	children: Map<string, GrepTreeNode>;
	leaf: boolean;
}

interface GrepSummary {
	matchCount: number;
	fileCount: number;
	treeLines: string[];
}

function sanitizeGrepTreePart(value: string): string {
	return value.replace(GREP_CONTROL_CHARACTER_PATTERN, "�");
}

function buildGrepFileTree(files: string[], maxLines = GREP_TREE_MAX_LINES): string[] {
	if (!Array.isArray(files) || files.length === 0 || maxLines <= 0) return [];
	const parts = files.map((file) => file.split("/").map(sanitizeGrepTreePart));
	let commonLength = Math.max(0, parts[0].length - 1);
	for (let index = 1; index < parts.length && commonLength > 0; index++) {
		commonLength = Math.min(commonLength, Math.max(0, parts[index].length - 1));
		let matched = 0;
		while (matched < commonLength && parts[index][matched] === parts[0][matched]) matched++;
		commonLength = matched;
	}
	const root: GrepTreeNode = { children: new Map(), leaf: false };
	let nodeCount = 0;
	for (const pathParts of parts) {
		let node = root;
		const relativeParts = pathParts.slice(commonLength);
		for (let index = 0; index < relativeParts.length; index++) {
			const part = relativeParts[index] || "�";
			let child = node.children.get(part);
			if (!child) {
				child = { children: new Map(), leaf: false };
				node.children.set(part, child);
				nodeCount++;
			}
			node = child;
			if (index === relativeParts.length - 1) node.leaf = true;
		}
	}
	const commonDirectory = parts[0].slice(0, commonLength).join("/");
	const lines = commonDirectory ? [`${commonDirectory}/`] : [];
	const availableLines = Math.max(0, maxLines - lines.length);
	const needsRemainder = nodeCount > availableLines;
	const contentBudget = Math.max(0, availableLines - (needsRemainder ? 1 : 0));
	let visibleFiles = 0;
	let contentLines = 0;
	const stack: Array<{ entries: Array<[string, GrepTreeNode]>; index: number; prefix: string }> = [
		{ entries: [...root.children], index: 0, prefix: "" },
	];
	while (stack.length > 0 && contentLines < contentBudget) {
		const frame = stack[stack.length - 1];
		if (frame.index >= frame.entries.length) {
			stack.pop();
			continue;
		}
		const entryIndex = frame.index++;
		const [name, child] = frame.entries[entryIndex];
		const isLast = entryIndex === frame.entries.length - 1;
		const directory = child.children.size > 0;
		lines.push(`${frame.prefix}${isLast ? "└─ " : "├─ "}${name}${directory ? "/" : ""}`);
		contentLines++;
		if (child.leaf) visibleFiles++;
		if (directory) {
			stack.push({
				entries: [...child.children],
				index: 0,
				prefix: frame.prefix + (isLast ? "   " : "│  "),
			});
		}
	}
	const hiddenFiles = Math.max(0, files.length - visibleFiles);
	if (needsRemainder && lines.length < maxLines) lines.push(`└─ … ${hiddenFiles} more files`);
	return lines;
}

function getGrepSummary(details: Required<Pick<GrepToolDetails, "matchCount" | "fileCount" | "files">>, state?: any): GrepSummary {
	if (state?.grepSummaryDetails === details) return state.grepSummary;
	const summary = {
		matchCount: details.matchCount,
		fileCount: details.fileCount,
		treeLines: buildGrepFileTree(details.files),
	};
	if (state) {
		state.grepSummaryDetails = details;
		state.grepSummary = summary;
	}
	return summary;
}

function hasGrepSummary(details: GrepToolDetails | undefined): details is Required<Pick<GrepToolDetails, "matchCount" | "fileCount" | "files">> & GrepToolDetails {
	return Number.isInteger(details?.matchCount) && (details?.matchCount ?? 0) > 0 &&
		Number.isInteger(details?.fileCount) && (details?.fileCount ?? 0) > 0 &&
		Array.isArray(details?.files) && details.files.length === details.fileCount &&
		details.files.length <= DEFAULT_LIMIT && details.files.every((file) => typeof file === "string");
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	state?: any,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		if (!options.expanded && hasGrepSummary(result.details)) {
			const summary = getGrepSummary(result.details, state);
			const matchesLabel = summary.matchCount === 1 ? "match" : "matches";
			const filesLabel = summary.fileCount === 1 ? "file" : "files";
			text += `\n${theme.fg("muted", `${summary.matchCount} ${matchesLabel} in ${summary.fileCount} ${filesLabel}`)}`;
			if (summary.treeLines.length > 0) {
				text += `\n${summary.treeLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			}
		} else {
			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 15;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (remaining > 0) {
				text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			}
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(GREP_BACKSLASH_PATTERN, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(GREP_CRLF_PATTERN, "\n").replace(GREP_CARRIAGE_RETURN_PATTERN, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(GREP_CARRIAGE_RETURN_PATTERN, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; displayPath: string; lineNumber: number; lineText?: string }> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, displayPath: formatPath(filePath), lineNumber, lineText });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							const summaryFiles: string[] = [];
							const seenSummaryFiles = new Set<string>();
							for (const match of matches) {
								if (!seenSummaryFiles.has(match.displayPath)) {
									seenSummaryFiles.add(match.displayPath);
									summaryFiles.push(match.displayPath);
								}
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = match.displayPath;
									const sanitized = match.lineText
										.replace(GREP_CRLF_PATTERN, "\n")
										.replace(GREP_CARRIAGE_RETURN_PATTERN, "")
										.replace(GREP_TRAILING_LINE_FEED_PATTERN, "");
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber);
									outputLines.push(...block);
								}
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {
								matchCount,
								fileCount: summaryFiles.length,
								files: summaryFiles,
							};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages, context.state));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
