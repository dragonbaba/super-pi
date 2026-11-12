import type { TreeIdentity } from "./file-tree-core.mjs";
export function containsWorkspacePath(root: string, candidate: string): boolean;
export function workspaceFilePath(roots: readonly string[], index: number, name: string, allowRoot?: boolean): string;
export function validFileIdentity(value: unknown, allowLink?: boolean): value is TreeIdentity;
