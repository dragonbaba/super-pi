import { access, open, statfs, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { CommitMetadata, FileCommitPlan, PublicationValidation } from "./file-commit.ts";
import type { PathIdentity } from "./native-file-core.ts";
import { nativeFileRequest } from "./native-file-client.ts";

const LOCAL_LINUX_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);

interface ObjectMetadata { mode: bigint; uid: bigint; gid: bigint; nlink: bigint }

function compatibility(reason: string, info: ObjectMetadata, target: PathIdentity, original: MetadataObservation): CommitMetadata {
  return new NativeCommitMetadata("protected_in_place", target, info, original, reason);
}

function groupAssignable(group: bigint): boolean {
  if (process.geteuid!() === 0 || group === BigInt(process.getegid!())) return true;
  for (const current of process.getgroups!()) if (BigInt(current) === group) return true;
  return false;
}

async function removeWindowsTemporary(path: string, expected: { device: string; inode: string }): Promise<void> {
  await nativeFileRequest("remove", { path, expected });
}

interface MetadataObservation {
  attributes?: number; links?: number; creationTime?: string; security?: string; securityFingerprint?: string; filesystem?: string;
  hasAttributes?: boolean; namesFingerprint?: string; valuesFingerprint?: string; writeClearsAttributes?: boolean;
  defaultAcl?: boolean; ownerAssignable?: boolean; replacementAccess?: boolean; mountId?: string;
}

async function inspect(handle: FileHandle, path: string, capability = false): Promise<MetadataObservation> {
  const info = await handle.stat({ bigint: true });
  return nativeFileRequest("inspect", { fd: handle.fd, path, capability, expected: { device: String(info.dev), inode: String(info.ino) } });
}

/** One prepared plan owns only bounded metadata. Methods do not capture an open
 * handle or recreate callbacks; the mutation queue releases the plan at completion. */
class NativeCommitMetadata implements CommitMetadata {
  readonly strategy: CommitMetadata["strategy"];
  readonly reason?: string;
  readonly replacementFailureMayChangeState = true;
  readonly removeTemporary = process.platform === "win32" ? removeWindowsTemporary : undefined;
  private readonly target: PathIdentity;
  private readonly info: ObjectMetadata;
  private readonly original: MetadataObservation;

  constructor(strategy: CommitMetadata["strategy"], target: PathIdentity, info: ObjectMetadata, original: MetadataObservation, reason?: string) {
    this.strategy = strategy; this.target = target; this.info = info; this.original = original; this.reason = reason;
  }
  async assertCurrent(handle: FileHandle): Promise<void> { await this.assertMetadata(handle, false); }
  async assertPostimage(handle: FileHandle): Promise<void> { await this.assertMetadata(handle, true); }
  private async assertMetadata(handle: FileHandle, postimage: boolean): Promise<void> {
    const current = await handle.stat({ bigint: true }), info = this.info, original = this.original;
    const compatibility = this.strategy === "protected_in_place";
    if ((compatibility || process.platform === "linux") && (current.mode !== info.mode || current.uid !== info.uid || current.gid !== info.gid || current.nlink !== (compatibility ? info.nlink : 1n))) throw new Error("[METADATA_CHANGED] File permission/owner/link metadata changed.");
    const next = await inspect(handle, this.target.canonical);
    if (process.platform === "win32") {
      if (next.securityFingerprint !== original.securityFingerprint || next.attributes !== original.attributes || next.creationTime !== original.creationTime || next.links !== (compatibility ? original.links : 1)) throw new Error(`[${postimage ? "POSTCOMMIT" : "METADATA_CHANGED"}] Windows metadata changed.`);
    } else if (next.namesFingerprint !== original.namesFingerprint || next.valuesFingerprint !== original.valuesFingerprint || !compatibility && next.hasAttributes) throw new Error("[METADATA_CHANGED] ACL/extended attributes changed.");
  }
  async assertBeforeInPlace(handle: FileHandle, plan: FileCommitPlan): Promise<void> {
    await nativeFileRequest("verify_in_place", { fd: handle.fd, target: plan.target, parent: plan.parent, previousSha256: plan.previousSha256 });
  }
  async finalizeInPlace(): Promise<void> {
    if (process.platform === "win32" && this.original.attributes === 0x80) {
      await nativeFileRequest("restore_attributes", { path: this.target.canonical, expected: this.target, attributes: this.original.attributes });
    }
  }
  async protectTemporary(staged: FileHandle, path: string): Promise<void> {
    if (process.platform === "win32") {
      const info = await staged.stat({ bigint: true });
      await nativeFileRequest("protect", { path, expected: { device: String(info.dev), inode: String(info.ino) } });
    } else await staged.chmod(0o600);
  }
  async prepareTemporary(staged: FileHandle, path: string): Promise<void> {
    if (this.strategy === "protected_in_place") return;
    const info = await staged.stat({ bigint: true });
    if (process.platform === "win32") {
      await nativeFileRequest("prepare", { path, security: this.original.security, attributes: this.original.attributes, expected: { device: String(info.dev), inode: String(info.ino) } });
    } else {
      if (info.uid !== this.info.uid || info.gid !== this.info.gid) await staged.chown(Number(this.info.uid), Number(this.info.gid));
      await staged.chmod(Number(this.info.mode) & 0o777);
      if ((await inspect(staged, path)).hasAttributes) throw new Error("[UNSUPPORTED_COMMIT] Temporary inherited unsupported extended attributes.");
    }
  }
  async replace(temporary: string, target: string, validation: PublicationValidation): Promise<void> {
    if (this.strategy !== "staged_replace") throw new Error("Preselected compatibility cannot publish a replacement.");
    await nativeFileRequest("replace", { temporary, target, validation, original: this.original,
      metadata: { mode: String(this.info.mode), uid: String(this.info.uid), gid: String(this.info.gid) } });
  }
}

