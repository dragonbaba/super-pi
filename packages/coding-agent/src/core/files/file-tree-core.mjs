// Shared filesystem mechanics for native and controlled MXC owners. No policy, session or global payload state.
import { constants } from 'node:fs';
import { lstat, realpath, opendir, open, link, unlink, mkdir, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, basename } from 'node:path';
import { FILE_STREAM_BUFFER_BYTES, FILE_RESULT_REASON_BYTES } from './file-operation-limits.mjs';

export async function capturePathIdentity(path) {
  const canonical = await realpath(path), info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('[unsupported] Links, reparse points and special files are unsupported.');
  return pathIdentityFromStat(path, canonical, info, false);
}
export function pathIdentityFromStat(path, canonical, info, symbolicLink = false) {
  return Object.freeze({ path, canonical, device: String(info.dev), inode: String(info.ino), size: String(info.size),
    mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), mode: String(info.mode), links: String(info.nlink), directory: info.isDirectory(),
    ...(symbolicLink ? { symbolicLink: true } : {}) });
}
export function sameIdentity(a, b, metadata = true) {
  return a.canonical === b.canonical && a.device === b.device && a.inode === b.inode && a.directory === b.directory
    && a.mode === b.mode && Boolean(a.symbolicLink) === Boolean(b.symbolicLink)
    && (!metadata || a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && a.links === b.links);
}
export async function captureTreeIdentity(path) {
  const info = await lstat(path, { bigint: true });
  const symbolicLink = info.isSymbolicLink();
  if (!symbolicLink && !info.isFile() && !info.isDirectory()) throw new Error('[unsupported] Special files are unsupported.');
  const canonical = symbolicLink ? resolve(await realpath(dirname(path)), basename(path)) : await realpath(path);
  // Canonical resolution is asynchronous too. Observe the leaf last, without
  // following a link's target, and reject mixed observations of two objects.
  const checked = await lstat(path, { bigint: true });
  if (info.dev !== checked.dev || info.ino !== checked.ino || info.mode !== checked.mode || info.size !== checked.size
    || info.mtimeNs !== checked.mtimeNs || info.ctimeNs !== checked.ctimeNs || info.nlink !== checked.nlink) throw new Error('[STALE_STATE] Tree entry changed during identity capture.');
  return pathIdentityFromStat(path, canonical, checked, symbolicLink);
}
export function protectedTreeName(name) {
  if (process.platform === 'win32') name = name.toLowerCase();
  return name === '.git' || name === '.sp';
}
function current(authority, signal) { signal?.throwIfAborted(); authority?.(); }

/** Iterative immutable preparation; parent indexes let callers serialize an inventory without repeated path strings. */
export async function prepareTree(source, operation, recursive = false, authority, signal) {
  const entries = [Object.freeze({ identity: source, parent: -1 })];
  let files = source.directory ? 0 : 1, directories = source.directory ? 1 : 0, skippedLinks = 0, bytes = source.directory || source.symbolicLink ? 0 : Number(source.size);
  for (let index = 0; index < entries.length; index++) {
    current(authority, signal);
    const entry = entries[index];
    if (!entry.identity.directory) continue;
    const directory = await opendir(entry.identity.path);
    try {
      for (;;) {
        current(authority, signal);
        const child = await directory.read();
        if (!child) break;
        if (protectedTreeName(child.name)) throw new Error('[POLICY_BLOCKED] Source tree contains protected .git/.sp metadata. No item executed.');
        if (operation === 'delete' && !recursive) throw new Error('[directory_not_empty] Recursive deletion requires recursive: true.');
        const path = resolve(entry.identity.path, child.name), observed = await captureTreeIdentity(path);
        if (observed.symbolicLink) {
          if (operation === 'move') throw new Error('[unsupported] Move source contains a link or junction. No item executed.');
          if (operation === 'copy') { skippedLinks++; continue; }
        } else if (observed.canonical !== resolve(entry.identity.canonical, child.name)) throw new Error('[STALE_STATE] Source ancestor changed during preparation.');
        entries.push(Object.freeze({ identity: observed, parent: index }));
        if (observed.directory) directories++;
        else if (!observed.symbolicLink) { files++; bytes += Number(observed.size); }
      }
    } finally { await directory.close(); }
    if (!sameIdentity(entry.identity, await capturePathIdentity(entry.identity.path))) throw new Error('[STALE_STATE] Directory changed during preparation.');
  }
  return Object.freeze({ entries: Object.freeze(entries), files, directories, skippedLinks, bytes });
}

