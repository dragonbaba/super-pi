// Temporary control artifacts only, inside the preassigned MXC exchange directory.
import { lstat, realpath, open, unlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { FILE_MANIFEST_RECORD_BYTES, FILE_STREAM_BUFFER_BYTES } from './file-operation-limits.mjs';

const ARTIFACT_NAME = /^[a-f0-9]{32}-[0-9]{1,16}\.manifest$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UNSIGNED = /^[0-9]{1,32}$/;
const KEYS = new Set(['name', 'bytes', 'sha256', 'device', 'inode', 'records']);
function need(value, message) { if (!value) throw new Error('[FILE_MANIFEST_INVALID] ' + message); }
function current(authority, signal) { signal?.throwIfAborted(); authority?.(); }
function sameObject(info, expected) { return info.isFile() && String(info.dev) === expected.device && String(info.ino) === expected.inode && info.nlink === 1n; }
async function ownedPath(exchange, name) {
  need(ARTIFACT_NAME.test(name), 'Artifact name was not assigned by the host');
  need(await realpath(exchange) === exchange && !(await lstat(exchange)).isSymbolicLink(), 'Exchange directory changed');
  return join(exchange, name);
}
export function validateManifestArtifact(raw, assignedName) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid artifact descriptor');
  const keys = Object.keys(raw); need(keys.length === KEYS.size, 'Missing artifact descriptor field');
  for (const key of keys) need(KEYS.has(key), 'Unexpected artifact descriptor field');
  need(raw.name === assignedName && ARTIFACT_NAME.test(raw.name) && Number.isSafeInteger(raw.bytes) && raw.bytes > 0
    && Number.isSafeInteger(raw.records) && raw.records > 0 && typeof raw.sha256 === 'string' && DIGEST.test(raw.sha256)
    && typeof raw.device === 'string' && UNSIGNED.test(raw.device) && typeof raw.inode === 'string' && UNSIGNED.test(raw.inode), 'Artifact identity/size/digest mismatch');
  return raw;
}
export async function createOwnedManifestFile(exchange, name) {
  const path = await ownedPath(exchange, name), handle = await open(path, 'wx', 0o600);
  try {
    const info = await handle.stat({ bigint: true });
    need(info.isFile() && info.nlink === 1n && info.size === 0n, 'Assigned artifact is not an empty exclusive file');
    return Object.freeze({ name, device: String(info.dev), inode: String(info.ino) });
  } finally { await handle.close(); }
}
export async function releaseOwnedManifestFile(exchange, owned) {
  need(owned && typeof owned.device === 'string' && UNSIGNED.test(owned.device)
    && typeof owned.inode === 'string' && UNSIGNED.test(owned.inode), 'Unknown assigned artifact identity');
  const path = await ownedPath(exchange, owned.name), info = await lstat(path, { bigint: true });
  need(sameObject(info, owned) && !info.isSymbolicLink() && await realpath(path) === path, 'Assigned artifact ownership changed; retained');
  await unlink(path);
}

