import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientLease, LspClientPool } from "./client-pool.ts";
import type { LspClient } from "./lsp-client.ts";
import { collectSupportedFiles, resolveRoot, resolveSupportedFile } from "./files.ts";
import { DEFAULT_FILE_LIMIT, DIAGNOSTIC_BATCH_SIZE } from "./limits.ts";
import { assertFixAuthorization, type FixAuthorization } from "./fix-authorization.ts";
import { capturePathIdentity } from "@super-pi/coding-agent/internal/files/native-file-core";
import { selectCommitMetadata } from "@super-pi/coding-agent/internal/files/file-commit-metadata";
import { commitPreparedFile, commitFailure, commitSummary, FileCommitError, type FileCommitReceipt } from "@super-pi/coding-agent/internal/files/file-commit";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits } from "./text-edits.ts";
import type {
	CodeAction,
	DiagnosticEntry,
	LspServerAdapter,
	LspTextEdit,
	StatusContext,
} from "./types.ts";

const MAX_LSP_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 50 * 1024;
const MAX_DIAGNOSTIC_LINES = 500;
const MAX_RETAINED_EDIT_ITEMS = 200;
// Observe early shutdown rejection immediately; the invocation finally awaits and reports it.
function observeDiscardFailure(): void {}

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
		return { ...textResult(`${adapter.name} LSP found no supported files to check. Not checked; no validation pass is established.`, {
			root,
			status: "not_checked",
			command,
			files,
			summary: { files: 0, diagnostics: 0 },
		}), isError: true };
	}
	for (const file of files) assertBoundedDocument(file);

	let lease: ClientLease | undefined;
	let diagnosticTurn: symbol | undefined;
	let aborted = false;
	let discard: Promise<void> | undefined;
	const abort = () => {
		aborted = true;
		if (lease && !discard) { discard = pool.discard(lease); void discard.catch(observeDiscardFailure); }
	};
	throwIfAborted(signal, adapter);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		ctx.ui.setStatus(statusKey, `${adapter.name} diagnostics`);
		throwIfAborted(signal, adapter);
		lease = await pool.acquire(adapter, root, timeoutMs);
		throwIfAborted(signal, adapter);
		const client = lease.client;
		diagnosticTurn = await client.acquireDiagnosticTurn();
		throwIfAborted(signal, adapter);

		const entries: DiagnosticEntry[] = [];
		const openedFiles: Array<{ file: string; uri: string }> = [];
		const pending: Promise<DiagnosticEntry>[] = [];
		try {
			for (let offset = 0; offset < files.length; offset += DIAGNOSTIC_BATCH_SIZE) {
				throwIfAborted(signal, adapter);
				try {
					const end = Math.min(offset + DIAGNOSTIC_BATCH_SIZE, files.length);
					for (let index = offset; index < end; index++) {
						throwIfAborted(signal, adapter);
						const file = files[index];
						const uri = pathToFileURL(file).href;
						const text = readBoundedDocument(file);
						client.didOpen(uri, text, adapter.languageIdFor(file));
						openedFiles.push({ file, uri });
					}
					for (const opened of openedFiles) pending.push(collectDiagnosticEntry(client, root, opened.file, opened.uri));
					const batch = await Promise.all(pending);
					throwIfAborted(signal, adapter);
					if (!client.running) throw new Error(`${adapter.name} LSP server exited during diagnostics; validation is unconfirmed.`);
					for (const entry of batch) entries.push(entry);
				} finally {
					pending.length = 0;
					try { for (const { uri } of openedFiles) if (client.running) client.didClose(uri); }
					finally { openedFiles.length = 0; }
				}
			}

			return textResult(formatDiagnostics(adapter, entries), {
				root,
				status: "diagnostics_received",
				command,
				files: entries,
				summary: summarize(entries),
			});
		} finally {
			pending.length = 0;
			openedFiles.length = 0;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		if (lease && diagnosticTurn !== undefined) lease.client.releaseDiagnosticTurn(diagnosticTurn);
		try {
			if (lease) { if (aborted) await (discard ?? pool.discard(lease)); else pool.release(lease); }
		} finally { ctx.ui.setStatus(statusKey, undefined); }
	}
}

// Explicit diagnostics-call setup; protocol notification delivery remains callback-stable.
async function collectDiagnosticEntry(client: LspClient, root: string, file: string, uri: string): Promise<DiagnosticEntry> {
	return { path: path.relative(root, file) || file, uri, diagnostics: await client.diagnostics(uri, true) };
}

