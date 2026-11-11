// Controlled file-tool entry inside MXC; no shell parser or host fallback.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from './image-signature.mjs';
import { FILE_LIMIT, IMAGE_LIMIT, SEARCH_ROWS, SEARCH_ENTRIES, TEXT_LIMIT, SEARCH_EXCERPT, SEARCH_CLIPPED_MARK, DIRECTORY_READ_BUFFER,
  normalizeReadOffset, normalizeReadLimit } from './mxc-file-limits.mjs';

const DIRECTORY_OPTIONS = Object.freeze({ bufferSize: DIRECTORY_READ_BUFFER });
const PROTECTED_NAMES = new Set(['.git', '.sp']);
const VERIFY_BYTES = 64 * 1024;
let unverifiedPublication = false;
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
// At most six JSON bytes per UTF-16 code unit, leaving ample envelope space
// in the 256 KiB protocol. Count paths, content and separators before retaining.
function safeTextEnd(source, end) {
  if (end > 0 && end < source.length && source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff
    && source.charCodeAt(end) >= 0xdc00 && source.charCodeAt(end) <= 0xdfff) return end - 1;
  return end;
}
function stopSearch(state, reason, omitted) {
  state.scanComplete = false; state.coverageComplete = false;
  state.stopReason = reason; state.outputTruncated = omitted;
}
function appendSearchRow(rows, row, state) {
  if (rows.length === SEARCH_ROWS) { stopSearch(state, 'row-limit', true); return false; }
  if (row.length + 1 > TEXT_LIMIT - state.outputUnits) { stopSearch(state, 'text-limit', true); return false; }
  rows.push(row); state.returnedRecords++; state.outputUnits += row.length + 1; return true;
}
function grepRows(source, pattern, name, rows, state) {
  let match = source.indexOf(pattern), start = 0, line = 1;
  const mode = state.outputMode;
  if (mode === 'files') {
    // Full-file eligibility is already checked. A match starting at LF
    // has no corresponding row in the legacy content scan.
    if (match >= 0 && source.charCodeAt(match) !== 10) {
      state.observedRecords++; appendSearchRow(rows, name, state);
    }
    return;
  }
  let matchedLines = 0;
  while (match >= 0 && start < source.length) {
    const next = source.indexOf('\n', start), end = next < 0 ? source.length : next;
    if (match >= start && match < end) {
      if (mode === 'count') matchedLines++;
      else {
        state.observedRecords++;
        if (rows.length === SEARCH_ROWS) { stopSearch(state, 'row-limit', true); return; }
        const clipped = end - start > SEARCH_EXCERPT;
        const excerptEnd = clipped ? safeTextEnd(source, start + SEARCH_EXCERPT - SEARCH_CLIPPED_MARK.length) : end;
        if (!appendSearchRow(rows, name + ':' + line + ':' + source.slice(start, excerptEnd)
          + (clipped ? SEARCH_CLIPPED_MARK : ''), state)) return;
        if (clipped) state.excerptTruncated = true;
      }
    }
    start = end + 1; line++;
    if (match < start) match = source.indexOf(pattern, start);
  }
  if (mode === 'count' && matchedLines > 0) { state.observedRecords++; appendSearchRow(rows, name + ':' + matchedLines, state); }
}
function searchFacts(operation, outputMode = operation === 'grep' ? 'content' : 'files') {
  return { version: 1, operation, outputMode, scanComplete: true,
    coverageComplete: true, outputTruncated: false, excerptTruncated: false, stopReason: 'none',
    visitedEntries: 0, scannedFiles: 0, observedRecords: 0, returnedRecords: 0, outputUnits: 0,
    skippedTooLarge: 0, skippedNonUtf8: 0, skippedNul: 0, excludedProtected: 0, excludedLinks: 0 };
}
function search(root, operation, scope, pattern, outputMode) {
  if (operation === 'grep') {
    need(typeof pattern === 'string' && pattern.length > 0, 'Literal search pattern required');
    need(outputMode === undefined || outputMode === 'content' || outputMode === 'files' || outputMode === 'count', 'Unknown grep outputMode');
  }
  // One call-owned record. Pending and output arrays are cleared on every exit.
  const state = searchFacts(operation, operation === 'grep' ? outputMode : 'files');
  const pending = [scope], rows = [];
  try {
    while (pending.length && state.scanComplete) {
      const name = pending.pop(), file = local(root, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { state.excludedLinks++; continue; }
      if (stat.isDirectory()) {
        // The native iterator owns at most one fixed batch, even for a huge directory.
        const directory = fs.opendirSync(file, DIRECTORY_OPTIONS);
        try {
          let entry;
          while ((entry = directory.readSync()) !== null) {
            if (PROTECTED_NAMES.has(entry.name.toLowerCase())) { state.excludedProtected++; continue; }
            if (entry.isSymbolicLink()) { state.excludedLinks++; continue; }
            if (state.visitedEntries === SEARCH_ENTRIES) { stopSearch(state, 'entry-limit', false); break; }
            state.visitedEntries++;
            const child = name === '.' ? entry.name : path.join(name, entry.name);
            if (operation === 'ls') {
              state.observedRecords++;
              if (!appendSearchRow(rows, child + (entry.isDirectory() ? '/' : ''), state)) break;
            } else pending.push(child);
          }
        } finally { directory.closeSync(); }
      } else if (stat.isFile()) {
        if (operation === 'find' && pattern && !name.includes(pattern)) continue;
        if (operation === 'grep') {
          state.scannedFiles++;
          if (stat.size > FILE_LIMIT) { state.skippedTooLarge++; state.coverageComplete = false; continue; }
          const bytes = read(file);
          if (!isUtf8(bytes)) { state.skippedNonUtf8++; state.coverageComplete = false; continue; }
          if (bytes.includes(0)) { state.skippedNul++; state.coverageComplete = false; continue; }
          grepRows(bytes.toString('utf8'), pattern, name, rows, state);
        } else { state.observedRecords++; appendSearchRow(rows, name, state); }
      }
    }
    const skippedFiles = state.skippedTooLarge + state.skippedNonUtf8 + state.skippedNul;
    const summary = !state.coverageComplete || state.excerptTruncated
      ? '[Search status: scanComplete=' + state.scanComplete + '; coverageComplete=' + state.coverageComplete
        + '; outputTruncated=' + state.outputTruncated + '; excerptTruncated=' + state.excerptTruncated
        + '; stop=' + state.stopReason + '; observedRecords=' + state.observedRecords + '; returnedRecords=' + state.returnedRecords
        + '; skippedTooLarge=' + state.skippedTooLarge + '; skippedNonUtf8=' + state.skippedNonUtf8 + '; skippedNul=' + state.skippedNul
         + (!state.coverageComplete ? '. Unchecked content remains.' : '')
         + (!state.scanComplete ? ' Narrow the search scope to continue.' : '')
         + (skippedFiles ? ' Inspect known skipped paths with a reader suited to their size or encoding.' : '')
         + (state.outputTruncated ? ' Results truncated.' : '')
         + (state.excerptTruncated ? SEARCH_CLIPPED_MARK + ' marks a clipped line prefix; the match may follow it.' : '') + ']\n' : '';
    return { text: summary + (rows.join('\n') || (state.coverageComplete ? '(no matches)' : '(no matches in scanned content; unchecked content remains)')), search: state };
  } finally { pending.length = 0; rows.length = 0; }
}
function readWindow(source, input, reply) {
  const offset = normalizeReadOffset(input.offset), limit = normalizeReadLimit(input.limit);
  let start = 0;
  for (let line = 1; line < offset && start < source.length; line++) {
    const next = source.indexOf('\n', start); start = next < 0 ? source.length : next + 1;
  }
  let end = start, nextUnread = start, returnedLines = 0, lineTruncated = false;
  while (returnedLines < limit && end < source.length) {
    const next = source.indexOf('\n', end), boundary = next < 0 ? source.length : next + 1;
    if (boundary - start > TEXT_LIMIT) {
      const clipped = safeTextEnd(source, start + TEXT_LIMIT);
      // If only the line terminator falls outside the budget, the body can
      // safely resume at the following physical line. Keep CRLF together.
      const contentEnd = next < 0 ? boundary : next - Number(next > end && source.charCodeAt(next - 1) === 13);
      if (clipped > end && clipped >= contentEnd) {
        end = contentEnd; nextUnread = boundary; returnedLines++;
      } else {
        lineTruncated = clipped > end; end = nextUnread = clipped;
      }
      break;
    }
    end = nextUnread = boundary; returnedLines++;
  }
  const hasMore = nextUnread < source.length, windowComplete = !lineTruncated && (returnedLines === limit || !hasMore);
  const nextOffset = hasMore && !lineTruncated && returnedLines > 0 ? offset + returnedLines : undefined;
  reply.read = { version: 1, offset, limit, windowComplete, hasMore, lineTruncated, returnedLines,
    incompleteLine: lineTruncated ? offset + returnedLines : undefined, nextOffset };
  reply.text = (lineTruncated ? '[Read window incomplete: line ' + (offset + returnedLines)
    + ' was truncated at the UTF-16 output budget; its suffix is unavailable through line offsets. No safe nextOffset.]\n'
    : hasMore ? '[Read window ' + (windowComplete ? 'complete' : 'incomplete') + '; more lines available'
      + (nextOffset === undefined ? '' : '; nextOffset=' + nextOffset) + '.]\n' : '')
    + source.slice(start, end) + '\n[Snapshot: ' + reply.snapshot + ']';
}
function publishedSnapshot(target, identity, text) {
  const expected = hash(text), size = Buffer.byteLength(text), fd = fs.openSync(target, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(before.isFile() && before.dev === identity.dev && before.ino === identity.ino && before.size === BigInt(size), 'Published file identity changed; verify current state');
    const bytes = Buffer.allocUnsafe(Math.min(VERIFY_BYTES, Math.max(1, size))), actual = createHash('sha256');
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
      need(count > 0, 'Published file changed during verification');
      actual.update(count === bytes.length ? bytes : bytes.subarray(0, count)); offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(target, { bigint: true });
    need(named.isFile() && before.dev === named.dev && before.ino === named.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.size === named.size
      && before.mtimeNs === named.mtimeNs && before.ctimeNs === named.ctimeNs && actual.digest('hex') === expected,
      'Published file changed; verify current state');
    return expected;
  } finally { fs.closeSync(fd); }
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
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, 'wx'); let identity;
    try { fs.writeFileSync(fd, input.content); identity = fs.fstatSync(fd, { bigint: true }); } finally { fs.closeSync(fd); }
    return verifiedPublication(target, identity, input.content);
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
    let publication;
    try { fs.writeFileSync(temporaryFd, text); publication = fs.fstatSync(temporaryFd, { bigint: true }); } finally { fs.closeSync(temporaryFd); }
    const current = fs.fstatSync(fd, { bigint: true });
    // Windows cannot replace the destination while this read handle is open.
    fs.closeSync(fd); fd = undefined;
    const named = fs.statSync(target, { bigint: true });
    need(before.dev === named.dev && before.ino === named.ino && before.size === current.size
      && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs && before.size === named.size
      && before.mtimeNs === named.mtimeNs && before.ctimeNs === named.ctimeNs, 'File changed before write');
    fs.renameSync(temporary, target); temporary = undefined;
    return verifiedPublication(target, publication, text);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (temporary) fs.unlinkSync(temporary); }
}
function verifiedPublication(target, identity, text) {
  unverifiedPublication = true;
  const snapshot = publishedSnapshot(target, identity, text);
  unverifiedPublication = false;
  return snapshot;
}
let request, items, phase = 'request';
try {
  const requestFile = process.argv[2]; need(fs.statSync(requestFile).size <= 4 * 1024 * 1024, 'Request too large');
  request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  const roots = request.workspaces, input = request.input, operation = request.operation;
  need(Array.isArray(roots) && roots.length > 0 && roots.length <= 17, 'Invalid workspace table');
  const root = roots[input.workspaceIndex ?? 0]; need(typeof root === 'string', 'Unknown workspace');
  const reply = { id: request.id, ok: true, text: undefined, snapshot: undefined, image: undefined, read: undefined, search: undefined };
  if (operation === 'read') {
    phase = 'read'; const file = local(root, input.path), stat = fs.statSync(file);
    need(stat.isFile(), 'Read requires an ordinary file');
    const header = Buffer.allocUnsafe(Math.min(stat.size, IMAGE_TYPE_SNIFF_BYTES)), fd = fs.openSync(file, 'r');
    let count; try { count = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const mimeType = detectSupportedImageMimeType(header.subarray(0, count));
    if (mimeType) {
      need(stat.size <= IMAGE_LIMIT, 'Image exceeds 16 MiB; resize it before read');
      const bytes = read(file, IMAGE_LIMIT); reply.snapshot = hash(bytes);
      const artifact = { name: request.id + '-0.bin', bytes: bytes.length, sha256: reply.snapshot };
      fs.writeFileSync(path.join(request.exchange, artifact.name), bytes, { flag: 'wx' });
      reply.image = { mimeType, artifact }; reply.text = 'Read image file [' + mimeType + ']';
    } else {
      const bytes = read(file); reply.snapshot = hash(bytes);
      need(isUtf8(bytes) && !bytes.includes(0), 'Unsupported binary file; read supports UTF-8 text and common image formats');
      readWindow(bytes.toString('utf8'), input, reply);
    }
  } else if (operation === 'ls' || operation === 'find' || operation === 'grep') {
    phase = 'read'; const result = search(root, operation, input.path || '.', input.pattern, input.outputMode);
    reply.text = result.text; reply.search = result.search;
  } else {
    need(request.mode === 'sandbox-write', 'Read-only workspace'); phase = 'mutation';
    if (operation === 'file_batch') {
      need(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 16, 'Invalid batch');
      items = reply.items = [];
      for (let index = 0; index < input.operations.length; index++) {
        const item = input.operations[index];
        try { items.push({ index, operation: item.operation, status: 'succeeded', snapshot: mutate(roots[item.workspaceIndex ?? 0], item.operation, item, request.maxWriteBytes) }); }
        catch (error) {
          items.push({ index, operation: item.operation, status: 'unknown', error: String(error.message).slice(0,800) });
          for (let next = index + 1; next < input.operations.length; next++) items.push({ index: next, operation: input.operations[next].operation, status: 'not_started' });
          throw error;
        }
      }
    } else reply.snapshot = mutate(root, operation, input, request.maxWriteBytes);
    reply.text = 'Workspace operation completed';
  }
  console.log(JSON.stringify(reply));
} catch (error) {
  console.log(JSON.stringify({ id: request?.id, ok: false, phase, noEffects: phase !== 'mutation', items,
    requiresVerification: unverifiedPublication || undefined, error: String(error.message).slice(0, 32768) }));
  process.exitCode = 1;
}
