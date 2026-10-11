import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { loadMoonshotBenchmarkAdapter } from '../scripts/bench/moonshot-benchmark-adapter.mjs';

test('benchmark adapter loads from a gitfile checkout and removes its owned module', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-moonshot-gitfile-'));
  try {
    const checkout = join(directory, 'checkout');
    execFileSync('git', ['init', '--quiet', `--separate-git-dir=${join(directory, 'metadata')}`, checkout]);
    const gitfile = join(checkout, '.git');
    assert.equal(statSync(gitfile).isFile(), true);
    const before = readFileSync(gitfile, 'utf8');
    const helperUrl = new URL('../scripts/bench/moonshot-benchmark-adapter.mjs', import.meta.url).href;
    // Resolve both a checkout-relative import and a package import; the module
    // runs outside the checkout and .git is deliberately an ordinary file.
    const source = 'import { shortHash } from "../utils/hash.ts"; import OpenAI from "openai"; '
      + 'function parseChunkUsage() { return { hash: shortHash("fixture"), client: typeof OpenAI }; }';
    const program = `import { loadMoonshotBenchmarkAdapter } from ${JSON.stringify(helperUrl)};
      const { api, modulePath } = await loadMoonshotBenchmarkAdapter(${JSON.stringify(source)}, 'baseline');
      console.log(JSON.stringify({ ...api.parseChunkUsage(), modulePath }));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: checkout, encoding: 'utf8',
    }));
    assert.equal(result.client, 'function');
    assert.ok(result.hash.length > 0);
    assert.equal(existsSync(dirname(result.modulePath)), false);
    assert.equal(readFileSync(gitfile, 'utf8'), before);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).trim(), '');
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('benchmark module cleanup also runs when module evaluation fails', async () => {
  // The thrown error carries the exact owned path; no broad temporary scan.
  const source = 'throw new Error(import.meta.url); function parseChunkUsage() {}';
  await assert.rejects(loadMoonshotBenchmarkAdapter(source, 'baseline'), error => {
    const modulePath = new URL(error.message);
    assert.equal(existsSync(new URL('.', modulePath)), false);
    return true;
  });
});
