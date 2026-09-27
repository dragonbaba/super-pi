import { registerLocalShellBackend } from "./shell-cwd.ts";
import { appendShellObservationError, normalizeShellProcessResult, observedShellError, shellProcessResultFromError, type ShellProcessResult } from "./shell-execution.ts";
import {
	getPowerShellCandidateConfig,
	getPowerShellConfig,
	type PowerShellConfig,
} from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	type createBashTool,
	createLocalShellOperations,
	createShellToolDefinition,
	type ShellToolConfig,
} from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export const powershellToolSystemPromptContribution = {
	snippet: "Execute PowerShell commands",
	guidelines: ["You can inspect SP_* environment variables for current model and session details."],
} as const;

export type PowerShellOperations = BashOperations;
export type PowerShellSpawnContext = BashSpawnContext;
export type PowerShellSpawnHook = BashSpawnHook;
export type PowerShellToolDetails = BashToolDetails;
export type PowerShellToolInput = BashToolInput;

export interface PowerShellToolState {
	configure(powershellPath?: string): void;
	enable(): void;
	disable(reason: string): void;
	readonly disabledReason: string | undefined;
	config: PowerShellConfig | undefined;
	confirmed: boolean;
	confirmation: Promise<void> | undefined;
	recovery: Promise<PowerShellConfig> | undefined;
}

export function createPowerShellToolState(): PowerShellToolState {
	let configuredPath: string | undefined;
	let disabledReason: string | undefined;
	return {
		configure(powershellPath) {
			if (powershellPath === configuredPath) return;
			configuredPath = powershellPath;
			this.enable();
		},
			enable() {
				disabledReason = undefined;
				this.config = undefined;
				this.confirmed = false;
				this.confirmation = undefined;
				this.recovery = undefined;
		},
		disable(reason) {
			disabledReason = reason;
				this.config = undefined;
				this.confirmed = false;
				this.confirmation = undefined;
				this.recovery = undefined;
		},
		get disabledReason() {
			return disabledReason;
		},
		config: undefined,
		confirmed: false,
		confirmation: undefined,
		recovery: undefined,
	};
}

export interface PowerShellToolOptions
	extends Pick<BashToolOptions, "operations" | "exposeSessionEnvironment" | "spawnHook"> {
	/** Trusted global PowerShell executable path. */
	powershellPath?: string;
	/** Runtime copy of the persisted resolution and availability state. */
	state?: PowerShellToolState;
	/** Called once when an unverified executable is confirmed usable. */
	onConfirmed?: (config: PowerShellConfig) => void | Promise<void>;
	/** Called after probing confirms that no usable PowerShell remains. */
	onUnavailable?: (error: Error, config?: PowerShellConfig) => void | Promise<void>;
}

export interface LocalPowerShellOperationsOptions {
	powershellPath?: string;
	state?: PowerShellToolState;
	onConfirmed?: (config: PowerShellConfig) => void | Promise<void>;
	onUnavailable?: (error: Error, config?: PowerShellConfig) => void | Promise<void>;
	/** Dependency seams for embedders and deterministic tests. */
	resolveCandidate?: (powershellPath?: string) => PowerShellConfig;
	probe?: (powershellPath?: string) => PowerShellConfig;
	execute?: (
		config: PowerShellConfig,
		command: string,
		cwd: string,
		options: Parameters<PowerShellOperations["exec"]>[2],
	) => Promise<ShellProcessResult>;
}

function isControlFlowError(error: unknown): boolean {
	return error instanceof Error && (error.message === "aborted" || error.message.startsWith("timeout:"));
}

function notStarted(error: unknown, previous?: ShellProcessResult, observationError?: string): Error {
	const result = previous ?? { exitCode: null, termination: "not_started" as const, observation: { started: false, exitCode: null, signal: null, outputDrained: true } };
	return observedShellError(error, observationError === undefined ? result : appendShellObservationError(result, observationError));
}

function isExecutableFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const attached = shellProcessResultFromError(error);
	// An errno cannot override completion facts or uncertainty about side effects.
	if (attached && normalizeShellProcessResult(attached).termination !== "not_started") return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOEXEC" || code === "EINVAL";
}

async function runPowerShellProbe(
	probe: (powershellPath?: string) => PowerShellConfig,
	powershellPath?: string,
): Promise<PowerShellConfig> {
	return probe(powershellPath);
}

