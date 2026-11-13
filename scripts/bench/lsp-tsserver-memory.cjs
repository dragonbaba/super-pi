// Opt-in child-process sampler for lsp-typescript-diagnostics.ts. It records no
// arbitrary arguments, environment values, source text or personal configuration.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.SP_LSP_DIAGNOSTICS_PROFILE_ROOT;
if (root && path.basename(process.argv[1] || '') === 'tsserver.js') {
  const role = process.argv.includes('partialSemantic') || process.argv.includes('syntactic') ? 'syntax' : 'semantic';
  const output = path.join(root, `tsserver-memory-${process.pid}.jsonl`);
  function sample(event = 'sample') {
    let phase;
    try { phase = fs.readFileSync(path.join(root, 'phase.txt'), 'utf8'); } catch { return; }
    const usage = process.memoryUsage();
    fs.appendFileSync(output, JSON.stringify({ time: Date.now(), phase, pid: process.pid, role, event, rss: usage.rss, heapUsed: usage.heapUsed }) + '\n');
  }
  sample('start');
  setInterval(sample, 100).unref();
  process.once('exit', () => sample('exit'));
}
