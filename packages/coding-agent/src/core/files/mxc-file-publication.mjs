// One controlled publication owner shared by MXC text overwrite and binary copy overwrite.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeIdentityTo } from './file-tree-core.mjs';
import { FILE_STREAM_BUFFER_BYTES } from './file-operation-limits.mjs';

// The publication producer owns the controlled retained-name format as well.
export const MXC_RETAINED_COMMIT_NAME_PATTERN = /^\.superpi-write-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;

function need(value, message) { if (!value) throw new Error(message); }
function sameObject(info, expected) { return info.isFile() && String(info.dev) === String(expected.dev ?? expected.device) && String(info.ino) === String(expected.ino ?? expected.inode); }
function sameVersion(before, current) { return sameObject(current, before) && current.size === before.size && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs && current.mode === before.mode && current.nlink === before.nlink; }
function hashOpened(fd, size, io = fs) {
  need(Number.isSafeInteger(size) && size >= 0, 'Unsupported file size');
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(FILE_STREAM_BUFFER_BYTES); let position = 0;
  while (position <= size) {
    const count = io.readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - position), position);
    if (!count) break;
    need(position + count <= size, 'Published file grew during verification');
    digest.update(count === buffer.length ? buffer : buffer.subarray(0, count)); position += count;
  }
  need(position === size, 'Published file shrank during verification'); return digest.digest('hex');
}
export function publishedDigest(target, identity, expected, size, io = fs) {
  const fd = io.openSync(target, 'r');
  try {
    const before = io.fstatSync(fd, { bigint: true });
    need(sameObject(before, identity) && before.size === BigInt(size), 'Published file identity changed; verify current state');
    const actual = hashOpened(fd, size, io), after = io.fstatSync(fd, { bigint: true }), named = io.lstatSync(target, { bigint: true });
    need(sameVersion(before, after) && sameVersion(before, named) && actual === expected, 'Published file changed; verify current state');
    return expected;
  } finally { io.closeSync(fd); }
}

class SyncTarget {
  constructor(fd, io) { this.fd = fd; this.io = io; }
  write(buffer, offset, length, position) { return { bytesWritten: this.io.writeSync(this.fd, buffer, offset, length, position) }; }
}

