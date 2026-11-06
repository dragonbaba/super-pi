// Guest-only entry. Neither this file nor a user command is executed on the host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from '../../utils/image-signature.mjs';
import { isVmPrivateName, isVmPrivatePath, isProtectedWorkspaceName, isVmPrivateDirectory, parseSandboxPrivateDirectories } from './workspace-policy.mjs';

const SOURCE = 'C:\\SuperPiInput';
const WORK = 'C:\\SuperPiWorkspace';
const EXCHANGE = 'C:\\SuperPiExchange';
const FILE_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const ARTIFACT_LIMIT = 256 * 1024 * 1024;
const ARTIFACT_FILES = 1024;
const SEARCH_ROWS = 200;
const SEARCH_ENTRIES = 20000;
const DIRECTORY_ENTRIES = Object.freeze({ withFileTypes: true });
const TRAILING_PATH_PATTERN = /[. ]$/;
const RESERVED_WORKSPACE_ROOTS = ['c:\\windows', 'c:\\superpiinput', 'c:\\superpiworkspace', 'c:\\superpiexchange', 'c:\\superpitools', 'c:\\superpitoolchains', 'c:\\superpicommand', 'c:\\superpivolume'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function need(value, reason) { if (!value) throw new Error(reason); }
class WorkspaceInputError extends Error {}
function needInput(value, reason) { if (!value) throw new WorkspaceInputError(reason); }
// Guest-only alias of the captured workspace, never a mount of the host project.
function commandWorkspace(root, workspace) {
  need(typeof workspace === 'string' && workspace.length > 3 && workspace.length < 4096 && !workspace.includes('\0'), 'Invalid command workspace');
  const drive = workspace[0].toUpperCase();
  need(drive >= 'A' && drive <= 'Z' && workspace[1] === ':' && workspace[2] === '\\'
    && workspace === path.win32.normalize(workspace) && !workspace.slice(2).includes(':'), 'Expected a local absolute command workspace');
  const lower = workspace.toLowerCase();
  for (const reserved of RESERVED_WORKSPACE_ROOTS) {
    need(lower !== reserved && !lower.startsWith(reserved + '\\') && !reserved.startsWith(lower + '\\'), 'Command workspace overlaps guest runtime');
  }
  const alias = drive === 'C' ? workspace : 'C:\\SuperPiToolchains\\' + drive + workspace.slice(2);
  const parts = path.win32.dirname(alias).slice(3).split('\\');
  let parent = 'C:\\';
  for (const part of parts) {
    if (!part) continue; // A project directly under C:\ has no parent components.
    need(!TRAILING_PATH_PATTERN.test(part), 'Invalid command workspace component');
    parent = path.win32.join(parent, part);
    if (fs.existsSync(parent)) {
      const stat = fs.lstatSync(parent);
      need(stat.isDirectory() && !stat.isSymbolicLink(), 'Redirected command workspace parent');
    } else fs.mkdirSync(parent);
  }
  need(!TRAILING_PATH_PATTERN.test(path.win32.basename(alias)), 'Invalid command workspace component');
  if (fs.existsSync(alias)) {
    need(fs.lstatSync(alias).isSymbolicLink() && fs.realpathSync(alias) === fs.realpathSync(root), 'Command workspace alias changed');
  } else fs.symlinkSync(root, alias, 'junction');
  return workspace;
}
function local(root, name) {
  needInput(typeof name === 'string' && name.length > 0 && name.length < 4096 && !name.includes('\0') && !name.includes(':'), 'Invalid workspace path');
  const parts = name.replaceAll('\\', '/').split('/');
  for (const part of parts) {
    const lower = part.toLowerCase();
    needInput(part && part !== '..' && !TRAILING_PATH_PATTERN.test(part) && !isProtectedWorkspaceName(lower), 'Protected workspace path');
  }
  const target = path.resolve(root, name);
  needInput(target.startsWith(root + path.sep), 'Workspace escape');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) need(!fs.lstatSync(cursor).isSymbolicLink(), 'Redirected workspace path');
  }
  return target;
}
function read(file) {
  const stat = fs.lstatSync(file); need(!stat.isSymbolicLink(), 'Redirected read path');
  needInput(stat.isFile() && stat.size <= FILE_LIMIT, 'File exceeds 2 MiB or is not ordinary'); return fs.readFileSync(file);
}
function fileHash(file, scratch) {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r');
  try { for (;;) { const count = fs.readSync(fd, scratch, 0, scratch.length, null); if (!count) break; digest.update(count === scratch.length ? scratch : scratch.subarray(0, count)); } return digest.digest('hex'); }
  finally { fs.closeSync(fd); }
}
function readImage(file, id) {
  const stat = fs.lstatSync(file);
  need(!stat.isSymbolicLink(), 'Redirected image path');
  needInput(stat.isFile(), 'Read requires an ordinary file');
  const header = Buffer.allocUnsafe(Math.min(stat.size, IMAGE_TYPE_SNIFF_BYTES)), fd = fs.openSync(file, 'r');
  let count;
  try { count = fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  const mimeType = detectSupportedImageMimeType(header.subarray(0, count));
  if (!mimeType) return undefined;
  needInput(stat.size <= IMAGE_LIMIT, 'Image bytes=' + stat.size + '; limit=' + IMAGE_LIMIT + '. Resize the image before read; shell base64 output is capped.');
  const artifact = { name: id + '-0.bin', bytes: stat.size, sha256: fileHash(file, Buffer.allocUnsafe(256 * 1024)) };
  phase = 'attachment';
  fs.copyFileSync(file, path.join(EXCHANGE, artifact.name), fs.constants.COPYFILE_EXCL);
  return { mimeType, artifact };
}
function catalog(root, hashes = false, privateDirectories) {
  const files = new Map(), pending = ['']; let bytes = 0;
  const scratch = hashes === true ? Buffer.allocUnsafe(256 * 1024) : undefined;
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relative), DIRECTORY_ENTRIES)) {
      // Match host capture before inspecting or traversing private metadata/dependencies.
      if (isVmPrivateName(entry.name.toLowerCase())) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory() && isVmPrivateDirectory(name, privateDirectories)) continue;
      need(!entry.isSymbolicLink(), 'Workspace contains a redirected entry');
      if (entry.isDirectory()) pending.push(name);
      else { const file = local(root, name), stat = fs.lstatSync(file); bytes += stat.size; need(stat.isFile() && bytes <= 16 * 1024 * 1024 * 1024 && files.size < 20000, 'Workspace capacity exceeded');
        files.set(name, hashes === 'versions' ? stat : hashes ? fileHash(file, scratch) : null); }
    }
  }
  return files;
}
function selected(root, scope, privateDirectories) {
  const output = new Map(), scratch = Buffer.allocUnsafe(256 * 1024);
  for (const name of scope) { const file = local(root, name); if (!isVmPrivatePath(name, privateDirectories) && fs.existsSync(file)) output.set(name, fileHash(file, scratch)); }
  return output;
}
function searchScope(root, raw) {
  if (raw === undefined || raw === '') return '';
  needInput(typeof raw === 'string' && raw.length < 4096 && !raw.includes('\0') && !raw.includes(':') && !path.isAbsolute(raw), 'Invalid search scope');
  const normalized = path.relative(root, path.resolve(root, raw.replaceAll('\\', '/'))).replaceAll('\\', '/');
  if (!normalized) return '';
  // local rejects escapes, protected components and redirected entries before realpath.
  return path.relative(root, fs.realpathSync(local(root, normalized))).replaceAll('\\', '/');
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
  if (operation === 'grep') needInput(typeof pattern === 'string' && pattern.length > 0, 'Literal search pattern required');
  const pending = [scope], rows = []; let visited = 0, truncated = false;
  try {
    while (pending.length && !truncated) {
      const name = pending.pop(), file = name ? local(root, name) : root, stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(file, DIRECTORY_ENTRIES)) {
          if (isProtectedWorkspaceName(entry.name.toLowerCase())) continue;
          need(++visited <= SEARCH_ENTRIES, 'Search entry capacity exceeded');
          need(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()), 'Search contains a non-ordinary or redirected entry');
          const child = name ? name + '/' + entry.name : entry.name;
          if (operation === 'ls') {
            if (rows.length === SEARCH_ROWS) { truncated = true; break; }
            rows.push(child + (entry.isDirectory() ? '/' : ''));
          } else pending.push(child);
        }
      } else {
        need(stat.isFile() && !stat.isSymbolicLink(), 'Search requires an ordinary file or directory');
        if (operation === 'find' && pattern && !name.includes(pattern)) continue;
        if (operation === 'grep') {
          if (stat.size > FILE_LIMIT) continue;
          const bytes = read(file); if (!isUtf8(bytes)) continue;
          truncated = grepRows(bytes.toString('utf8'), pattern, name, rows);
        } else if (rows.length === SEARCH_ROWS) truncated = true;
        else rows.push(name);
      }
    }
    return rows.join('\n') + (truncated ? '\n[Results truncated at ' + SEARCH_ROWS + ' rows; narrow the search scope.]' : '');
  } finally { pending.length = 0; rows.length = 0; }
}
function changes(before, root, scope, maxWriteBytes, artifactId, artifactOffset = 0, privateDirectories) {
  const after = scope ? selected(root, scope, privateDirectories) : catalog(root, true, privateDirectories), output = []; let bytes = 0;
  for (const [name, hash] of after) if (before.get(name) !== hash) {
    if (artifactId) {
      const file = local(root, name), size = fs.statSync(file).size; bytes += size;
      need(output.length < 32 && size <= 64 * 1024 * 1024 && bytes <= ARTIFACT_LIMIT,
        'File-operation artifacts: files=' + (output.length + 1) + '/32; fileBytes=' + size + '/67108864; bytes=' + bytes + '/' + ARTIFACT_LIMIT);
      const artifact = { name: artifactId + '-' + (artifactOffset + output.length) + '.bin', bytes: size, sha256: hash };
      fs.copyFileSync(file, path.join(EXCHANGE, artifact.name), fs.constants.COPYFILE_EXCL);
      output.push({ path: name, before: before.get(name) ?? null, content: null, artifact }); continue;
    }
    const content = read(local(root, name)); bytes += content.length;
    need(content.length <= maxWriteBytes, 'Candidate exceeds the native write limit');
    need(output.length < 32 && bytes <= OUTPUT_LIMIT, 'Writeback capacity exceeded');
    output.push({ path: name, before: before.get(name) ?? null, content: content.toString('base64') });
  }
  for (const [name, hash] of before) if (!after.has(name)) { need(output.length < 32, 'Writeback capacity exceeded'); output.push({ path: name, before: hash, content: null }); }
  return output;
}
// Metadata travels in JSON; bytes remain in independent files and are validated again by the host.
function commandChanges(before, roots, id, privateDirectories) {
  const output = []; let bytes = 0;
  const scratch = Buffer.allocUnsafe(256 * 1024);
  for (let workspaceIndex = 0; workspaceIndex < roots.length; workspaceIndex++) {
    const root = roots[workspaceIndex], previous = before[workspaceIndex], after = catalog(root, 'versions', privateDirectories);
    for (const [name, stat] of after) {
      const old = previous.get(name);
      if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs && old.ctimeMs === stat.ctimeMs && old.ino === stat.ino) continue;
      const file = local(root, name), size = fs.statSync(file).size; bytes += size;
      need(size <= 64 * 1024 * 1024, 'Artifact file bytes=' + size + '; limit=67108864; path=' + name);
      need(output.length < ARTIFACT_FILES && bytes <= ARTIFACT_LIMIT,
        'Artifact capacity: files=' + (output.length + 1) + '/' + ARTIFACT_FILES + '; bytes=' + bytes + '/' + ARTIFACT_LIMIT);
      const artifact = { name: id + '-' + output.length + '.bin', bytes: size, sha256: fileHash(file, scratch) };
      fs.copyFileSync(file, path.join(EXCHANGE, artifact.name), fs.constants.COPYFILE_EXCL);
      output.push({ path: name, workspaceIndex, before: null, content: null, artifact });
    }
    for (const name of previous.keys()) if (!after.has(name)) {
      need(output.length < ARTIFACT_FILES, 'Artifact capacity: files=' + (output.length + 1) + '/' + ARTIFACT_FILES);
      output.push({ path: name, workspaceIndex, before: null, content: null });
    }
  }
  return output;
}
function mutate(root, operation, input, maxWriteBytes) {
  const target = local(root, input.path);
  if (operation === 'write') {
    needInput(typeof input.content === 'string' && Buffer.byteLength(input.content) <= maxWriteBytes, 'Write exceeds the native write limit');
    if (fs.existsSync(target)) needInput(input.snapshot === sha(read(target)), 'Read snapshot required or changed. Read the file again, reconcile changes, then pass snapshot: result.details.snapshot (SHA-256), not result.ref. This write did not modify the target.');
    else needInput(input.snapshot === undefined || input.snapshot === null, 'Create cannot reuse a snapshot');
    phase = 'mutation';
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, input.content);
  } else if (operation === 'edit') {
    const source = read(target); needInput(input.snapshot === sha(source), 'Read snapshot required or changed. Read the file again, reconcile changes, then pass snapshot: result.details.snapshot (SHA-256), not result.ref. This edit did not modify the target.');
    needInput(isUtf8(source), 'File is not UTF-8 text');
    let text = source.toString('utf8'); needInput(Array.isArray(input.edits) && input.edits.length > 0 && input.edits.length <= 20, 'Invalid edit list');
    for (const edit of input.edits) {
      needInput(typeof edit.oldText === 'string' && edit.oldText.length && typeof edit.newText === 'string', 'Exact text edits required');
      const at = text.indexOf(edit.oldText); needInput(at >= 0 && text.indexOf(edit.oldText, at + 1) < 0, 'Edit target is missing or ambiguous');
      text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
    }
    needInput(Buffer.byteLength(text) <= maxWriteBytes, 'Edited file exceeds the native write limit'); phase = 'mutation'; fs.writeFileSync(target, text);
  } else if (operation === 'delete') { needInput(fs.lstatSync(target).isFile(), 'Only files may be deleted'); phase = 'mutation'; fs.unlinkSync(target); }
  else if (operation === 'move') { const destination = local(root, input.destination); needInput(!fs.existsSync(destination), 'Destination exists'); phase = 'mutation'; fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.linkSync(target, destination); fs.unlinkSync(target); }
  else throw new Error('Unsupported mutation');
}
let request, execution, phase = 'request';
try {
  const requestFile = path.join(EXCHANGE, 'request.json'); need(fs.statSync(requestFile).size <= 4 * 1024 * 1024, 'Request too large');
  request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  need(/^[a-f0-9]{32}$/.test(request.id) && ['read-only', 'sandbox-write'].includes(request.mode), 'Invalid request identity');
  const maxWriteBytes = request.maxWriteBytes;
  need(Number.isSafeInteger(maxWriteBytes) && maxWriteBytes > 0 && maxWriteBytes <= FILE_LIMIT, 'Invalid native write limit');
  const directories = request.directories ?? [];
  need(Array.isArray(directories) && directories.length <= 16, 'Invalid workspace table');
  const privateDirectories = parseSandboxPrivateDirectories(request.privateDirectories);
  const roots = [], workspaces = [request.workspace, ...directories];
  for (let i = 0; i < workspaces.length; i++) {
    const suffix = i ? '-' + i : '', source = SOURCE + suffix, work = WORK + suffix;
    if (request.mode === 'sandbox-write' && !fs.existsSync(work)) fs.cpSync(source, work, { recursive: true, dereference: false });
    roots.push(request.mode === 'read-only' ? source : work);
  }
  const input = request.input, operation = request.operation;
  const workspaceIndex = input.workspaceIndex ?? 0;
  need(Number.isSafeInteger(workspaceIndex) && workspaceIndex >= 0 && workspaceIndex < roots.length, 'Unknown workspace');
  const root = roots[workspaceIndex], command = operation === 'powershell' || operation === 'bash';
  let text, snapshot, before, scope, batchScopes, image;
  if (request.mode === 'sandbox-write' && !['read', 'ls', 'find', 'grep'].includes(operation)) {
    if (command) { before = []; for (const directory of roots) before.push(catalog(directory, 'versions', privateDirectories)); }
    else if (operation === 'file_batch') {
      need(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 16, 'Invalid operations');
      batchScopes = []; before = [];
      for (const item of input.operations) {
        const index = item.workspaceIndex ?? 0;
        need(Number.isSafeInteger(index) && index >= 0 && index < roots.length, 'Unknown batch workspace');
        const selectedRoot = roots[index];
        local(selectedRoot, item.path); if (!batchScopes[index]) batchScopes[index] = new Set();
        batchScopes[index].add(item.path);
        if (item.destination !== undefined) { local(selectedRoot, item.destination); batchScopes[index].add(item.destination); }
      }
      for (let i = 0; i < batchScopes.length; i++) if (batchScopes[i]) before[i] = selected(roots[i], batchScopes[i], privateDirectories);
    } else {
      scope = new Set();
      const operations = operation === 'file_batch' ? input.operations : [input];
      need(Array.isArray(operations) && operations.length > 0 && operations.length <= 16, 'Invalid operations');
      for (const item of operations) { local(root, item.path); scope.add(item.path); if (item.destination !== undefined) { local(root, item.destination); scope.add(item.destination); } }
      before = selected(root, scope, privateDirectories);
    }
  }
  if (operation === 'read') {
    phase = 'read';
    const file = local(root, input.path);
    image = readImage(file, request.id);
    if (image) { snapshot = image.artifact.sha256; text = 'Read image file [' + image.mimeType + ']'; }
    else {
      const bytes = read(file); snapshot = sha(bytes);
      needInput(isUtf8(bytes) && !bytes.includes(0), 'Unsupported binary file. read supports UTF-8 text and JPEG, PNG, GIF, WebP, BMP images. Convert other formats to PNG before read; do not transport binary via capped shell output.');
      const source = bytes.toString('utf8'), offset = Math.max(0, (input.offset ?? 1) - 1), count = Math.min(2000, input.limit ?? 2000);
      let start = 0, end = 0;
      for (let line = 0; line < offset; line++) { const next = source.indexOf('\n', start); if (next < 0) { start = source.length; break; } start = next + 1; }
      end = start;
      for (let line = 0; line < count && end < source.length && end - start < 32768; line++) { const next = source.indexOf('\n', end); end = next < 0 ? source.length : next + 1; }
      text = source.slice(start, Math.min(end, start + 32768)) + '\n[Snapshot: ' + snapshot + ']';
    }
  } else if (operation === 'ls' || operation === 'find' || operation === 'grep') {
    phase = 'read';
    text = search(root, operation, searchScope(root, input.path), input.pattern);
  } else if (command) {
    needInput(typeof input.command === 'string' && input.command.length <= 32768, 'Invalid command');
    phase = 'read';
    const commandPath = searchScope(root, input.cwd);
    needInput(fs.statSync(path.resolve(root, commandPath)).isDirectory(), 'Command cwd must be a directory');
    const cwd = commandPath ? path.win32.resolve(workspaces[workspaceIndex], commandPath) : workspaces[workspaceIndex];
    phase = 'launch';
    let drives = '';
    for (let i = 0; i < roots.length; i++) {
      commandWorkspace(roots[i], workspaces[i]);
      const drive = workspaces[i][0].toUpperCase();
      if (drive !== 'C' && !drives.includes(drive)) drives += (drives ? ';' : '') + drive;
    }
    const timeout = Math.min(120000, Math.max(1, (input.timeout ?? 30) * 1000));
    fs.writeFileSync(path.join(EXCHANGE, 'command.txt'), input.command, 'utf8');
    // The supervisor's second argument identifies this workspace runtime, not the selected cwd.
    const child = spawnSync('C:\\SuperPiTools\\command.exe', [EXCHANGE, roots[0], String(timeout), cwd, operation, drives], { windowsHide: true, encoding: 'utf8', timeout: timeout + 10000, maxBuffer: 65536 });
    need(!child.error && child.status === 0, 'Command supervisor failed');
    const result = JSON.parse(fs.readFileSync(path.join(EXCHANGE, 'command-result.json'), 'utf8'));
    result.stdout = Buffer.from(result.stdoutBase64, 'base64').toString('utf8');
    result.stderr = Buffer.from(result.stderrBase64, 'base64').toString('utf8');
    phase = 'execution';
    execution = { exitCode: result.exitCode, timedOut: result.timedOut, closed: result.closed, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated === true };
    need(result.closed === true, 'Command process family did not close');
    need(!result.timedOut && result.exitCode === 0, 'Command failed (' + result.exitCode + '): ' + result.stderr + result.stdout);
    text = result.stdout + (result.stderr ? '\n' + result.stderr : '');
  } else {
    need(request.mode === 'sandbox-write', 'Read-only workspace');
    if (operation === 'file_batch') {
      need(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 16, 'Invalid batch');
      for (const item of input.operations) mutate(roots[item.workspaceIndex ?? 0], item.operation, item, maxWriteBytes);
    } else mutate(root, operation, input, maxWriteBytes);
    text = 'Sandbox operation completed';
  }
  phase = 'collection';
  const candidates = before && request.mode === 'sandbox-write' && !batchScopes ? command ? commandChanges(before, roots, request.id, privateDirectories)
    : changes(before, root, scope, maxWriteBytes, operation === 'move' ? request.id : undefined, 0, privateDirectories) : [];
  if (batchScopes) for (let i = 0; i < batchScopes.length; i++) if (batchScopes[i]) {
    for (const change of changes(before[i], roots[i], batchScopes[i], maxWriteBytes, request.id, i * 32, privateDirectories)) { if (i) change.workspaceIndex = i; candidates.push(change); }
  }
  if (!command && workspaceIndex) for (const candidate of candidates) candidate.workspaceIndex = workspaceIndex;
  const result = { id: request.id, ok: true, text, snapshot, image, execution, changes: candidates };
  const encoded = JSON.stringify(result); need(Buffer.byteLength(encoded) <= 24 * 1024 * 1024, 'Result too large');
  fs.writeFileSync(path.join(EXCHANGE, 'response.json'), encoded);
} catch (error) {
  const noEffects = (phase === 'request' || phase === 'read') && (error instanceof WorkspaceInputError
    || phase === 'read' && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
  fs.writeFileSync(path.join(EXCHANGE, 'response.json'), JSON.stringify({ id: request?.id, ok: false, phase, execution, noEffects, error: String(error.message).slice(0, 32768) }));
  process.exitCode = 1;
}
