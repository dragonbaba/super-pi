import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientLease, LspClientPool } from "./client-pool.js";
import { collectSupportedFiles, resolveRoot, resolveSupportedFile } from "./files.js";
import { DEFAULT_FILE_LIMIT } from "./limits.js";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits } from "./text-edits.js";
import type {
	CodeAction,
	DiagnosticEntry,
	LspServerAdapter,
	LspTextEdit,
	StatusContext,
} from "./types.js";

const MAX_LSP_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 50 * 1024;
const MAX_DIAGNOSTIC_LINES = 500;
const MAX_RETAINED_EDIT_ITEMS = 200;

export async function runDiagnostics(
	pool: LspClientPool,
	adapter: LspServerAdapter,
	params: { root?: string; paths?: string[]; limit?: number; files?: readonly string[] },
	timeoutMs: number,
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const root = resolveRoot(params.root);
	const command = adapter.defaultCommand;
	const files =
		params.files ??
		collectSupportedFiles(adapter, root, params.paths, params.limit ?? DEFAULT_FILE_LIMIT);
	if (files.length === 0) {
		return textResult(`${adapter.name} LSP found no supported files to check.`, {
			root,
			command,
			files,
			summary: { files: 0, diagnostics: 0 },
		});
	}
	for (const file of files) assertBoundedDocument(file);

	let lease: ClientLease | undefined;
	let aborted = false;
	const abort = () => {
		aborted = true;
		if (lease) void pool.discard(lease);
	};
	throwIfAborted(signal, adapter);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		ctx.ui.setStatus(statusKey, `${adapter.name} diagnostics`);
		throwIfAborted(signal, adapter);
		lease = await pool.acquire(adapter, root, timeoutMs);
		const client = lease.client;

		const openedFiles: Array<{ file: string; uri: string }> = [];
		try {
			for (const file of files) {
				throwIfAborted(signal, adapter);
				const uri = pathToFileURL(file).href;
				const text = readBoundedDocument(file);
				client.didOpen(uri, text, adapter.languageIdFor(file));
				openedFiles.push({ file, uri });
			}

			const entries: DiagnosticEntry[] = await Promise.all(
				openedFiles.map(async ({ file, uri }) => ({
					path: path.relative(root, file) || file,
					uri,
					diagnostics: await client.diagnostics(uri),
				})),
			);
			return textResult(formatDiagnostics(adapter, entries), {
				root,
				command,
				files: entries,
				summary: summarize(entries),
			});
		} finally {
			for (const { uri } of openedFiles) client.didClose(uri);
		}
	} finally {
		ctx.ui.setStatus(statusKey, undefined);
		signal?.removeEventListener("abort", abort);
		if (lease && !aborted) pool.release(lease);
	}
}

export async function runFix(
	pool: LspClientPool,
	adapter: LspServerAdapter,
	params: { root?: string; path: string; kind?: string; write?: boolean },
	timeoutMs: number,
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const root = resolveRoot(params.root);
	const file = resolveSupportedFile(adapter, root, params.path);
	const actionKind = params.kind?.trim() || "source.fixAll";
	const text = readBoundedDocument(file);

	let lease: ClientLease | undefined;
	let aborted = false;
	const abort = () => {
		aborted = true;
		if (lease) void pool.discard(lease);
	};
	throwIfAborted(signal, adapter);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		ctx.ui.setStatus(statusKey, `${adapter.name} fix`);
		throwIfAborted(signal, adapter);
		lease = await pool.acquire(adapter, root, timeoutMs);
		const client = lease.client;
		throwIfAborted(signal, adapter);
		const uri = pathToFileURL(file).href;
		client.didOpen(uri, text, adapter.languageIdFor(file));
		let resolvedActions: CodeAction[];
		let selectedActions: CodeAction[];
		let edits: LspTextEdit[];
		let newText: string;
		try {
			const diagnostics = await client.diagnostics(uri);
			const actions = await client.codeActions(uri, text, diagnostics, actionKind);
			resolvedActions = await client.resolveActions(actions);
			selectedActions = selectCodeActions(resolvedActions, actionKind);
			edits = selectedActions.flatMap((action) => collectWorkspaceEdits(action.edit, uri));
			if (hasOverlappingTextEdits(text, edits)) {
				const relativePath = path.relative(root, file) || file;
				throw new Error(
					`${adapter.name} LSP returned overlapping code-action edits for ${relativePath}; ` +
						"use a narrower action kind.",
				);
			}
			newText = applyTextEdits(text, edits);
		} finally {
			client.didClose(uri);
		}
		const changed = newText !== text;

		if (params.write && changed) writeFileSync(file, newText);

		return textResult(
			formatEditSummary(adapter, "fix", root, file, changed, params.write, newText),
			{
				path: path.relative(root, file) || file,
				uri,
				changed,
				write: params.write ?? false,
				kind: actionKind,
				actions: resolvedActions.slice(0, MAX_RETAINED_EDIT_ITEMS).map(({ title, kind }) => ({ title, kind })),
				appliedActions: selectedActions.slice(0, MAX_RETAINED_EDIT_ITEMS).map(({ title, kind }) => ({ title, kind })),
				editCount: edits.length,
				edits: edits.slice(0, MAX_RETAINED_EDIT_ITEMS),
				previewTruncated: !params.write && Buffer.byteLength(newText, "utf8") > MAX_MODEL_OUTPUT_BYTES,
			},
		);
	} finally {
		ctx.ui.setStatus(statusKey, undefined);
		signal?.removeEventListener("abort", abort);
		if (lease && !aborted) pool.release(lease);
	}
}

