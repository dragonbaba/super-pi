// Protocol fixture only; no language analysis.
import { TYPESCRIPT_PROJECT_PROGRESS_TITLE } from '../../packages/lsp/src/project-progress.ts';
const mode = process.argv[2]; let buffer = Buffer.alloc(0), created = false;
const opens = new Map();
function send(message) { const body = JSON.stringify({ jsonrpc: '2.0', ...message }); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
function publish(uri, nonempty = false) { send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: nonempty ? [{ message: 'late diagnostic', severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [] } }); }
function handle(message) {
 if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
 else if (message.method === 'textDocument/didOpen') {
  const uri = message.params.textDocument.uri, count = (opens.get(uri) ?? 0) + 1; opens.set(uri, count);
  if (mode === 'late-ready' || mode === 'loading-empty') {
   if (!created) { created = true; send({ id: 'load', method: 'window/workDoneProgress/create', params: { token: 'load' } }); }
   send({ method: '$/progress', params: { token: 'load', value: { kind: 'begin', title: TYPESCRIPT_PROJECT_PROGRESS_TITLE } } }); publish(uri);
   if (mode === 'late-ready') {
    setTimeout(() => { send({ method: '$/progress', params: { token: 'load', value: { kind: 'end' } } }); publish(uri); }, 10);
    setTimeout(() => publish(uri, true), 70);
   }
  } else if (mode === 'mixed') { if (uri.endsWith('confirmed.ts') || count > 1) publish(uri, true); }
  else if (mode === 'exit-command' && uri.endsWith('confirmed.ts')) publish(uri, true);
 } else if (message.method === 'workspace/symbol') {
  if (message.params.query === 'exit') process.stderr.write('controlled exit\n', () => process.exit(23));
  else send({ id: message.id, result: [{ name: String([...opens.values()].reduce((sum, n) => sum + n, 0)) }] });
 } else if (message.method === 'shutdown') send({ id: message.id, result: null });
 else if (message.method === 'exit') process.exit(0);
}
process.stdin.on('data', chunk => {
 buffer = Buffer.concat([buffer, chunk]);
 while (true) {
  const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
  const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]); if (buffer.length < end + 4 + size) return;
  const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()); buffer = buffer.subarray(end + 4 + size); handle(message);
 }
});
