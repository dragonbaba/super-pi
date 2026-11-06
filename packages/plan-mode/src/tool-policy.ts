import {
	findNonReadOnlyShellSegment,
	type SafeGhSubcommandPath,
	type SafeGitSubcommand,
	type ToolInfo,
} from "@super-pi/coding-agent";

export {
	BUILTIN_SAFE_GIT_SUBCOMMANDS,
	type BuiltinSafeGitSubcommand,
	CONFIGURABLE_SAFE_GIT_SUBCOMMANDS,
	type ConfigurableSafeGitSubcommand,
	SAFE_GH_SUBCOMMAND_PATHS,
	SAFE_GIT_SUBCOMMANDS,
	type SafeGhSubcommandPath,
	type SafeGitSubcommand,
} from "@super-pi/coding-agent";

export interface SafeSubcommands {
	git?: SafeGitSubcommand[];
	gh?: SafeGhSubcommandPath[];
}

export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["codemode", "read", "bash", "powershell", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "limited" | "user-opt-in" | "blocked";

const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);

export function isBuiltinTool(tool: ToolInfo) {
	return tool.sourceInfo.source === "builtin";
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
  if (tool.name === "delete" || tool.name === "move" || tool.name === "file_batch") return "blocked";
	if (!isBuiltinTool(tool)) return "user-opt-in";
	if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
	if (tool.name === "bash" || tool.name === "powershell" || tool.name === "codemode") return "limited";
	return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
	return classifyPlanModeTool(tool) !== "blocked";
}

export function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

/** The first Bash segment Plan mode does not run; the shared read-only judgment decides. */
export function findBlockedCommandSegment(
	command: string,
	safeSubcommands: SafeSubcommands = {},
): string | undefined {
	return findNonReadOnlyShellSegment("bash", command, safeSubcommands);
}

export function isSafeCommand(command: string, safeSubcommands: SafeSubcommands = {}) {
	return findBlockedCommandSegment(command, safeSubcommands) === undefined;
}