/** One asynchronous preparation owns a private file; no whole-manifest string or per-row closure. */
export class ManifestArtifactWriter {
  static async attach(exchange, owned, authority, signal) {
    current(authority, signal);
    need(owned && typeof owned.device === 'string' && UNSIGNED.test(owned.device)
      && typeof owned.inode === 'string' && UNSIGNED.test(owned.inode), 'Missing host-assigned artifact identity');
    const path = await ownedPath(exchange, owned.name), handle = await open(path, 'r+');
    try {
      const info = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      need(sameObject(info, owned) && sameObject(named, owned) && info.size === 0n && named.size === 0n
        && !named.isSymbolicLink() && await realpath(path) === path, 'Host-assigned artifact changed or was already consumed');
      return new ManifestArtifactWriter(path, owned.name, handle, owned.device, owned.inode, authority, signal, false);
    } catch (error) { await handle.close(); throw error; }
  }
  static async create(exchange, assignedName, authority, signal) {
    current(authority, signal);
    const path = await ownedPath(exchange, assignedName), handle = await open(path, 'wx', 0o600);
    try {
      const info = await handle.stat({ bigint: true });
      need(info.isFile() && info.nlink === 1n, 'Created artifact is not an exclusive ordinary file');
      return new ManifestArtifactWriter(path, assignedName, handle, String(info.dev), String(info.ino), authority, signal);
    } catch (error) { await handle.close(); throw error; }
  }
  constructor(path, name, handle, device, inode, authority, signal, ownsArtifact = true) {
    this.path = path; this.name = name; this.handle = handle; this.device = device; this.inode = inode;
    this.authority = authority; this.signal = signal; this.hash = createHash('sha256'); this.bytes = 0; this.records = 0;
    this.finishing = undefined; this.disposal = undefined; this.closed = false; this.poisoned = false; this.published = false;
    this.ownsArtifact = ownsArtifact;
  }
  append(record) {
    need(this.handle && this.hash && !this.closed && !this.poisoned, 'Artifact writer is closed or failed');
    try {
      current(this.authority, this.signal);
      const serialized = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(serialized);
      need(bytes <= FILE_MANIFEST_RECORD_BYTES, 'Prepared metadata row exceeds its transportable record budget');
      writeFileSync(this.handle.fd, serialized); this.hash.update(serialized); this.bytes += bytes; this.records++;
      current(this.authority, this.signal);
    } catch (error) { this.poisoned = true; throw error; }
  }
  finish() {
    need(this.handle && this.hash && this.records > 0 && !this.closed && !this.poisoned, 'Artifact writer is incomplete or failed');
    this.closed = true; return this.finishing = this.publish();
  }
  async publish() {
    try {
      current(this.authority, this.signal); await this.handle.sync();
      const info = await this.handle.stat({ bigint: true });
      need(sameObject(info, this) && info.size === BigInt(this.bytes), 'Prepared artifact changed before close');
      current(this.authority, this.signal); await this.handle.close(); this.handle = undefined;
      current(this.authority, this.signal);
      const descriptor = { name: this.name, bytes: this.bytes, sha256: this.hash.digest('hex'), device: this.device, inode: this.inode, records: this.records };
      this.hash = undefined; this.authority = undefined; this.signal = undefined; this.published = true;
      return Object.freeze(descriptor);
    } catch (error) { this.poisoned = true; throw error; }
  }
  dispose() { this.closed = true; return this.disposal ??= this.remove(); }
  async remove() {
    try { await this.finishing; } catch { /* Original finish caller receives the failure. */ }
    const handle = this.handle; this.handle = undefined; this.hash = undefined; this.authority = undefined; this.signal = undefined;
    if (this.published) return;
    try { if (handle) await handle.close(); }
    finally {
      if (this.ownsArtifact) {
        const info = await lstat(this.path, { bigint: true });
        need(sameObject(info, this) && !info.isSymbolicLink() && await realpath(this.path) === this.path, 'Incomplete artifact ownership changed; retained');
        await unlink(this.path);
      }
    }
  }
  get diagnostics() { return { handleRetained: this.handle !== undefined, hashRetained: this.hash !== undefined,
    authorityRetained: this.authority !== undefined, published: this.published, closed: this.closed }; }
}

/** Stage bounded rows incrementally; the visitor must never execute effects before final digest/identity acceptance. */
export async function visitManifestArtifact(exchange, assignedName, descriptor, visitor, authority, signal) {
  validateManifestArtifact(descriptor, assignedName); current(authority, signal);
  const path = await ownedPath(exchange, assignedName), named = await lstat(path, { bigint: true });
  need(sameObject(named, descriptor) && !named.isSymbolicLink() && named.size === BigInt(descriptor.bytes) && await realpath(path) === path, 'Artifact path/identity changed');
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true }); need(sameObject(before, descriptor) && before.size === named.size, 'Artifact changed before read');
    const decoder = new StringDecoder('utf8'), buffer = Buffer.allocUnsafe(FILE_STREAM_BUFFER_BYTES), hash = createHash('sha256');
    let carry = '', bytes = 0, records = 0;
    for (;;) {
      current(authority, signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, descriptor.bytes + 1 - bytes), null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; need(bytes <= descriptor.bytes, 'Artifact grew during read');
      const chunk = read.bytesRead === buffer.length ? buffer : buffer.subarray(0, read.bytesRead); hash.update(chunk);
      const text = carry + decoder.write(chunk); let start = 0;
      for (;;) {
        const end = text.indexOf('\n', start); if (end < 0) break;
        const row = text.slice(start, end); need(Buffer.byteLength(row) + 1 <= FILE_MANIFEST_RECORD_BYTES, 'Oversized manifest row');
        current(authority, signal); visitor.onManifestRecord(JSON.parse(row), records++); start = end + 1;
      }
      carry = text.slice(start); need(Buffer.byteLength(carry) < FILE_MANIFEST_RECORD_BYTES, 'Unterminated oversized manifest row');
    }
    carry += decoder.end();
    need(!carry && bytes === descriptor.bytes && records === descriptor.records && hash.digest('hex') === descriptor.sha256, 'Artifact bytes/records/digest do not match preparation');
    const after = await handle.stat({ bigint: true }), final = await lstat(path, { bigint: true });
    need(sameObject(after, descriptor) && sameObject(final, descriptor) && final.size === before.size && after.size === before.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.mtimeNs === final.mtimeNs && before.ctimeNs === final.ctimeNs, 'Artifact changed during read');
    current(authority, signal);
    return records;
  } finally { await handle.close(); }
}

export async function releaseManifestArtifact(exchange, assignedName, descriptor) {
  validateManifestArtifact(descriptor, assignedName);
  const path = await ownedPath(exchange, assignedName), info = await lstat(path, { bigint: true });
  need(sameObject(info, descriptor) && !info.isSymbolicLink() && await realpath(path) === path, 'Artifact ownership changed; retained');
  await unlink(path);
}
