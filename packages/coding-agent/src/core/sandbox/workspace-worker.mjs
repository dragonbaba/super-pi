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
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function need(value, reason) { if (!value) throw new Error(reason); }
function local(root, name) {
  need(typeof name === 'string' && name.length > 0 && name.length < 4096 && !name.includes('\0') && !name.includes(':'), 'Invalid workspace path');
  const parts = name.replaceAll('\\', '/').split('/');
  need(parts.every(part => part && part !== '..' && !/[. ]$/.test(part) && !['.git', '.sp'].includes(part.toLowerCase())), 'Protected workspace path');
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
  const scratch = hashes ? Buffer.allocUnsafe(256 * 1024) : undefined;
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      need(!entry.isSymbolicLink(), 'Workspace contains a redirected entry');
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) pending.push(name);
      else { const file = local(root, name), stat = fs.lstatSync(file); bytes += stat.size; need(stat.isFile() && bytes <= 256 * 1024 * 1024 && files.size < 20000, 'Workspace capacity exceeded'); files.set(name, hashes ? fileHash(file, scratch) : null); }
    }
  }
  return files;
}
function selected(root, scope) {
  const output = new Map();
  for (const name of scope) { const file = local(root, name); if (fs.existsSync(file)) output.set(name, sha(read(file))); }
  return output;
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
function changes(before, root, scope, maxWriteBytes) {
  const after = scope ? selected(root, scope) : catalog(root, true), output = []; let bytes = 0;
  for (const [name, hash] of after) if (before.get(name) !== hash) {
    const content = read(local(root, name)); bytes += content.length;
    need(content.length <= maxWriteBytes, 'Candidate exceeds the native write limit');
    need(output.length < 32 && bytes <= OUTPUT_LIMIT, 'Writeback capacity exceeded');
    output.push({ path: name, before: before.get(name) ?? null, content: content.toString('base64') });
  }
  for (const [name, hash] of before) if (!after.has(name)) { need(output.length < 32, 'Writeback capacity exceeded'); output.push({ path: name, before: hash, content: null }); }
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
let request;
try {
  const requestFile = path.join(EXCHANGE, 'request.json'); need(fs.statSync(requestFile).size <= 4 * 1024 * 1024, 'Request too large');
  request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  need(/^[a-f0-9]{32}$/.test(request.id) && ['read-only', 'sandbox-write'].includes(request.mode), 'Invalid request identity');
  const maxWriteBytes = request.maxWriteBytes;
  need(Number.isSafeInteger(maxWriteBytes) && maxWriteBytes > 0 && maxWriteBytes <= FILE_LIMIT, 'Invalid native write limit');
  if (request.mode === 'sandbox-write' && !fs.existsSync(WORK)) fs.cpSync(SOURCE, WORK, { recursive: true, dereference: false });
  const root = request.mode === 'read-only' ? SOURCE : WORK;
  const input = request.input, operation = request.operation;
  let text, snapshot, before, scope;
  if (request.mode === 'sandbox-write' && !['read', 'ls', 'find', 'grep'].includes(operation)) {
    if (operation === 'powershell') before = catalog(root, true);
    else {
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
    const files = catalog(root); const rows = [];
    for (const name of files.keys()) {
      if (input.path && input.path !== '.' && !name.startsWith(input.path.replaceAll('\\', '/').replace(/\/$/, '') + '/')) continue;
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
  } else if (operation === 'powershell') {
    need(typeof input.command === 'string' && input.command.length <= 32768, 'Invalid command');
    const timeout = Math.min(120000, Math.max(1, (input.timeout ?? 30) * 1000));
    fs.writeFileSync(path.join(EXCHANGE, 'command.txt'), input.command, 'utf8');
    const child = spawnSync('C:\\SuperPiTools\\command.exe', [EXCHANGE, root, String(timeout)], { windowsHide: true, encoding: 'utf8', timeout: timeout + 10000, maxBuffer: 65536 });
    need(!child.error && child.status === 0, 'Command supervisor failed');
    const result = JSON.parse(fs.readFileSync(path.join(EXCHANGE, 'command-result.json'), 'utf8'));
    result.stdout = Buffer.from(result.stdoutBase64, 'base64').toString('utf8');
    result.stderr = Buffer.from(result.stderrBase64, 'base64').toString('utf8');
    need(result.closed === true, 'Command process family did not close');
    need(!result.timedOut && result.exitCode === 0, 'Command failed (' + result.exitCode + '): ' + result.stderr + result.stdout);
    text = result.stdout + (result.stderr ? '\n' + result.stderr : '');
  } else {
    need(request.mode === 'sandbox-write', 'Read-only workspace');
    if (operation === 'file_batch') {
      need(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 16, 'Invalid batch');
      for (const item of input.operations) mutate(root, item.operation, item, maxWriteBytes);
    } else mutate(root, operation, input, maxWriteBytes);
    text = 'Sandbox operation completed';
  }
  const result = { id: request.id, ok: true, text, snapshot, changes: before && request.mode === 'sandbox-write' ? changes(before, root, scope, maxWriteBytes) : [] };
  const encoded = JSON.stringify(result); need(Buffer.byteLength(encoded) <= 24 * 1024 * 1024, 'Result too large');
  fs.writeFileSync(path.join(EXCHANGE, 'response.json'), encoded);
} catch (error) {
  fs.writeFileSync(path.join(EXCHANGE, 'response.json'), JSON.stringify({ id: request?.id, ok: false, error: String(error.message).slice(0, 32768) }));
  process.exitCode = 1;
}
