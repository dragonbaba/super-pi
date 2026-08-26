import type { ExtensionRunnerOptions } from "./extensions/runner.ts";

/**
 * Extension host policy for the standard CLI runtime.
 *
 * Safety hooks are fail-closed, so a stalled extension cannot block project
 * trust or another safety decision indefinitely. AgentSession retains this
 * object and reuses it whenever reload constructs a new ExtensionRunner.
 */
export const CLI_EXTENSION_HOST_POLICY = Object.freeze({
	hookTimeouts: Object.freeze({
		safety: Object.freeze({ timeoutMs: 30_000 }),
	}),
}) satisfies ExtensionRunnerOptions;
