import { access, open, statfs, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { CommitMetadata } from "./file-commit.ts";
import type { PathIdentity } from "./native-file-core.ts";
import { nativeFileRequest } from "./native-file-client.ts";

const LOCAL_LINUX_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);

function unsupportedPublish(): Promise<void> { return Promise.reject(new Error("Preselected compatibility cannot publish a replacement.")); }
async function noMetadataCopy(): Promise<void> { /* In-place writes retain the object. */ }
function compatibility(reason: string, original: { mode: bigint; uid: bigint; gid: bigint; nlink: bigint }, extra?: (handle: FileHandle) => Promise<void>): CommitMetadata {
  async function assertCurrent(handle: FileHandle): Promise<void> {
    const info = await handle.stat({ bigint: true });
    if (info.mode !== original.mode || info.uid !== original.uid || info.gid !== original.gid || info.nlink !== original.nlink) throw new Error("[METADATA_CHANGED] In-place permission/owner/link metadata changed.");
    await extra?.(handle);
  }
  return { strategy: "protected_in_place", reason, prepareTemporary: noMetadataCopy, assertCurrent, assertPostimage: assertCurrent,
    async assertBeforeInPlace(handle, plan) { await nativeFileRequest("verify_in_place", { fd: handle.fd, target: plan.target, parent: plan.parent, previousSha256: plan.previousSha256 }); },
    replace: unsupportedPublish, replacementFailureMayChangeState: true };
}

interface MetadataObservation {
  attributes?: number; links?: number; creationTime?: string; security?: string; securityFingerprint?: string; filesystem?: string;
  hasAttributes?: boolean; namesFingerprint?: string; valuesFingerprint?: string; writeClearsAttributes?: boolean;
  defaultAcl?: boolean; ownerAssignable?: boolean;
}

