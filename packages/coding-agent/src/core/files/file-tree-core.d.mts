import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { PathIdentity } from "./native-file-core.js";
export interface TreeIdentity extends PathIdentity { symbolicLink?: true; }
export interface TreeEntry { identity: TreeIdentity; parent: number; }
export interface TreePreparation { readonly entries: readonly TreeEntry[]; readonly files: number; readonly directories: number; readonly skippedLinks: number; readonly bytes: number; readonly unlinkFiles?: number; }
export function capturePathIdentity(path: string): Promise<PathIdentity>;
export function pathIdentityFromStat(path: string, canonical: string, info: BigIntStats, symbolicLink?: boolean): TreeIdentity;
export function captureTreeIdentity(path: string): Promise<TreeIdentity>;
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
  stateChanged: boolean | "unknown"; requiresVerification?: true; files: number; bytes: number; directories: number;
  skippedLinks: number; coverageComplete: boolean; sha256?: string; reason?: string;
}
export function executeTree(tree: TreePreparation, operation: "copy" | "move" | "delete", sourceParent: PathIdentity,
  destination: string | undefined, destinationParent: PathIdentity | undefined, authority: () => void, signal?: AbortSignal, moveByCopy?: boolean): Promise<TreeResult>;
