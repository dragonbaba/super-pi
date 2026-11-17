import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { PathIdentity } from "./native-file-core.js";
export interface TreeIdentity extends PathIdentity { symbolicLink?: true; }
export interface TreeEntry { identity: TreeIdentity; parent: number; }
export interface ProtectedTreeEntry { readonly parent: number; readonly name: string; }
export interface TreePreparation { readonly entries: readonly TreeEntry[]; readonly files: number; readonly directories: number; readonly skippedLinks: number; readonly bytes: number; readonly unlinkFiles?: number; readonly protectedEntries?: readonly ProtectedTreeEntry[]; }
export interface TreeProtectionSummary { skippedProtected: number; skippedProtectedPaths: string[]; skippedProtectedPathsOmitted: number; retainedDirectories?: number; sourceRetained?: boolean; }
export function summarizeTreeProtection(tree: TreePreparation): TreeProtectionSummary | undefined;
export function protectedDirectoryIndexes(tree: TreePreparation): Set<number> | undefined;
export function capturePathIdentity(path: string, expected?: PathIdentity & { symbolicLink?: boolean }): Promise<PathIdentity>;
export function assertFilePathAfterFailure(expected: PathIdentity & { symbolicLink?: boolean }): Promise<void>;
export function assertFilePathAfterFailureSync(expected: PathIdentity & { symbolicLink?: boolean }): void;
export function pathIdentityFromStat(path: string, canonical: string, info: BigIntStats, symbolicLink?: boolean): TreeIdentity;
export function captureTreeIdentity(path: string, expected?: PathIdentity & { symbolicLink?: boolean }): Promise<TreeIdentity>;
export function sameIdentity(a: PathIdentity, b: PathIdentity, metadata?: boolean): boolean;
export function protectedTreeName(name: string): boolean;
export function prepareTree(source: PathIdentity, operation: "copy" | "move" | "delete", recursive?: boolean, authority?: () => void, signal?: AbortSignal): Promise<TreePreparation>;
export function writeIdentityTo(source: PathIdentity, target: FileHandle, authority?: () => void, signal?: AbortSignal): Promise<string>;
export function hashIdentity(source: PathIdentity, authority?: () => void, signal?: AbortSignal): Promise<string>;
export function boundedReason(text: string, budget?: number): string;
export function knownNoEffectError(error: unknown): boolean;
export function revalidateTree(tree: TreePreparation, authority?: () => void, signal?: AbortSignal): Promise<void>;
export interface TreeResult {
  status: "succeeded" | "failed_no_change" | "partial" | "cancelled" | "state_unknown";
  stateChanged: boolean | "unknown"; requiresVerification?: true; stopInvocation?: true; files: number; bytes: number; directories: number;
  skippedLinks: number; coverageComplete: boolean; sha256?: string; reason?: string;
  skippedProtected?: number; skippedProtectedPaths?: string[]; skippedProtectedPathsOmitted?: number; retainedDirectories?: number; sourceRetained?: boolean;
}
export function executeTree(tree: TreePreparation, operation: "copy" | "move" | "delete", sourceParent: PathIdentity,
  destination: string | undefined, destinationParent: PathIdentity | undefined, authority: () => void, signal?: AbortSignal, moveByCopy?: boolean): Promise<TreeResult>;
