import path from "node:path";
import { containsDirectory } from "../session-execution-profile.ts";
import { fileMutationItem, fileMutationItemCount, fileMutationItemOperation, validateFileMutationTargets } from "../files/file-mutation-input.ts";
import { mutationRequestHash, type PermissionPathApproval } from "../files/file-invocation.ts";
const HOST_ASSIGNED_FIELDS = ['workspaceIndex', 'sourceWorkspaceIndex', 'destinationWorkspaceIndex', 'inputHash'];

function relativeWorkspacePath(cwd: string, value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (!value.length || value.length > 4096 || value.includes("\0")) throw new Error("[SANDBOX_PATH] Invalid workspace path");
    // Do not interpret drive-relative, UNC or device paths as ordinary workspace input.
    if (value.startsWith("\\\\") || value.startsWith("//") || !path.isAbsolute(value) && value.includes(":"))
        throw new Error("[SANDBOX_PATH] Use a workspace-relative path or an absolute path inside the session workspace");
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(cwd, value);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
        throw new Error("[SANDBOX_PATH] Path is outside the session workspace: " + value);
    return relative.replaceAll("\\", "/") || ".";
}

function assignedMutationPath(primary: string, directories: readonly string[], target: string) {
    if (typeof target !== 'string') throw new Error('[SANDBOX_PATH] Missing approved path in the complete invocation table');
    const absolute = path.resolve(primary, target);
    let selected = primary, workspaceIndex = 0, selectedContains = containsDirectory(primary, absolute);
    for (let index = 0; index < directories.length; index++) if (containsDirectory(directories[index], absolute)
        && (!selectedContains || directories[index].length > selected.length)) { selected = directories[index]; workspaceIndex = index + 1; selectedContains = true; }
    return { path: relativeWorkspacePath(selected, absolute), workspaceIndex };
}

/** v3 transport projection. Source/destination identities are assigned
 * independently, and a relative destination always uses the primary workspace.
 * canonicalPaths comes only from the operation-policy owner, never the model. */
export function workspaceMutationItems(cwd: string, operation: string, input: Record<string, unknown>, directories: readonly string[] = [], canonicalPaths?: readonly string[]): Record<string, any>[] {
    validateFileMutationTargets(operation, input);
    const count = fileMutationItemCount(operation, input), result: Record<string, any>[] = [];
    let cursor = 0;
    for (let index = 0; index < count; index++) {
        const item = fileMutationItem(operation, input, index), name = fileMutationItemOperation(operation, input, index);
        for (const key of HOST_ASSIGNED_FIELDS) if (Object.hasOwn(input, key)) throw new Error('[SANDBOX_PATH] Workspace/manifest identity is assigned by the host, not a tool argument');
        const source = canonicalPaths ? canonicalPaths[cursor++] : item.path;
        const destination = item.destination === undefined ? undefined : canonicalPaths ? canonicalPaths[cursor++] : item.destination;
        result.push(workspaceMutationItem(cwd, name, item, directories, source, destination));
    }
    if (canonicalPaths && cursor !== canonicalPaths.length) throw new Error('[SANDBOX_PATH] Complete approved path table does not match the invocation');
    return result;
}

/** Projection of one already validated immutable item during invocation setup. */
export function workspaceMutationItem(cwd: string, operation: string, item: Record<string, any>, directories: readonly string[], canonicalSource: string, canonicalDestination?: string): Record<string, any> {
    for (const key of HOST_ASSIGNED_FIELDS) if (Object.hasOwn(item, key)) throw new Error('[SANDBOX_PATH] Workspace/manifest identity is assigned by the host, not a tool argument');
    const source = assignedMutationPath(cwd, directories, canonicalSource);
    const translated: Record<string, any> = { ...item, operation, path: source.path, workspaceIndex: source.workspaceIndex,
        inputHash: mutationRequestHash(operation as PermissionPathApproval['operation'], item) };
    if (item.destination !== undefined) {
        const destination = assignedMutationPath(cwd, directories, canonicalDestination!);
        translated.destination = destination.path; translated.destinationWorkspaceIndex = destination.workspaceIndex;
    }
    return translated;
}

function translatePaths(cwd: string, input: Record<string, unknown>): Record<string, unknown> {
    const target = input.path === undefined || input.path === "" ? input.path : relativeWorkspacePath(cwd, input.path);
    const destination = input.destination === undefined ? undefined : relativeWorkspacePath(cwd, input.destination);
    if (target === input.path && destination === input.destination) return input;
    const translated: Record<string, unknown> = { ...input, path: target };
    if (destination !== undefined) translated.destination = destination;
    return translated;
}

/** Runs once per explicit tool invocation, preserving the original authorization arguments. */
export function workspaceInput(cwd: string, operation: string, input: Record<string, unknown>, directories: readonly string[] = []): Record<string, unknown> {
    if (operation === "file_batch") throw new Error("[SANDBOX_UNSUPPORTED] Batch mutations require the complete v3 path table.");
    if (Object.hasOwn(input, "workspaceIndex")) throw new Error("[SANDBOX_PATH] Workspace identity is assigned by the host, not a tool argument");
    if (operation === "powershell" || operation === "bash") {
        if (input.cwd === undefined) return input;
        if (typeof input.cwd !== "string" || !input.cwd.length) throw new Error("[SANDBOX_PATH] Invalid command cwd");
        let index = 0, selected = cwd;
        const target = path.resolve(cwd, input.cwd);
        for (let i = 0; i < directories.length; i++) if (containsDirectory(directories[i], target)) { selected = directories[i]; index = i + 1; break; }
        // Validate the original spelling too (drive-relative and device paths are not relative directories).
        relativeWorkspacePath(selected, input.cwd);
        const relative = relativeWorkspacePath(selected, target);
        return { ...input, cwd: relative, workspaceIndex: index }; // Shell source remains untouched.
    }
    const primary = cwd; let index = 0;
    if (typeof input.path === "string" && path.isAbsolute(input.path)) {
        for (let i = 0; i < directories.length; i++) if (containsDirectory(directories[i], input.path)) { cwd = directories[i]; index = i + 1; break; }
    }
    if (index) {
        const selected = typeof input.destination === "string" && !path.isAbsolute(input.destination)
            ? { ...input, destination: path.resolve(primary, input.destination) } : input;
        return { ...translatePaths(cwd, selected), workspaceIndex: index };
    }
    return translatePaths(cwd, input);
}
