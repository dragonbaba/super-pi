// Protocol/status fixture only. This process does not analyze HTML or JavaScript.
const mode = process.argv[2];
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function handle(message) {
  if (message.method === "initialize") send({ id: message.id, result: { capabilities: mode.startsWith("push") ? {} : { diagnosticProvider: {} } } });
  else if (message.method === "textDocument/diagnostic") {
    if (mode === "error") send({ id: message.id, error: { code: -32603, message: "synthetic diagnostic failure" } });
    else send({ id: message.id, result: mode === "missing-report" ? {} : { kind: "full", items: [] } });
  } else if (message.method === "textDocument/didOpen" && (mode === "push-empty" || mode === "push-provisional")) {
    send({ method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [] } });
    if (mode === "push-provisional") setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: {
      uri: message.params.textDocument.uri,
      diagnostics: [{ message: "synthetic late analysis error", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    } }), 40);
  } else if (message.method === "shutdown") send({ id: message.id, result: null });
  else if (message.method === "exit") process.exit(0);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size); handle(message);
  }
});