export async function runFix(
	pool: LspClientPool,
	adapter: LspServerAdapter,
	params: { root?: string; path: string; kind?: string; write?: boolean },
	timeoutMs: number,
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
	authorization?: FixAuthorization,
) {
	const root = resolveRoot(params.root);
	const file = resolveSupportedFile(adapter, root, params.path);
	if (params.write) {
		assertFixAuthorization(authorization, file);
		signal = signal ? AbortSignal.any([signal, authorization!.revocationSignal]) : authorization!.revocationSignal;
	}
	const actionKind = params.kind?.trim() || "source.fixAll";
	const target = params.write ? await capturePathIdentity(file) : undefined;
	const text = readBoundedDocument(file);
	const plan = target ? { target, parent: await capturePathIdentity(path.dirname(file)),
		previousSha256: createHash("sha256").update(text, "utf8").digest("hex"), metadata: await selectCommitMetadata(target) } : undefined;

	let lease: ClientLease | undefined;
	let discard: Promise<void> | undefined;
	let aborted = false;
	const abort = () => {
		aborted = true;
		if (lease && !discard) { discard = pool.discard(lease); void discard.catch(observeDiscardFailure); }
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

		throwIfAborted(signal, adapter);
		let commit: FileCommitReceipt | undefined;
		if (params.write && changed) {
			assertFixAuthorization(authorization, file);
			if (Buffer.byteLength(newText, "utf8") > MAX_LSP_DOCUMENT_BYTES) throw new Error("LSP fix result exceeds the document byte limit.");
			try {
				commit = await commitPreparedFile(plan!, Buffer.from(newText, "utf8"), {
					assertPathAllowed: async () => { assertFixAuthorization(authorization, file); return authorization!.canonicalTarget; },
					assertCurrent: authorization!.assertCurrent,
					signal,
				});
			} catch (error) {
				if (!(error instanceof FileCommitError)) throw error;
				return { ...textResult(`LSP fix could not finish. Inspect the current file before retrying.\n${commitSummary(error.receipt)}\n${error.message}`,
					{ path: path.relative(root, file) || file, ...commitFailure(error) }), isError: true };
			}
		}

		return textResult(
			formatEditSummary(adapter, "fix", root, file, changed, params.write, newText),
			{
				path: path.relative(root, file) || file,
				uri,
				changed,
				write: params.write ?? false,
				commit,
				kind: actionKind,
				actions: resolvedActions.slice(0, MAX_RETAINED_EDIT_ITEMS).map(({ title, kind }) => ({ title, kind })),
				appliedActions: selectedActions.slice(0, MAX_RETAINED_EDIT_ITEMS).map(({ title, kind }) => ({ title, kind })),
				editCount: edits.length,
				edits: edits.slice(0, MAX_RETAINED_EDIT_ITEMS),
				previewTruncated: !params.write && Buffer.byteLength(newText, "utf8") > MAX_MODEL_OUTPUT_BYTES,
			},
		);
	} finally {
		signal?.removeEventListener("abort", abort);
		try {
			if (lease) { if (aborted) await (discard ?? pool.discard(lease)); else pool.release(lease); }
		} finally { ctx.ui.setStatus(statusKey, undefined); }
	}
}

function assertBoundedDocument(file: string) {
	if (statSync(file).size > MAX_LSP_DOCUMENT_BYTES) {
		throw new Error(`LSP document exceeds ${MAX_LSP_DOCUMENT_BYTES} bytes: ${file}. Narrow the requested files.`);
	}
}

function readBoundedDocument(file: string) {
	const fd = openSync(file, "r");
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error(`LSP document must be a regular file: ${file}.`);
		const size = info.size;
		if (size > MAX_LSP_DOCUMENT_BYTES) throw new Error(`LSP document exceeds ${MAX_LSP_DOCUMENT_BYTES} bytes: ${file}.`);
		// One bounded file-owned buffer, including a growth sentinel; no per-read wrappers or arrays.
		const bytes = Buffer.allocUnsafe(size + 1);
		let used = 0;
		while (used < bytes.length) {
			const count = readSync(fd, bytes, used, bytes.length - used, null);
			if (count === 0) break;
			used += count;
		}
		if (used !== size) throw new Error(`LSP document size changed while reading: ${file}. Retry from a fresh read.`);
		const text = bytes.toString("utf8", 0, used);
		if (Buffer.byteLength(text) > MAX_LSP_DOCUMENT_BYTES) throw new Error(`LSP decoded document exceeds ${MAX_LSP_DOCUMENT_BYTES} bytes: ${file}.`);
		return text;
	} finally { closeSync(fd); }
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
