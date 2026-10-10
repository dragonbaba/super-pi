// Run: node --expose-gc scripts/bench/moonshot-long-cache-usage.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { moonshotaiProvider } from '../../packages/ai/src/providers/moonshotai.ts';
import { moonshotaiCnProvider } from '../../packages/ai/src/providers/moonshotai-cn.ts';
import { createProvider } from '../../packages/ai/src/models.ts';
import { lazyApi } from '../../packages/ai/src/api/lazy.ts';

const baseline = '1257a336fdbee6f97e0aa60e5a706fd4cae0501e';
const adapterPath = 'packages/ai/src/api/openai-completions.ts';
const modelsPath = 'packages/ai/src/models.ts';
const base = path => execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' });
const read = path => readFileSync(path, 'utf8');
const parse = text => ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = text => printer.printFile(parse(text));
function functionText(source, name) {
  const ast = parse(source);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, name);
  return fn.getText(ast).replace(/^export /, '');
}
const before = base(adapterPath), after = read(adapterPath);
const header = functionText(after, 'getMoonshotCacheWrite1h');
const reverted = after.replace(header, '')
  .replace('\t\t\tconst cacheWrite1h = getMoonshotCacheWrite1h(model, response.headers);', '')
  .replaceAll(', model, cacheWrite1h)', ', model)')
  .replace('\tcacheWrite1h: number | undefined,', '')
  .replace('\t\tcacheWrite1h: cacheWrite1h === undefined ? undefined : Math.min(cacheWrite1h, Math.max(0, cacheWriteTokens)),', '');
