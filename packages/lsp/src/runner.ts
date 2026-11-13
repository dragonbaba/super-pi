import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClientLease, LspClientPool } from "./client-pool.ts";
import type { LspClient } from "./lsp-client.ts";
import { collectSupportedFiles, resolveRoot, resolveSupportedFile } from "./files.ts";
import { DEFAULT_FILE_LIMIT, DIAGNOSTIC_BATCH_SIZE, MIN_DIAGNOSTIC_WAIT_MS, MAX_DIAGNOSTIC_WAIT_MS } from "./limits.ts";
import { EMPTY_READONLY_ARRAY } from "./collections.ts";
import { collectSynchronousDiagnostics } from "./synchronous-diagnostics.ts";
import { assertFixAuthorization, type FixAuthorization } from "./fix-authorization.ts";
import { capturePathIdentity } from "@super-pi/coding-agent/internal/files/native-file-core";
import { selectCommitMetadata } from "@super-pi/coding-agent/internal/files/file-commit-metadata";
import { commitPreparedFile, commitFailure, commitSummary, FileCommitError, type FileCommitReceipt } from "@super-pi/coding-agent/internal/files/file-commit";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits } from "./text-edits.ts";
import type {
	CodeAction,
	DiagnosticEntry,
	DiagnosticReport,
	DiagnosticPath,
	SynchronousDiagnostics,
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

interface DiagnosticOutcome { path: string; status: string; completion: string; receivedReport: boolean; elapsedMs: number; diagnosticPath: DiagnosticPath; projectReady?: boolean; projectReadyAtCompletion?: boolean; projectReadyForMs?: number; error?: string; }
interface DiagnosticBatch { files: number; elapsedMs: number; startedMs: number; projectReadiness?: string; }
interface DiagnosticCollection {
	client: LspClient; adapter: LspServerAdapter; root: string; files: readonly string[]; signal?: AbortSignal;
	waitMs?: number; timeoutMs: number; started: number; next: number; active: number; peak: number; submitted: number;
	stopped: boolean; serverFailed: boolean; hasError: boolean; error?: unknown; failure?: string;
	diagnosticPath: DiagnosticPath; synchronousDiagnostics?: SynchronousDiagnostics;
	entries: Array<DiagnosticEntry | undefined>; outcomes: Array<DiagnosticOutcome | undefined>; batches: DiagnosticBatch[];
}
function recordDiagnosticFailure(state: DiagnosticCollection, error: unknown): void {
	state.stopped = true;
	if (!state.hasError) { state.hasError = true; state.error = error; }
	state.failure ??= error instanceof Error ? error.message : String(error);
	if (!state.client.running) state.serverFailed = true;
}
/** One request-owned slot; completion starts another file, never another notification waiter. */
async function runDiagnosticSlot(state: DiagnosticCollection): Promise<void> {
	while (!state.stopped && state.next < state.files.length) {
		const index = state.next++, file = state.files[index], uri = pathToFileURL(file).href;
		const group = Math.floor(index / DIAGNOSTIC_BATCH_SIZE);
		const batch = state.batches[group] ??= { files: 0, elapsedMs: 0, startedMs: performance.now() - state.started };
		let opened = false, text: string | undefined, report: DiagnosticReport | undefined;
		try {
			throwIfAborted(state.signal, state.adapter);
			const readStarted = performance.now();
			try { text = readBoundedDocument(file); }
			catch (error) {
				throwIfAborted(state.signal, state.adapter);
				if (!state.client.running) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const outcome: DiagnosticOutcome = { path: path.relative(state.root, file) || file, status: "unconfirmed", completion: "read_error", receivedReport: false, elapsedMs: performance.now() - readStarted, diagnosticPath: state.diagnosticPath, error: message };
				if (state.diagnosticPath !== "sync-request") { outcome.projectReady = false; outcome.projectReadyAtCompletion = state.client.projectReady; outcome.projectReadyForMs = state.client.projectReadyForMs; }
				state.outcomes[index] = outcome;
				state.failure ??= message;
				continue;
			}
			state.client.didOpen(uri, text, state.adapter.languageIdFor(file));
			text = undefined; // No source payload survives the diagnostic await.
			opened = true; state.active++; state.submitted++; batch.files++;
			state.peak = Math.max(state.peak, state.active);
			report = state.synchronousDiagnostics
				? await collectSynchronousDiagnostics(state.client, file, state.synchronousDiagnostics, state.timeoutMs)
				: await state.client.collectDiagnosticReport(uri, state.waitMs, state.timeoutMs);
			throwIfAborted(state.signal, state.adapter);
			const relativePath = path.relative(state.root, file) || file;
			const outcome: DiagnosticOutcome = { path: relativePath, status: report.error ? "unconfirmed" : "confirmed", completion: report.completion, receivedReport: report.receivedReport, elapsedMs: report.elapsedMs, diagnosticPath: state.diagnosticPath, error: report.error };
			if (state.diagnosticPath !== "sync-request") { outcome.projectReady = report.projectReady; outcome.projectReadyAtCompletion = report.projectReadyAtCompletion; outcome.projectReadyForMs = report.projectReadyForMs; }
			state.outcomes[index] = outcome;
			if (!report.error) state.entries[index] = { path: relativePath, uri, diagnostics: report.diagnostics };
			else state.failure ??= report.error;
			if (!state.client.running) { state.serverFailed = state.stopped = true; state.failure ??= `${state.adapter.name} LSP server exited during diagnostics.`; }
		} catch (error) { recordDiagnosticFailure(state, error); }
		finally {
			text = undefined; report = undefined;
			if (opened) {
				try { if (state.client.running) state.client.didClose(uri); }
				catch (error) { recordDiagnosticFailure(state, error); }
				finally { state.active--; }
			}
			batch.elapsedMs = performance.now() - state.started - batch.startedMs;
			if (state.diagnosticPath !== "sync-request") batch.projectReadiness = state.client.projectReadiness;
		}
	}
}

export async function runDiagnostics(
	pool: LspClientPool,
	adapter: LspServerAdapter,
	params: { root?: string; paths?: string[]; limit?: number; files?: readonly string[]; waitMs?: number },
	timeoutMs: number,
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const started = performance.now();
	if (params.waitMs !== undefined && (!Number.isInteger(params.waitMs) || params.waitMs < MIN_DIAGNOSTIC_WAIT_MS || params.waitMs > MAX_DIAGNOSTIC_WAIT_MS)) throw new Error(`waitMs must be an integer from ${MIN_DIAGNOSTIC_WAIT_MS} to ${MAX_DIAGNOSTIC_WAIT_MS}.`);
	let effectiveWaitMs: number | "not_applicable" = Math.min(params.waitMs ?? adapter.pushDiagnosticsGraceMs ?? timeoutMs, timeoutMs);
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
			outcomes: [], unconfirmedFiles: [], submittedFiles: 0, requestedFiles: 0,
			elapsedMs: performance.now() - started, batchCount: 0, batches: [], effectiveWaitMs,
			diagnosticPath: undefined as DiagnosticPath | undefined, diagnosticConcurrency: 0,
			summary: { files: 0, diagnostics: 0 },
		}), isError: true };
	}

	let lease: ClientLease | undefined;
	let diagnosticTurn: symbol | undefined;
	let executing = false;
	let aborted = false;
	let discard: Promise<void> | undefined;
	const abort = () => {
		aborted = true;
		if (lease && executing && !discard) { discard = pool.discard(lease); void discard.catch(observeDiscardFailure); }
	};
	throwIfAborted(signal, adapter);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		ctx.ui.setStatus(statusKey, `${adapter.name} diagnostics`);
		throwIfAborted(signal, adapter);
		lease = await pool.acquire(adapter, root, timeoutMs);
		throwIfAborted(signal, adapter);
		const client = lease.client;
		const declared = adapter.synchronousDiagnostics;
		const synchronousDiagnostics = declared && client.supportsExecuteCommand(declared.command) ? declared : undefined;
		const diagnosticPath: DiagnosticPath = synchronousDiagnostics ? "sync-request" : client.supportsPullDiagnostics ? "pull" : "publish";
		const diagnosticConcurrency = Math.min(DIAGNOSTIC_BATCH_SIZE, Math.max(1, synchronousDiagnostics?.maxConcurrentFiles ?? DIAGNOSTIC_BATCH_SIZE));
		effectiveWaitMs = synchronousDiagnostics ? "not_applicable" : client.diagnosticWaitMs(params.waitMs, timeoutMs);
		diagnosticTurn = await client.acquireDiagnosticTurn(signal);
		throwIfAborted(signal, adapter);
		executing = true;

		const state: DiagnosticCollection = { client, adapter, root, files, signal, waitMs: params.waitMs, timeoutMs, started,
			diagnosticPath, synchronousDiagnostics,
			next: 0, active: 0, peak: 0, submitted: 0, stopped: false, serverFailed: false, hasError: false,
			entries: new Array(files.length), outcomes: new Array(files.length), batches: [] };
		const slots: Promise<void>[] = [];
		try {
			for (let slot = 0; slot < Math.min(diagnosticConcurrency, files.length); slot++) slots.push(runDiagnosticSlot(state));
			// Slots own every in-flight file until close, including after another slot fails.
			await Promise.all(slots);
			throwIfAborted(signal, adapter);
			if (state.hasError && !state.serverFailed) throw state.error;
			let confirmed = 0;
			for (let index = 0; index < files.length; index++) {
				if (state.entries[index]) state.entries[confirmed++] = state.entries[index];
				if (!state.outcomes[index]) {
					const outcome: DiagnosticOutcome = { path: path.relative(root, files[index]) || files[index], status: "not_started", completion: "server_error", receivedReport: false, elapsedMs: 0, diagnosticPath };
					if (diagnosticPath !== "sync-request") { outcome.projectReady = false; outcome.projectReadyAtCompletion = false; outcome.projectReadyForMs = 0; }
					state.outcomes[index] = outcome;
				}
			}
			state.entries.length = confirmed;
			const entries = state.entries as DiagnosticEntry[], outcomes = state.outcomes as DiagnosticOutcome[];
			const unconfirmedFiles: string[] = [];
			for (const outcome of outcomes) if (outcome.status !== "confirmed") unconfirmedFiles.push(outcome.path);
			const isError = state.serverFailed || unconfirmedFiles.length > 0;
			const notice = isError ? `\nUnconfirmed: ${unconfirmedFiles.length} file(s). This is not a complete pass. Confirmed reports are retained; retry only unconfirmedFiles.\n` : "";
			let text = formatDiagnostics(adapter, entries, MAX_MODEL_OUTPUT_BYTES - Buffer.byteLength(notice));
			if (isError) {
				text += notice;
				let bytes = Buffer.byteLength(text);
				for (const file of unconfirmedFiles) { const line = `\n${file}`; const size = Buffer.byteLength(line); if (bytes + size > MAX_MODEL_OUTPUT_BYTES) break; text += line; bytes += size; }
			}
			return { ...textResult(text, {
				root,
				status: state.serverFailed ? "failed" : isError ? "partial" : "diagnostics_received",
				command,
				files: entries,
				outcomes, unconfirmedFiles, submittedFiles: state.submitted, requestedFiles: files.length,
				elapsedMs: performance.now() - started, batchCount: state.batches.length, batches: state.batches, effectiveWaitMs, failure: state.failure,
				diagnosticPath, diagnosticConcurrency, syncRequestFallback: declared && !synchronousDiagnostics ? "command_not_advertised" : undefined,
				scheduling: "sliding_window", peakOpenDocuments: state.peak,
				summary: summarize(entries),
			}), isError };
		} finally {
			slots.length = 0; state.files = EMPTY_READONLY_ARRAY;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		if (lease && diagnosticTurn !== undefined) lease.client.releaseDiagnosticTurn(diagnosticTurn);
		try {
			if (lease) { if (aborted && executing) await (discard ?? pool.discard(lease)); else pool.release(lease); }
		} finally { ctx.ui.setStatus(statusKey, undefined); }
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

export function formatDiagnostics(adapter: LspServerAdapter, entries: DiagnosticEntry[], maxBytes = MAX_MODEL_OUTPUT_BYTES) {
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
			if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(next, "utf8") > maxBytes - 160) break outer;
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

export function textResult<T>(text: string, details: T) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