/** Called once after path authorization, before any staging/in-place write; no failure-triggered fallback. */
export async function selectCommitMetadata(target: PathIdentity): Promise<CommitMetadata> {
  if (target.directory) throw new Error("[UNSUPPORTED_COMMIT] Only existing regular files can be committed.");
  await access(target.canonical, constants.W_OK);
  const handle = await open(target.canonical, "r");
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || String(info.dev) !== target.device || String(info.ino) !== target.inode) throw new Error("[STALE_STATE] Object changed during capability selection.");
    if (!(Number(info.mode) & 0o222)) throw new Error("[UNSUPPORTED_COMMIT] Read-only target; permissions are not overridden.");
    if (process.platform === "linux" && Number(info.mode) & 0o7000) throw new Error("[UNSUPPORTED_COMMIT] Special mode bits may be cleared by writing; target was not modified.");
    if (process.arch !== "x64" || (process.platform !== "win32" && process.platform !== "linux")) throw new Error("[UNSUPPORTED_COMMIT] File metadata checks are only validated on Windows/Linux x64; target was not modified.");
    let original: MetadataObservation;
    try { original = await inspect(handle, target.canonical, true); }
    catch (error) {
      if ((error as { nativeUnavailable?: boolean }).nativeUnavailable) throw new Error(`[UNSUPPORTED_COMMIT] Native metadata capability unavailable: ${(error as Error).message.slice(0, 300)}; target was not modified.`);
      throw error; // Inspection/permission failure never means absent metadata or fallback.
    }
    if (process.platform === "linux" && original.writeClearsAttributes) throw new Error("[UNSUPPORTED_COMMIT] File capabilities may be cleared by writing; target was not modified.");
    if (info.nlink !== 1n) return compatibility("Multiple hardlinks: retain the existing object; supported mode/owner and observed metadata are verified.", info, target, original);
    if (process.platform === "linux" && original.hasAttributes) return compatibility("Visible ACL/extended attributes require the original object; values are verified before and after writing.", info, target, original);
    if (process.platform === "linux") {
      const filesystem = await statfs(target.canonical);
      if (!LOCAL_LINUX_FILESYSTEMS.has(filesystem.type)) return compatibility("Unknown/network filesystem: retain the original object; observed mode/owner and visible attributes are verified, without a local replacement guarantee.", info, target, original);
      if (info.uid !== BigInt(process.geteuid!())) return compatibility("Foreign owner: retain the original object and verify mode/owner and visible attributes.", info, target, original);
      if (!groupAssignable(info.gid)) return compatibility("Target group cannot be assigned to a new file: retain the original object and verify mode/owner and visible attributes.", info, target, original);
      try { await access(dirname(target.canonical), constants.W_OK | constants.X_OK); }
      catch (error) {
        if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        return compatibility("Parent directory cannot publish a sibling: preselected in-place write; mode/owner and visible extended attributes are verified.", info, target, original);
      }
      const parent = await open(dirname(target.canonical), "r");
      try {
        const parentMetadata = await inspect(parent, dirname(target.canonical));
        if (!original.mountId || !parentMetadata.mountId) throw new Error("[UNSUPPORTED_COMMIT] Mount identity is unavailable before staging.");
        if (original.mountId !== parentMetadata.mountId) return compatibility("Target and parent have different mount identities: retain the mounted object and verify mode/owner and visible attributes.", info, target, original);
        if (parentMetadata.defaultAcl) return compatibility("Parent default ACL would be inherited by a new file: retain the existing object and verify its mode/owner and visible attributes.", info, target, original);
      } finally { await parent.close(); }
    }
    if (process.platform === "win32") {
      if (original.filesystem !== "NTFS") return compatibility("Only local NTFS has a validated staged capability; retain the original object and verify observed Windows metadata.", info, target, original);
      if (original.replacementAccess !== true) return compatibility("Windows replacement access is denied: retain the writable original object; verify owner/group/DACL, attributes and creation time. Selected before any candidate is created.", info, target, original);
      if (original.attributes! & 1) throw new Error("[UNSUPPORTED_COMMIT] Read-only Windows target.");
      if (original.attributes! & ~(0x20 | 0x80)) return compatibility("Special Windows attributes require the original object; observed metadata is verified, advanced metadata is not verified.", info, target, original);
      // ReplaceFileW/SetSecurityInfo can normalize legacy unprotected explicit
      // ACEs into inherited ACEs. Select object preservation BEFORE any effects.
      const control = Buffer.from(original.security!, "base64").readUInt16LE(2);
      if (!(control & (0x1000 | 0x0400))) return compatibility("Legacy unprotected Windows DACL: replacement can change inheritance semantics; retain the original object and verify owner/group/DACL, attributes and creation time.", info, target, original);
      if (!original.ownerAssignable) return compatibility("Owner/group differ from the process token defaults: retain the existing object; no privilege is enabled to assign foreign ownership.", info, target, original);
      if ((control & 0x010b) || !(control & 0x0004)) return compatibility("Windows descriptor defaulted/request/presence flags require the original object; retain and verify their semantics.", info, target, original);
    }
    return new NativeCommitMetadata("staged_replace", target, info, original);
  } finally { await handle.close(); }
}
