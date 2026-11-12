export interface ManifestArtifact { name: string; bytes: number; sha256: string; device: string; inode: string; records: number; }
export interface OwnedManifestFile { name: string; device: string; inode: string; }
export function createOwnedManifestFile(exchange: string, name: string): Promise<Readonly<OwnedManifestFile>>;
export function releaseOwnedManifestFile(exchange: string, owned: OwnedManifestFile): Promise<void>;
export interface ManifestVisitor { onManifestRecord(record: unknown, index: number): void; }
export function validateManifestArtifact(raw: unknown, assignedName: string): ManifestArtifact;
export class ManifestArtifactWriter {
  static attach(exchange: string, owned: OwnedManifestFile, authority?: () => void, signal?: AbortSignal): Promise<ManifestArtifactWriter>;
  static create(exchange: string, assignedName: string, authority?: () => void, signal?: AbortSignal): Promise<ManifestArtifactWriter>;
  append(record: unknown): void;
  finish(): Promise<Readonly<ManifestArtifact>>;
  dispose(): Promise<void>;
  readonly diagnostics: { handleRetained: boolean; hashRetained: boolean; authorityRetained: boolean; published: boolean; closed: boolean };
}
export function visitManifestArtifact(exchange: string, assignedName: string, descriptor: ManifestArtifact, visitor: ManifestVisitor, authority?: () => void, signal?: AbortSignal): Promise<number>;
export function releaseManifestArtifact(exchange: string, assignedName: string, descriptor: ManifestArtifact): Promise<void>;
