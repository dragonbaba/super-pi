/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../utils/child-process.ts";
import { stopOwnedProcessGroup, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import { WindowsShellJob } from "../utils/windows-shell-job.ts";

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

/** Internal runtime lifecycle; no per-chunk signal composition or ownership wrappers. */
export interface ExecLifecycleOwner {
	readonly signal: AbortSignal;
	recordCleanupFailure(message: string): void;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Owns a Windows job or a POSIX process group through physical cleanup.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
	owner?: ExecLifecycleOwner,
): Promise<ExecResult> {
	const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}
	const ownerSignal = owner?.signal;
	const deadline = options?.timeout && options.timeout > 0 ? performance.now() + options.timeout : undefined;
	const cancelled = (): boolean => Boolean(options?.signal?.aborted || ownerSignal?.aborted || deadline !== undefined && performance.now() >= deadline);
	if (cancelled()) return { stdout: "", stderr: "", code: 1, killed: true, truncated: false };
	let job: WindowsShellJob | undefined, proc: ChildProcess;
	let admissionCancelled = false;
	const beforeSpawn = (): void => {
		if (cancelled()) { admissionCancelled = true; throw new Error("Command cancelled before dispatch"); }
	};
	try {
		if (process.platform === "win32") {
			job = await WindowsShellJob.spawn(command, args, cwd, process.env, false, undefined, beforeSpawn);
			proc = job.child;
		} else {
			proc = spawn(command, args, { cwd, shell: false, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			if (proc.pid) trackDetachedChildPid(proc.pid);
		}
	} catch (error) {
		return { stdout: "", stderr: admissionCancelled ? "" : error instanceof Error ? error.message : String(error), code: 1, killed: admissionCancelled, truncated: false };
	}
	const output = proc.stdout!, errors = proc.stderr!;
	const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
	let stdout = "", stderr = "", outputBytes = 0;
	let killed = false, truncated = false, settled = false;
	let timeoutId: NodeJS.Timeout | undefined, forceKillId: NodeJS.Timeout | undefined;
	let cleanup: Promise<string | undefined> | undefined;
	const forceKill = (): void => {
		if (cleanup) return;
		if (job) cleanup = job.stop();
		else if (proc.pid) cleanup = stopOwnedProcessGroup(proc.pid);
	};
	const onRootExit = (): void => { forceKill(); };
	const killProcess = (): void => {
		if (killed || settled) return;
		killed = true;
		// Inherited writing handles must not keep our reading ends alive after cancellation.
		output.destroy(); errors.destroy();
		if (job) forceKill();
		else if (proc.pid) {
			try { process.kill(-proc.pid, "SIGTERM"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") forceKill(); }
			if (!cleanup) forceKillId = setTimeout(forceKill, FORCE_KILL_DELAY_MS);
		}
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
	output.on("data", onStdoutData); errors.on("data", onStderrData);
	proc.on("exit", onRootExit);
	options?.signal?.addEventListener("abort", killProcess, { once: true });
	ownerSignal?.addEventListener("abort", killProcess, { once: true });
	if (deadline !== undefined) timeoutId = setTimeout(killProcess, Math.max(0, deadline - performance.now()));
	let code: number | null;
	let cleanupFailure: string | undefined;
	try {
		const exit = waitForChildProcess(proc);
		// Windows admission awaits native initialization; consume cancellation in that gap.
		if (cancelled()) killProcess();
		code = await exit;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		code = 1;
		if (!stderr) stderr = error.message;
	} finally {
		settled = true;
		clearTimeout(timeoutId); clearTimeout(forceKillId);
		forceKill();
		try { cleanupFailure = await cleanup; }
		catch (error) { cleanupFailure = `Process-tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
		if (cleanupFailure) owner?.recordCleanupFailure(cleanupFailure);
		else if (!job && proc.pid) untrackDetachedChildPid(proc.pid);
		options?.signal?.removeEventListener("abort", killProcess);
		ownerSignal?.removeEventListener("abort", killProcess);
		proc.removeListener("exit", onRootExit);
		output.removeListener("data", onStdoutData); errors.removeListener("data", onStderrData);
		output.destroy(); errors.destroy();
	}
	// A cap can split a valid UTF-8 character. Do not invent a replacement character at that cut.
	if (!truncated) { stdout += stdoutDecoder.end(); stderr += stderrDecoder.end(); }
	const failure = cleanupFailure ?? job?.dispatchError ?? job?.launchError?.message;
	if (failure) { code = 1; stderr = stderr ? `${stderr}\n${failure}` : failure; }
	const result = { stdout, stderr, code: killed && code === 0 ? 1 : code ?? 1, killed, truncated };
	stdout = ""; stderr = "";
	return result;
}
