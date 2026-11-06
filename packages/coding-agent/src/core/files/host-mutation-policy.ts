import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative } from "node:path";
import { getAgentDir } from "../../config.ts";
import { canonicalizeProspectivePath } from "./protected-path-policy.ts";

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
async function exists(target: string, filesOnly: boolean): Promise<boolean> {
    try { const stat = await lstat(target); return !filesOnly || stat.isFile(); }
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
function deletionRefusal(target: string, workspaces: readonly string[], home: string, agent: string, system: readonly string[]): string | undefined {
    if (target === parse(target).root) return "文件系统或盘符根目录";
    if (inside(target, home)) return "HOME 或其祖先目录";
    for (const workspace of workspaces) if (inside(target, workspace)) return "工作区根或其祖先目录";
    if (inside(agent, target) || inside(target, agent)) return "agent 自身目录及其内容";
    for (const root of system) if (inside(root, target) || inside(target, root)) return "系统关键目录及其内容";
    return undefined;
}

/** Cold, bounded native invocation classification; execution and approvals remain owned by SessionExecutionPolicy. */
export async function assessHostMutations(workspaces: readonly string[], paths: readonly string[], tool: string, input: Record<string, any>, existingFilesOnly = false): Promise<HostMutationAssessment> {
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
            if (await exists(target, existingFilesOnly)) assessment.externalOverwrite ??= `${operation} ${target}`;
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
