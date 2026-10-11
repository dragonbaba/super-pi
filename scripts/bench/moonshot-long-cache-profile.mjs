// Run serially on one idle machine: node --expose-gc scripts/bench/moonshot-long-cache-profile.mjs
// Optional --output DIRECTORY saves raw .heapprofile files plus the JSON summary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createProvider } from '../../packages/ai/src/models.ts';
import { lazyApi } from '../../packages/ai/src/api/lazy.ts';
import { moonshotaiProvider } from '../../packages/ai/src/providers/moonshotai.ts';
import { loadMoonshotBenchmarkAdapter } from './moonshot-benchmark-adapter.mjs';

const baseline = '1257a336fdbee6f97e0aa60e5a706fd4cae0501e';
const adapterPath = 'packages/ai/src/api/openai-completions.ts';
const candidateSource = readFileSync(adapterPath, 'utf8');
const baselineSource = execFileSync('git', ['show', `${baseline}:${adapterPath}`], { encoding: 'utf8' });
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? undefined : resolve(process.argv[outputIndex + 1]);
if (output) mkdirSync(output, { recursive: true });
assert.equal(typeof globalThis.gc, 'function', '--expose-gc required');
const samplingInterval = 1024;
const repetitions = 3;
const model = moonshotaiProvider().getModels().find(value => value.id === 'kimi-k3');
const raw = { prompt_tokens: 1000, completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 } };
const context = { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] };
const headers = new Headers({ 'Msh-Usage-Cache-Write-Tokens-1h': '100' });
const loaded = {
  baseline: await loadMoonshotBenchmarkAdapter(baselineSource, 'baseline'),
  candidate: await loadMoonshotBenchmarkAdapter(candidateSource, 'candidate'),
};
// Both full adapters use identical transpilation and provider/lazy wrappers.
const providers = {};
for (const label of ['baseline', 'candidate']) providers[label] = createProvider({ id: model.provider,
  auth: {}, models: [model], api: lazyApi(async () => loaded[label].api, 'mutation-with-generation') });

const updatesPerRequest = 128;
const chunk = { id: 'fixture', model: 'kimi-k3', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }], usage: raw };
// Precompute immutable wire data outside all sample windows; native Response,
// Headers, decoder and SDK allocations still occur inside every measured send.
const wire = `data: ${JSON.stringify(chunk)}\n\n`.repeat(updatesPerRequest)
  + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
async function fetchFixture() {
  return new Response(wire, { headers: { 'content-type': 'text/event-stream',
    'Msh-Usage-Cache-Write-Tokens-1h': '100' } });
}
const options = { apiKey: 'fixture-only', maxRetries: 0, fetch: fetchFixture };
// Escaping usage records prevent scalar replacement from hiding their changed
// size; the bounded ring is allocated once before sampling and cleared afterward.
const retainedUsage = new Array(256);
let checksum = 0;
function parseBatch(api, count) {
  for (let index = 0; index < count; index++) {
    const usage = api.parseChunkUsage(raw, model, 100);
    retainedUsage[index % retainedUsage.length] = usage;
    checksum += usage.cost.cacheWrite;
  }
}
function headerBatch(api, count) {
  for (let index = 0; index < count; index++) checksum += api.getMoonshotCacheWrite1h?.(model, headers) ?? 0;
}
async function requestBatch(provider, count, entry) {
  for (let request = 0; request < count; request++) {
    const stream = provider[entry](model, context, options);
    let updates = 0;
    for await (const event of stream) if (event.type === 'text_delta') updates++;
    const result = await stream.result();
    assert.equal(updates, updatesPerRequest);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    checksum += result.usage.cost.cacheWrite;
  }
}
async function workload(label, phase, count) {
  if (phase === 'usage') parseBatch(loaded[label].api, count);
  else if (phase === 'header') headerBatch(loaded[label].api, count);
  else await requestBatch(providers[label], count, phase === 'sdk-direct' ? 'stream' : 'streamSimple');
}
function summarize(profile, units) {
  const sites = new Map();
  const pending = [profile.head];
  let bytes = 0;
  while (pending.length) {
    const node = pending.pop();
    bytes += node.selfSize;
    if (node.selfSize) {
      const frame = node.callFrame;
      // Keep the complete raw profile separately; normalize only temporary names.
      const url = frame.url.replace(/pi-moonshot-bench-[^/\\]+/g, 'pi-moonshot-bench-TEMP');
      const key = `${frame.functionName}|${url}|${frame.lineNumber}`;
      const row = sites.get(key) ?? { function: frame.functionName, url, line: frame.lineNumber + 1, bytes: 0 };
      row.bytes += node.selfSize;
      sites.set(key, row);
    }
    for (const child of node.children) pending.push(child);
  }
  const sorted = [...sites.values()].sort((a, b) => b.bytes - a.bytes);
  return { sampledBytes: bytes, sampledBytesPerUnit: bytes / units, samples: profile.samples.length,
    leadingSites: sorted.slice(0, 8),
    relevantSites: sorted.filter(site => /parseChunkUsage|getMoonshotCacheWrite1h|calculateCost|undici/.test(`${site.function} ${site.url}`)).slice(0, 16) };
}
const rows = [];
for (const phase of ['header', 'usage', 'sdk-direct', 'sdk-simple']) {
  const sdk = phase.startsWith('sdk-');
  const count = sdk ? 64 : 100_000;
  for (const label of ['baseline', 'candidate']) await workload(label, phase, sdk ? 16 : 30_000);
  for (let repetition = 0; repetition < repetitions; repetition++) {
    // Alternate pair order, on one process/machine, with GC outside the window.
    for (const label of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      retainedUsage.fill(undefined);
      await nextTurn(); globalThis.gc();
      const profiler = new Session(); profiler.connect();
      let profile;
      try {
        await profiler.post('HeapProfiler.startSampling', { samplingInterval,
          includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        await workload(label, phase, count);
        profile = (await profiler.post('HeapProfiler.stopSampling')).profile;
      } finally { profiler.disconnect(); retainedUsage.fill(undefined); }
      const units = sdk ? count * updatesPerRequest : count;
      const row = { phase, label, repetition, requests: sdk ? count : undefined, units,
        unit: phase === 'header' ? 'response-header lookup' : 'usage update', ...summarize(profile, units) };
      rows.push(row);
      if (output) writeFileSync(join(output, `${phase}-${label}-${repetition}.heapprofile`), JSON.stringify(profile));
      console.error(JSON.stringify({ phase, label, repetition, sampledBytesPerUnit: row.sampledBytesPerUnit }));
    }
  }
}
const result = { baseline, candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  candidateAdapterSha256: createHash('sha256').update(candidateSource).digest('hex'),
  node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  samplingInterval, repetitions, updatesPerRequest, checksum, rows };
if (output) writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
