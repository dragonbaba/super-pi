import { statSync } from "node:fs";
import {
	consumeSubagentWorkspaceDelegation,
	type SessionPermissionMode,
	type SubagentWorkspaceGrant,
} from "../resource-lifecycle-guard/permission-contract.ts";
import { canonicalWorkspace, isPathInside } from "./child-security.ts";

export interface DelegatedTaskPolicy extends SubagentWorkspaceGrant {
	allowMutation: boolean;
}

function validMode(value: unknown): value is SessionPermissionMode {
	return value === "read-only" || value === "workspace-write" || value === "full-access";
}

export function consumeDelegatedTaskPolicies(
	input: unknown,
	requestedCwds: readonly (string | undefined)[],
	primaryCwd: string,
	toolCallId: string,
): DelegatedTaskPolicy[] {
	const delegation = consumeSubagentWorkspaceDelegation(input);
	if (!delegation
		|| delegation.schemaVersion !== 1
		|| !Number.isSafeInteger(delegation.sequence)
		|| delegation.sequence < 0
		|| delegation.toolCallId !== toolCallId) {
		throw new Error("Subagent workspace delegation is missing, invalid, or belongs to another tool call; reload the permission controller and retry.");
	}
	if (delegation.grants.length !== requestedCwds.length) {
		throw new Error("Subagent workspace delegation does not match the requested task count.");
	}
	const canonicalPrimary = canonicalWorkspace(primaryCwd);
	const policies: DelegatedTaskPolicy[] = [];
	for (let index = 0; index < requestedCwds.length; index++) {
		const grant = delegation.grants[index];
		if (!grant || !validMode(grant.permissionMode)) throw new Error("Subagent workspace grant is invalid.");
		const expected = canonicalWorkspace(requestedCwds[index] ?? canonicalPrimary);
		const granted = canonicalWorkspace(grant.canonicalCwd);
		if (expected !== granted) throw new Error("Subagent workspace grant does not match the requested canonical cwd.");
		const identity = statSync(granted);
		if (!identity.isDirectory()
			|| !Number.isFinite(grant.device)
			|| !Number.isFinite(grant.inode)
			|| identity.dev !== grant.device
			|| identity.ino !== grant.inode) {
			throw new Error("Subagent workspace identity changed after authorization.");
		}
		if (grant.writable !== (grant.permissionMode !== "read-only")) {
			throw new Error("Subagent workspace grant has an inconsistent write capability.");
		}
		if (grant.source !== "primary" && grant.source !== "additional" && grant.source !== "full-access-exact") {
			throw new Error("Subagent workspace grant source is invalid.");
		}
		if (grant.source === "primary" && !isPathInside(granted, canonicalPrimary)) {
			throw new Error("Subagent primary-workspace grant escapes the active project.");
		}
		policies.push({ ...grant, canonicalCwd: granted, allowMutation: grant.writable });
	}
	return policies;
}
