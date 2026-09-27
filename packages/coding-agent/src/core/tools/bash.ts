import { withMsysStdinBridge } from "./msys-stdin.ts";
import { boundedShellInput } from "./bounded-shell-input.ts";
import { prepareShellCwd, getShellCwdBinding, isLocalShellBackend, registerLocalShellBackend } from "./shell-cwd.ts";
import { constants } from "node:fs";
import { access as fsAccess, realpath as fsRealpath } from "node:fs/promises";
import { type AgentTool, ToolResultError, toolResultFromError } from "@super-pi/agent-core";
import { type Component, Container, getCapabilities, RELEASE_COMPONENT_RENDER_CACHE, Text, truncateToWidth, visibleWidth } from "@super-pi/tui";
import { spawn } from "child_process";
import type { Writable } from "node:stream";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess, type ChildProcessObservation } from "../../utils/child-process.ts";
import { normalizeShellProcessResult, observedShellError, shellProcessResultFromError, readShellExecution, shellFailureCategory, type ShellExecutionFacts, type ShellProcessResult, type ShellTermination } from "./shell-execution.ts";
import { setOwnProperty } from "../../utils/record.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { ANSI_SGR_PATTERN, NODE_PARSE_LOCATION_PATTERN } from "./bash-regex.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import {
	RELEASE_TOOL_RENDER_DERIVED_STATE,
	TOOL_RENDER_LIFECYCLE_GENERATION,
	type ToolRenderLifecycleState,
} from "./tool-render-lifecycle.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const OUTPUT_FAILURE_ABORT = Symbol("shell-output-failure-abort");
const SHELL_START_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EINVAL"]);

function appendShellStatus(text: string, status: string): string { return `${text ? `${text}\n\n` : ""}${status}`; }
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const SESSION_ENVIRONMENT_KEYS = new Set([
	"SP_SESSION_ID",
	"SP_SESSION_FILE",
	"SP_PROVIDER",
	"SP_MODEL",
	"SP_REASONING_LEVEL",
]);
// Inherited values that change Bash `cd` resolution or run Bash startup code invisibly
// to command inspection. A spawn hook may still set them deliberately.
const SHELL_SEMANTIC_ENVIRONMENT_KEYS = new Set(["CDPATH", "BASHOPTS", "SHELLOPTS", "BASH_ENV", "ENV", "POSIXLY_CORRECT"]);

function isShellSemanticEnvironmentKey(key: string): boolean {
	return SHELL_SEMANTIC_ENVIRONMENT_KEYS.has(key) || key.startsWith("BASH_FUNC_");
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Literal directory for this call; relative to Session cwd. No shell or home expansion. Does not change Session cwd." })),
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [
		"You can inspect SP_* environment variables for current model and session details.",
		"For Node scripts, use node -e when the one-off source can be passed reliably; for complex quoting or reusable code, an explicit file or supported stdin is optional. Script length does not decide permission, and a file does not bypass approval.",
	],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	cwd?: string;
	shellExecution?: ShellExecutionFacts;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	spillFileCapped?: boolean;
	/** Producer-issued by the Agent for a refusal before the Bash tool ran. */
	executionStatus?: "not_executed";
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			beforeSpawn?: (cwd: string) => void;
		},
	) => Promise<ShellProcessResult>;
}

/** One observer per command-input pipe, retained through close so EPIPE cannot
 * arrive after facts are finalized or become an unhandled late stream error. */
class ShellInputObserver {
	private stream: Writable | undefined;
	private resolveClosed: (() => void) | undefined;
	private readonly closed: Promise<void>;
	error: string | undefined;
	private readonly onError = (error: Error): void => { this.error ??= error.message.slice(0, 1000); };
	private readonly onClose = (): void => {
		this.stream?.removeListener("error", this.onError);
		this.stream = undefined;
		const resolve = this.resolveClosed; this.resolveClosed = undefined; resolve?.();
	};
	constructor(stream: Writable) {
		this.stream = stream;
		this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
		stream.on("error", this.onError); stream.once("close", this.onClose);
	}
	finish(): Promise<void> { this.stream?.destroy(); return this.closed; }
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return registerLocalShellBackend({
		exec: async (command, cwd, { onData, signal, timeout, env, beforeSpawn }) => {
			const observation: ChildProcessObservation = { started: false, exitCode: null, signal: null, outputDrained: false };
			let stopReason: ShellTermination | undefined;
			let inputObserver: ShellInputObserver | undefined;
			try {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				stopReason = "cancelled";
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const actualCwd = await fsRealpath(cwd);
			observation.cwd = actualCwd;
			if (signal?.aborted) { stopReason = "cancelled"; signal.throwIfAborted(); }
			beforeSpawn?.(actualCwd);
			observation.spawnAttempted = true;
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd: actualCwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin && child.stdin) {
				inputObserver = new ShellInputObserver(child.stdin);
				child.stdin.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timeoutHandle: NodeJS.Timeout | undefined;
			let outputSettled = false;
			const onAbort = () => {
				if (outputSettled) return;
				stopReason ??= signal?.reason?.[OUTPUT_FAILURE_ABORT] ? "output_failure" : "cancelled";
				if (child.pid) killProcessTree(child.pid);
				if (observation.exitCode !== null || observation.signal !== null) { child.stdout?.destroy(); child.stderr?.destroy(); }
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						if (outputSettled) return;
						stopReason ??= "timeout";
						if (child.pid) killProcessTree(child.pid);
						if (observation.exitCode !== null || observation.signal !== null) { child.stdout?.destroy(); child.stderr?.destroy(); }
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child, observation);
				outputSettled = true;
				await inputObserver?.finish();
				const termination = stopReason ?? (observation.signal ? "signal" : exitCode === null ? "unknown" : "exit");
				const result: ShellProcessResult = { exitCode, observation, termination, inputError: inputObserver?.error };
				if (stopReason) throw observedShellError(new Error(stopReason === "timeout" ? `timeout:${timeout}` : stopReason === "output_failure" ? "output capture failed" : "aborted"), result);
				return result;
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				child.stdout?.removeListener("data", onData); child.stderr?.removeListener("data", onData);
				await inputObserver?.finish();
			}
			} catch (error) {
				if (shellProcessResultFromError(error)) throw error;
				if (!observation.started) observation.outputDrained = true;
				throw observedShellError(error, { exitCode: observation.exitCode, observation,
					termination: observation.started ? stopReason ?? "unknown" : stopReason === "cancelled" ? "cancelled" : "not_started", inputError: inputObserver?.error });
			}
		},
	});
}