async function inspect(handle: FileHandle, path: string, capability = false): Promise<MetadataObservation> {
  const info = await handle.stat({ bigint: true });
  return nativeFileRequest("inspect", { fd: handle.fd, path, capability, expected: { device: String(info.dev), inode: String(info.ino) } });
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
    const checkAttributes = async (current: FileHandle) => {
      const next = await inspect(current, target.canonical);
      if (process.platform === "win32") {
        if (next.securityFingerprint !== original.securityFingerprint || next.attributes !== original.attributes || next.creationTime !== original.creationTime || next.links !== original.links) throw new Error("[METADATA_CHANGED] In-place Windows metadata changed.");
      } else if (next.namesFingerprint !== original.namesFingerprint || next.valuesFingerprint !== original.valuesFingerprint) throw new Error("[METADATA_CHANGED] In-place ACL/extended attributes changed.");
    };
    if (info.nlink !== 1n) return compatibility("Multiple hardlinks: retain the existing object; supported mode/owner and observed metadata are verified.", info, checkAttributes);
    if (process.platform === "linux" && original.hasAttributes) return compatibility("Visible ACL/extended attributes require the original object; values are verified before and after writing.", info, checkAttributes);
    if (process.platform === "linux") {
      const filesystem = await statfs(target.canonical);
      if (!LOCAL_LINUX_FILESYSTEMS.has(filesystem.type)) return compatibility("Unknown/network filesystem: retain the original object; observed mode/owner and visible attributes are verified, without a local replacement guarantee.", info, checkAttributes);
      if (info.uid !== BigInt(process.geteuid!())) return compatibility("Foreign owner: retain the original object and verify mode/owner and visible attributes.", info, checkAttributes);
      if (process.geteuid!() !== 0 && info.gid !== BigInt(process.getegid!()) && !process.getgroups!().some(group => BigInt(group) === info.gid)) return compatibility("Target group cannot be assigned to a new file: retain the original object and verify mode/owner and visible attributes.", info, checkAttributes);
      try { await access(dirname(target.canonical), constants.W_OK | constants.X_OK); }
      catch (error) {
        if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        return compatibility("Parent directory cannot publish a sibling: preselected in-place write; mode/owner and visible extended attributes are verified.", info, checkAttributes);
      }
      const parent = await open(dirname(target.canonical), "r");
      try {
        if ((await inspect(parent, dirname(target.canonical))).defaultAcl) return compatibility("Parent default ACL would be inherited by a new file: retain the existing object and verify its mode/owner and visible attributes.", info, checkAttributes);
      } finally { await parent.close(); }
    }
    if (process.platform === "win32") {
      if (original.filesystem !== "NTFS") return compatibility("Only local NTFS has a validated staged capability; retain the original object and verify observed Windows metadata.", info, checkAttributes);
      if (original.attributes! & 1) throw new Error("[UNSUPPORTED_COMMIT] Read-only Windows target.");
      if (original.attributes! & ~(0x20 | 0x80)) return compatibility("Special Windows attributes require the original object; observed metadata is verified, advanced metadata is not verified.", info, checkAttributes);
      // ReplaceFileW/SetSecurityInfo can normalize legacy unprotected explicit
      // ACEs into inherited ACEs. Select object preservation BEFORE any effects.
      const control = Buffer.from(original.security!, "base64").readUInt16LE(2);
      if (!(control & (0x1000 | 0x0400))) return compatibility("Legacy unprotected Windows DACL: replacement can change inheritance semantics; retain the original object and verify owner/group/DACL, attributes and creation time.", info, checkAttributes);
      if (!original.ownerAssignable) return compatibility("Owner/group differ from the process token defaults: retain the existing object; no privilege is enabled to assign foreign ownership.", info, checkAttributes);
      if ((control & 0x010b) || !(control & 0x0004)) return compatibility("Windows descriptor defaulted/request/presence flags require the original object; retain and verify their semantics.", info, checkAttributes);
    }
    async function assertMetadata(current: FileHandle, postimage = false): Promise<void> {
      const currentInfo = await current.stat({ bigint: true });
      if (process.platform === "linux" && (currentInfo.mode !== info.mode || currentInfo.uid !== info.uid || currentInfo.gid !== info.gid || currentInfo.nlink !== 1n)) throw new Error("[STALE_STATE] File permission/ownership/link metadata changed.");
      const next = await inspect(current, target.canonical);
      if (process.platform === "win32") {
        if (next.securityFingerprint !== original.securityFingerprint || next.attributes !== original.attributes || next.creationTime !== original.creationTime || next.links !== 1) throw new Error(`[${postimage ? "POSTCOMMIT" : "STALE_STATE"}] Windows metadata changed.`);
      } else if (next.hasAttributes || next.namesFingerprint !== original.namesFingerprint) throw new Error("[STALE_STATE] Extended attributes changed.");
    }
    return {
      strategy: "staged_replace", replacementFailureMayChangeState: true,
      async protectTemporary(staged, path) {
        if (process.platform === "win32") {
          const stagedInfo = await staged.stat({ bigint: true });
          await nativeFileRequest("protect", { path, expected: { device: String(stagedInfo.dev), inode: String(stagedInfo.ino) } });
        } else await staged.chmod(0o600);
      },
      async prepareTemporary(staged, path) {
        if (process.platform === "win32") {
          const stagedInfo = await staged.stat({ bigint: true });
          await nativeFileRequest("prepare", { path, security: original.security, expected: { device: String(stagedInfo.dev), inode: String(stagedInfo.ino) } });
        } else {
          const stagedInfo = await staged.stat({ bigint: true });
          if (stagedInfo.uid !== info.uid || stagedInfo.gid !== info.gid) await staged.chown(Number(info.uid), Number(info.gid));
          await staged.chmod(Number(info.mode) & 0o777);
          const stageMetadata = await inspect(staged, path);
          if (stageMetadata.hasAttributes) throw new Error("[UNSUPPORTED_COMMIT] Temporary inherited unsupported extended attributes.");
        }
      },
      assertCurrent: assertMetadata,
      assertPostimage: handle => assertMetadata(handle, true),
      removeTemporary: process.platform === "win32" ? async (path, expected) => { await nativeFileRequest("remove", { path, expected }); } : undefined,
      async replace(temporary, path, validation) {
        await nativeFileRequest("replace", { temporary, target: path, validation, original,
          metadata: { mode: String(info.mode), uid: String(info.uid), gid: String(info.gid) } });
      },
    };
  } finally { await handle.close(); }
}
