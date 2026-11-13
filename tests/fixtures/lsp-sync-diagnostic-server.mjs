// Controlled protocol fixture; no TypeScript project analysis.
import { DIAGNOSTIC_BATCH_SIZE } from '../../packages/lsp/src/limits.ts';
import { TYPESCRIPT_SYNCHRONOUS_DIAGNOSTICS as capability } from '../../packages/lsp/src/typescript-diagnostics.ts';
const mode = process.argv[2];
let buffer = Buffer.alloc(0), opened = 0, closed = 0, active = 0, peak = 0, held = mode === 'held', pull = 0;
const counts = [0, 0, 0], pending = [];
function send(message) { const body = JSON.stringify({ jsonrpc: '2.0', ...message }); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
function response(message, kind) {
  send({ id: message.id, result: { success: true, body: kind === 1 ? [{ start: { line: 2, offset: 3 }, end: { line: 2, offset: 4 }, text: 'fixture diagnostic', code: 9001, category: 'warning', reportsUnnecessary: true, source: 'fixture' }] : [] } });
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { executeCommandProvider: { commands: [mode === 'missing' || mode === 'pull' ? 'other.command' : capability.command] }, ...(mode === 'pull' ? { diagnosticProvider: {} } : {}) } } });
  } else if (message.method === 'textDocument/didOpen') {
    opened++; active++; peak = Math.max(peak, active);
    if (active > DIAGNOSTIC_BATCH_SIZE) process.stderr.write('too many open documents\n', () => process.exit(23));
    send({ method: 'textDocument/publishDiagnostics', params: { uri: message.params.textDocument.uri, diagnostics: [] } });
  } else if (message.method === 'textDocument/didClose') { active--; closed++; }
  else if (message.method === 'textDocument/diagnostic') { pull++; send({ id: message.id, result: { kind: 'full', items: [] } }); }
  else if (message.method === 'workspace/executeCommand') {
    const [request, args] = message.params.arguments, kind = capability.requests.indexOf(request);
    if (message.params.command !== capability.command || kind < 0) { send({ id: message.id, error: { code: -32602, message: 'unexpected bridge request' } }); return; }
    counts[kind]++;
    if (args.file.endsWith('bad.ts') && kind === 1) {
      if (mode === 'failure') { send({ id: message.id, result: { success: false, body: [] } }); return; }
      if (mode === 'rpc-error') { send({ id: message.id, error: { code: -32001, message: 'controlled request failure' } }); return; }
      if (mode === 'missing-body') { send({ id: message.id, result: { success: true } }); return; }
      if (mode === 'timeout') return;
      if (mode === 'exit') { process.stderr.write('controlled sync exit\n', () => process.exit(23)); return; }
    }
    if (held) pending.push({ message, kind });
    else if (mode === 'slow') setTimeout(() => response(message, kind), 40);
    else if (mode === 'slow-semantic' && kind === 1) setTimeout(() => response(message, kind), 1500);
    else response(message, kind);
  } else if (message.method === 'workspace/symbol') {
    if (message.params.query === 'release') { held = false; for (const item of pending) response(item.message, item.kind); pending.length = 0; }
    send({ id: message.id, result: [{ name: JSON.stringify({ opened, closed, active, peak, counts, pull }) }] });
  } else if (message.method === 'shutdown') send({ id: message.id, result: null });
  else if (message.method === 'exit') process.exit(0);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()); buffer = buffer.subarray(end + 4 + size); handle(message);
  }
});
