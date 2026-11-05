import path from "node:path";
import { containsDirectory } from "../session-execution-profile.ts";

function relativeWorkspacePath(cwd: string, value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (!value.length || value.length >= 4096 || value.includes("\0")) throw new Error("[SANDBOX_PATH] Invalid workspace path");
    // Do not interpret drive-relative, UNC or device paths as ordinary workspace input.
    if (value.startsWith("\\\\") || value.startsWith("//") || !path.isAbsolute(value) && value.includes(":"))
        throw new Error("[SANDBOX_PATH] Use a workspace-relative path or an absolute path inside the session workspace");
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(cwd, value);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
        throw new Error("[SANDBOX_PATH] Path is outside the session workspace: " + value);
    return relative.replaceAll("\\", "/") || ".";
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
    if (Object.hasOwn(input, "workspaceIndex")) throw new Error("[SANDBOX_PATH] Workspace identity is assigned by the host, not a tool argument");
    if (operation === "powershell" || operation === "bash") return input; // Shell source is never rewritten as text.
    const primary = cwd; let index = 0;
    if (typeof input.path === "string" && path.isAbsolute(input.path)) {
        for (let i = 0; i < directories.length; i++) if (containsDirectory(directories[i], input.path)) { cwd = directories[i]; index = i + 1; break; }
    }
    if (operation !== "file_batch" && index) {
        const selected = typeof input.destination === "string" && !path.isAbsolute(input.destination)
            ? { ...input, destination: path.resolve(primary, input.destination) } : input;
        return { ...translatePaths(cwd, selected), workspaceIndex: index };
    }
    if (operation !== "file_batch") return translatePaths(cwd, input);
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 16)
        throw new Error("[SANDBOX_PATH] Invalid file batch");
    const operations = [];
    for (const item of input.operations) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("[SANDBOX_PATH] Invalid file operation");
        const translated = workspaceInput(cwd, String(item.operation), item, directories);
        operations.push(translated);
    }
    return { ...input, operations };
}
