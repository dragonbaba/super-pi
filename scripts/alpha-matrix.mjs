import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Sequential independent processes; never mix timing with parallel test load.
// Evidence output is caller-selected and retained. Only alpha-bench's private
// temporary HOME is removed. Existing evidence directories are never reused.
const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--suite', '--runs'].includes(args[i]) || !args[i + 1]) throw new Error('expected --output PATH [--suite rates,slow,history,batch,corpus,profile,ansi] [--runs 5]');
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.output) throw new Error('--output must name a new persistent evidence directory');
const runs = Number(options.runs ?? 5);
if (!Number.isInteger(runs) || runs < 5 || runs > 10) throw new Error('requires 5–10 independent processes');
const suites = (options.suite ?? 'rates,slow,history,batch,corpus,profile,ansi').split(',');
if (suites.some(suite => !['rates', 'slow', 'history', 'batch', 'corpus', 'profile', 'ansi'].includes(suite))) throw new Error('unknown suite');
function git(...args) { return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim(); }
const head = git('rev-parse', 'HEAD');
if (git('status', '--porcelain')) throw new Error('benchmark requires a clean candidate');
const output = resolve(options.output);
mkdirSync(output); // Exclusive creation deliberately fails on an existing path.
const cases = [];
function add(suite, name, values, command = 'stream') {
  for (let run = 1; run <= runs; run++) cases.push({ suite, name: `${suite}-${name}-n${run}`, args: [command, ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, String(value)])] });
}
for (const suite of suites) {
  if (suite === 'rates') for (let layer = 0; layer <= 3; layer++) for (const rate of [10, 20, 50, 100, 0]) add(suite, `l${layer}-r${rate}`, { layer, rate, count: 20 });
  if (suite === 'slow') for (const mode of ['regular', 'fullscreen']) for (const delay of [5, 20, 50, 100]) for (const rate of [10, 20, 50, 100, 0]) add(suite, `${mode}-d${delay}-r${rate}`, { layer: 3, mode, delay, rate, count: 20 });
  if (suite === 'history') for (const mode of ['regular', 'fullscreen']) for (const history of [0, 5000, 50000]) for (const columns of [120, 200]) add(suite, `${mode}-h${history}-w${columns}`, { layer: 3, mode, history, columns, rows: columns === 120 ? 40 : 60, rate: 100, count: 200, corpus: 'word' });
  if (suite === 'batch') for (let layer = 0; layer <= 3; layer++) for (const batch of [2, 4, 8]) add(suite, `l${layer}-b${batch}`, { layer, rate: 10, batch, count: batch * 10 });
  if (suite === 'corpus') for (let layer = 0; layer <= 3; layer++) for (const mode of layer < 2 ? ['regular'] : ['regular', 'fullscreen']) for (const corpus of ['plain', 'cjk', 'emoji', 'ansi', 'word', 'markdown', 'fence', 'link', 'latex']) add(suite, `l${layer}-${mode}-${corpus}`, { layer, mode, corpus, rate: 100, count: 40 });
  if (suite === 'profile') for (const mode of ['regular', 'fullscreen']) add(suite, mode, { layer: 3, mode, history: 50000, corpus: 'word', rate: 100, count: 200, profile: 'on' });
  if (suite === 'ansi') add(suite, 'index', {}, 'ansi');
}
if (cases.length > 1500) throw new Error('matrix hard capacity exceeded');
const manifest = { head, node: process.version, platform: process.platform, runs, suites, planned: cases.length, results: [] };
const manifestPath = join(output, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
for (const entry of cases) {
  const stdout = join(output, `${entry.name}.jsonl`); const stderr = join(output, `${entry.name}.stderr`);
  const outFd = openSync(stdout, 'wx'); const errFd = openSync(stderr, 'wx');
  let result;
  try { result = spawnSync(process.execPath, ['scripts/alpha-bench.mjs', ...entry.args], { cwd: repository, stdio: ['ignore', outFd, errFd], timeout: 300000 }); }
  finally { closeSync(outFd); closeSync(errFd); }
  const record = { ...entry, exitCode: result.status, errorCode: result.error?.code,
    stdoutSha256: createHash('sha256').update(readFileSync(stdout)).digest('hex'),
    stderrSha256: createHash('sha256').update(readFileSync(stderr)).digest('hex') };
  manifest.results.push(record);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (result.error || result.status !== 0) throw new Error(`matrix stopped at ${entry.name}; see retained evidence`);
  if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain')) throw new Error('candidate changed during measurement; stop and preserve evidence');
  console.log(`${manifest.results.length}/${cases.length} ${entry.name}`);
}
