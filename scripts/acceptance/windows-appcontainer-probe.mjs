// Executed only inside the manual AppContainer spike's private fixture.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
const [root, port] = process.argv.slice(2);
const results = {};
function attempt(name, operation) {
  try { results[name] = { ok: true, value: operation() }; }
  catch (error) { results[name] = { ok: false, code: error.code }; }
}
attempt('workspaceWrite', () => fs.writeFileSync(path.join(root, 'workspace', '中文.txt'), 'ภาษาไทย\n${literal}\\n\r\n'));
attempt('workspaceRead', () => fs.readFileSync(path.join(root, 'workspace', '中文.txt'), 'utf8'));
attempt('toolchainRead', () => fs.readFileSync(path.join(root, 'tools', 'readonly.txt'), 'utf8'));
attempt('toolchainWrite', () => fs.writeFileSync(path.join(root, 'tools', 'readonly.txt'), 'forbidden'));
attempt('outsideRead', () => fs.readFileSync(path.join(root, 'outside', 'canary.txt'), 'utf8'));
attempt('outsideWrite', () => fs.writeFileSync(path.join(root, 'outside', 'new.txt'), 'forbidden'));
attempt('junctionRead', () => fs.readFileSync(path.join(root, 'workspace', 'escape', 'canary.txt'), 'utf8'));
results.loopback = await new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve({ connected: true }); });
  socket.once('error', error => resolve({ connected: false, code: error.code }));
  socket.once('timeout', () => { socket.destroy(); resolve({ connected: false, code: 'TIMEOUT' }); });
});
const ready = path.join(root, 'workspace', 'child-ready.txt');
try {
  const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)', ready], { stdio: 'ignore' });
  child.on('error', error => { results.child = { ok: false, code: error.code }; });
  child.unref();
  for (let tries = 0; tries < 100 && !results.child; tries++) {
    if (fs.existsSync(ready)) { results.child = { ok: true, pid: child.pid }; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} catch (error) { results.child = { ok: false, code: error.code }; }
results.child ??= { ok: false, code: 'NO_READY_SIGNAL' };
fs.writeFileSync(path.join(root, 'workspace', 'result.json'), JSON.stringify(results));
