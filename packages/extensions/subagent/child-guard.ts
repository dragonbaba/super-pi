import type { ExtensionAPI } from "@super-pi/coding-agent";
import {
	bashRiskReason,
	canonicalWorkspace,
	recursiveTraversalRiskReason,
	resolveWorkspacePath,
	sensitivePathReason,
} from "./child-security.ts";
import { OUTSIDE_CD_COMMAND_PATTERN } from "./regex.ts";

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const RECURSIVE_FILE_TOOLS = new Set(["grep", "find", "ls"]);

export default function childGuard(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n<subagent-security>\nDo not inspect credentials, secret environment values, Pi auth storage, browser profiles, or private key files. Access files only inside the assigned canonical workspace. Bash is not a sandbox and is available only when explicitly permitted.\n</subagent-security>`,
	}));

	pi.on("tool_call", (event, ctx) => {
		let workspace: string;
		try {
			workspace = canonicalWorkspace(process.env.SP_SUBAGENT_WORKSPACE || ctx.cwd);
			const actualCwd = canonicalWorkspace(ctx.cwd);
			if (actualCwd !== workspace) return { block: true, reason: "Subagent guard: working directory changed outside its assignment" };
		} catch {
			return { block: true, reason: "Subagent guard: workspace cannot be safely resolved" };
		}

		if (FILE_TOOLS.has(event.toolName)) {
			const input = event.input as { path?: unknown; file_path?: unknown };
			const supplied = typeof input.path === "string" ? input.path : input.file_path;
			const candidate = typeof supplied === "string" ? supplied : (RECURSIVE_FILE_TOOLS.has(event.toolName) ? "." : undefined);
			if (candidate === undefined) return { block: true, reason: "Subagent guard: missing file path" };
			const reason = sensitivePathReason(candidate, workspace);
			if (reason) return { block: true, reason: `Subagent guard: ${reason}` };
			try { resolveWorkspacePath(candidate, workspace, false); }
			catch { return { block: true, reason: "Subagent guard: path escapes the assigned workspace (including via symlink)" }; }
			if (RECURSIVE_FILE_TOOLS.has(event.toolName)) {
				const traversalReason = recursiveTraversalRiskReason(candidate, workspace);
				if (traversalReason) return { block: true, reason: `Subagent guard: ${traversalReason}` };
			}
		}

		if (event.toolName === "bash") {
			if (process.env.SP_SUBAGENT_ALLOW_BASH !== "1") return { block: true, reason: "Subagent guard: Bash is disabled for this agent" };
			const input = event.input as { command?: unknown };
			if (typeof input.command !== "string") return { block: true, reason: "Subagent guard: missing Bash command" };
			const reason = bashRiskReason(input.command);
			if (reason) return { block: true, reason: `Subagent guard: ${reason}` };
			if (OUTSIDE_CD_COMMAND_PATTERN.test(input.command)) {
				return { block: true, reason: "Subagent guard: Bash may not change outside the assigned workspace" };
			}
		}
	});
}
