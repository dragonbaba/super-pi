import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { HARD_MAX_TASKS } from "../tasks/limits.ts";
import { canonicalSessionDirectory } from "../session-execution-profile.ts";
import { classifyStructuredReadonlyArguments } from "./structured-argv.ts";
import type { StructuredReadonlyWorkspaceDelegation, StructuredReadonlyPathGrant, SubagentWorkspaceGrant } from "./extension-permissions.ts";

type StructuredScope = Omit<StructuredReadonlyWorkspaceDelegation,
    "schemaVersion" | "sequence" | "toolCallId" | "requestHash" | "assertCurrent" | "revocationSignal">;
export interface NativeDelegationScope {
    paths: string[];
    subagent?: SubagentWorkspaceGrant[];
    structured?: StructuredScope;
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
    if (tool !== "subagent" && tool !== "structured_readonly_command") return undefined;
    const primary = await directory(cwd, undefined);
    if (tool === "subagent") {
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
        return { paths, subagent: grants };
    }
    need((input.command === "rg" || input.command === "git") && Array.isArray(input.args), "Expected structured rg/git arguments");
    for (const argument of input.args) need(typeof argument === "string", "Expected string command arguments");
    const target = await directory(primary.canonical, input.cwd);
    const root = inside(primary.canonical, target.canonical) ? primary : target;
    const source = root === primary ? "primary" : "full-access-exact";
    const additionalRoots: StructuredReadonlyPathGrant[] = [], paths = [root.canonical];
    for (const argument of classifyStructuredReadonlyArguments(input.command, input.args).pathArguments) {
        const value = argument.startsWith("@") ? argument.slice(1) : argument;
        if (!isAbsolute(value)) continue;
        const canonical = await realpath(value), stat = await lstat(canonical);
        if (inside(root.canonical, canonical)) continue;
        const extra = await directory(cwd, stat.isDirectory() ? canonical : dirname(canonical));
        if (paths.includes(extra.canonical)) continue;
        need(additionalRoots.length < 16, "Too many external command roots");
        paths.push(extra.canonical);
        additionalRoots.push({ canonicalRoot: extra.canonical, rootDevice: extra.identity.dev, rootInode: extra.identity.ino,
            source: inside(primary.canonical, extra.canonical) ? "primary" : "full-access-exact" });
    }
    return { paths, structured: { canonicalRoot: root.canonical, rootDevice: root.identity.dev, rootInode: root.identity.ino,
        canonicalCwd: target.canonical, cwdDevice: target.identity.dev, cwdInode: target.identity.ino,
        invocationCwd: primary.canonical, source, additionalRoots } };
}
