/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import type { WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnsiStreamFilter } from "../utils/ansi.ts";
import { createPrivateOutputStream } from "../utils/private-output-file.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { CARRIAGE_RETURN_PATTERN } from "../utils/shell-regex.ts";
import type { BashOperations } from "./tools/bash.ts";
import { normalizeShellProcessResult, observedShellError, shellProcessResultFromError } from "./tools/shell-execution.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

const STREAM_DECODE_OPTIONS = { stream: true };

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileClosed: Promise<void> | undefined;
	let tempFileError: Error | undefined;
	let onTempFileOpen: (() => void) | undefined;
	const onTempFileError = (error: Error) => { tempFileError ??= error; };
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFileStream || tempFileError) {
			return;
		}
		try {
			const path = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
			// Only a successful exclusive open grants cleanup ownership. A collision
			// must neither truncate/follow the existing entry nor remove it later.
			// Private at creation: POSIX mode or a protected current-user Windows DACL.
			tempFileStream = createPrivateOutputStream(path);
			onTempFileOpen = () => { tempFilePath = path; };
			tempFileStream.once("open", onTempFileOpen);
			tempFileStream.on("error", onTempFileError);
			// One non-rejecting close waiter at the spill boundary, never per chunk.
			// An error may precede physical close, so error alone cannot release it.
			tempFileClosed = new Promise<void>(resolve => { tempFileStream!.once("close", resolve); });
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		} catch (error) {
			// I/O setup failures must not escape a local stdout/stderr data listener.
			tempFileError ??= error instanceof Error ? error : new Error(String(error));
		}
	};

	// Independent pipes must not complete each other's ANSI or UTF-8 prefixes.
	// Unlabelled legacy custom output uses the stdout slot as one logical stream.
	let stdoutDecoder: TextDecoder | undefined = new TextDecoder();
	let stderrDecoder: TextDecoder | undefined = new TextDecoder();
	let stdoutAnsi: AnsiStreamFilter | undefined = new AnsiStreamFilter();
	let stderrAnsi: AnsiStreamFilter | undefined = new AnsiStreamFilter();
	let onChunk = options?.onChunk;
	const appendText = (filtered: string) => {
		// ANSI has already been filtered using the source's own state.
		const text = sanitizeBinaryOutput(filtered).replace(
			CARRIAGE_RETURN_PATTERN,
			"",
		);
		if (!text) return;

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream && !tempFileError) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes) {
			const excess = outputBytes - maxOutputBytes;
			const first = outputChunks[0];
			if (first.length <= excess) {
				outputChunks.shift();
				outputBytes -= first.length;
			} else {
				// Keep the tail of a large chunk, not just later small chunks.
				outputChunks[0] = first.slice(excess);
				outputBytes -= excess;
			}
		}

		// Stream to callback
		onChunk?.(text);
	};
	const onData = (data: Buffer, source?: "stdout" | "stderr") => {
		// Custom operations may retain this callback beyond command completion.
		const decoder = source === "stderr" ? stderrDecoder : stdoutDecoder;
		const ansi = source === "stderr" ? stderrAnsi : stdoutAnsi;
		if (!decoder || !ansi) return;
		totalBytes += data.length;
		appendText(ansi.write(decoder.decode(data, STREAM_DECODE_OPTIONS)));
	};

	try {
		let result;
		let cancelled = false;
		try {
			result = normalizeShellProcessResult(await operations.exec(command, cwd, {
				onData,
				signal: options?.signal,
			}));
			// An observed zero exit alone does not mean the entire submitted command
			// reached the shell. Propagate producer facts to direct Session/RPC callers
			// before they can persist a successful BashResult; never retry the command.
			if (result.inputError !== undefined) throw observedShellError(new Error(`[SHELL_INPUT_FAILED] Command input was not fully delivered: ${result.inputError}`), result);
			if (result.observationError !== undefined) throw observedShellError(new Error(`[SHELL_OBSERVATION_FAILED] ${result.observationError}`), result);
			if (result.observation?.outputDrained === false || result.observation?.started === false
				|| result.termination !== undefined && result.termination !== "exit" || result.exitCode === null) {
				throw observedShellError(new Error("[SHELL_EXECUTION_FAILED] Command completion was not fully observed; inspect state before retrying."), result);
			}
		} catch (err) {
			// Cancellation cannot erase an already observed delivery/completion failure.
			const observed = shellProcessResultFromError(err);
			if (!options?.signal?.aborted || (observed && (observed.inputError !== undefined || observed.observationError !== undefined
				|| observed.observation?.outputDrained === false || observed.termination !== "cancelled"))) throw err;
			cancelled = true;
		}
		// Flush UTF-8 once, before discarding an unfinished control. A callback
		// failure here must still reject, including after accepted cancellation.
		const finalStdout = stdoutDecoder.decode();
		const finalStderr = stderrDecoder.decode();
		stdoutDecoder = undefined;
		stderrDecoder = undefined;
		appendText(stdoutAnsi.write(finalStdout));
		appendText(stderrAnsi.write(finalStderr));
		cancelled ||= options?.signal?.aborted ?? false;

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
			await tempFileClosed;
			if (!tempFileError && !tempFileStream.writableFinished) {
				tempFileError = new Error("Output log closed before all writes finished");
			}
		}
		if (tempFileError) throw tempFileError;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result?.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		stdoutDecoder = undefined;
		stderrDecoder = undefined;
		if (tempFileStream) {
			if (!tempFileStream.writableEnded) tempFileStream.end();
			// Rejection has no BashResult through which callers could find this log.
			// Wait for this owned stream to close before removing its exact path.
			await tempFileClosed;
		}
		if (tempFilePath) {
			try { await unlink(tempFilePath); }
			catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
					const failure = Object.assign(new Error(`${err instanceof Error ? err.message : String(err)}\n[SHELL_LOG_CLEANUP_FAILED] Output retained at ${tempFilePath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: err }), { fullOutputPath: tempFilePath });
					const result = shellProcessResultFromError(err);
					throw result ? observedShellError(failure, result) : failure;
				}
			}
		}

		throw err;
	} finally {
		stdoutDecoder = undefined;
		stderrDecoder = undefined;
		stdoutAnsi?.reset();
		stderrAnsi?.reset();
		stdoutAnsi = undefined;
		stderrAnsi = undefined;
		onChunk = undefined;
		outputChunks.length = 0;
		if (onTempFileOpen) tempFileStream?.off("open", onTempFileOpen);
		tempFileStream?.off("error", onTempFileError);
		onTempFileOpen = undefined;
		tempFileStream = undefined;
		tempFileClosed = undefined;
		tempFileError = undefined;
		tempFilePath = undefined;
	}
}