/**
 * Create bash operations using Super Pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want Super Pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	let config: ShellConfig | undefined;
	return createLocalShellOperations("bash", () => (config ??= getShellConfig(options?.shellPath)));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
	filterBashSemantics: boolean,
): BashSpawnContext {
	const shellEnv = getShellEnv();
	const env: NodeJS.ProcessEnv = {};
	const shellEnvKeys = Object.keys(shellEnv);
	for (let index = 0; index < shellEnvKeys.length; index++) {
		const key = shellEnvKeys[index]!;
		if (!SESSION_ENVIRONMENT_KEYS.has(key) && !(filterBashSemantics && isShellSemanticEnvironmentKey(key))) setOwnProperty(env, key, shellEnv[key]);
	}
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.SP_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.SP_SESSION_FILE = sessionFile;
		if (model) {
			env.SP_PROVIDER = model.provider;
			env.SP_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.SP_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as SP_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;
const MAX_FAILURE_FRAGMENT_CHARS = 2048;
const BASH_SPECIFIC_FAILURE_MARKERS = [
	"SyntaxError",
	"TypeError",
	"ReferenceError",
	"RangeError",
	"AssertionError",
	"Cannot find module",
	"ERR_",
] as const;
const BASH_GENERIC_FAILURE_MARKERS = [
	"Error:",
	"Command exited with code",
	"Command timed out",
	"Command aborted",
] as const;

function nextLineEnd(text: string, start: number): number {
	const end = text.indexOf("\n", start);
	return end === -1 ? text.length : end;
}

function lineHasSpecificFailureMarker(line: string): boolean {
	for (const marker of BASH_SPECIFIC_FAILURE_MARKERS) if (line.includes(marker)) return true;
	return false;
}

function lineHasGenericFailureMarker(line: string): boolean {
	for (const marker of BASH_GENERIC_FAILURE_MARKERS) if (line.includes(marker)) return true;
	return false;
}

function boundFailureFragment(line: string): string {
	if (line.length <= MAX_FAILURE_FRAGMENT_CHARS) return line;
	const tailLength = 512;
	return line.slice(0, MAX_FAILURE_FRAGMENT_CHARS - tailLength - 1) + "…" + line.slice(-tailLength);
}

type BashFailurePreview = {
	context: string[];
	exception: string;
	status: string | undefined;
	stack: string | undefined;
	omitted: boolean;
	statusFirst: boolean;
};

function nodeParseContext(lines: readonly string[]): string[] {
	let locationIndex = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (NODE_PARSE_LOCATION_PATTERN.test(lines[index]!.replace(ANSI_SGR_PATTERN, "").trim())) {
			locationIndex = index;
			break;
		}
	}
	if (locationIndex < 0) return [];
	const context: string[] = [];
	for (let index = locationIndex; index < lines.length && context.length < 3; index++) {
		const line = lines[index]!;
		if (line.trim()) context.push(line);
	}
	return context.map(boundFailureFragment);
}

function isShellStatusFooter(line: string): boolean {
	return line === "[SHELL_RUNTIME_FAILED]" || line === "[SHELL_INTERRUPTED]" || line === "[SHELL_START_FAILED]" || line === "[SHELL_OUTPUT_FAILED]"
		|| line.startsWith("Command exited with code ") || line.startsWith("Command timed out") || line.startsWith("Command aborted");
}

/** Select the first useful failure and terminal status once per final result. */
function createBashFailurePreview(output: string, execution?: ShellExecutionFacts): BashFailurePreview | undefined {
	let firstUseful: string | undefined;
	let firstUsefulPrefix: string[] = [];
	let firstUsefulEnd = -1;
	let genericFailure: string | undefined;
	let genericFailureEnd = -1;
	let status: string | undefined;
	let nonblankCharacters = 0;
	let firstDiagnostic: string | undefined;
	let nextStack: string | undefined;
	const recentLines: string[] = [];
	for (let start = 0; start < output.length;) {
		const end = nextLineEnd(output, start);
		const line = output.slice(start, end);
		if (line.trim()) {
			nonblankCharacters += line.length;
			if (execution && firstDiagnostic === undefined && !isShellStatusFooter(line)) firstDiagnostic = boundFailureFragment(line);
		}
		if (!firstUseful) {
			if (lineHasSpecificFailureMarker(line)) {
				firstUseful = line;
				firstUsefulEnd = end;
				if (line.includes("SyntaxError")) firstUsefulPrefix = nodeParseContext(recentLines);
			} else if (!genericFailure && lineHasGenericFailureMarker(line) && (!execution || !isShellStatusFooter(line))) {
				genericFailure = line;
				genericFailureEnd = end;
			}
		}
		if (!execution && (line.includes("Command exited with code") || line.includes("Command timed out") || line.includes("Command aborted"))) status = line;
		recentLines.push(line);
		if (recentLines.length > 4) recentLines.shift();
		if (end === output.length) break;
		start = end + 1;
	}
	if (!firstUseful && genericFailure) {
		firstUseful = genericFailure;
		firstUsefulEnd = genericFailureEnd;
	}
	if (execution) status = `Shell: ${shellFailureCategory(execution)}; exit=${execution.exitCode ?? "unknown"}${execution.signal ? `; signal=${execution.signal}` : ""}`;
	if (!firstUseful) {
		if (!execution) return undefined;
		return { context: [], exception: firstDiagnostic ? `Output: ${firstDiagnostic}` : "", status, stack: undefined,
			omitted: nonblankCharacters > (firstDiagnostic?.length ?? 0), statusFirst: true };
	}
	const nextStart = firstUsefulEnd + 1;
	if (firstUsefulPrefix.length === 0 && nextStart < output.length) {
		const nextEnd = nextLineEnd(output, nextStart);
		const next = output.slice(nextStart, nextEnd);
		if (next.includes(" at ") || next.trimStart().startsWith("at ") || next.includes(": line ")) nextStack = next;
	}
	const exception = execution ? `Output: ${boundFailureFragment(firstUseful)}` : boundFailureFragment(firstUseful);
	const terminalStatus = status && status !== firstUseful ? boundFailureFragment(status) : undefined;
	const stack = nextStack ? boundFailureFragment(nextStack) : undefined;
	let selectedCharacters = exception.length + (terminalStatus?.length ?? 0) + (stack?.length ?? 0);
	for (const line of firstUsefulPrefix) selectedCharacters += line.length;
	return {
		context: firstUsefulPrefix,
		exception,
		status: terminalStatus,
		stack,
		// Ignore blank separators; count both unselected lines and shortened fragments.
		omitted: nonblankCharacters > selectedCharacters,
		statusFirst: Boolean(execution),
	};
}

