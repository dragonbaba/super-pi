import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path";
import { getAgentDir } from "../../config.ts";
import { assessCanonicalMutationPath, canonicalizeProspectivePath, canonicalWorkspaceMetadata } from "./protected-path-policy.ts";
import type { ShellMutationScan } from "../shell-policy/mutation-effects.ts";

const POSIX_SYSTEM_ROOTS = ["/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/run"] as const;
const MAC_SYSTEM_ROOTS = ["/System", "/Library", "/Applications"] as const;
export interface HostMutationAssessment {
    ask: boolean;
    forbidden?: string;
    externalOverwrite?: string;
    newExternalFiles?: string[];
    details: string;
}
function inside(root: string, target: string): boolean {
    const part = relative(root, target);
    return part === "" || part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part);
}
function inWorkspace(workspaces: readonly string[], target: string): boolean {
    for (const root of workspaces) if (inside(root, target)) return true;
    return false;
}
async function exists(target: string): Promise<boolean> {
    try { await lstat(target); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function systemRoots(home: string): Promise<string[]> {
    const roots: string[] = [];
    if (process.platform === "win32") {
        const drive = process.env.SystemDrive ? process.env.SystemDrive + "\\" : parse(home).root;
        roots.push(await canonicalizeProspectivePath(process.env.SystemRoot ?? join(drive, "Windows")));
        roots.push(await canonicalizeProspectivePath(process.env.ProgramFiles ?? join(drive, "Program Files")));
        roots.push(await canonicalizeProspectivePath(process.env["ProgramFiles(x86)"] ?? join(drive, "Program Files (x86)")));
        roots.push(await canonicalizeProspectivePath(process.env.ProgramData ?? join(drive, "ProgramData")));
    } else {
        for (const root of POSIX_SYSTEM_ROOTS) roots.push(await canonicalizeProspectivePath(root));
        if (process.platform === "darwin") for (const root of MAC_SYSTEM_ROOTS) roots.push(await canonicalizeProspectivePath(root));
    }
    return roots;
}
function deletionRefusal(target: string, workspaces: readonly string[], home: string, agent: string, system: readonly string[], workspaceContents = false): string | undefined {
    if (target === parse(target).root) return "文件系统或盘符根目录";
    if (inside(target, home)) return "HOME 或其祖先目录";
    for (const workspace of workspaces) if (inside(target, workspace) && !(workspaceContents && target === workspace)) return "工作区根或其祖先目录";
    if (inside(agent, target) || inside(target, agent)) return "agent 自身目录及其内容";
    for (const root of system) if (inside(root, target) || inside(target, root)) return "系统关键目录及其内容";
    return undefined;
}

/** Cold, bounded native invocation classification; execution and approvals remain owned by SessionExecutionPolicy. */
export async function assessHostMutations(workspaces: readonly string[], paths: readonly string[], tool: string, input: Record<string, any>): Promise<HostMutationAssessment> {
    const batch = tool === "file_batch", count = batch ? input.operations.length : 1;
    const assessment: HostMutationAssessment = { ask: false, details: "" };
    // A preview cannot delete or overwrite. Existing explicit rules and protected-file checks still apply.
    if (batch && input.dryRun === true) return assessment;
    const agent = await canonicalizeProspectivePath(getAgentDir());
    let destructive = false;
    for (let index = 0; index < count; index++) {
        const operation = batch ? input.operations[index].operation : tool;
        if (operation === "delete" || operation === "move") destructive = true;
    }
    const home = destructive ? await canonicalizeProspectivePath(homedir()) : "";
    const system = destructive ? await systemRoots(home) : [];
    let cursor = 0;
    for (let index = 0; index < count; index++) {
        const item = batch ? input.operations[index] : input, operation = batch ? item.operation : tool;
        const target = paths[cursor++]!, external = !inWorkspace(workspaces, target), agentPath = inside(agent, target);
        assessment.details += `${operation}: ${target} [${agentPath ? "agent 自身目录" : external ? "工作区外" : "工作区内"}]\n`;
        if (operation === "delete" || operation === "move") {
            const reason = deletionRefusal(target, workspaces, home, agent, system);
            if (reason) assessment.forbidden ??= `${operation} ${target}\n禁止原因：${reason}`;
            else if (external) assessment.ask = true;
        } else if (agentPath) assessment.ask = true;
        else if (external && !(batch && operation === "write" && item.mode === "create")) {
            if (await exists(target)) assessment.externalOverwrite ??= `${operation} ${target}`;
            else if (operation === "write") (assessment.newExternalFiles ??= []).push(target);
        }
        if (item.destination !== undefined) {
            const destination = paths[cursor++]!, outside = !inWorkspace(workspaces, destination), agentDestination = inside(agent, destination);
            assessment.details += `目标: ${destination} [${agentDestination ? "agent 自身目录" : outside ? "工作区外" : "工作区内"}]\n`;
            if (outside || agentDestination) assessment.ask = true;
        }
    }
    return assessment;
}

export interface HostShellAssessment extends HostMutationAssessment { paths: string[]; }

async function pathInfo(target: string) {
    try { return await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Unlinking the link itself does not delete its referent; ancestors still resolve against disk. */
async function canonicalDeletionPath(target: string, contents: boolean): Promise<string> {
    if (!contents && (await pathInfo(target))?.isSymbolicLink()) return join(await canonicalizeProspectivePath(dirname(target)), basename(target));
    return canonicalizeProspectivePath(target);
}

async function gitResetRoot(cwd: string): Promise<string> {
    let current = cwd;
    for (;;) {
        if (await pathInfo(join(current, ".git"))) return current;
        const parent = dirname(current);
        if (parent === current) return cwd;
        current = parent;
    }
}

/** Same decision owner and protected roots as native files, fed by bounded shell operation facts. */
export async function assessHostShellEffects(workspaces: readonly string[], unavailable: readonly string[], scan: ShellMutationScan): Promise<HostShellAssessment> {
    const assessment: HostShellAssessment = { ask: scan.recognized && scan.uncertain, details: "", paths: [] };
    if (scan.recognized && scan.uncertain) assessment.details = "目标无法确定：命令包含动态目标或超过分析范围，需允许一次。\n";
    if (!scan.effects.length) return assessment;
    const metadata = await canonicalWorkspaceMetadata(workspaces), agent = await canonicalizeProspectivePath(getAgentDir());
    const home = await canonicalizeProspectivePath(homedir()), system = await systemRoots(home);
    for (const effect of scan.effects) {
        const destructive = effect.kind === "delete" || effect.kind === "delete-contents" || effect.kind === "move" || effect.kind === "git-clean";
        const gitScope = effect.kind === "git-clean" || effect.kind === "git-reset";
        const original = effect.kind === "git-reset" ? await gitResetRoot(effect.path) : effect.path;
        const target = destructive ? await canonicalDeletionPath(original, effect.kind === "delete-contents" || gitScope) : await canonicalizeProspectivePath(original);
        for (const root of unavailable) if (inside(root, original) || inside(root, target)) throw new Error("[POLICY_BLOCKED] Additional workspace is unavailable or redirected: " + root);
        const external = !inWorkspace(workspaces, target), agentPath = inside(agent, target);
        assessment.paths.push(target);
        assessment.details += `${effect.kind}: ${target} [${agentPath ? "agent 自身目录" : external ? "工作区外" : "工作区内"}]\n`;
        if (effect.kind !== "copy") {
            const protectedPath = assessCanonicalMutationPath(workspaces, target, metadata);
            for (const violation of protectedPath.violations) if (violation !== "workspace_escape" && !(gitScope && violation === "workspace_root"))
                assessment.forbidden ??= `${effect.kind} ${target}\n禁止原因：${violation}`;
        }
        if (destructive) {
            const reason = deletionRefusal(target, workspaces, home, agent, system, gitScope);
            if (reason) assessment.forbidden ??= `${effect.kind} ${target}\n禁止原因：${reason}`;
            else if (external) assessment.ask = true;
        } else if (effect.kind !== "copy") {
            if (agentPath) assessment.ask = true;
            else if (external && effect.kind !== "create" && await pathInfo(target)) assessment.externalOverwrite ??= `${effect.kind} ${target}`;
        }
        if (effect.destination !== undefined) {
            let destination = await canonicalizeProspectivePath(effect.destination);
            if ((await pathInfo(destination))?.isDirectory()) destination = await canonicalizeProspectivePath(join(destination, basename(effect.path)));
            for (const root of unavailable) if (inside(root, effect.destination) || inside(root, destination)) throw new Error("[POLICY_BLOCKED] Additional workspace is unavailable or redirected: " + root);
            const outside = !inWorkspace(workspaces, destination), agentDestination = inside(agent, destination);
            assessment.paths.push(destination);
            assessment.details += `目标: ${destination} [${agentDestination ? "agent 自身目录" : outside ? "工作区外" : "工作区内"}]\n`;
            const protectedDestination = assessCanonicalMutationPath(workspaces, destination, metadata);
            for (const violation of protectedDestination.violations) if (violation !== "workspace_escape") assessment.forbidden ??= `${effect.kind} ${destination}\n禁止原因：${violation}`;
            if (agentDestination) assessment.ask = true;
            else if (outside && await pathInfo(destination)) assessment.externalOverwrite ??= `${effect.kind} ${destination}`;
            else if (outside && effect.kind === "move") assessment.ask = true;
        }
    }
    return assessment;
}
