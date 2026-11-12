// Controlled file-tool entry inside MXC; no shell parser or host fallback.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from '../../utils/image-signature.mjs';
import { MxcFilePublication } from '../files/mxc-file-publication.mjs';
import { FILE_RPC_REQUEST_BYTES } from '../files/file-operation-limits.mjs';
import { pathIdentityFromStat, sameIdentity, boundedReason } from '../files/file-tree-core.mjs';
import { FILE_LIMIT, IMAGE_LIMIT, SEARCH_ROWS, SEARCH_ENTRIES, TEXT_LIMIT, SEARCH_EXCERPT, SEARCH_CLIPPED_MARK, DIRECTORY_READ_BUFFER,
  normalizeReadOffset, normalizeReadLimit } from './mxc-file-limits.mjs';

const DIRECTORY_OPTIONS = Object.freeze({ bufferSize: DIRECTORY_READ_BUFFER });
const PROTECTED_NAMES = new Set(['.git', '.sp']);
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
function mutate(root, operation, input, maxWriteBytes, preflight = false, baseline, facts) {
  need(!preflight || operation === 'write' || operation === 'edit', 'Only text preparation uses this owner');
  const target = local(root, input.path, true);
  need(operation === 'write' || operation === 'edit', 'Unsupported file operation');
  if (operation === 'write' && !fs.existsSync(target)) {
    need(input.snapshot == null && typeof input.content === 'string' && Buffer.byteLength(input.content) <= maxWriteBytes, 'Invalid new-file write');
    need(input.mode !== 'overwrite' && baseline?.exists !== true, 'Prepared overwrite target disappeared; no creation');
    if (baseline) need(hash(input.content) === baseline.nextSha256, 'Prepared new-file content changed; no creation');
    if (preflight) {
      try { fs.lstatSync(target); throw new Error('Create refuses an existing link or object'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { exists: false, target, nextSha256: hash(input.content), bytes: Buffer.byteLength(input.content) };
    }
    throw new Error('Exclusive creation requires the prepared v3 creation owner');
  }
  // Read a pinned version, then replace atomically; a failed temporary write leaves the original intact.
  let fd = fs.openSync(target, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(before.isFile() && before.size <= BigInt(FILE_LIMIT), 'File exceeds text capacity');
    need(!(operation === 'write' && input.mode === 'create') && baseline?.exists !== false, 'Create target appeared; no overwrite');
    if (baseline?.identity) need(sameIdentity(baseline.identity, pathIdentityFromStat(target, fs.realpathSync(target), before)), 'Prepared text target identity changed');
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
    if (baseline) need(hash(text) === baseline.nextSha256, 'Prepared text changed; no publication');
    if (preflight) return { exists: true, target, identity: pathIdentityFromStat(target, fs.realpathSync(target), before), nextSha256: hash(text), bytes: Buffer.byteLength(text) };
    const publication = new MxcFilePublication(target, fd, before, input.snapshot, baseline?.parent); fd = undefined;
    try { return publication.commitText(text); }
    finally { try { publication.dispose(); } finally {
      unverifiedPublication ||= publication.requiresVerification;
      if (facts) {
        facts.stateChanged = publication.outcome === 'unknown' ? 'unknown' : publication.outcome === 'committed' || publication.retainedTemporary !== undefined;
        facts.requiresVerification = publication.requiresVerification || undefined; facts.retainedTemporary = publication.retainedTemporary;
        facts.commit = { strategy: 'staged_replace', outcome: publication.outcome, fileSynced: publication.outcome === 'committed', directorySynced: false,
          retainedTemporary: publication.retainedTemporary };
      }
    } }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function runFileWorker(preparsedRequest) {
 let request, phase = 'request';
 try {
  if (preparsedRequest === undefined) {
    const requestFile = process.argv[2]; need(fs.statSync(requestFile).size <= FILE_RPC_REQUEST_BYTES, 'Request too large');
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  } else request = preparsedRequest;
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
    throw new Error('File mutations require the prepared v3 RPC');
  }
  console.log(JSON.stringify(reply));
 } catch (error) {
  console.log(JSON.stringify({ id: request?.id, ok: false, phase, noEffects: true, error: String(error.message).slice(0, 32768) }));
  process.exitCode = 1;
 }
}
function prepareTextMutation(root, operation, input, maxWriteBytes) {
  need(operation === 'write' || operation === 'edit', 'Invalid text preparation operation');
  return mutate(root, operation, input, maxWriteBytes, true);
}
function executePreparedTextMutation(root, operation, input, maxWriteBytes, baseline) {
  need(operation === 'write' || operation === 'edit', 'Invalid prepared text operation');
  const facts = { stateChanged: false, requiresVerification: undefined, retainedTemporary: undefined };
  const previous = unverifiedPublication; unverifiedPublication = false;
  try {
    const snapshot = mutate(root, operation, input, maxWriteBytes, false, baseline, facts);
    need(snapshot === baseline.nextSha256, 'Published text does not match the prepared postimage');
    return { status: 'succeeded', stateChanged: true, snapshot, bytes: baseline.bytes, commit: facts.commit };
  } catch (error) {
    const changed = facts.stateChanged === 'unknown' ? 'unknown' : facts.stateChanged;
    return { status: changed === 'unknown' ? 'state_unknown' : changed ? 'partial' : 'failed_no_change', stateChanged: changed,
      requiresVerification: changed !== false || unverifiedPublication || facts.requiresVerification || undefined,
      commit: facts.commit, reason: boundedReason(String(error.message)) };
  } finally { unverifiedPublication = previous; }
}
export { runFileWorker, prepareTextMutation, executePreparedTextMutation };
