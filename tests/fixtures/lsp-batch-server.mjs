// Controlled protocol fixture; it does not analyze source files.
import { DIAGNOSTIC_BATCH_SIZE } from '../../packages/lsp/src/limits.ts';
const mode = process.argv[2];
let buffer = Buffer.alloc(0), opened = 0, closed = 0, active = 0, peak = 0, reports = 0;
function send(message, callback) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, callback);
}
function handle(message) {
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: { diagnosticProvider: {} } } });
  else if (message.method === 'textDocument/didOpen') {
    opened++; active++; peak = Math.max(peak, active);
    if (active > DIAGNOSTIC_BATCH_SIZE) {
      process.stderr.write('fixture: too many simultaneously open documents\n', () => process.exit(23));
    }
  } else if (message.method === 'textDocument/didClose') { closed++; active--; }
  else if (message.method === 'textDocument/diagnostic') {
    reports++;
    if (mode === 'exit-after-partial' && reports === DIAGNOSTIC_BATCH_SIZE + 2) {
      process.stderr.write('fixture: exited after partial diagnostics\n', () => process.exit(23));
    } else send({ id: message.id, result: { kind: 'full', items: [] } });
  } else if (message.method === 'workspace/symbol') send({ id: message.id, result: [{ name: JSON.stringify({ opened, closed, active, peak, reports }) }] });
  else if (message.method === 'shutdown') send({ id: message.id, result: null });
  else if (message.method === 'exit') process.exit(0);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size); handle(message);
  }
});