assert.equal(print(reverted), print(before), 'entire adapter unchanged outside the named primitive path');
assert.equal(print(read(modelsPath)), print(base(modelsPath)), 'cost function behavior unchanged');
assert.equal(print(read('packages/ai/src/types.ts')), print(base('packages/ai/src/types.ts')));
const changed = execFileSync('git', ['diff', '--name-only', baseline, '--', 'packages'], { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
assert.deepEqual(changed, [adapterPath, modelsPath, 'packages/ai/src/types.ts'].sort());

function instrument(source) {
  const transformed = ts.transform(parse(source), [context => {
    const visit = node => {
      const visited = ts.visitEachChild(node, visit, context);
      const kind = ts.isObjectLiteralExpression(node) ? 'objects' : ts.isArrayLiteralExpression(node) ? 'arrays'
        : ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? 'closures' : ts.isNewExpression(node) ? 'constructors' : undefined;
      return kind ? ts.factory.createParenthesizedExpression(ts.factory.createCommaListExpression([
        ts.factory.createPostfixIncrement(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('counts'), kind)), visited,
      ])) : visited;
    };
    return root => ts.visitNode(root, visit);
  }]);
  try { return ts.transpileModule(printer.printFile(transformed.transformed[0]), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; }
  finally { transformed.dispose(); }
}
let owners = [moonshotaiProvider(), moonshotaiCnProvider()];
const baselineMode = process.argv.includes('--baseline');
if (baselineMode) {
  const adapterUrl = new URL(`../../${adapterPath}`, import.meta.url);
  const baselineSource = before.replace(/from "(\.[^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(new URL(specifier, adapterUrl).href)}`);
  const output = '.git/t05-4-moonshot-long-cache-20261011/baseline-api.mjs';
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, ts.transpileModule(baselineSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const api = await import(pathToFileURL(output).href);
  owners = owners.map(provider => createProvider({ id: provider.id, auth: {}, models: provider.getModels(),
    api: lazyApi(async () => api, 'mutation-with-generation') }));
}
const model = owners[0].getModels().find(value => value.id === 'kimi-k3');
const raw = { prompt_tokens: 1000, completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 } };
for (const label of ['baseline', 'candidate']) {
  const counts = { objects: 0, arrays: 0, closures: 0, constructors: 0 };
  const context = vm.createContext({ counts });
  vm.runInContext(instrument(`${header}\n${functionText(label === 'baseline' ? before : after, 'parseChunkUsage')}\n${functionText(read(modelsPath), 'calculateCost')}`), context);
  const parseUsage = vm.runInContext('parseChunkUsage', context);
  if (label === 'candidate') {
    const parseHeader = vm.runInContext('getMoonshotCacheWrite1h', context);
    const headers = new Headers({ 'msh-usage-cache-write-tokens-1h': '100' });
    for (let index = 0; index < 10_000; index++) assert.equal(parseHeader(model, headers), 100);
    assert.deepEqual(counts, { objects: 0, arrays: 0, closures: 0, constructors: 0 });
    console.log(JSON.stringify({ phase: 'header-allocations', label, calls: 10_000, counts }));
  }
  for (const tiered of [false, true]) {
    const fixture = { ...model, cost: { ...model.cost, ...(tiered ? { tiers: [
      { inputTokensAbove: 999, input: 4, output: 20, cacheRead: 0.5, cacheWrite: 4 },
    ] } : {}) } };
    for (const key of Object.keys(counts)) counts[key] = 0;
    for (let index = 0; index < 10_000; index++) {
      const usage = parseUsage(raw, fixture, 100);
      assert.equal(usage.cacheWrite1h, label === 'baseline' ? undefined : 100);
      assert.equal(usage.cost.cacheWrite, (tiered ? 4 : 3) * (label === 'baseline' ? 200 : 300) / 1e6);
    }
    assert.deepEqual(counts, { objects: 20_000, arrays: tiered ? 0 : 10_000, closures: 0, constructors: 0 });
    console.log(JSON.stringify({ phase: 'usage-allocations', label, tiered, calls: 10_000, counts }));
  }
}
console.log(JSON.stringify({ phase: 'source-scope', changed, newPerUsageObjects: 0, newPerUsageArrays: 0,
  newPerUsageClosures: 0, newPerUsagePromises: 0, newPerUsageControllers: 0, copiedBodies: 0 }));

assert.equal(typeof globalThis.gc, 'function', '--expose-gc required');
const controllers = [], refs = [], sdkSignals = [];
let fixtureLabel = '';
const watch = value => refs.push({ label: fixtureLabel, ref: new WeakRef(value) });
async function lifetime(provider, entry, outcome) {
  fixtureLabel = `${provider.id}/${entry}/${outcome}`;
  const model = provider.getModels().find(value => value.id === 'kimi-k3');
  const controller = new AbortController(); controllers.push(controller);
  const context = { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] };
  let bodyController, reads = 0, deltas = 0, events = 0;
  const options = { apiKey: 'fixture-only', signal: controller.signal, maxRetries: 0,
    onPayload(payload) { watch(payload); watch(payload.messages); },
    fetch: async (_url, init) => {
      sdkSignals.push(init.signal);
      const chunk = { id: 'fixture', model: 'kimi-k3', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }], usage: raw };
      const body = new ReadableStream({ start(value) {
        bodyController = value; watch(value);
        value.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      } });
      const response = new Response(body, { headers: {
        'content-type': 'text/event-stream', 'Msh-Usage-Cache-Write-Tokens-1h': '100',
      } });
      const get = response.headers.get.bind(response.headers);
      response.headers.get = name => { if (name === 'msh-usage-cache-write-tokens-1h') reads++; return get(name); };
      for (const value of [body, response, response.headers]) watch(value);
      return response;
    } };
  const stream = provider[entry](model, context, options);
  for await (const event of stream) {
    events++;
    if (event.type !== 'text_delta') continue;
    deltas++;
    assert.equal(event.partial.usage.cacheWrite1h, baselineMode ? undefined : 100);
    if (outcome === 'done') {
      bodyController.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      bodyController.close();
    } else {
      if (outcome === 'abort') controller.abort('fixture abort');
      bodyController.error(new Error('fixture mid-stream failure'));
    }
  }
  const result = await stream.result();
  assert.equal(result.stopReason, outcome === 'done' ? 'stop' : outcome === 'abort' ? 'aborted' : 'error');
  assert.equal(result.usage.cost.cacheWrite, baselineMode ? 0.0006 : 0.0009);
  assert.equal(reads, baselineMode ? 0 : 1); assert.equal(deltas, 1);
  assert.equal(events, outcome === 'done' ? 5 : 4);
  for (const value of [context, context.messages, options, stream, result, result.usage]) watch(value);
  console.log(JSON.stringify({ phase: 'production-stream', provider: provider.id, entry, outcome, headerReads: reads, deltas, events }));
}
for (const provider of owners) for (const entry of ['stream', 'streamSimple']) {
  for (const outcome of ['done', 'error', 'abort']) await lifetime(provider, entry, outcome);
}
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
const retained = refs.filter(value => value.ref.deref());
assert.ok(retained.every(value => value.label.endsWith('/error')), 'success and caller abort must release without stack inspection');
console.log(JSON.stringify({ phase: 'retained-before-sdk-stack', baselineMode, count: retained.length,
  outcomes: [...new Set(retained.map(value => value.label))] }));
// Probe the SDK-owned lazy AbortError stack separately, without changing production.
for (const signal of sdkSignals) if (signal.reason instanceof Error) void signal.reason.stack;
sdkSignals.length = 0;
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
assert.equal(refs.filter(value => value.ref.deref()).length, 0);
console.log(JSON.stringify({ phase: 'request-release', requests: 12, released: refs.length, retained: 0,
  heldControllers: controllers.length, heldProviders: owners.length, abortReason: 'primitive fixture reason' }));