export type BashRenderState = ToolRenderLifecycleState & {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
	elapsedTimer?: BashElapsedTimer;
};

/** One owner per active rendering lifecycle. The callback never retains a render context. */
class BashElapsedTimer {
	private state: BashRenderState | undefined;
	private refresh: WeakRef<() => void> | undefined;
	private readonly generation: number | undefined;
	private handle: NodeJS.Timeout | undefined;
	constructor(state: BashRenderState, refresh: () => void) {
		this.state = state;
		this.refresh = new WeakRef(refresh);
		this.generation = state[TOOL_RENDER_LIFECYCLE_GENERATION];
		this.handle = setInterval(this.tick, 1000);
		state.interval = this.handle;
		this.handle.unref?.();
	}
	private readonly tick = (): void => {
		const state = this.state;
		if (!state) return;
		if (state[TOOL_RENDER_LIFECYCLE_GENERATION] !== this.generation || state.endedAt !== undefined) {
			this.stop();
			return;
		}
		const refresh = this.refresh?.deref();
		if (refresh) refresh();
		else this.stop();
	};
	stop(): void {
		if (this.handle !== undefined) clearInterval(this.handle);
		if (this.state && this.state.interval === this.handle) this.state.interval = undefined;
		this.handle = undefined;
		this.refresh = undefined;
		this.state = undefined;
	}
	/** Low-frequency diagnostics, including references owned by a late timer callback. */
	getReferenceCounts() { return { handles: Number(this.handle !== undefined), states: Number(this.state !== undefined), refreshReferences: Number(this.refresh !== undefined) }; }
}

function releaseBashRenderDerivedState(state: unknown): void {
	const bashState = state as BashRenderState;
	bashState.elapsedTimer?.stop();
	bashState.elapsedTimer = undefined;
	const interval = bashState.interval;
	bashState.interval = undefined;
	if (interval !== undefined) clearInterval(interval);
	// Cache release must not erase the final duration of this execution.
}