function sameOpened(info, expected) {
  return info.isFile() && String(info.dev) === expected.device && String(info.ino) === expected.inode
    && String(info.size) === expected.size && String(info.mtimeNs) === expected.mtime && String(info.ctimeNs) === expected.ctime;
}

/** Copy at most the prepared size plus one growth-detection byte, with fixed memory and independent write offsets. */
export async function writeIdentityTo(source, target, authority, signal) {
  current(authority, signal);
  if (!sameIdentity(source, await capturePathIdentity(source.path))) throw new Error('[STALE_STATE] Copy source changed before open.');
  const input = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameOpened(await input.stat({ bigint: true }), source)) throw new Error('[STALE_STATE] Copy source identity changed before read.');
    const buffer = Buffer.allocUnsafe(FILE_STREAM_BUFFER_BYTES), hash = createHash('sha256'), size = Number(source.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('[unsupported] File size cannot be represented safely.');
    let position = 0;
    while (position <= size) {
      current(authority, signal);
      const read = await input.read(buffer, 0, Math.min(buffer.length, size + 1 - position), position);
      if (!read.bytesRead) break;
      if (position + read.bytesRead > size) throw new Error('[STALE_STATE] Copy source grew during read.');
      hash.update(read.bytesRead === buffer.length ? buffer : buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        current(authority, signal);
        const next = await target.write(buffer, written, read.bytesRead - written, position + written);
        if (!next.bytesWritten) throw new Error('Copy write made no progress.');
        written += next.bytesWritten;
      }
      position += read.bytesRead;
    }
    if (position !== size || !sameOpened(await input.stat({ bigint: true }), source)
      || !sameIdentity(source, await capturePathIdentity(source.path))) throw new Error('[STALE_STATE] Copy source changed during read; verify the candidate.');
    current(authority, signal);
    return hash.digest('hex');
  } finally { await input.close(); }
}

export async function hashIdentity(source, authority, signal) {
  current(authority, signal);
  const file = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameOpened(await file.stat({ bigint: true }), source)) throw new Error('[STALE_STATE] Hash source identity changed.');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(FILE_STREAM_BUFFER_BYTES), size = Number(source.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('[unsupported] File size cannot be represented safely.');
    let position = 0;
    while (position <= size) {
      current(authority, signal);
      const read = await file.read(buffer, 0, Math.min(buffer.length, size + 1 - position), position);
      if (!read.bytesRead) break;
      if (position + read.bytesRead > size) throw new Error('[STALE_STATE] Hash source grew.');
      hash.update(read.bytesRead === buffer.length ? buffer : buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
    }
    if (position !== size || !sameOpened(await file.stat({ bigint: true }), source)
      || !sameIdentity(source, await capturePathIdentity(source.path))) throw new Error('[STALE_STATE] Hash source changed.');
    current(authority, signal);
    return hash.digest('hex');
  } finally { await file.close(); }
}

export function boundedReason(text, budget = FILE_RESULT_REASON_BYTES) {
  if (Buffer.byteLength(text) <= budget) return text;
  let index = 0, bytes = 0;
  while (index < text.length) {
    const point = text.codePointAt(index), count = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + count > budget) break;
    bytes += count; index += point > 0xffff ? 2 : 1;
  }
  return text.slice(0, index);
}

export async function revalidateTree(tree, authority, signal) {
  for (const entry of tree.entries) {
    current(authority, signal);
    if (!sameIdentity(entry.identity, await captureTreeIdentity(entry.identity.path))) throw new Error('[STALE_STATE] Prepared tree changed before execution.');
  }
  current(authority, signal);
}

const KNOWN_NO_EFFECT_CODES = new Set(['EEXIST', 'ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EXDEV', 'ENOTDIR', 'EISDIR', 'EMLINK', 'ENOSPC', 'EROFS', 'ENOTSUP']);
export function knownNoEffectError(error) { return KNOWN_NO_EFFECT_CODES.has(error?.code); }