function assertBoundedDocument(file: string) {
	if (statSync(file).size > MAX_LSP_DOCUMENT_BYTES) {
		throw new Error(`LSP document exceeds ${MAX_LSP_DOCUMENT_BYTES} bytes: ${file}. Narrow the requested files.`);
	}
}

function readBoundedDocument(file: string) {
	assertBoundedDocument(file);
	const text = readFileSync(file, "utf8");
	if (Buffer.byteLength(text) > MAX_LSP_DOCUMENT_BYTES) {
		throw new Error(`LSP document exceeds ${MAX_LSP_DOCUMENT_BYTES} bytes after read: ${file}.`);
	}
	return text;
}

function selectCodeActions(actions: CodeAction[], requestedKind: string) {
	return actions.filter(
		(action) => action.kind === requestedKind || action.kind?.startsWith(`${requestedKind}.`),
	);
}

export function formatDiagnostics(adapter: LspServerAdapter, entries: DiagnosticEntry[]) {
	const summary = summarize(entries);
	const headline = `${adapter.name} LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`;
	if (summary.diagnostics === 0) return headline;
	let output = `${headline}\n`;
	let retained = 0;
	outer: for (const entry of entries) {
		for (const diagnostic of entry.diagnostics) {
			if (retained >= MAX_DIAGNOSTIC_LINES) break outer;
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const severity = severityName(diagnostic.severity);
			const source = diagnostic.source ?? adapter.name;
			const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
			const next = `\n${entry.path}:${line}:${column}: ${severity} ${source}${code}: ${diagnostic.message}`;
			if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(next, "utf8") > MAX_MODEL_OUTPUT_BYTES - 160) break outer;
			output += next;
			retained += 1;
		}
	}
	if (retained < summary.diagnostics) output += `\n\n[LSP diagnostics truncated: ${retained} of ${summary.diagnostics} retained]`;
	return output;
}

function formatEditSummary(
	adapter: LspServerAdapter,
	action: "fix",
	root: string,
	file: string,
	changed: boolean,
	write: boolean | undefined,
	text: string,
) {
	const relativePath = path.relative(root, file) || file;
	const status = changed ? (write ? "updated" : "computed changes for") : "left unchanged";
	const summary = `${adapter.name} LSP ${action} ${status} ${relativePath}.`;
	if (write || !changed) return summary;
	return `${summary}\n\n${truncateUtf8(text, MAX_MODEL_OUTPUT_BYTES - Buffer.byteLength(summary, "utf8") - 96)}`;
}

function summarize(entries: DiagnosticEntry[]) {
	return {
		files: entries.length,
		diagnostics: entries.reduce((total, entry) => total + entry.diagnostics.length, 0),
	};
}

function truncateUtf8(value: string, maxBytes: number): string {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.length <= maxBytes) return value;
	let clipped = encoded.subarray(0, Math.max(0, maxBytes)).toString("utf8");
	if (clipped.endsWith("�")) clipped = clipped.slice(0, -1);
	return `${clipped}\n\n[LSP output truncated: ${encoded.length} bytes total]`;
}

function severityName(severity: number | undefined) {
	if (severity === 1) return "error";
	if (severity === 2) return "warning";
	if (severity === 3) return "info";
	if (severity === 4) return "hint";
	return "diagnostic";
}

function throwIfAborted(signal: AbortSignal | undefined, adapter: LspServerAdapter) {
	if (signal?.aborted) throw new Error(`${adapter.name} LSP request aborted.`);
}

export function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