/** Optional, instance-local counters. No output or component references are stored here. */
export interface BashRenderAllocationMetrics {
	previewComponentsCreated: number;
	timeComponentsCreated: number;
	warningComponentsCreated: number;
	expandedComponentsCreated: number;
	timeTextUpdates: number;
	warningTextUpdates: number;
	preparedOutputRecomputations: number;
	previewLineRecomputations: number;
	failureAnalyses: number;
}

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
	cachedFailureOmitted: boolean;
	preparedContent: Array<{ type: string; text?: string; data?: string; mimeType?: string }> | undefined;
	preparedShowImages: boolean | undefined;
	preparedCapabilitiesImages: ReturnType<typeof getCapabilities>["images"] | undefined;
	preparedIsPartial: boolean | undefined;
	preparedTruncated: boolean | undefined;
	preparedFullOutputPath: string | undefined;
	preparedToolOutputStyle: string | undefined;
	preparedStyledOutput: string | undefined;
	preparedErrorPreview: BashFailurePreview | undefined;
	preparedIsError: boolean | undefined;
	preparedExecutionCategory: string | undefined;
	preparedExitCode: number | null | undefined;
	preparedSignal: string | null | undefined;
	expandedOutputComponent: Text | undefined;
	expandedOutputText: string | undefined;
	allocationMetrics?: BashRenderAllocationMetrics;
};

/** Only bounded final-failure fragments are visited during width-dependent layout. */
function appendBashFailureLine(state: BashResultRenderState, lines: string[], text: string, width: number): void {
	if (lines.length >= BASH_PREVIEW_LINES) {
		state.cachedFailureOmitted = true;
		return;
	}
	if (visibleWidth(text) > width) state.cachedFailureOmitted = true;
	lines.push(truncateToWidth(theme.fg("toolOutput", text), width, "..."));
}

/** Reads the owner's current prepared output, never a captured prior output string. */
class BashPreviewComponent implements Component {
	private state: BashResultRenderState | undefined;
	constructor(state: BashResultRenderState) { this.state = state; }
	render(width: number): string[] {
		const state = this.state;
		if (!state) return [];
		if (state.cachedLines === undefined || state.cachedWidth !== width) {
			state.cachedFailureOmitted = false;
			if (state.preparedErrorPreview) {
				const failure = state.preparedErrorPreview;
				const lines: string[] = [];
				state.cachedFailureOmitted = failure.omitted;
				if (failure.statusFirst && failure.status) appendBashFailureLine(state, lines, failure.status, width);
				for (const contextLine of failure.context) appendBashFailureLine(state, lines, contextLine, width);
				if (failure.exception) appendBashFailureLine(state, lines, failure.exception, width);
				if (!failure.statusFirst && failure.status) appendBashFailureLine(state, lines, failure.status, width);
				if (failure.stack) appendBashFailureLine(state, lines, failure.stack, width);
				state.cachedLines = lines;
				state.cachedSkipped = 0;
			} else {
				const preview = truncateToVisualLines(state.preparedStyledOutput ?? "", BASH_PREVIEW_LINES, width);
				state.cachedLines = preview.visualLines;
				state.cachedSkipped = preview.skippedCount;
			}
			state.cachedWidth = width;
			if (state.allocationMetrics) state.allocationMetrics.previewLineRecomputations++;
		}
		const lines = [""];
		if (state.cachedFailureOmitted) {
			const hint = theme.fg("muted", "... (more failure details,") +
				` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			lines.push(truncateToWidth(hint, width, "..."));
		} else if (state.cachedSkipped && state.cachedSkipped > 0) {
			const hint = theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
				` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			lines.push(truncateToWidth(hint, width, "..."));
		}
		for (const line of state.cachedLines) lines.push(line);
		return lines;
	}
	invalidate(): void { /* Width and prepared output own cache invalidation. */ }
	[RELEASE_COMPONENT_RENDER_CACHE](): void { this.state = undefined; }
}

