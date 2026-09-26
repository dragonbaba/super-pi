import { access, open, statfs, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import type { CommitMetadata } from "./file-commit.ts";
import type { PathIdentity } from "./native-file-core.ts";
import { nativeFileRequest } from "./native-file-client.ts";

const LOCAL_LINUX_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);

function unsupportedPublish(): Promise<void> { return Promise.reject(new Error("Preselected compatibility cannot publish a replacement.")); }
async function noMetadataCopy(): Promise<void> { /* In-place writes retain the object. */ }
function compatibility(reason: string): CommitMetadata {
  return { strategy: "protected_in_place", reason, prepareTemporary: noMetadataCopy, assertCurrent: noMetadataCopy,
    replace: unsupportedPublish, replacementFailureMayChangeState: true };
}

interface MetadataObservation {
  attributes?: number; links?: number; creationTime?: string; security?: string; securityFingerprint?: string; filesystem?: string;
  hasAttributes?: boolean; namesFingerprint?: string;
}

async function inspect(handle: FileHandle, path: string): Promise<MetadataObservation> {
  const info = await handle.stat({ bigint: true });
  return nativeFileRequest("inspect", { fd: handle.fd, path, expected: { device: String(info.dev), inode: String(info.ino) } });
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
    if (info.nlink !== 1n) return compatibility("Multiple hardlinks: preserve the existing object; no staged-replacement guarantee.");
    if (process.arch !== "x64" || (process.platform !== "win32" && process.platform !== "linux")) return compatibility("Native staged capability is not validated on this platform/architecture.");
    if (process.platform === "linux") {
      const filesystem = await statfs(target.canonical);
      if (!LOCAL_LINUX_FILESYSTEMS.has(filesystem.type)) return compatibility("Unknown/network filesystem: no local staged-replacement guarantee.");
      if (info.uid !== BigInt(process.getuid!()) || Number(info.mode) & 0o7000) return compatibility("Foreign owner or special mode bits require the original file object.");
    }
    let original: MetadataObservation;
    try { original = await inspect(handle, target.canonical); }
    catch (error) {
      if ((error as { nativeUnavailable?: boolean }).nativeUnavailable) return compatibility(`Native staged capability unavailable: ${(error as Error).message.slice(0, 300)}`);
      throw error; // Inspection/permission failure never means absent metadata or fallback.
    }
    if (process.platform === "linux" && original.hasAttributes) return compatibility("Visible ACL/extended attributes require the original object; no metadata-dropping replacement.");
    if (process.platform === "win32") {
      if (original.filesystem !== "NTFS") return compatibility("Only local NTFS has a validated staged capability.");
      if (original.attributes! & 1) throw new Error("[UNSUPPORTED_COMMIT] Read-only Windows target.");
      if (original.attributes! & ~(0x20 | 0x80)) return compatibility("Special Windows attributes require the original object.");
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
        await nativeFileRequest("replace", { temporary, target: path, validation, original });
      },
    };
  } finally { await handle.close(); }
}
