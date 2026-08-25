import { findUnsafePowerShellSegment } from "@super-pi/coding-agent";
import { type BashPermissionScope, inspectBashPermissionScope } from "./permission-bash.ts";

export function inspectPowerShellPermissionScope(input: unknown, cwd: string): BashPermissionScope | undefined {
	const fallback = inspectBashPermissionScope(input, cwd);
	if (!input || typeof input !== "object") return fallback;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string" || findUnsafePowerShellSegment(command) !== undefined) return fallback;
	return {
		kind: "read-only",
		targets: [],
		primitives: [],
		classes: ["read:powershell"],
		dynamicScope: false,
		unverifiableScope: false,
	};
}
