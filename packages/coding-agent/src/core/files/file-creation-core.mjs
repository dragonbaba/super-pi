import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { capturePathIdentity, sameIdentity, knownNoEffectError } from "./file-tree-core.mjs";
import { FILE_RESULT_INLINE_BYTES, FILE_RESULT_FAILURE_SAMPLES } from "./file-operation-limits.mjs";
export const MAX_CREATED_DIRECTORIES = 32;
/** Display/journal samples only. Full directory ownership remains in the
 * invocation's authenticated inventory until that invocation releases it. */
export function summarizeCreatedDirectories(creation, created) {
    const sample = []; let bytes = 0;
    for (const parent of created) {
        if (sample.length === FILE_RESULT_FAILURE_SAMPLES) break;
        const size = Buffer.byteLength(JSON.stringify(parent));
        if (bytes + size > FILE_RESULT_INLINE_BYTES) break;
        bytes += size; sample.push(parent);
    }
    const total = creation.createdDirectoryCount ?? created.length;
    return { bytes: creation.bytes ?? 0, addedLines: creation.addedLines, createdDirectoryCount: total,
        createdDirectories: sample, createdDirectoriesOmitted: total - sample.length };
}
export function directoryKey(path) { return process.platform === "win32" ? path.toLowerCase() : path; }
const createdFileIdentities = new WeakMap();
/** Only the original successful result carries this association. The existing
 * serialized failure path does not carry an original CreationResult object. */
export function originalCreatedFileIdentity(result) {
    return createdFileIdentities.get(result);
}
/** Preparation-owned canonical paths, including Windows short-name aliases. */
export function canonicalCreationDirectories(plan) {
    const directories = [];
    for (const path of plan.directories)
        directories.push(resolve(plan.ancestor.canonical, relative(plan.ancestor.path, path)));
    return directories;
}
export async function prepareFileCreation(path, createOnly = false, maxDirectories = MAX_CREATED_DIRECTORIES) {
    try {
        await lstat(path);
        if (createOnly)
            throw new Error("[TARGET_APPEARED] Create-only target already exists.");
        return undefined;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const directories = [];
    let probe = dirname(path);
    for (;;) {
        try {
            const ancestor = await capturePathIdentity(probe);
            if (!ancestor.directory)
                throw new Error("[WRITE_FAILED] A parent path is a file.");
            directories.reverse();
            return Object.freeze({ path, canonicalTarget: resolve(ancestor.canonical, relative(probe, path)), ancestor, directories: Object.freeze(directories) });
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            if (directories.length >= maxDirectories || dirname(probe) === probe)
                throw new Error("[MUTATION_BUDGET_EXCEEDED] Too many missing parent directories.");
            directories.push(probe);
            probe = dirname(probe);
        }
    }
}
export async function verifyCreationAncestor(plan) {
    if (!sameIdentity(plan.ancestor, await capturePathIdentity(plan.ancestor.path), false))
        throw new Error("[STALE_STATE] Existing parent ancestor changed after preflight.");
}
/** No target I/O, no line arrays or copy of the content. A trailing newline does not add a line. */
export function addedContentSummary(content) {
    let lines = content.length ? 1 : 0;
    let text = true;
    for (let i = 0; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code === 10 && i + 1 < content.length)
            lines++;
        if (code === 0 || (code === 13 && content.charCodeAt(i + 1) !== 10))
            text = false;
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = content.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                text = false;
            else
                i++;
        }
        else if (code >= 0xdc00 && code <= 0xdfff)
            text = false;
    }
    return { bytes: Buffer.byteLength(content, "utf8"), ...(text ? { addedLines: lines } : {}) };
}
async function verifyCreatedDirectories(created) {
    for (const directory of created) {
        if (!directory.identity || !sameIdentity(directory.identity, await capturePathIdentity(directory.path), false))
            throw new Error("[STALE_STATE] Created directory changed before file creation.");
    }
}
function retainUnprovenDirectories(created) {
    // mkdir returns no handle/identity. A later lstat cannot prove creation ownership
    // against external replacement, so this portable implementation never deletes it.
    for (const directory of created)
        directory.status = "retained";
}
/** Single write and file_batch share this exclusive create core. Never removes a partially written file. */
export class FileCreationFailure extends Error {
    constructor(facts) { super(String(facts.cause)); this.name = "FileCreationFailure"; this.facts = facts; }
}
/** Shared parent effects for text creation and copy/move destinations. Preparation
 * remains read-only; callers retain this complete inventory until publication. */
