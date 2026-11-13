import type { PathIdentity } from "./native-file-core.js";
import type { TreeIdentity, TreePreparation } from "./file-tree-core.mjs";
import type { FileCreationPlan, CreatedDirectory } from "./file-creation-core.mjs";
import type { ManifestArtifact, OwnedManifestFile } from "./file-manifest-artifact.mjs";
import type { FileRpcEnvelope } from "./file-rpc-chunks.js";
import type { FileOperation, FileOperationInput } from "./file-service.js";

export interface FileWorkerInput extends FileOperationInput {
  operation: FileOperation; workspaceIndex: number; destinationWorkspaceIndex?: number; inputHash: string; mode?: "create" | "overwrite";
}
export interface FileWorkerRequest extends FileRpcEnvelope { itemCount: number; }
export interface FileWorkerTextPreparation {
  exists: boolean; target: string; identity?: PathIdentity; nextSha256: string; bytes: number; previousSha256?: string; parent?: PathIdentity;
}
export interface FileWorkerHeader {
  kind: "file-plan-v3"; ownerId: string; generation: number; callId: string; requestHash: string; index: number; itemCount: number;
  operation: FileOperation; inputHash: string; workspaceIndex: number; destinationWorkspaceIndex?: number;
  target: string; destination?: string; source?: TreeIdentity; sourceParent?: PathIdentity; destinationParent?: PathIdentity; destinationIdentity?: PathIdentity;
  recursive?: boolean; overwrite?: boolean; mode?: "create" | "overwrite";
  moveStrategy?: "copy_unlink_verified";
  tree?: { entries: number; files: number; directories: number; skippedLinks: number; bytes: number };
  text?: FileWorkerTextPreparation;
  creation?: { path: string; canonicalTarget: string; ancestor: PathIdentity; directoryCount: number };
}
export interface PreparedFileWorkerManifest { header: FileWorkerHeader; tree?: TreePreparation; creation?: FileCreationPlan; }
export interface ValidatedFileWorkerContent { sourceSha256?: string; previousSha256?: string; }
export interface PreparedFileWorkerReply { index: number; manifest: ManifestArtifact; }
export class FileWorkerManifest {
  constructor(request: FileWorkerRequest, item: FileWorkerInput, index: number);
  onManifestRecord(record: unknown, row: number): void;
  finish(): PreparedFileWorkerManifest;
  dispose(): void;
}
export function readFileWorkerManifest(request: FileWorkerRequest, item: FileWorkerInput, index: number, descriptor: ManifestArtifact): Promise<PreparedFileWorkerManifest>;
export function prepareFileWorkerManifest(request: FileWorkerRequest, item: FileWorkerInput, index: number, owned: OwnedManifestFile,
  textPreparation: (root: string, operation: "write" | "edit", input: FileWorkerInput, maxWriteBytes: number) => FileWorkerTextPreparation): Promise<PreparedFileWorkerReply>;
export function revalidateFileWorkerManifest(request: FileWorkerRequest, item: FileWorkerInput, prepared: PreparedFileWorkerManifest,
  preview?: boolean, sharedDirectories?: Map<string, PathIdentity>): Promise<ValidatedFileWorkerContent>;
export function writeFileParentManifest(request: FileWorkerRequest, index: number, creation: FileCreationPlan, owned: OwnedManifestFile,
  kind: "shared" | "created", values: Map<string, PathIdentity> | readonly CreatedDirectory[]): Promise<ManifestArtifact>;
export function readFileParentManifest(request: FileWorkerRequest, index: number, creation: FileCreationPlan, kind: "shared" | "created",
  descriptor: ManifestArtifact): Promise<{ shared: Map<string, PathIdentity>; created: CreatedDirectory[] }>;