class BashResultRenderComponent extends Container {
	previewComponent: BashPreviewComponent | undefined;
	timeComponent: Text | undefined;
	timeText: string | undefined;
	warningComponent: Text | undefined;
	warningText: string | undefined;
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
		cachedFailureOmitted: false,
		preparedContent: undefined,
		preparedShowImages: undefined,
		preparedCapabilitiesImages: undefined,
		preparedIsPartial: undefined,
		preparedTruncated: undefined,
		preparedFullOutputPath: undefined,
		preparedToolOutputStyle: undefined,
	preparedStyledOutput: undefined,
	preparedErrorPreview: undefined,
	preparedIsError: undefined,
	preparedExecutionCategory: undefined,
	preparedExitCode: undefined,
	preparedSignal: undefined,
		expandedOutputComponent: undefined,
		expandedOutputText: undefined,
	};

	override invalidate(): void {
		// ToolExecutionComponent immediately calls renderResult after invalidation.
		// Dependency checks below invalidate only the output caches that actually changed.
	}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.children.length = 0;
		this.previewComponent?.[RELEASE_COMPONENT_RENDER_CACHE]();
		this.previewComponent = undefined;
		this.timeComponent?.setText("");
		this.timeComponent = undefined;
		this.timeText = undefined;
		this.warningComponent?.setText("");
		this.warningComponent = undefined;
		this.warningText = undefined;
		const state = this.state;
		state.cachedWidth = undefined;
		state.cachedLines = undefined;
		state.cachedSkipped = undefined;
		state.cachedFailureOmitted = false;
		state.preparedContent = undefined;
		state.preparedShowImages = undefined;
		state.preparedCapabilitiesImages = undefined;
		state.preparedIsPartial = undefined;
		state.preparedTruncated = undefined;
		state.preparedFullOutputPath = undefined;
		state.preparedToolOutputStyle = undefined;
		state.preparedStyledOutput = undefined;
		state.preparedErrorPreview = undefined;
		state.preparedIsError = undefined;
		state.preparedExecutionCategory = undefined;
		state.preparedExitCode = undefined;
		state.preparedSignal = undefined;
		state.expandedOutputComponent = undefined;
		state.expandedOutputText = undefined;
		state.allocationMetrics = undefined;
	}

	/** Test/benchmark instrumentation is opt-in and contains only numeric counters. */
	setAllocationMetrics(metrics: BashRenderAllocationMetrics | undefined): void { this.state.allocationMetrics = metrics; }

	/** Low-frequency final-unmount diagnostics; never called from result rendering. */
	getBashResultRenderCacheReferenceCounts(): {
		cachedLineReferences: number;
		preparedContentReferences: number;
		preparedStyledOutputCodeUnits: number;
		expandedOutputReferences: number;
		derivedChildReferences: number;
		previewComponentReferences: number;
		timeComponentReferences: number;
		timeTextCodeUnits: number;
		warningComponentReferences: number;
		warningTextCodeUnits: number;
		allocationMetricsReferences: number;
		preparedFailurePreviewReferences: number;
	} {
		return {
			cachedLineReferences: this.state.cachedLines?.length ?? 0,
			preparedContentReferences: this.state.preparedContent?.length ?? 0,
			preparedStyledOutputCodeUnits: this.state.preparedStyledOutput?.length ?? 0,
			expandedOutputReferences:
				(this.state.expandedOutputComponent === undefined ? 0 : 1) +
				(this.state.expandedOutputText === undefined ? 0 : 1),
			derivedChildReferences: this.children.length,
			previewComponentReferences: Number(this.previewComponent !== undefined),
			timeComponentReferences: Number(this.timeComponent !== undefined),
			timeTextCodeUnits: this.timeText?.length ?? 0,
			warningComponentReferences: Number(this.warningComponent !== undefined),
			warningTextCodeUnits: this.warningText?.length ?? 0,
			allocationMetricsReferences: Number(this.state.allocationMetrics !== undefined),
			preparedFailurePreviewReferences: Number(this.state.preparedErrorPreview !== undefined),
		};
	}
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatShellCall(args: { command?: string; timeout?: number; cwd?: string } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix + (args?.cwd ? theme.fg("muted", ` [cwd=${args.cwd}]`) : "");
}

function snapshotBashResultContent(
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
	const snapshot = new Array<{ type: string; text?: string; data?: string; mimeType?: string }>(content.length);
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		snapshot[index] = { type: block.type, text: block.text, data: block.data, mimeType: block.mimeType };
	}
	return snapshot;
}

function bashResultContentMatches(
	snapshot: Array<{ type: string; text?: string; data?: string; mimeType?: string }> | undefined,
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): boolean {
	if (!snapshot || snapshot.length !== content.length) return false;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		const previous = snapshot[index];
		if (previous.type !== block.type || previous.text !== block.text || previous.data !== block.data || previous.mimeType !== block.mimeType) return false;
	}
	return true;
}