/** One top-level operation owns its manifest, created-directory identities and fixed-buffer I/O. */
class TreeExecution {
  constructor(tree, operation, sourceParent, destination, destinationParent, authority, signal, moveByCopy) {
    this.tree = tree; this.operation = operation; this.sourceParent = sourceParent; this.destination = destination;
    this.destinationParent = destinationParent; this.authority = authority; this.signal = signal;
    // Node's path-based link cannot bind a freshly created tree parent. Choose
    // checked copy/unlink for a directory before the first effect.
    this.moveByCopy = moveByCopy || operation === 'move' && tree.entries[0].identity.directory;
    this.created = new Map(); this.groups = new Map(); this.changed = false; this.attempted = false; this.effectPending = false;
    this.files = 0; this.bytes = 0; this.directories = 0; this.sha256 = undefined;
    if (operation !== 'copy') {
      const reverse = operation === 'delete';
      for (let index = reverse ? tree.entries.length - 1 : 0; reverse ? index >= 0 : index < tree.entries.length; index += reverse ? -1 : 1) {
        const entry = tree.entries[index], identity = entry.identity;
        if (identity.directory || identity.links === '1') continue;
        const key = identity.device + ':' + identity.inode;
        let group = this.groups.get(key);
        if (!group) { group = { entries: [], next: 0, ctime: identity.ctime, links: identity.links, changed: false }; this.groups.set(key, group); }
        group.entries.push(entry);
      }
    }
  }
  current = () => current(this.authority, this.signal);
  sourceIdentity(entry) {
    const identity = entry.identity;
    if (identity.directory || identity.links === '1') return identity;
    const group = this.groups.get(identity.device + ':' + identity.inode);
    return group?.changed ? { ...identity, ctime: group.ctime, links: group.links } : identity;
  }
  async advanceSource(entry, decremented) {
    const identity = this.sourceIdentity(entry), group = this.groups.get(identity.device + ':' + identity.inode);
    if (!group) return;
    if (group.entries[group.next++] !== entry) throw new Error('[STALE_STATE] Source alias order changed.');
    if (group.next === group.entries.length) return;
    const next = group.entries[group.next].identity, observed = await captureTreeIdentity(next.path);
    const links = String(BigInt(identity.links) - (decremented ? 1n : 0n));
    if (!sameIdentity(next, observed, false) || next.size !== observed.size || next.mtime !== observed.mtime || observed.links !== links) throw new Error('[STALE_STATE] Remaining source alias changed after the completed operation.');
    this.current(); group.ctime = observed.ctime; group.links = links; group.changed = true;
  }
  async checkParent(expected) {
    this.current();
    if (!expected || !sameIdentity(expected, await capturePathIdentity(expected.path), false)) throw new Error('[STALE_STATE] Prepared parent changed.');
    this.current();
  }
  async checkSource(entry, metadata = true) {
    this.current();
    await this.checkParent(entry.parent < 0 ? this.sourceParent : this.tree.entries[entry.parent].identity);
    if (!sameIdentity(this.sourceIdentity(entry), await captureTreeIdentity(entry.identity.path), metadata)) throw new Error('[STALE_STATE] Prepared source changed; it was not removed.');
  }
  async copyFile(entry, destination, parent) {
    await this.checkSource(entry); await this.checkParent(parent); this.current();
    const source = this.sourceIdentity(entry);
    let target, published;
    this.attempted = true;
    try {
      this.effectPending = true; target = await open(destination, 'wx+', process.platform === 'win32' ? undefined : 0o600); this.effectPending = false; this.changed = true;
      const info = await target.stat({ bigint: true });
      published = { device: String(info.dev), inode: String(info.ino) };
      await this.checkParent(parent);
      const opened = await capturePathIdentity(destination);
      if (!info.isFile() || info.nlink !== 1n || opened.canonical !== resolve(parent.canonical, basename(destination)) || opened.device !== published.device || opened.inode !== published.inode
        || opened.links !== '1') throw new Error('[STALE_STATE] Opened copy target is outside its prepared parent or has another owner.');
      this.current();
      // The exclusive candidate starts private, then receives the prepared
      // access bits through its pinned handle; umask cannot drop executable bits.
      if (process.platform !== 'win32') await target.chmod(Number(source.mode) & 0o777);
      const digest = await writeIdentityTo(source, target, this.current, this.signal);
      await target.sync();
      await this.checkParent(parent);
      const observed = await capturePathIdentity(destination);
      if (observed.device !== published.device || observed.inode !== published.inode || observed.size !== entry.identity.size
        || await hashIdentity(observed, this.current, this.signal) !== digest) throw new Error('[STALE_STATE] Copy destination verification failed; source retained.');
      await this.checkSource(entry); this.current();
      this.sha256 = digest; this.bytes += Number(entry.identity.size);
      return observed;
    } finally { if (target) await target.close(); }
  }
  async moveFile(entry, destination, parent) {
    await this.checkSource(entry); await this.checkParent(parent); this.current();
    if (this.moveByCopy) return this.copyMoveFile(entry, destination, parent);
    const expected = this.sourceIdentity(entry);
    this.attempted = true;
    try { this.effectPending = true; await link(entry.identity.path, destination); this.effectPending = false; this.changed = true; }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      this.attempted = false; this.effectPending = false;
      return this.copyMoveFile(entry, destination, parent);
    }
    await this.checkSource(entry, false); await this.checkParent(parent);
    const source = await capturePathIdentity(entry.identity.path), target = await capturePathIdentity(destination);
    if (source.size !== entry.identity.size || source.mtime !== entry.identity.mtime || target.device !== source.device || target.inode !== source.inode
      || source.links !== (expected.links === '1' ? '2' : String(BigInt(expected.links) + 1n))) throw new Error('[STALE_STATE] Move source or linked destination changed; both names retained.');
    if (!sameIdentity(source, await capturePathIdentity(entry.identity.path))) throw new Error('[STALE_STATE] Linked move source changed at the final deletion boundary; both names retained.');
    this.current(); this.effectPending = true; await unlink(entry.identity.path); this.effectPending = false; this.files++; this.bytes += Number(entry.identity.size);
    if (entry.identity.links !== '1') await this.advanceSource(entry, false);
  }
  async copyMoveFile(entry, destination, parent) {
    const copied = await this.copyFile(entry, destination, parent);
    await this.checkSource(entry); await this.checkParent(parent); this.current();
    if (!sameIdentity(copied, await capturePathIdentity(destination))) throw new Error('[STALE_STATE] Copied destination changed before source deletion; source retained.');
    if (!sameIdentity(this.sourceIdentity(entry), await captureTreeIdentity(entry.identity.path))) throw new Error('[STALE_STATE] Copied source changed at the final deletion boundary; source retained.');
    this.current(); this.effectPending = true; await unlink(entry.identity.path); this.effectPending = false; this.files++;
    if (entry.identity.links !== '1') await this.advanceSource(entry, true);
  }
  async finalizeDirectoryPermissions(index) {
    const entry = this.tree.entries[index], expected = this.created.get(index);
    const parent = entry.parent < 0 ? this.destinationParent : this.created.get(entry.parent);
    await this.checkParent(parent); this.current();
    const handle = await open(expected.path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() || String(info.dev) !== expected.device || String(info.ino) !== expected.inode
        || !sameIdentity(expected, await capturePathIdentity(expected.path), false)) throw new Error('[STALE_STATE] Created directory changed before permission finalization.');
      this.current(); this.effectPending = true; await handle.chmod(Number(entry.identity.mode) & 0o777); this.effectPending = false;
      const observed = await capturePathIdentity(expected.path);
      if (observed.canonical !== expected.canonical || observed.device !== expected.device || observed.inode !== expected.inode
        || !observed.directory || (Number(observed.mode) & 0o777) !== (Number(entry.identity.mode) & 0o777)) throw new Error('[STALE_STATE] Created directory permission verification failed.');
      this.created.set(index, observed);
    } finally { await handle.close(); }
  }
  async execute() {
    const source = this.tree.entries[0].identity;
    try {
      await revalidateTree(this.tree, this.current, this.signal);
      await this.checkParent(this.sourceParent);
      if (this.destination) await this.checkParent(this.destinationParent);
      if (this.operation === 'delete') {
        // Bottom-up nonrecursive removal: runtime additions and links are never followed.
        for (let index = this.tree.entries.length - 1; index >= 0; index--) {
          const entry = this.tree.entries[index];
          await this.checkSource(entry, !entry.identity.directory); this.current(); this.attempted = true;
          this.effectPending = true;
          if (entry.identity.directory) { await rmdir(entry.identity.path); this.directories++; }
          else { await unlink(entry.identity.path); this.files++; if (!entry.identity.symbolicLink) this.bytes += Number(entry.identity.size); }
          this.effectPending = false;
          this.changed = true;
          if (!entry.identity.directory && entry.identity.links !== '1') await this.advanceSource(entry, true);
        }
      } else {
        for (let index = 0; index < this.tree.entries.length; index++) {
          const entry = this.tree.entries[index], destination = index === 0 ? this.destination : resolve(this.destination, relative(source.path, entry.identity.path));
          const parent = entry.parent < 0 ? this.destinationParent : this.created.get(entry.parent);
          await this.checkSource(entry, !entry.identity.directory); await this.checkParent(parent);
          if (entry.identity.directory) {
            // Owner access permits bounded population; group/other permissions
            // never exceed the source. Restore exact access bits bottom-up.
            this.current(); this.attempted = true; this.effectPending = true;
            await mkdir(destination, process.platform === 'win32' ? undefined : { mode: (Number(entry.identity.mode) & 0o777) | 0o700 });
            this.effectPending = false; this.changed = true;
            await this.checkParent(parent);
            const created = await capturePathIdentity(destination);
            if (!created.directory || created.canonical !== resolve(parent.canonical, basename(destination))) throw new Error('[STALE_STATE] Created directory is outside its prepared parent; no children were populated.');
            this.created.set(index, created); this.directories++;
          } else if (this.operation === 'move') await this.moveFile(entry, destination, parent);
          else { await this.copyFile(entry, destination, parent); this.files++; }
        }
        if (process.platform !== 'win32') {
          for (let index = this.tree.entries.length - 1; index >= 0; index--) {
            if (this.tree.entries[index].identity.directory) await this.finalizeDirectoryPermissions(index);
          }
        }
        if (this.operation === 'move' && source.directory) {
          for (let index = this.tree.entries.length - 1; index >= 0; index--) {
            const entry = this.tree.entries[index];
            if (!entry.identity.directory) continue;
            await this.checkSource(entry, false); this.current(); this.attempted = true; this.effectPending = true; await rmdir(entry.identity.path); this.effectPending = false;
          }
        }
        if (this.operation === 'copy') {
          // Copy never changes source directories itself. Detect runtime child
          // additions/removals instead of claiming complete directory coverage.
          for (const entry of this.tree.entries) if (entry.identity.directory) await this.checkSource(entry);
        }
      }
      return this.receipt('succeeded');
    } catch (error) {
      const status = this.effectPending && !knownNoEffectError(error) ? 'state_unknown' : this.changed ? 'partial'
        : this.signal?.aborted ? 'cancelled' : 'failed_no_change';
      return this.receipt(status, boundedReason(error instanceof Error ? error.message : String(error)));
    } finally {
      this.created.clear(); this.groups.clear(); this.authority = undefined; this.signal = undefined; this.tree = undefined;
      this.sourceParent = undefined; this.destinationParent = undefined;
    }
  }
  receipt(status, reason) {
    return { status, stateChanged: status === 'state_unknown' ? 'unknown' : this.changed, requiresVerification: status === 'partial' || status === 'state_unknown' || undefined,
      files: this.files, bytes: this.bytes, directories: this.directories, skippedLinks: this.tree.skippedLinks,
      coverageComplete: this.tree.skippedLinks === 0 && status === 'succeeded', sha256: status === 'succeeded' && !this.tree.entries[0].identity.directory ? this.sha256 : undefined, reason };
  }
}
export async function executeTree(tree, operation, sourceParent, destination, destinationParent, authority, signal, moveByCopy = false) {
  return new TreeExecution(tree, operation, sourceParent, destination, destinationParent, authority, signal, moveByCopy).execute();
}
