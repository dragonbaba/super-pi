// Controlled file-tool entry inside MXC; no shell parser or host fallback.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from './image-signature.mjs';

const FILE_LIMIT = 2 * 1024 * 1024, IMAGE_LIMIT = 16 * 1024 * 1024;
const SEARCH_ROWS = 200, SEARCH_ENTRIES = 20000, TEXT_LIMIT = 32768;
const DIRECTORY_ENTRIES = Object.freeze({ withFileTypes: true });
const PROTECTED_NAMES = new Set(['.git', '.sp']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function need(value, message) { if (!value) throw new Error(message); }
function local(root, name, mutation = false) {
  need(typeof name === 'string' && name.length > 0 && name.length < 4096 && !name.includes('\0'), 'Invalid workspace path');
  const target = path.resolve(root, name), relative = path.relative(root, target);
  need(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Workspace escape');
  if (mutation) need(relative && !relative.split(path.sep).some(part => PROTECTED_NAMES.has(part.toLowerCase())), 'Protected workspace path');
  return target;
}
function read(file, limit = FILE_LIMIT) {
  const fd = fs.openSync(file, 'r');
  try { return readHandle(fd, limit); } finally { fs.closeSync(fd); }
}
function readHandle(fd, limit) {
  const stat = fs.fstatSync(fd, { bigint: true });
  need(stat.isFile() && stat.size <= BigInt(limit), 'File exceeds read capacity or is not ordinary');
  const bytes = Buffer.allocUnsafe(Number(stat.size)); let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    need(count > 0, 'File changed during read'); offset += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  need(stat.size === after.size && stat.mtimeNs === after.mtimeNs && stat.ctimeNs === after.ctimeNs, 'File changed during read');
  return bytes;
}
function grepRows(source, pattern, name, rows) {
  let match = source.indexOf(pattern), start = 0, line = 1;
  while (match >= 0 && start < source.length) {
    const next = source.indexOf('\n', start), end = next < 0 ? source.length : next;
    if (match >= start && match < end) {
      if (rows.length === SEARCH_ROWS) return true;
      rows.push(name + ':' + line + ':' + source.slice(start, Math.min(end, start + 256)));
    }
    start = end + 1; line++;
    if (match < start) match = source.indexOf(pattern, start);
  }
  return false;
}
function search(root, operation, scope, pattern) {
  if (operation === 'grep') need(typeof pattern === 'string' && pattern.length > 0, 'Literal search pattern required');
  const pending = [scope], rows = []; let visited = 0, truncated = false;
  try {
    while (pending.length && !truncated) {
      const name = pending.pop(), file = local(root, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue; // Do not traverse cycles or implicit search roots.
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(file, DIRECTORY_ENTRIES)) {
          if (PROTECTED_NAMES.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
          if (++visited > SEARCH_ENTRIES) { truncated = true; break; }
          const child = name === '.' ? entry.name : path.join(name, entry.name);
          if (operation === 'ls') {
            if (rows.length === SEARCH_ROWS) { truncated = true; break; }
            rows.push(child + (entry.isDirectory() ? '/' : ''));
          } else pending.push(child);
        }
      } else if (stat.isFile()) {
        if (operation === 'find' && pattern && !name.includes(pattern)) continue;
        if (operation === 'grep') {
          if (stat.size > FILE_LIMIT) continue;
          const bytes = read(file); if (!isUtf8(bytes) || bytes.includes(0)) continue;
          truncated = grepRows(bytes.toString('utf8'), pattern, name, rows);
        } else if (rows.length === SEARCH_ROWS) truncated = true;
        else rows.push(name);
      }
    }
    return (rows.join('\n') || '(no matches)') + (truncated ? '\n[Results truncated; narrow the search scope.]' : '');
  } finally { pending.length = 0; rows.length = 0; }
}
function mutate(root, operation, input, maxWriteBytes) {
  const target = local(root, input.path, true);
  if (operation === 'delete') { need(fs.lstatSync(target).isFile(), 'Only files may be deleted'); fs.unlinkSync(target); return; }
  if (operation === 'move') {
    const destination = local(root, input.destination, true);
    need(fs.lstatSync(target).isFile(), 'Only files may be moved');
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.linkSync(target, destination); fs.unlinkSync(target); return;
  }
  need(operation === 'write' || operation === 'edit', 'Unsupported file operation');
  if (operation === 'write' && !fs.existsSync(target)) {
    need(input.snapshot == null && typeof input.content === 'string' && Buffer.byteLength(input.content) <= maxWriteBytes, 'Invalid new-file write');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, input.content, { flag: 'wx' }); return;
  }
  // Read a pinned version, then replace atomically; a failed temporary write leaves the original intact.
  let fd = fs.openSync(target, 'r'), temporary;
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(before.isFile() && before.size <= BigInt(FILE_LIMIT), 'File exceeds text capacity');
    const bytes = readHandle(fd, FILE_LIMIT);
    need(input.snapshot === hash(bytes), 'Read snapshot required or changed. Read again and reconcile before retry.');
    let text = input.content;
    if (operation === 'edit') {
      need(isUtf8(bytes), 'File is not UTF-8 text'); text = bytes.toString('utf8');
      need(Array.isArray(input.edits) && input.edits.length > 0 && input.edits.length <= 20, 'Invalid edit list');
      for (const edit of input.edits) {
        need(typeof edit.oldText === 'string' && edit.oldText.length && typeof edit.newText === 'string', 'Exact text edits required');
        const at = text.indexOf(edit.oldText); need(at >= 0 && text.indexOf(edit.oldText, at + 1) < 0, 'Edit target missing or ambiguous');
        text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
      }
    }
    need(typeof text === 'string' && Buffer.byteLength(text) <= maxWriteBytes, 'Write exceeds the native write limit');
    const candidate = path.join(path.dirname(target), '.superpi-write-' + randomUUID() + '.tmp');
    const temporaryFd = fs.openSync(candidate, 'wx'); temporary = candidate;
    try { fs.writeFileSync(temporaryFd, text); } finally { fs.closeSync(temporaryFd); }
    const current = fs.fstatSync(fd, { bigint: true });
    // Windows cannot replace the destination while this read handle is open.
    fs.closeSync(fd); fd = undefined;
    const named = fs.statSync(target, { bigint: true });
    need(before.dev === named.dev && before.ino === named.ino && before.size === current.size
      && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs && before.size === named.size
      && before.mtimeNs === named.mtimeNs && before.ctimeNs === named.ctimeNs, 'File changed before write');
    fs.renameSync(temporary, target); temporary = undefined;
  } finally { if (fd !== undefined) fs.closeSync(fd); if (temporary) fs.unlinkSync(temporary); }
}
let request, phase = 'request';
try {
  const requestFile = process.argv[2]; need(fs.statSync(requestFile).size <= 4 * 1024 * 1024, 'Request too large');
  request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  const roots = request.workspaces, input = request.input, operation = request.operation;
  need(Array.isArray(roots) && roots.length > 0 && roots.length <= 17, 'Invalid workspace table');
  const root = roots[input.workspaceIndex ?? 0]; need(typeof root === 'string', 'Unknown workspace');
  let text, snapshot, image;
  if (operation === 'read') {
    phase = 'read'; const file = local(root, input.path), stat = fs.statSync(file);
    need(stat.isFile(), 'Read requires an ordinary file');
    const header = Buffer.allocUnsafe(Math.min(stat.size, IMAGE_TYPE_SNIFF_BYTES)), fd = fs.openSync(file, 'r');
    let count; try { count = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const mimeType = detectSupportedImageMimeType(header.subarray(0, count));
    if (mimeType) {
      need(stat.size <= IMAGE_LIMIT, 'Image exceeds 16 MiB; resize it before read');
      const bytes = read(file, IMAGE_LIMIT); snapshot = hash(bytes);
      const artifact = { name: request.id + '-0.bin', bytes: bytes.length, sha256: snapshot };
      fs.writeFileSync(path.join(request.exchange, artifact.name), bytes, { flag: 'wx' });
      image = { mimeType, artifact }; text = 'Read image file [' + mimeType + ']';
    } else {
      const bytes = read(file); snapshot = hash(bytes);
      need(isUtf8(bytes) && !bytes.includes(0), 'Unsupported binary file; read supports UTF-8 text and common image formats');
      const source = bytes.toString('utf8'), offset = Math.max(0, (input.offset ?? 1) - 1), count = Math.min(2000, input.limit ?? 2000);
      let start = 0, end = 0;
      for (let line = 0; line < offset; line++) { const next = source.indexOf('\n', start); if (next < 0) { start = source.length; break; } start = next + 1; }
      end = start;
      for (let line = 0; line < count && end < source.length && end - start < TEXT_LIMIT; line++) { const next = source.indexOf('\n', end); end = next < 0 ? source.length : next + 1; }
      text = source.slice(start, Math.min(end, start + TEXT_LIMIT)) + '\n[Snapshot: ' + snapshot + ']';
    }
  } else if (operation === 'ls' || operation === 'find' || operation === 'grep') {
    phase = 'read'; text = search(root, operation, input.path || '.', input.pattern);
  } else {
    need(request.mode === 'sandbox-write', 'Read-only workspace'); phase = 'mutation';
    if (operation === 'file_batch') {
      need(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 16, 'Invalid batch');
      for (const item of input.operations) mutate(roots[item.workspaceIndex ?? 0], item.operation, item, request.maxWriteBytes);
    } else mutate(root, operation, input, request.maxWriteBytes);
    text = 'Workspace operation completed';
  }
  console.log(JSON.stringify({ id: request.id, ok: true, text, snapshot, image }));
} catch (error) {
  console.log(JSON.stringify({ id: request?.id, ok: false, phase, noEffects: phase !== 'mutation', error: String(error.message).slice(0, 32768) }));
  process.exitCode = 1;
}
