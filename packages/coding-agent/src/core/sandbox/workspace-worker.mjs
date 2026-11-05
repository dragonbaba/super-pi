// Guest-only entry. Neither this file nor a user command is executed on the host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';

const SOURCE = 'C:\\SuperPiInput';
const WORK = 'C:\\SuperPiWorkspace';
const EXCHANGE = 'C:\\SuperPiExchange';
const FILE_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const ARTIFACT_LIMIT = 256 * 1024 * 1024;
const ARTIFACT_FILES = 1024;
const TRAILING_PATH_PATTERN = /[. ]$/;
const RESERVED_WORKSPACE_ROOTS = ['c:\\windows', 'c:\\superpiinput', 'c:\\superpiworkspace', 'c:\\superpiexchange', 'c:\\superpitools', 'c:\\superpitoolchains', 'c:\\superpicommand', 'c:\\superpivolume'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function need(value, reason) { if (!value) throw new Error(reason); }
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
  need(typeof name === 'string' && name.length > 0 && name.length < 4096 && !name.includes('\0') && !name.includes(':'), 'Invalid workspace path');
  const parts = name.replaceAll('\\', '/').split('/');
  for (const part of parts) {
    const lower = part.toLowerCase();
    need(part && part !== '..' && !TRAILING_PATH_PATTERN.test(part) && lower !== '.git' && lower !== '.sp' && lower !== 'node_modules', 'Protected workspace path');
  }
  const target = path.resolve(root, name);
  need(target.startsWith(root + path.sep), 'Workspace escape');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) need(!fs.lstatSync(cursor).isSymbolicLink(), 'Redirected workspace path');
  }
  return target;
}
function read(file) { const stat = fs.lstatSync(file); need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= FILE_LIMIT, 'File exceeds 2 MiB or is not ordinary'); return fs.readFileSync(file); }
function fileHash(file, scratch) {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r');
  try { for (;;) { const count = fs.readSync(fd, scratch, 0, scratch.length, null); if (!count) break; digest.update(count === scratch.length ? scratch : scratch.subarray(0, count)); } return digest.digest('hex'); }
  finally { fs.closeSync(fd); }
}
function catalog(root, hashes = false) {
  const files = new Map(), pending = ['']; let bytes = 0;
  const scratch = hashes === true ? Buffer.allocUnsafe(256 * 1024) : undefined;
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      need(!entry.isSymbolicLink(), 'Workspace contains a redirected entry');
      // Installed dependencies stay private to the VM, including package links and binary assets.
      if (entry.isDirectory() && entry.name.toLowerCase() === 'node_modules') continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) pending.push(name);
      else { const file = local(root, name), stat = fs.lstatSync(file); bytes += stat.size; need(stat.isFile() && bytes <= 16 * 1024 * 1024 * 1024 && files.size < 20000, 'Workspace capacity exceeded');
        files.set(name, hashes === 'versions' ? stat : hashes ? fileHash(file, scratch) : null); }
    }
  }
  return files;
}
function selected(root, scope) {
  const output = new Map(), scratch = Buffer.allocUnsafe(256 * 1024);
  for (const name of scope) { const file = local(root, name); if (fs.existsSync(file)) output.set(name, fileHash(file, scratch)); }
  return output;
}
function searchScope(root, raw) {
  if (raw === undefined || raw === '') return '';
  need(typeof raw === 'string' && raw.length < 4096 && !raw.includes('\0') && !raw.includes(':') && !path.isAbsolute(raw), 'Invalid search scope');
  const normalized = path.relative(root, path.resolve(root, raw.replaceAll('\\', '/'))).replaceAll('\\', '/');
  if (!normalized) return '';
  // local rejects escapes, protected components and redirected entries before realpath.
  return path.relative(root, fs.realpathSync(local(root, normalized))).replaceAll('\\', '/');
}
function matchesScope(name, scope) {
  return scope === '' || name === scope || name.startsWith(scope) && name[scope.length] === '/';
}
function grepRows(source, pattern, name, rows) {
  let match = source.indexOf(pattern), start = 0, line = 1;
  while (match >= 0 && start < source.length && rows.length < 200) {
    const next = source.indexOf('\n', start), end = next < 0 ? source.length : next;
    if (match >= start && match < end) rows.push(name + ':' + line + ':' + source.slice(start, Math.min(end, start + 256)));
    start = end + 1; line++;
    if (match < start) match = source.indexOf(pattern, start);
  }
}
function changes(before, root, scope, maxWriteBytes, artifactId, artifactOffset = 0) {
  const after = scope ? selected(root, scope) : catalog(root, true), output = []; let bytes = 0;
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
function commandChanges(before, roots, id) {
  const output = []; let bytes = 0;
  const scratch = Buffer.allocUnsafe(256 * 1024);
  for (let workspaceIndex = 0; workspaceIndex < roots.length; workspaceIndex++) {
    const root = roots[workspaceIndex], previous = before[workspaceIndex], after = catalog(root, 'versions');
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
    need(typeof input.content === 'string' && Buffer.byteLength(input.content) <= maxWriteBytes, 'Write exceeds the native write limit');
    if (fs.existsSync(target)) need(input.snapshot === sha(read(target)), 'Read snapshot required or changed');
    else need(input.snapshot === undefined || input.snapshot === null, 'Create cannot reuse a snapshot');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, input.content);
  } else if (operation === 'edit') {
    const source = read(target); need(input.snapshot === sha(source), 'Read snapshot required or changed');
    need(isUtf8(source), 'File is not UTF-8 text');
    let text = source.toString('utf8'); need(Array.isArray(input.edits) && input.edits.length > 0 && input.edits.length <= 20, 'Invalid edit list');
    for (const edit of input.edits) {
      need(typeof edit.oldText === 'string' && edit.oldText.length && typeof edit.newText === 'string', 'Exact text edits required');
      const at = text.indexOf(edit.oldText); need(at >= 0 && text.indexOf(edit.oldText, at + 1) < 0, 'Edit target is missing or ambiguous');
      text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
    }
    need(Buffer.byteLength(text) <= maxWriteBytes, 'Edited file exceeds the native write limit'); fs.writeFileSync(target, text);
  } else if (operation === 'delete') { need(fs.lstatSync(target).isFile(), 'Only files may be deleted'); fs.unlinkSync(target); }
  else if (operation === 'move') { const destination = local(root, input.destination); need(!fs.existsSync(destination), 'Destination exists'); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.linkSync(target, destination); fs.unlinkSync(target); }
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
  let text, snapshot, before, scope, batchScopes;
  if (request.mode === 'sandbox-write' && !['read', 'ls', 'find', 'grep'].includes(operation)) {
    if (command) { before = []; for (const directory of roots) before.push(catalog(directory, 'versions')); }
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
      for (let i = 0; i < batchScopes.length; i++) if (batchScopes[i]) before[i] = selected(roots[i], batchScopes[i]);
    } else {
      scope = new Set();
      const operations = operation === 'file_batch' ? input.operations : [input];
      need(Array.isArray(operations) && operations.length > 0 && operations.length <= 16, 'Invalid operations');
      for (const item of operations) { local(root, item.path); scope.add(item.path); if (item.destination !== undefined) { local(root, item.destination); scope.add(item.destination); } }
      before = selected(root, scope);
    }
  }
  if (operation === 'read') {
    const bytes = read(local(root, input.path)); snapshot = sha(bytes);
    need(isUtf8(bytes), 'File is not UTF-8 text');
    const source = bytes.toString('utf8'), offset = Math.max(0, (input.offset ?? 1) - 1), count = Math.min(2000, input.limit ?? 2000);
    let start = 0, end = 0;
    for (let line = 0; line < offset; line++) { const next = source.indexOf('\n', start); if (next < 0) { start = source.length; break; } start = next + 1; }
    end = start;
    for (let line = 0; line < count && end < source.length && end - start < 32768; line++) { const next = source.indexOf('\n', end); end = next < 0 ? source.length : next + 1; }
    text = source.slice(start, Math.min(end, start + 32768)) + '\n[Snapshot: ' + snapshot + ']';
  } else if (operation === 'ls' || operation === 'find' || operation === 'grep') {
    const searchRoot = searchScope(root, input.path), files = catalog(root); const rows = [];
    for (const name of files.keys()) {
      if (!matchesScope(name, searchRoot)) continue;
      if (operation === 'find' && input.pattern && !name.includes(input.pattern)) continue;
      if (operation === 'grep') {
        need(typeof input.pattern === 'string' && input.pattern.length > 0, 'Literal search pattern required');
        if (fs.statSync(local(root, name)).size > FILE_LIMIT) continue;
        const bytes = read(local(root, name)); if (!isUtf8(bytes)) continue;
        const source = bytes.toString('utf8');
        grepRows(source, input.pattern, name, rows);
      } else rows.push(name);
      if (rows.length >= 200) break;
    }
    text = rows.join('\n');
  } else if (command) {
    need(typeof input.command === 'string' && input.command.length <= 32768, 'Invalid command');
    phase = 'launch';
    for (let i = 0; i < roots.length; i++) commandWorkspace(roots[i], workspaces[i]);
    const cwd = request.workspace;
    const timeout = Math.min(120000, Math.max(1, (input.timeout ?? 30) * 1000));
    fs.writeFileSync(path.join(EXCHANGE, 'command.txt'), input.command, 'utf8');
    const child = spawnSync('C:\\SuperPiTools\\command.exe', [EXCHANGE, root, String(timeout), cwd, operation], { windowsHide: true, encoding: 'utf8', timeout: timeout + 10000, maxBuffer: 65536 });
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
  const candidates = before && request.mode === 'sandbox-write' && !batchScopes ? command ? commandChanges(before, roots, request.id)
    : changes(before, root, scope, maxWriteBytes, operation === 'move' ? request.id : undefined) : [];
  if (batchScopes) for (let i = 0; i < batchScopes.length; i++) if (batchScopes[i]) {
    for (const change of changes(before[i], roots[i], batchScopes[i], maxWriteBytes, request.id, i * 32)) { if (i) change.workspaceIndex = i; candidates.push(change); }
  }
  if (!command && workspaceIndex) for (const candidate of candidates) candidate.workspaceIndex = workspaceIndex;
  const result = { id: request.id, ok: true, text, snapshot, execution, changes: candidates };
  const encoded = JSON.stringify(result); need(Buffer.byteLength(encoded) <= 24 * 1024 * 1024, 'Result too large');
  fs.writeFileSync(path.join(EXCHANGE, 'response.json'), encoded);
} catch (error) {
  fs.writeFileSync(path.join(EXCHANGE, 'response.json'), JSON.stringify({ id: request?.id, ok: false, phase, execution, error: String(error.message).slice(0, 32768) }));
  process.exitCode = 1;
}
