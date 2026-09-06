import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('matrix capacity rejection has no side effects and permits corrected same-path run', () => {
  const root = mkdtempSync(join(tmpdir(), 'g2s-matrix-preflight-'));
  const output = join(root, 'evidence'); const marker = join(root, 'children'); const preload = join(root, 'preload.mjs');
  // Isolate metadata and benchmark subprocesses: exercise the real CLI planner
  // and filesystem without launching any performance campaign.
  writeFileSync(preload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {appendFileSync} from 'node:fs';
cp.execFileSync = (_cmd,args) => args[0] === 'status' ? '' : 'fixture-head';
cp.spawnSync = () => { appendFileSync(${JSON.stringify(marker)}, 'child\\n'); return {status:0}; }; syncBuiltinESMExports();`);
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve(import.meta.dirname, '../scripts/alpha-matrix.mjs'), '--output', output, ...args], { encoding: 'utf8' });
  try {
    const rejected = invoke(['--runs', '10']);
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /capacity/);
    assert.equal(existsSync(output), false); assert.equal(existsSync(marker), false);
    const accepted = invoke(['--suite', 'ansi', '--runs', '5']);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')).planned, 5);
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
