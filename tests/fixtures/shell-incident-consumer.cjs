// Records only synthetic fixture source, never enabled by the production app.
const fs = require('node:fs');
const crypto = require('node:crypto');
if (!process.argv[1]) {
  const chunks = [];
  const stream = process.stdin, emit = stream.emit;
  stream.emit = function observedEmit(name, ...args) {
    if (name === 'data') chunks.push(Buffer.from(args[0]));
    return emit.call(this, name, ...args);
  };
  process.on('exit', () => {
    const source = typeof process._eval === 'string' ? Buffer.from(process._eval) : Buffer.concat(chunks);
    fs.appendFileSync(process.env.SP_INCIDENT_REPORT, JSON.stringify({ phase: 'consumer', executable: process.execPath,
      argv: process.argv, execArgv: process.execArgv, kind: typeof process._eval === 'string' ? 'eval' : 'stdin',
      source: source.toString('base64'), sha256: crypto.createHash('sha256').update(source).digest('hex') }) + '\n');
  });
}
