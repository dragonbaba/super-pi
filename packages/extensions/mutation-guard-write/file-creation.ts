import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { capturePathIdentity, sameIdentity, type PathIdentity } from "./native-file-core.ts";

export const MAX_CREATED_DIRECTORIES = 32;
export function directoryKey(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }
export interface FileCreationPlan {
  path: string;
  canonicalTarget: string;
  ancestor: PathIdentity;
  directories: readonly string[];
}
export interface CreatedDirectory { path: string; identity?: PathIdentity; status: "created" | "removed" | "retained" }
export interface CreationResult { createdDirectories: CreatedDirectory[]; bytes: number; addedLines?: number }

export async function prepareFileCreation(path: string, createOnly = false): Promise<FileCreationPlan | undefined> {
  try {
    await lstat(path);
    if (createOnly) throw new Error("[TARGET_APPEARED] Create-only target already exists.");
    return undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directories: string[] = [];
  let probe = dirname(path);
  for (;;) {
    try {
      const ancestor = await capturePathIdentity(probe);
      if (!ancestor.directory) throw new Error("[WRITE_FAILED] A parent path is a file.");
      directories.reverse();
      return Object.freeze({ path, canonicalTarget: resolve(ancestor.canonical, relative(probe, path)), ancestor, directories: Object.freeze(directories) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (directories.length === MAX_CREATED_DIRECTORIES || dirname(probe) === probe) throw new Error("[MUTATION_BUDGET_EXCEEDED] Too many missing parent directories.");
      directories.push(probe); probe = dirname(probe);
    }
  }
}

export async function verifyCreationAncestor(plan: FileCreationPlan): Promise<void> {
  if (!sameIdentity(plan.ancestor, await capturePathIdentity(plan.ancestor.path), false)) throw new Error("[STALE_STATE] Existing parent ancestor changed after preflight.");
}

/** No target I/O, no line arrays or copy of the content. A trailing newline does not add a line. */
export function addedContentSummary(content: string): { bytes: number; addedLines?: number } {
  let lines = content.length ? 1 : 0;
  let text = true;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 10 && i + 1 < content.length) lines++;
    if (code === 0 || (code === 13 && content.charCodeAt(i + 1) !== 10)) text = false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) text = false;
      else i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) text = false;
  }
  return { bytes: Buffer.byteLength(content, "utf8"), ...(text ? { addedLines: lines } : {}) };
}

async function verifyCreatedDirectories(created: readonly CreatedDirectory[]): Promise<void> {
  for (const directory of created) {
    if (!directory.identity || !sameIdentity(directory.identity, await capturePathIdentity(directory.path), false)) throw new Error("[STALE_STATE] Created directory changed before file creation.");
  }
}

function retainUnprovenDirectories(created: CreatedDirectory[]): void {
  // mkdir returns no handle/identity. A later lstat cannot prove creation ownership
  // against external replacement, so this portable implementation never deletes it.
  for (const directory of created) directory.status = "retained";
}

/** Single write and file_batch share this exclusive create core. Never removes a partially written file. */
export async function executeFileCreation(
  plan: FileCreationPlan, content: string, assertPathAllowed: () => Promise<string>, signal?: AbortSignal,
  beforeExclusiveCreate?: (path: string) => void | Promise<void>,
  sharedDirectories?: Map<string, PathIdentity>,
  assertAuthority?: () => void,
): Promise<CreationResult> {
  const created: CreatedDirectory[] = [];
  let fileCreated = false;
  try {
    await verifyCreationAncestor(plan);
    await assertPathAllowed();
    for (const path of plan.directories) {
      signal?.throwIfAborted();
      await verifyCreationAncestor(plan);
      const shared = sharedDirectories?.get(directoryKey(path));
      if (shared) {
        if (!sameIdentity(shared, await capturePathIdentity(path), false)) throw new Error("[STALE_STATE] Shared created parent changed.");
        continue;
      }
      await verifyCreatedDirectories(created);
      assertAuthority?.();
      signal?.throwIfAborted();
      await mkdir(path); // Nonrecursive and exclusive: a competing directory invalidates this plan.
      const record: CreatedDirectory = { path, status: "retained" };
      created.push(record);
      const identity = await capturePathIdentity(path);
      record.identity = identity;
      record.status = "created";
      sharedDirectories?.set(directoryKey(path), identity);
    }
    await beforeExclusiveCreate?.(plan.path);
    signal?.throwIfAborted();
    await verifyCreationAncestor(plan);
    await verifyCreatedDirectories(created);
    if (sharedDirectories) for (const path of plan.directories) {
      const identity = sharedDirectories.get(directoryKey(path));
      if (!identity || !sameIdentity(identity, await capturePathIdentity(path), false)) throw new Error("[STALE_STATE] Shared parent identity changed before file creation.");
    }
    if (directoryKey(await assertPathAllowed()) !== directoryKey(plan.canonicalTarget)) throw new Error("[STALE_STATE] Creation target changed.");
    assertAuthority?.();
    signal?.throwIfAborted();
    const handle = await open(plan.path, "wx");
    fileCreated = true;
    try {
      const opened = await handle.stat({ bigint: true });
      const current = await capturePathIdentity(plan.path);
      if (directoryKey(current.canonical) !== directoryKey(plan.canonicalTarget) || current.device !== String(opened.dev) || current.inode !== String(opened.ino)) throw new Error("[STALE_STATE] Created file identity changed.");
      await verifyCreationAncestor(plan);
      await verifyCreatedDirectories(created);
      signal?.throwIfAborted();
      await assertPathAllowed();
      await verifyCreationAncestor(plan);
      await verifyCreatedDirectories(created);
      const finalName = await capturePathIdentity(plan.path);
      if (directoryKey(finalName.canonical) !== directoryKey(plan.canonicalTarget) || finalName.device !== String(opened.dev) || finalName.inode !== String(opened.ino)) throw new Error("[STALE_STATE] Opened file was moved or replaced during authorization.");
      assertAuthority?.();
      signal?.throwIfAborted();
      await handle.writeFile(content, "utf8");
    } finally { await handle.close(); }
    return { createdDirectories: created, ...addedContentSummary(content) };
  } catch (error) {
    retainUnprovenDirectories(created);
    for (const directory of created) if (directory.status === "removed") sharedDirectories?.delete(directoryKey(directory.path));
    let stateChanged = fileCreated;
    for (const directory of created) if (directory.status !== "removed") stateChanged = true;
    throw new Error(JSON.stringify({ ok: false, operation: "write", category: (error as NodeJS.ErrnoException).code === "EEXIST" ? "TARGET_APPEARED" : stateChanged ? "PARTIAL_MUTATION" : "WRITE_FAILED",
      status: stateChanged ? "partial" : signal?.aborted ? "cancelled" : "failed_no_change", target: plan.path, stateChanged, retryable: !stateChanged,
      fileCreated, createdDirectories: created, cause: error instanceof Error ? error.message : String(error) }));
  }
}
