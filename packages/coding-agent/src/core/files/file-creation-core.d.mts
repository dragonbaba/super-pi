import type { PathIdentity } from "./native-file-core.js";
export const MAX_CREATED_DIRECTORIES: number;
export function directoryKey(path: string): string;
export interface FileCreationPlan { path: string; canonicalTarget: string; ancestor: PathIdentity; directories: readonly string[]; }
export interface CreatedDirectory { path: string; identity?: PathIdentity; status: "created" | "removed" | "retained"; }
export interface CreationResult { createdDirectories: CreatedDirectory[]; bytes: number; addedLines?: number; }
export function summarizeCreatedDirectories(creation: { bytes?: number; addedLines?: number; createdDirectoryCount?: number }, created: readonly CreatedDirectory[]):
  { bytes: number; addedLines?: number; createdDirectoryCount: number; createdDirectories: CreatedDirectory[]; createdDirectoriesOmitted: number };
export interface CreatedFileIdentity { readonly path: string; readonly device: string; readonly inode: string; }
export function originalCreatedFileIdentity(result: CreationResult): Readonly<CreatedFileIdentity> | undefined;
export function canonicalCreationDirectories(plan: FileCreationPlan): string[];
export function prepareFileCreation(path: string, createOnly?: boolean, maxDirectories?: number): Promise<FileCreationPlan | undefined>;
export function verifyCreationAncestor(plan: FileCreationPlan): Promise<void>;
export function addedContentSummary(content: string): { bytes: number; addedLines?: number };
export function executeFileCreationDirectories(plan: FileCreationPlan, assertPathAllowed: () => Promise<string>, signal?: AbortSignal,
  sharedDirectories?: Map<string, PathIdentity>, assertAuthority?: () => void): Promise<CreatedDirectory[]>;
export function executeFileCreation(plan: FileCreationPlan, content: string | Uint8Array, assertPathAllowed: () => Promise<string>, signal?: AbortSignal,
  beforeExclusiveCreate?: (path: string) => void | Promise<void>, sharedDirectories?: Map<string, PathIdentity>, assertAuthority?: () => void,
  structuredFailure?: boolean): Promise<CreationResult>;
export class FileCreationFailure extends Error { readonly facts: Record<string, unknown>; }