export async function executeFileCreationDirectories(plan, assertPathAllowed, signal, sharedDirectories, assertAuthority) {
    const created = [];
    let effectPending = false;
    try {
        await verifyCreationAncestor(plan);
        if (directoryKey(await assertPathAllowed()) !== directoryKey(plan.canonicalTarget))
            throw new Error("[STALE_STATE] Creation target changed before directory creation.");
        for (const path of plan.directories) {
            signal?.throwIfAborted();
            await verifyCreationAncestor(plan);
            const shared = sharedDirectories?.get(directoryKey(path));
            if (shared) {
                if (!sameIdentity(shared, await capturePathIdentity(path), false))
                    throw new Error("[STALE_STATE] Shared created parent changed.");
                continue;
            }
            await verifyCreatedDirectories(created);
            assertAuthority?.();
            signal?.throwIfAborted();
            effectPending = true;
            await mkdir(path); // Nonrecursive and exclusive: a competing directory invalidates this plan.
            effectPending = false;
            // Keep the preparation-owned spelling even if identity capture fails.
            const record = { path: resolve(plan.ancestor.canonical, relative(plan.ancestor.path, path)), status: "retained" };
            created.push(record);
            const identity = await capturePathIdentity(path);
            record.identity = identity;
            record.status = "created";
            sharedDirectories?.set(directoryKey(path), identity);
        }
        return created;
    } catch (error) {
        retainUnprovenDirectories(created);
        const changed = created.length > 0;
        const stateChanged = effectPending && !knownNoEffectError(error) ? "unknown" : changed;
        throw new FileCreationFailure({ ok: false, status: stateChanged === "unknown" ? "state_unknown" : changed ? "partial" : signal?.aborted ? "cancelled" : "failed_no_change",
            operation: "write", category: error.code === "EEXIST" ? "TARGET_APPEARED" : stateChanged ? "PARTIAL_MUTATION" : "WRITE_FAILED",
            target: plan.path, stateChanged, requiresVerification: stateChanged !== false, retryable: stateChanged === false,
            fileCreated: false, createdDirectories: created, cause: error instanceof Error ? error.message : String(error) });
    }
}
export async function executeFileCreation(plan, content, assertPathAllowed, signal, beforeExclusiveCreate, sharedDirectories, assertAuthority, structuredFailure = false) {
    let created = [];
    let fileCreated = false;
    let effectPending = false;
    let originalIdentity;
    try {
        created = await executeFileCreationDirectories(plan, assertPathAllowed, signal, sharedDirectories, assertAuthority);
        await beforeExclusiveCreate?.(plan.path);
        signal?.throwIfAborted();
        await verifyCreationAncestor(plan);
        await verifyCreatedDirectories(created);
        if (sharedDirectories)
            for (const path of plan.directories) {
                const identity = sharedDirectories.get(directoryKey(path));
                if (!identity || !sameIdentity(identity, await capturePathIdentity(path), false))
                    throw new Error("[STALE_STATE] Shared parent identity changed before file creation.");
            }
        if (directoryKey(await assertPathAllowed()) !== directoryKey(plan.canonicalTarget))
            throw new Error("[STALE_STATE] Creation target changed.");
        assertAuthority?.();
        signal?.throwIfAborted();
        effectPending = true;
        const handle = await open(plan.path, "wx");
        effectPending = false;
        fileCreated = true;
        try {
            const opened = await handle.stat({ bigint: true });
            originalIdentity = Object.freeze({ path: plan.canonicalTarget, device: String(opened.dev), inode: String(opened.ino) });
            const current = await capturePathIdentity(plan.path);
            if (directoryKey(current.canonical) !== directoryKey(plan.canonicalTarget) || current.device !== String(opened.dev) || current.inode !== String(opened.ino))
                throw new Error("[STALE_STATE] Created file identity changed.");
            await verifyCreationAncestor(plan);
            await verifyCreatedDirectories(created);
            signal?.throwIfAborted();
            await assertPathAllowed();
            await verifyCreationAncestor(plan);
            await verifyCreatedDirectories(created);
            const finalName = await capturePathIdentity(plan.path);
            if (directoryKey(finalName.canonical) !== directoryKey(plan.canonicalTarget) || finalName.device !== String(opened.dev) || finalName.inode !== String(opened.ino) || finalName.links !== "1" || opened.nlink !== 1n)
                throw new Error("[STALE_STATE] Opened file was moved or replaced during authorization.");
            assertAuthority?.();
            signal?.throwIfAborted();
            await handle.writeFile(content, "utf8");
        }
        finally {
            await handle.close();
        }
        const result = { createdDirectories: created, ...(typeof content === "string" ? addedContentSummary(content) : { bytes: content.byteLength }) };
        if (originalIdentity)
            createdFileIdentities.set(result, originalIdentity);
        return result;
    }
    catch (error) {
        if (error instanceof FileCreationFailure) throw structuredFailure ? error : new Error(JSON.stringify(error.facts));
        retainUnprovenDirectories(created);
        for (const directory of created)
            if (directory.status === "removed")
                sharedDirectories?.delete(directoryKey(directory.path));
        let stateChanged = fileCreated;
        for (const directory of created)
            if (directory.status !== "removed")
                stateChanged = true;
        if (effectPending && !knownNoEffectError(error)) stateChanged = "unknown";
        const facts = { ok: false, operation: "write", category: error.code === "EEXIST" ? "TARGET_APPEARED" : stateChanged ? "PARTIAL_MUTATION" : "WRITE_FAILED",
            status: stateChanged === "unknown" ? "state_unknown" : stateChanged ? "partial" : signal?.aborted ? "cancelled" : "failed_no_change",
            target: plan.path, stateChanged, requiresVerification: stateChanged !== false, retryable: stateChanged === false,
            fileCreated, createdDirectories: created, cause: error instanceof Error ? error.message : String(error) };
        throw structuredFailure ? new FileCreationFailure(facts) : new Error(JSON.stringify(facts));
    }
}
