import type { AgentToolResult } from "@super-pi/agent-core";
import type { BashToolDetails } from "./bash.ts";

const BACKGROUND_LAUNCH = Symbol.for("super-pi.shell-background-launch");
export const DEFAULT_BACKGROUND_SHELL_TIMEOUT = 1800;
export const MAX_BACKGROUND_SHELL_TIMEOUT = 7200;
export type BackgroundShellExecution = (signal: AbortSignal) => Promise<AgentToolResult<BashToolDetails | undefined>>;
export type BackgroundShellLaunch = (execute: BackgroundShellExecution, signal: AbortSignal | undefined, release: () => void) => AgentToolResult<BashToolDetails>;

/** A private, one-use handoff installed only by the final shell authorization. */
export function attachBackgroundShellLaunch(input: object, launch: BackgroundShellLaunch): void {
	Object.defineProperty(input, BACKGROUND_LAUNCH, { value: launch, configurable: true });
}

export function consumeBackgroundShellLaunch(input: object): BackgroundShellLaunch {
	const descriptor = Object.getOwnPropertyDescriptor(input, BACKGROUND_LAUNCH);
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
		throw new Error("[SHELL_BACKGROUND_UNAVAILABLE] Background execution requires the session task manager and fresh shell authorization; no command was started.");
	}
	Object.defineProperty(input, BACKGROUND_LAUNCH, { value: undefined, configurable: true });
	return descriptor.value;
}

export function validateBackgroundShellInput(input: { background?: unknown; cwd?: unknown; timeout?: unknown }): void {
	if (input.background === undefined || input.background === false) return;
	if (input.background !== true) throw new Error("background must be a boolean.");
	if (typeof input.cwd !== "string" || input.cwd.length === 0) throw new Error("Background commands require explicit cwd; use cwd: '.' for the current workspace.");
	if (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > MAX_BACKGROUND_SHELL_TIMEOUT)) {
		throw new Error(`Background command timeout must be greater than 0 and at most ${MAX_BACKGROUND_SHELL_TIMEOUT} seconds; default ${DEFAULT_BACKGROUND_SHELL_TIMEOUT}.`);
	}
}
