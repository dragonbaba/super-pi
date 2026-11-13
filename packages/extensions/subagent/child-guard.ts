import type { ExtensionAPI } from "@super-pi/coding-agent";
import {
	bashRiskReason,
	canonicalWorkspace,
	recursiveTraversalRiskReason,
	resolveWorkspacePath,
	sensitivePathReason,
} from "./child-security.ts";
import { OUTSIDE_CD_COMMAND_PATTERN } from "./regex.ts";
import { installChildControl } from "./child-control.ts";
import { isFileMutationOperation, fileMutationItem, fileMutationItemCount, validateFileMutationTargets } from "../../coding-agent/src/core/files/file-mutation-input.ts";

const FILE_TOOLS = new Set(["read", "write", "edit", "copy", "delete", "move", "grep", "find", "ls"]);
const RECURSIVE_FILE_TOOLS = new Set(["grep", "find", "ls"]);
type FileInput = { path?: unknown; file_path?: unknown; destination?: unknown };

export default function childGuard(pi: ExtensionAPI): void {
	const parentExecution = process.env.SP_SUBAGENT_PARENT_EXECUTION === "1";
	installChildControl(pi);
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n<subagent-security>\nDo not inspect credentials, secret environment values, Pi auth storage, browser profiles, or private key files. Stay within the assigned task scope. ${parentExecution ? "Workspace operations execute in the parent under its original workspace and permissions; the assigned cwd grants no additional permission. Use only the shell tools exposed by the parent execution profile." : "Access files only inside the assigned canonical workspace. Bash is available only when explicitly permitted; PowerShell is disabled."}\n</subagent-security>`,
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

		if (FILE_TOOLS.has(event.toolName) || event.toolName === "file_batch") {
			const input = event.input as FileInput & { operations?: FileInput[] };
			const mutation = isFileMutationOperation(event.toolName);
			try { if (mutation) validateFileMutationTargets(event.toolName, input); }
			catch { return { block: true, reason: "Subagent guard: invalid file target list" }; }
			const count = mutation ? fileMutationItemCount(event.toolName, input) : 1;
			for (let index = 0; index < count; index++) {
				const operation = mutation ? fileMutationItem(event.toolName, input, index) : input;
				const supplied = typeof operation.path === "string" ? operation.path : operation.file_path;
				const candidate = typeof supplied === "string" ? supplied : (RECURSIVE_FILE_TOOLS.has(event.toolName) ? "." : undefined);
				if (candidate === undefined) return { block: true, reason: "Subagent guard: missing file path" };
				const reason = sensitivePathReason(candidate, workspace)
					?? (typeof operation.destination === "string" ? sensitivePathReason(operation.destination, workspace) : undefined);
				if (reason) return { block: true, reason: `Subagent guard: ${reason}` };
				if (!parentExecution) {
					try { resolveWorkspacePath(candidate, workspace, false); if (typeof operation.destination === "string") resolveWorkspacePath(operation.destination, workspace, false); }
					catch { return { block: true, reason: "Subagent guard: path escapes the assigned workspace (including via symlink)" }; }
				}
				if (RECURSIVE_FILE_TOOLS.has(event.toolName)) {
					const traversalReason = recursiveTraversalRiskReason(candidate, workspace);
					if (traversalReason) return { block: true, reason: `Subagent guard: ${traversalReason}` };
				}
			}
		}

		if (event.toolName === "bash") {
			if (process.env.SP_SUBAGENT_ALLOW_BASH !== "1") return { block: true, reason: "Subagent guard: Bash is disabled for this agent" };
			const input = event.input as { command?: unknown };
			if (typeof input.command !== "string") return { block: true, reason: "Subagent guard: missing Bash command" };
			const reason = bashRiskReason(input.command);
			if (reason && !(parentExecution && reason === "command may write outside the assigned workspace")) return { block: true, reason: `Subagent guard: ${reason}` };
			if (!parentExecution && OUTSIDE_CD_COMMAND_PATTERN.test(input.command)) {
				return { block: true, reason: "Subagent guard: Bash may not change outside the assigned workspace" };
			}
		}
		if (event.toolName === "powershell" && !parentExecution) {
			return { block: true, reason: "Subagent guard: PowerShell is disabled for this agent" };
		}
	});
}
