import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { HARD_MAX_TASKS } from "../tasks/limits.ts";
import { canonicalSessionDirectory } from "../session-execution-profile.ts";
import type { SubagentWorkspaceGrant } from "./extension-permissions.ts";

export interface NativeDelegationScope {
    workspace: string;
    paths: string[];
    subagent?: SubagentWorkspaceGrant[];
}
function need(value: unknown, reason: string): asserts value {
    if (!value) throw new Error("[POLICY_BLOCKED] " + reason);
}
function inside(root: string, target: string): boolean {
    const part = relative(root, target);
    return part === "" || part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part);
}
async function directory(cwd: string, raw: unknown) {
    need(raw === undefined || typeof raw === "string" && raw.length > 0 && raw.length <= 4096 && !raw.includes("\0"), "Invalid delegated cwd");
    const canonical = canonicalSessionDirectory(resolve(cwd, raw ?? ".")), identity = await lstat(canonical);
    need(identity.isDirectory() && !identity.isSymbolicLink(), "Delegation requires an ordinary directory");
    return { canonical, identity };
}

/** Cold authorization only. No process starts until the caller has checked all scope rules. */
export async function prepareNativeDelegation(tool: string, input: Record<string, any>, cwd: string, readOnly: boolean): Promise<NativeDelegationScope | undefined> {
    if (tool !== "subagent") return undefined;
    const primary = await directory(cwd, undefined);
    const single = typeof input.agent === "string" && typeof input.task === "string";
    const parallel = Array.isArray(input.tasks) && input.tasks.length > 0;
    const chain = Array.isArray(input.chain) && input.chain.length > 0;
    need(Number(single) + Number(parallel) + Number(chain) === 1, "Select exactly one subagent task mode");
    const tasks = parallel ? input.tasks : chain ? input.chain : [input];
    need(tasks.length <= HARD_MAX_TASKS, "Too many delegated tasks");
    const grants: SubagentWorkspaceGrant[] = [], paths: string[] = [];
    for (const task of tasks) {
        need(task && typeof task === "object" && (task.readOnly === undefined || typeof task.readOnly === "boolean"), "Invalid delegated task");
        const target = await directory(primary.canonical, task.cwd), writable = !readOnly && task.readOnly !== true;
        grants.push({ canonicalCwd: target.canonical, device: target.identity.dev, inode: target.identity.ino,
            permissionMode: writable ? "full-access" : "read-only", writable,
            source: inside(primary.canonical, target.canonical) ? "primary" : "full-access-exact" });
        paths.push(target.canonical);
    }
    return { workspace: primary.canonical, paths, subagent: grants };
}
