/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../utils/child-process.ts";

const DEFAULT_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
const FORCE_KILL_DELAY_MS = 5000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/** Combined stdout/stderr raw-byte limit. Default 256 MiB, capped by the runtime string limit.
	 * A nonnegative integer; 0 accepts no output. Exceeding the limit terminates the child. */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** Output exceeded maxBuffer; both streams may be incomplete and code is nonzero. */
	truncated: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout, abort signal and a combined output cap. Owns the direct child
 * and its reading ends; this API does not yet own descendant processes.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}
	if (options?.signal?.aborted) return { stdout: "", stderr: "", code: 1, killed: true, truncated: false };
	const proc = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
	let stdout = "", stderr = "", outputBytes = 0;
	let killed = false, truncated = false, settled = false;
	let timeoutId: NodeJS.Timeout | undefined, forceKillId: NodeJS.Timeout | undefined;
	const forceKill = (): void => {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
	};
	const killProcess = (): void => {
		if (killed || settled) return;
		killed = true;
		// Inherited writing handles must not keep our reading ends alive after cancellation.
		proc.stdout?.destroy(); proc.stderr?.destroy();
		proc.kill("SIGTERM");
		forceKillId = setTimeout(forceKill, FORCE_KILL_DELAY_MS);
	};
	const takeWithinCap = (data: Buffer): Buffer | undefined => {
		if (settled || killed) return undefined;
		const remaining = maxBuffer - outputBytes;
		if (data.length <= remaining) { outputBytes += data.length; return data; }
		outputBytes += remaining;
		truncated = true;
		killProcess();
		return remaining > 0 ? data.subarray(0, remaining) : undefined;
	};
	const onStdoutData = (data: Buffer): void => {
		const chunk = takeWithinCap(data);
		if (chunk) stdout += stdoutDecoder.write(chunk);
	};
	const onStderrData = (data: Buffer): void => {
		const chunk = takeWithinCap(data);
		if (chunk) stderr += stderrDecoder.write(chunk);
	};
	proc.stdout.on("data", onStdoutData); proc.stderr.on("data", onStderrData);
	options?.signal?.addEventListener("abort", killProcess, { once: true });
	if (options?.timeout && options.timeout > 0) timeoutId = setTimeout(killProcess, options.timeout);
	let code: number | null;
	try {
		code = await waitForChildProcess(proc);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		code = 1;
		if (!stderr) stderr = error.message;
	} finally {
		settled = true;
		clearTimeout(timeoutId); clearTimeout(forceKillId);
		options?.signal?.removeEventListener("abort", killProcess);
		proc.stdout.removeListener("data", onStdoutData); proc.stderr.removeListener("data", onStderrData);
		proc.stdout.destroy(); proc.stderr.destroy();
	}
	// A cap can split a valid UTF-8 character. Do not invent a replacement character at that cut.
	if (!truncated) { stdout += stdoutDecoder.end(); stderr += stderrDecoder.end(); }
	const result = { stdout, stderr, code: killed && code === 0 ? 1 : code ?? 1, killed, truncated };
	stdout = ""; stderr = "";
	return result;
}