function getPreparedBashOutput(
	component: BashResultRenderComponent,
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: BashToolDetails },
	options: ToolRenderResultOptions,
	showImages: boolean,
	isError: boolean,
): string {
	const state = component.state;
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const execution = readShellExecution(result.details);
	const executionCategory = execution ? shellFailureCategory(execution) : undefined;
	const capabilitiesImages = getCapabilities().images;
	const toolOutputStyle = theme.fg("toolOutput", "sp-bash-style");
	if (
		bashResultContentMatches(state.preparedContent, result.content) &&
		state.preparedShowImages === showImages &&
		state.preparedCapabilitiesImages === capabilitiesImages &&
		state.preparedIsPartial === options.isPartial &&
		state.preparedTruncated === truncation?.truncated &&
		state.preparedFullOutputPath === fullOutputPath &&
		state.preparedToolOutputStyle === toolOutputStyle
		&& state.preparedIsError === isError
		&& state.preparedExecutionCategory === executionCategory && state.preparedExitCode === execution?.exitCode && state.preparedSignal === execution?.signal
	) return state.preparedStyledOutput ?? "";

	let output = getTextOutput(result as any, showImages).trim();
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) output = output.slice(0, footerStart).trimEnd();
	}
	let styledOutput = "";
	if (output) {
		let start = 0;
		while (start <= output.length) {
			const newline = output.indexOf("\n", start);
			const end = newline === -1 ? output.length : newline;
			if (start > 0) styledOutput += "\n";
			styledOutput += theme.fg("toolOutput", output.slice(start, end));
			if (newline === -1) break;
			start = newline + 1;
		}
	}
	if (state.allocationMetrics) state.allocationMetrics.preparedOutputRecomputations++;
	if (
		state.preparedStyledOutput !== styledOutput ||
		state.preparedIsPartial !== options.isPartial ||
		state.preparedIsError !== isError || state.preparedExecutionCategory !== executionCategory || state.preparedExitCode !== execution?.exitCode || state.preparedSignal !== execution?.signal
	) {
		state.cachedWidth = undefined;
		state.cachedLines = undefined;
		state.cachedSkipped = undefined;
		state.cachedFailureOmitted = false;
	}
	state.preparedContent = snapshotBashResultContent(result.content);
	state.preparedShowImages = showImages;
	state.preparedCapabilitiesImages = capabilitiesImages;
	state.preparedIsPartial = options.isPartial;
	state.preparedTruncated = truncation?.truncated;
	state.preparedFullOutputPath = fullOutputPath;
	state.preparedToolOutputStyle = toolOutputStyle;
	state.preparedStyledOutput = styledOutput;
	if (state.allocationMetrics && isError && !options.isPartial) state.allocationMetrics.failureAnalyses++;
	state.preparedErrorPreview = isError && !options.isPartial ? createBashFailurePreview(output, execution) : undefined;
	state.preparedIsError = isError;
	state.preparedExecutionCategory = executionCategory; state.preparedExitCode = execution?.exitCode; state.preparedSignal = execution?.signal;
	return styledOutput;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
	isError: boolean,
): void {
	const state = component.state;
	// Reuse the bounded child list without invalidating or releasing retained children.
	component.children.length = 0;

	const styledOutput = getPreparedBashOutput(component, result, options, showImages, isError);
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!styledOutput) {
		state.expandedOutputComponent = undefined;
		state.expandedOutputText = undefined;
	}

	if (styledOutput) {
		if (options.expanded) {
			const text = `\n${styledOutput}`;
			let outputComponent = state.expandedOutputComponent;
			if (!outputComponent) {
				outputComponent = new Text(text, 0, 0);
				if (state.allocationMetrics) state.allocationMetrics.expandedComponentsCreated++;
			}
			if (state.expandedOutputText !== text) outputComponent.setText(text);
			state.expandedOutputComponent = outputComponent;
			state.expandedOutputText = text;
			component.addChild(outputComponent);
		} else {
			state.expandedOutputComponent = undefined;
			state.expandedOutputText = undefined;
			if (!component.previewComponent) {
				component.previewComponent = new BashPreviewComponent(state);
				if (state.allocationMetrics) state.allocationMetrics.previewComponentsCreated++;
			}
			component.addChild(component.previewComponent);
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		let warning = "";
		if (fullOutputPath) {
			warning = `${result.details?.spillFileCapped ? "Capped output file (5 MiB; later output unavailable)" : "Full output"}: ${fullOutputPath}`;
		}
		if (truncation?.truncated) {
			if (warning) warning += ". ";
			if (truncation.truncatedBy === "lines") {
				warning += `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
			} else {
				warning += `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`;
			}
		}
		const text = `\n${theme.fg("warning", `[${warning}]`)}`;
		if (!component.warningComponent) {
			component.warningComponent = new Text(text, 0, 0);
			if (state.allocationMetrics) state.allocationMetrics.warningComponentsCreated++;
		} else if (component.warningText !== text) {
			component.warningComponent.setText(text);
			if (state.allocationMetrics) state.allocationMetrics.warningTextUpdates++;
		}
		component.warningText = text;
		component.addChild(component.warningComponent);
	} else {
		component.warningComponent?.setText("");
		component.warningComponent = undefined;
		component.warningText = undefined;
	}

	if (startedAt !== undefined && readShellExecution(result.details)?.started !== false && result.details?.executionStatus !== "not_executed") {
		const label = options.isPartial && endedAt === undefined ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		const text = `\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`;
		if (!component.timeComponent) {
			component.timeComponent = new Text(text, 0, 0);
			if (state.allocationMetrics) state.allocationMetrics.timeComponentsCreated++;
		} else if (component.timeText !== text) {
			component.timeComponent.setText(text);
			if (state.allocationMetrics) state.allocationMetrics.timeTextUpdates++;
		}
		component.timeText = text;
		component.addChild(component.timeComponent);
	}
}

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const backendExecute = ops.exec;
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, an output log is saved to a temp file, capped at 5 MiB. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
        prepareArguments(args) {
            if (args && typeof args === "object" && typeof (args as BashToolInput).command === "string" && boundedShellInput((args as BashToolInput).command)
              && (config.name !== "bash" || !isLocalShellBackend(ops) || commandPrefix || (spawnHook && spawnHook !== withMsysStdinBridge) || ops.exec !== backendExecute)) throw new Error("[SHELL_INPUT_UNSUPPORTED] Bounded heredoc input requires the unchanged built-in Bash backend and transport.");
            if (args && typeof args === "object" && (args as BashToolInput).cwd !== undefined
              && (!isLocalShellBackend(ops) || commandPrefix || (spawnHook && spawnHook !== withMsysStdinBridge) || ops.exec !== backendExecute)) throw new Error("[SHELL_CWD_UNSUPPORTED] Explicit cwd requires an unchanged built-in local backend without commandPrefix or spawnHook.");
            return args as BashToolInput;
        },
		async execute(
			_toolCallId,
			input: BashToolInput,
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			const { command, timeout } = input;
            let cwdBinding = getShellCwdBinding(input);
            let executionEntered = false;
            try {
            if (boundedShellInput(command) && (config.name !== "bash" || !isLocalShellBackend(ops) || commandPrefix || (spawnHook && spawnHook !== withMsysStdinBridge) || ops.exec !== backendExecute)) throw new Error("[SHELL_INPUT_UNSUPPORTED] Bounded heredoc backend or transport changed before execution.");
			if (input.cwd !== undefined && (!isLocalShellBackend(ops) || commandPrefix || (spawnHook && spawnHook !== withMsysStdinBridge) || ops.exec !== backendExecute)) throw new Error("[SHELL_CWD_UNSUPPORTED] Explicit cwd requires the built-in local backend without commandPrefix or spawnHook.");
			if (input.cwd === undefined && cwdBinding && !cwdBinding.isReleased) throw new Error("[SHELL_CWD_CHANGED] Bound cwd was removed before execution.");
            cwdBinding = input.cwd === undefined && !cwdBinding ? undefined : await prepareShellCwd(input, ctx?.cwd ?? cwd);
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			// These variables only change Bash startup and cd; PowerShell keeps them as ordinary data.
			const spawnContext = resolveSpawnContext(resolvedCommand, cwdBinding?.canonical ?? cwd, spawnHook, exposeSessionEnvironment, ctx, config.name === "bash");
			let acceptingOutput = true;
			let outputFailure: Error | undefined;
			const outputAbort = new AbortController();
			const executionSignal = signal ? AbortSignal.any([signal, outputAbort.signal]) : outputAbort.signal;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;
			const recordOutputFailure = (error: unknown) => {
				if (outputFailure) return;
				outputFailure = error instanceof Error ? error : new Error(String(error));
				acceptingOutput = false;
				outputAbort.abort({ [OUTPUT_FAILURE_ABORT]: true, cause: outputFailure });
			};
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix, onSpillError: recordOutputFailure });

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				try {
					const snapshot = output.snapshot({ persistIfTruncated: true });
					onUpdate({
						content: [{ type: "text", text: snapshot.content || "" }],
						details: {
							truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
							fullOutputPath: snapshot.fullOutputPath,
							spillFileCapped: snapshot.spillFileCapped,
						},
					});
				} catch (error) { recordOutputFailure(error); }
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const onUpdateTimer = () => { updateTimer = undefined; emitOutputUpdate(); };
			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(onUpdateTimer, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				try {
					output.append(data);
					scheduleOutputUpdate();
				} catch (error) { recordOutputFailure(error); }
			};

			let logError: string | undefined, cleanupError: string | undefined;
			let cleanup: "not_needed" | "removed" | "failed" = "not_needed";
			const finishOutput = async () => {
				acceptingOutput = false;
				try {
					if (outputFailure) throw outputFailure;
					output.finish();
					clearUpdateTimer();
					emitOutputUpdate();
					if (outputFailure) throw outputFailure;
					const snapshot = output.snapshot({ persistIfTruncated: true });
					await output.closeTempFile();
					return snapshot;
				} catch (error) {
					clearUpdateTimer();
					logError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
					try { output.finish(true); } catch { /* Keep the first capture/log error. */ }
					try { cleanup = await output.discardTempFile(); }
					catch (failure) { cleanup = "failed"; cleanupError = (failure instanceof Error ? failure.message : String(failure)).slice(0, 1000); }
					return output.snapshot({ recoverInMemoryTail: true });
				}
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				const details: BashToolDetails = { cwd: spawnContext.cwd };
				if (truncation.truncated) {
					details.truncation = truncation; details.fullOutputPath = snapshot.fullOutputPath; details.spillFileCapped = snapshot.spillFileCapped;
					const outputLabel = snapshot.fullOutputPath ? `${snapshot.spillFileCapped ? "Capped output file (5 MiB; later output unavailable)" : "Full output"}: ${snapshot.fullOutputPath}` : "Output log unavailable";
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${outputLabel}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${outputLabel}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${outputLabel}]`;
					}
				}
				return { text, details };
			};

			try {
				let processResult: ShellProcessResult | undefined, executionError: unknown;
				try {
					executionEntered = true;
					processResult = await (cwdBinding ? backendExecute : ops.exec).call(ops, spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal: executionSignal,
						timeout,
						env: spawnContext.env,
						beforeSpawn: cwdBinding?.beforeSpawn,
					});
				} catch (err) {
					executionError = err; processResult = shellProcessResultFromError(err);
				}

				const snapshot = await finishOutput();
				const { text, details } = formatOutput(snapshot, executionError ? "" : "(no output)");
				let outputText = text, failure: string | undefined;
				if (processResult) processResult = normalizeShellProcessResult(processResult);
				const observation = processResult?.observation;
				const local = isLocalShellBackend(ops) && ops.exec === backendExecute;
				const started = observation?.started ?? "unknown";
				const errorMessage = (executionError instanceof Error ? executionError.message : executionError === undefined ? "" : String(executionError)).slice(0, 1000);
				// Legacy custom backends report control-flow failure through their
				// rejected operation, never through stdout. Keep start/effects unknown.
				const termination = processResult?.termination ?? (processResult && processResult.exitCode !== null ? "exit"
					: executionError && errorMessage.startsWith("timeout:") ? "timeout"
					: executionError && (signal?.aborted || errorMessage === "aborted") ? "cancelled" : "unknown");
				const facts: ShellExecutionFacts = { version: 1, producer: local ? "local-shell" : "custom-shell",
					started, cwd: local ? observation?.cwd ?? null : null,
					executionStatus: started === false ? observation?.spawnAttempted ? "start_failed" : "not_executed" : termination === "exit" ? "exited" : termination === "unknown" ? "unknown" : "interrupted",
					sideEffects: started === false ? "none" : "unknown", retryGuidance: started === false ? "fresh_request" : "inspect_before_retry",
					exitCode: processResult?.exitCode ?? null, signal: observation?.signal ?? null,
					termination,
					inputError: processResult?.inputError?.slice(0, 1000),
					observationError: processResult?.observationError?.slice(0, 1000),
					secondaryObservationError: processResult?.secondaryObservationError?.slice(0, 1000),
					observationErrorsOmitted: processResult?.observationErrorsOmitted,
					output: { complete: logError ? false : observation?.outputDrained ?? "unknown", tailTruncated: snapshot.truncation.truncated,
						log: logError ? "failed" : snapshot.fullOutputPath ? snapshot.spillFileCapped ? "capped" : "complete" : "not_needed",
						cleanup, logError, cleanupError } };
				details.shellExecution = facts;
				if (!readShellExecution(details)) {
					facts.started = "unknown"; facts.executionStatus = "unknown"; facts.sideEffects = "unknown"; facts.retryGuidance = "inspect_before_retry";
					facts.exitCode = null; facts.signal = null; facts.termination = "unknown"; facts.cwd = null;
					facts.output.complete = logError ? false : "unknown";
					facts.inputError = undefined; facts.secondaryObservationError = undefined; facts.observationErrorsOmitted = undefined;
					facts.observationError = "Backend returned inconsistent process observations; completion and effects are unknown.";
				}
				if (facts.started === false) details.executionStatus = "not_executed";
				if (executionError) {
					if (facts.termination === "timeout") failure = `[SHELL_INTERRUPTED] Command timed out after ${timeout ?? "requested"} seconds`;
					else if (facts.termination === "cancelled") failure = "[SHELL_INTERRUPTED] Command aborted";
					else failure = `[${facts.started === false || !observation && SHELL_START_ERROR_CODES.has((executionError as NodeJS.ErrnoException).code ?? "") ? "SHELL_START_FAILED" : "SHELL_EXECUTION_FAILED"}] ${errorMessage}`;
				} else if (facts.started === false) failure = "[SHELL_START_FAILED] Backend reports that the process did not start";
				else if (facts.termination === "signal") failure = `[SHELL_INTERRUPTED] Command terminated by ${facts.signal ?? "an unobserved signal"}`;
				else if (facts.exitCode === null) failure = "[SHELL_EXECUTION_FAILED] Command termination is unknown (null exit code)";
				else if (facts.exitCode !== 0) { failure = "[SHELL_RUNTIME_FAILED]"; outputText = appendShellStatus(outputText, `Command exited with code ${facts.exitCode}`); }
				else if (observation && !observation.outputDrained) failure = "[SHELL_OUTPUT_INCOMPLETE] Process exited but output streams did not finish before the drain boundary";
				else if (facts.termination !== "exit") failure = `[SHELL_EXECUTION_FAILED] Command completion is ${facts.termination}; inspect state before retrying`;
				if (facts.observationError !== undefined) failure = appendShellStatus(failure ?? "", `[SHELL_OBSERVATION_FAILED] ${facts.observationError}`);
				if (facts.inputError) {
					const inputFailure = `[SHELL_INPUT_FAILED] Command input was not fully delivered: ${facts.inputError}`;
					failure = failure ? `${inputFailure}\n${failure}` : inputFailure;
				}
				if (failure) outputText = `${failure}${outputText ? `\n${outputText}` : ""}`;
				if (logError) {
					const status = `[SHELL_LOG_FAILED] Command output was not fully recorded: ${logError}`;
					outputText = failure ? appendShellStatus(outputText, status) : `${status}\n${outputText}`;
				}
				if (cleanupError) outputText = appendShellStatus(outputText, `[SHELL_LOG_CLEANUP_FAILED] ${cleanupError}`);
				if (failure || logError) throw new ToolResultError(outputText, { content: [{ type: "text", text: outputText }], details });
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
			} catch (error) {
				if (toolResultFromError(error)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const details: BashToolDetails = { executionStatus: executionEntered ? undefined : "not_executed",
					shellExecution: { version: 1, producer: isLocalShellBackend(ops) && ops.exec === backendExecute ? "local-shell" : "custom-shell", started: executionEntered ? "unknown" : false, cwd: null,
						executionStatus: executionEntered ? "unknown" : "not_executed", sideEffects: executionEntered ? "unknown" : "none", retryGuidance: executionEntered ? "inspect_before_retry" : "fresh_request",
						exitCode: null, signal: null, termination: executionEntered ? "unknown" : "not_started",
						output: { complete: executionEntered ? "unknown" : true, tailTruncated: false, log: "not_needed", cleanup: "not_needed" } } };
				throw new ToolResultError(message, { content: [{ type: "text", text: message }], details }, { cause: error });
			} finally { cwdBinding?.release(); }
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			state[RELEASE_TOOL_RENDER_DERIVED_STATE] = releaseBashRenderDerivedState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args, config.prompt));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			state[RELEASE_TOOL_RENDER_DERIVED_STATE] = releaseBashRenderDerivedState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				releaseBashRenderDerivedState(state);
			} else if (state.startedAt !== undefined && state.endedAt === undefined && !state.interval) {
				state.elapsedTimer = new BashElapsedTimer(state, context.refreshResult ?? context.invalidate);
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
				context.isError,
			);
			component.invalidate();
			return component;
		},
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "sp-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