export function createLocalPowerShellOperations(options: LocalPowerShellOperationsOptions = {}): PowerShellOperations {
	const state = options.state ?? createPowerShellToolState();
	state.configure(options.powershellPath);
	const resolveCandidate = options.resolveCandidate ?? getPowerShellCandidateConfig;
	const probe = options.probe ?? getPowerShellConfig;
	const localOperationsByConfig = new WeakMap<PowerShellConfig, PowerShellOperations>();
	const execute =
		options.execute ??
		((config: PowerShellConfig, command: string, cwd: string, executionOptions: Parameters<PowerShellOperations["exec"]>[2]) => {
			let operations = localOperationsByConfig.get(config);
			if (!operations) {
				operations = createLocalShellOperations("PowerShell", () => config);
				localOperationsByConfig.set(config, operations);
			}
			return operations.exec(`${UTF8_OUTPUT_PREFIX}${command}`, cwd, executionOptions);
		});
	const disable = async (cause: unknown, previous?: ShellProcessResult): Promise<never> => {
		const processResult = shellProcessResultFromError(cause) ?? previous ?? {
			exitCode: null, termination: "not_started" as const, observation: { started: false, exitCode: null, signal: null, outputDrained: true },
		};
		const failedConfig = state.config;
		const detail = (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000);
		const error = new Error(
			`PowerShell is unavailable: ${detail}. The powershell tool has been disabled. ` +
				"Explicitly enable the powershell tool to try again.",
		);
		state.disable(error.message);
		try {
			await options.onUnavailable?.(error, failedConfig);
		} catch (persistenceError) {
			const persistenceDetail = (persistenceError instanceof Error ? persistenceError.message : String(persistenceError)).slice(0, 1000);
			throw observedShellError(new Error(`${error.message} Failed to persist the disabled state: ${persistenceDetail}`, {
				cause: persistenceError,
			}), appendShellObservationError(processResult, persistenceDetail));
		}
		throw observedShellError(error, processResult);
	};
	const confirm = async (config: PowerShellConfig): Promise<void> => {
		if (state.confirmed) return;
		if (state.confirmation) return state.confirmation;
		let confirmation!: Promise<void>;
		confirmation = (async () => {
			await options.onConfirmed?.(config);
			if (state.confirmation === confirmation && state.config === config && !state.disabledReason) {
				state.confirmed = true;
			}
		})();
		state.confirmation = confirmation;
		try {
			await confirmation;
		} finally {
			if (state.confirmation === confirmation) state.confirmation = undefined;
		}
	};
	const recover = async (
		command: string,
		cwd: string,
		executionOptions: Parameters<PowerShellOperations["exec"]>[2],
		initialError: unknown,
	): Promise<ShellProcessResult> => {
		let verified: PowerShellConfig;
		try {
			const recovery = state.recovery ?? runPowerShellProbe(probe, options.powershellPath);
			state.recovery = recovery;
			verified = await recovery;
			if (state.recovery === recovery) state.recovery = undefined;
		} catch (error) {
			state.recovery = undefined;
			if (state.disabledReason) throw notStarted(new Error(state.disabledReason), shellProcessResultFromError(initialError));
			return disable(error, shellProcessResultFromError(initialError));
		}
		state.config = verified;
		try { await confirm(verified); } catch (error) {
			throw notStarted(error, shellProcessResultFromError(initialError), error instanceof Error ? error.message : String(error));
		}
		try {
			const result = normalizeShellProcessResult(await execute(verified, command, cwd, executionOptions));
			if (result.termination === "not_started") return disable(notStarted(new Error("Verified PowerShell did not start"), result));
			return result;
		} catch (error) {
			if (isControlFlowError(error)) throw error;
			if (!isExecutableFailure(error)) throw error;
			return disable(error);
		}
	};
	const backend: PowerShellOperations = {
		exec: async (command, cwd, executionOptions) => {
			if (state.disabledReason) throw notStarted(new Error(state.disabledReason));
			let config: PowerShellConfig;
			try {
				config = state.config ?? resolveCandidate(options.powershellPath);
				state.config = config;
			} catch (error) {
				return disable(error);
			}
			let result: ShellProcessResult;
			try {
				result = normalizeShellProcessResult(await execute(config, command, cwd, executionOptions));
			} catch (error) {
				if (isControlFlowError(error)) throw error;
				if (!isExecutableFailure(error)) throw error;
				return recover(command, cwd, executionOptions, error);
			}
			if (result.termination === "not_started") {
				return recover(command, cwd, executionOptions, notStarted(new Error("PowerShell did not start"), result));
			}
			if (result.exitCode === null && result.observation?.started !== true) return result;
			// Reaching an exit code proves that PowerShell started. A non-zero
			// command result is not an executable failure and must never cause
			// discovery or replay of a potentially stateful command. Keep status
			// persistence outside the executable-failure catch for the same reason.
			try {
				await confirm(config);
			} catch (error) {
				const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
				throw observedShellError(new Error(
					`PowerShell command completed with exit code ${result.exitCode}, but Super Pi could not persist ` +
						`the executable status: ${detail}. The command was not retried.`,
					{ cause: error },
				), appendShellObservationError(result, detail));
			}
			return result;
		},
	};
	return options.execute ? backend : registerLocalShellBackend(backend);
}

const powershellToolConfig: ShellToolConfig = {
	name: "powershell",
	label: "powershell",
	shellName: "PowerShell",
	prompt: "PS>",
	promptSnippet: powershellToolSystemPromptContribution.snippet,
	promptGuidelines: powershellToolSystemPromptContribution.guidelines,
	tempFilePrefix: "sp-powershell",
};

export function createPowerShellToolDefinition(
	cwd: string,
	options?: PowerShellToolOptions,
): ReturnType<typeof createShellToolDefinition> {
	return createShellToolDefinition(cwd, powershellToolConfig, {
		...options,
		operations:
			options?.operations ??
			createLocalPowerShellOperations({
				powershellPath: options?.powershellPath,
				state: options?.state,
				onConfirmed: options?.onConfirmed,
				onUnavailable: options?.onUnavailable,
			}),
	});
}

export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): ReturnType<typeof createBashTool> {
	const definition = createPowerShellToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
