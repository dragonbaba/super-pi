import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@super-pi/agent-core";
import { type Component, Container, getCapabilities, RELEASE_COMPONENT_RENDER_CACHE, Text, truncateToWidth } from "@super-pi/tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
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
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const SESSION_ENVIRONMENT_KEYS = new Set([
	"SP_SESSION_ID",
	"SP_SESSION_FILE",
	"SP_PROVIDER",
	"SP_MODEL",
	"SP_REASONING_LEVEL",
]);

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
	truncation?: TruncationResult;
	fullOutputPath?: string;
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
		},
	) => Promise<{ exitCode: number | null }>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
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
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
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
): BashSpawnContext {
	const shellEnv = getShellEnv();
	const env: NodeJS.ProcessEnv = {};
	const shellEnvKeys = Object.keys(shellEnv);
	for (let index = 0; index < shellEnvKeys.length; index++) {
		const key = shellEnvKeys[index]!;
		if (!SESSION_ENVIRONMENT_KEYS.has(key)) setOwnProperty(env, key, shellEnv[key]);
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
	return context;
}

/** Select the first useful failure and terminal status once per final result. */
function createBashFailurePreview(output: string): string | undefined {
	let firstUseful: string | undefined;
	let firstUsefulPrefix: string[] = [];
	let firstUsefulEnd = -1;
	let genericFailure: string | undefined;
	let genericFailureEnd = -1;
	let status: string | undefined;
	let recovery: string | undefined;
	const recentLines: string[] = [];
	for (let start = 0; start < output.length;) {
		const end = nextLineEnd(output, start);
		const line = output.slice(start, end);
		if (!firstUseful) {
			if (lineHasSpecificFailureMarker(line)) {
				firstUseful = line;
				firstUsefulEnd = end;
				if (line.includes("SyntaxError")) firstUsefulPrefix = nodeParseContext(recentLines);
			} else if (!genericFailure && lineHasGenericFailureMarker(line)) {
				genericFailure = line;
				genericFailureEnd = end;
			}
		}
		if (line.includes("Command exited with code") || line.includes("Command timed out") || line.includes("Command aborted")) status = line;
		if (line.includes("[Node script recovery]")) recovery = line;
		recentLines.push(line);
		if (recentLines.length > 4) recentLines.shift();
		if (end === output.length) break;
		start = end + 1;
	}
	if (!firstUseful && genericFailure) {
		firstUseful = genericFailure;
		firstUsefulEnd = genericFailureEnd;
	}
	if (!firstUseful) return undefined;
	let preview = firstUsefulPrefix.length > 0 ? firstUsefulPrefix.join("\n") + "\n" + firstUseful : firstUseful;
	if (firstUsefulPrefix.length > 0) recovery = undefined;
	const nextStart = firstUsefulEnd + 1;
	if (firstUsefulPrefix.length === 0 && nextStart < output.length) {
		const nextEnd = nextLineEnd(output, nextStart);
		const next = output.slice(nextStart, nextEnd);
		if (next.includes(" at ") || next.trimStart().startsWith("at ") || next.includes(": line ")) preview += `\n${next}`;
	}
	if (status && status !== firstUseful && !preview.includes(status)) preview += `\n${status}`;
	if (recovery && recovery !== firstUseful && !preview.includes(recovery)) preview += `\n${recovery}`;
	return preview;
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
}

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
	preparedContent: Array<{ type: string; text?: string; data?: string; mimeType?: string }> | undefined;
	preparedShowImages: boolean | undefined;
	preparedCapabilitiesImages: ReturnType<typeof getCapabilities>["images"] | undefined;
	preparedIsPartial: boolean | undefined;
	preparedTruncated: boolean | undefined;
	preparedFullOutputPath: string | undefined;
	preparedToolOutputStyle: string | undefined;
	preparedStyledOutput: string | undefined;
	preparedErrorPreview: string | undefined;
	preparedIsError: boolean | undefined;
	expandedOutputComponent: Text | undefined;
	expandedOutputText: string | undefined;
	allocationMetrics?: BashRenderAllocationMetrics;
};

/** Reads the owner's current prepared output, never a captured prior output string. */
class BashPreviewComponent implements Component {
	private state: BashResultRenderState | undefined;
	constructor(state: BashResultRenderState) { this.state = state; }
	render(width: number): string[] {
		const state = this.state;
		if (!state) return [];
		if (state.cachedLines === undefined || state.cachedWidth !== width) {
			const preview = truncateToVisualLines(state.preparedErrorPreview ?? state.preparedStyledOutput ?? "", BASH_PREVIEW_LINES, width);
			state.cachedLines = preview.visualLines;
			state.cachedSkipped = preview.skippedCount;
			state.cachedWidth = width;
			if (state.allocationMetrics) state.allocationMetrics.previewLineRecomputations++;
		}
		const lines = [""];
		if (state.cachedSkipped && state.cachedSkipped > 0) {
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
		};
	}
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
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
	if (state.preparedStyledOutput !== styledOutput) {
		state.cachedWidth = undefined;
		state.cachedLines = undefined;
		state.cachedSkipped = undefined;
	}
	state.preparedContent = snapshotBashResultContent(result.content);
	state.preparedShowImages = showImages;
	state.preparedCapabilitiesImages = capabilitiesImages;
	state.preparedIsPartial = options.isPartial;
	state.preparedTruncated = truncation?.truncated;
	state.preparedFullOutputPath = fullOutputPath;
	state.preparedToolOutputStyle = toolOutputStyle;
	state.preparedStyledOutput = styledOutput;
	state.preparedErrorPreview = isError && !options.isPartial ? createBashFailurePreview(styledOutput) : undefined;
	state.preparedIsError = isError;
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
			warning = `Full output: ${fullOutputPath}`;
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

	if (startedAt !== undefined) {
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
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook, exposeSessionEnvironment, ctx);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
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