/** Per-file I/O setup owns both handles and one candidate; never reused after return or failure. */
export class MxcFilePublication {
  constructor(target, fd, before, previousSha256, expectedParent, io = fs) {
    this.io = io;
    this.target = target; this.sourceFd = fd; this.before = before; this.previousSha256 = previousSha256;
    this.parentPath = path.dirname(target); this.parentCanonical = expectedParent?.canonical ?? io.realpathSync(this.parentPath);
    this.parent = expectedParent ?? io.lstatSync(this.parentCanonical, { bigint: true });
    this.temporary = undefined; this.candidateFd = undefined; this.candidate = undefined;
    this.requiresVerification = false; this.outcome = 'not_committed'; this.closed = false; this.disposed = false;
  }
  assertParent() {
    const info = this.io.lstatSync(this.parentPath, { bigint: true });
    need(info.isDirectory() && this.io.realpathSync(this.parentPath) === this.parentCanonical
      && String(info.dev) === String(this.parent.dev ?? this.parent.device) && String(info.ino) === String(this.parent.ino ?? this.parent.inode), 'Prepared parent directory changed');
  }
  assertOriginal() {
    this.assertParent();
    const opened = this.io.fstatSync(this.sourceFd, { bigint: true }), named = this.io.lstatSync(this.target, { bigint: true });
    need(sameVersion(this.before, opened) && sameVersion(this.before, named) && hashOpened(this.sourceFd, Number(this.before.size), this.io) === this.previousSha256, 'File changed before write');
  }
  stage() {
    need(!this.closed && this.temporary === undefined, 'Publication owner was already consumed'); this.assertOriginal();
    const candidate = path.join(this.parentCanonical, '.superpi-write-' + randomUUID() + '.tmp');
    this.candidateFd = this.io.openSync(candidate, 'wx+', 0o600); this.temporary = candidate;
    this.candidate = this.io.fstatSync(this.candidateFd, { bigint: true });
    need(this.candidate.isFile() && this.candidate.nlink === 1n, 'Candidate identity unavailable');
    this.assertParent();
    const named = this.io.lstatSync(candidate, { bigint: true });
    need(sameVersion(this.candidate, named) && !named.isSymbolicLink() && this.io.realpathSync(candidate) === candidate, 'Opened candidate name or identity changed before writing');
  }
  finalize(expected, size) {
    this.io.fsyncSync(this.candidateFd); this.assertOriginal();
    need(hashOpened(this.candidateFd, size, this.io) === expected, 'Staged candidate bytes changed');
    const named = this.io.lstatSync(this.temporary, { bigint: true });
    need(sameVersion(this.candidate, named) && named.nlink === 1n && this.io.realpathSync(this.temporary) === this.temporary, 'Staged candidate identity changed');
    this.io.fchmodSync(this.candidateFd, Number(this.before.mode & 0o777n)); this.io.fsyncSync(this.candidateFd);
    this.io.closeSync(this.candidateFd); this.candidateFd = undefined;
    this.io.closeSync(this.sourceFd); this.sourceFd = undefined;
    // Final identity/content validation is synchronous and immediately precedes the replace.
    this.assertParent();
    const target = this.io.lstatSync(this.target, { bigint: true }); need(sameVersion(this.before, target), 'File changed before publication');
    this.requiresVerification = true; this.outcome = 'unknown';
    this.io.renameSync(this.temporary, this.target); this.temporary = undefined; this.outcome = 'committed';
    const result = publishedDigest(this.target, this.candidate, expected, size, this.io); this.requiresVerification = false; this.closed = true; return result;
  }
  commitText(text) {
    this.stage(); this.io.writeFileSync(this.candidateFd, text);
    // Record the original handle identity after writing; version changes on our candidate are expected.
    this.candidate = this.io.fstatSync(this.candidateFd, { bigint: true });
    return this.finalize(createHash('sha256').update(text).digest('hex'), Buffer.byteLength(text));
  }
  async commitCopy(source, expectedHash, authority, signal) {
    this.stage();
    const actual = await writeIdentityTo(source, new SyncTarget(this.candidateFd, this.io), authority, signal);
    need(actual === expectedHash, 'Copy source digest changed after preparation');
    const named = this.io.lstatSync(source.path, { bigint: true });
    need(sameObject(named, source) && String(named.size) === source.size && String(named.mtimeNs) === source.mtime && String(named.ctimeNs) === source.ctime, 'Copy source changed before publication');
    signal?.throwIfAborted(); authority?.();
    this.candidate = this.io.fstatSync(this.candidateFd, { bigint: true }); return this.finalize(actual, Number(source.size));
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.closed = true; let failure;
    if (this.candidateFd !== undefined) { const fd = this.candidateFd; this.candidateFd = undefined; try { this.io.closeSync(fd); } catch (error) { failure = error; } }
    if (this.sourceFd !== undefined) { const fd = this.sourceFd; this.sourceFd = undefined; try { this.io.closeSync(fd); } catch (error) { failure ??= error; } }
    if (this.temporary) {
      try {
        const info = this.io.lstatSync(this.temporary, { bigint: true });
        need(this.candidate && sameObject(info, this.candidate) && info.nlink === 1n && !info.isSymbolicLink() && this.io.realpathSync(this.temporary) === this.temporary, 'Candidate ownership changed; retained for verification');
        this.io.unlinkSync(this.temporary); this.temporary = undefined;
      } catch (error) { this.requiresVerification = true; failure ??= error; }
    }
    this.before = undefined; this.parent = undefined; this.candidate = undefined; this.io = undefined;
    if (failure) throw failure;
  }
  get retainedTemporary() { return this.temporary; }
  get diagnostics() { return { sourceHandleRetained: this.sourceFd !== undefined, candidateHandleRetained: this.candidateFd !== undefined,
    metadataRetained: this.before !== undefined || this.parent !== undefined || this.candidate !== undefined, ioRetained: this.io !== undefined }; }
}
