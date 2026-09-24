import { findUnsafePowerShellSegment } from "@super-pi/coding-agent";
import { type BashPermissionScope, inspectBashPermissionScope } from "./permission-bash.ts";

export function inspectPowerShellPermissionScope(input: unknown, cwd: string): BashPermissionScope | undefined {
	const fallback = inspectBashPermissionScope(input, cwd);
	if (!input || typeof input !== "object") return fallback;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string") return fallback;
	if (findUnsafePowerShellSegment(command) !== undefined) {
		if (!fallback?.primitives.includes("stateful_shell_expansion")) return fallback;
		// PowerShell $((...)) is a subexpression, not Bash recursive arithmetic.
		return {
			...fallback,
			primitives: fallback.primitives.filter(primitive => primitive !== "stateful_shell_expansion"),
			classes: fallback.classes.filter(value => value !== "opaque:stateful_shell_expansion"),
		};
	}
	return {
		kind: "read-only",
		targets: [],
		primitives: [],
		classes: ["read:powershell"],
		dynamicScope: false,
		unverifiableScope: false,
	};
}
