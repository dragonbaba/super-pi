// Run after npm run build:offline: node --expose-gc scripts/bench/moonshot-cache-pricing.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { moonshotaiProvider } from '../../packages/ai/src/providers/moonshotai.ts';
import { moonshotaiCnProvider } from '../../packages/ai/src/providers/moonshotai-cn.ts';
import { createModels, calculateCost } from '../../packages/ai/src/models.ts';
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from '../../packages/ai/src/models-store.ts';
import { withRemoteCatalog } from '../../packages/coding-agent/src/core/remote-catalog-provider.ts';

const baseline = '076c36f44946a5e7c0644e09cc9aa864fa9cbb40';
const base = path => execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' });
const read = path => readFileSync(path, 'utf8');
const generatorPath = 'packages/ai/scripts/generate-models.ts';
const helperPath = 'packages/ai/scripts/catalog-pricing.ts';
const dataDir = 'packages/ai/src/providers/data';
const providers = ['moonshotai', 'moonshotai-cn'];
const changedProduction = execFileSync('git', ['diff', '--name-only', baseline, '--', 'packages'], { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
assert.deepEqual(changedProduction, [generatorPath, `${dataDir}/.manifest.json`, ...providers.map(id => `${dataDir}/${id}.json`)].sort());
const parse = text => ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = text => printer.printFile(parse(text));
const section = source => source.slice(source.indexOf('// Process Moonshot AI models'), source.indexOf('// Process Xiaomi MiMo models'));
const before = base(generatorPath), after = read(generatorPath);
const oldSection = section(before), newSection = section(after);
const oldAst = parse(oldSection), newAst = parse(newSection);
let oldExpression, declaration, correction;
function findOld(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(oldAst) === 'cost') oldExpression = node.initializer.getText(oldAst);
  ts.forEachChild(node, findOld);
}
function findNew(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(newAst) === 'cost') declaration = node;
  if (ts.isIfStatement(node) && node.expression.getText(newAst) === 'isKimiK3'
    && node.thenStatement.getText(newAst).includes('cost.cacheWrite')) correction = node;
  ts.forEachChild(node, findNew);
}
findOld(oldAst); findNew(newAst);
assert.ok(oldExpression && declaration && correction);
const expression = declaration.declarationList.declarations[0].initializer.getText(newAst);
assert.equal(print(expression), print(oldExpression));
const correctedSource = newSection.replace(declaration.getText(newAst), '').replace(correction.getText(newAst), '')
  .replace('\t\t\t\t\tcost,', `\t\t\t\t\tcost: ${oldExpression},`);
assert.equal(print(after.replace(newSection, correctedSource)), print(before));
const correctionSites = { objects: 0, arrays: 0, closures: 0, constructors: 0, calls: 0 };
function countCorrection(node) {
  if (ts.isObjectLiteralExpression(node)) correctionSites.objects++;
  if (ts.isArrayLiteralExpression(node)) correctionSites.arrays++;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) correctionSites.closures++;
  if (ts.isNewExpression(node)) correctionSites.constructors++;
  if (ts.isCallExpression(node)) correctionSites.calls++;
  ts.forEachChild(node, countCorrection);
}
countCorrection(correction);
assert.deepEqual(correctionSites, { objects: 0, arrays: 0, closures: 0, constructors: 0, calls: 0 });
assert.equal(read(helperPath).replaceAll('\r\n', '\n'), base(helperPath).replaceAll('\r\n', '\n'));
const helperAst = parse(read(helperPath));
const helperSource = helperAst.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['threshold', 'getModelsDevCost'].includes(node.name.text)).map(node => node.getText(helperAst)).join('\n').replace('export function', 'function');
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
for (const label of ['baseline', 'candidate']) {
  const counts = { objects: 0, arrays: 0, closures: 0, constructors: 0 };
  const context = vm.createContext({ counts, KIMI_K3_COST: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } });
  const body = label === 'baseline' ? `return ${oldExpression};`
    : `const cost = ${expression}; ${correction.getText(newAst)} return cost;`;
  vm.runInContext(instrument(`${helperSource}\nfunction convert(m, isKimiK3) { ${body} }`), context);
  const convert = vm.runInContext('convert', context);
  for (const tiered of [false, true]) {
    const cost = { input: 3, output: 15, cache_read: 0.3, cache_write: 99,
      ...(tiered ? { tiers: [{ tier: { type: 'context', size: 100 }, input: 4, cache_write: 88 },
        { tier: { type: 'context', size: 200 }, input: 6, cache_write: 77 }] } : {}) };
    const row = { cost }, snapshot = structuredClone(row);
    for (const key of Object.keys(counts)) counts[key] = 0;
    for (let index = 0; index < 10_000; index++) {
      const result = convert(row, true);
      assert.equal(result.cacheWrite, label === 'candidate' ? 3 : 99);
      if (tiered) assert.equal(result.tiers[0].cacheWrite, label === 'candidate' ? 4 : 88);
    }
    assert.deepEqual(row, snapshot);
    assert.deepEqual(counts, { objects: tiered ? 30_000 : 10_000, arrays: tiered ? 10_000 : 0, closures: 0, constructors: 0 });
    console.log(JSON.stringify({ phase: 'generation-allocations', label, tiered, calls: 10_000, counts }));
  }
}
const manifestPath = `${dataDir}/.manifest.json`;
const oldManifest = JSON.parse(base(manifestPath)), manifest = JSON.parse(read(manifestPath));
assert.equal(manifest.generatedAt, oldManifest.generatedAt);
assert.equal(manifest.structureHash, oldManifest.structureHash);
assert.deepEqual(Object.keys(manifest.files), Object.keys(oldManifest.files));
for (const file of Object.keys(oldManifest.files)) {
  if (!providers.some(id => file === `${id}.json`)) assert.equal(manifest.files[file], oldManifest.files[file]);
}
for (const id of providers) {
  const path = `${dataDir}/${id}.json`, expected = JSON.parse(base(path));
  expected['openai-completions']['kimi-k3'].cost.cacheWrite = 3;
  assert.deepEqual(JSON.parse(read(path)), expected);
}
console.log(JSON.stringify({ phase: 'source-scope', correctionSites, runtimeFunctionChanges: 0, changedProduction,
  unchangedProviderHashes: Object.keys(manifest.files).length - 2, unchangedGeneratedAt: manifest.generatedAt }));

assert.equal(typeof globalThis.gc, 'function', '--expose-gc required');
const owners = [moonshotaiProvider(), moonshotaiCnProvider()], controllers = [], refs = [];
const watch = value => refs.push(new WeakRef(value));
async function requestLifetime(provider, entry, outcome) {
  const model = provider.getModels().find(value => value.id === 'kimi-k3');
  const controller = new AbortController(); controllers.push(controller);
  const context = { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] };
  let requests = 0;
  const options = { apiKey: 'fixture-only', signal: controller.signal, maxRetries: 0,
    onPayload(payload) { watch(payload); watch(payload.messages); },
    fetch: async () => {
      requests++;
      if (outcome === 'abort') { controller.abort('fixture abort'); throw new DOMException('fixture abort', 'AbortError'); }
      if (outcome === 'error') return new Response('fixture failure', { status: 400 });
      return new Response('data: {"id":"fixture","model":"kimi-k3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":400,"cache_write_tokens":200}}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } };
  const stream = provider[entry](model, context, options), result = await stream.result();
  assert.equal(requests, 1);
  assert.equal(result.stopReason, outcome === 'done' ? 'stop' : outcome === 'error' ? 'error' : 'aborted');
  if (outcome === 'done') assert.equal(result.usage.cost.cacheWrite, 0.0006);
  for (const value of [context, context.messages, options, stream, result, result.usage]) watch(value);
}
for (const provider of owners) for (const entry of ['stream', 'streamSimple']) {
  for (const outcome of ['done', 'error', 'abort']) await requestLifetime(provider, entry, outcome);
}
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
assert.equal(refs.filter(ref => ref.deref()).length, 0);
console.log(JSON.stringify({ phase: 'request-release', requests: 12, released: refs.length, retained: 0,
  heldControllers: controllers.length, heldProviders: owners.length, abortReason: 'primitive fixture reason' }));

const catalogRefs = [], registries = [];
async function restoreLifetime(provider, profileRevision) {
  const store = new InMemoryModelsStore(), registry = createModels({ modelsStore: store });
  registries.push(registry);
  const remote = withRemoteCatalog(provider, 'http://127.0.0.1:1', 1);
  const source = provider.getModels().find(value => value.id === 'kimi-k3');
  await store.write(provider.id, { models: [source], profileRevision, lastModified: 2 });
  registry.setProvider(remote);
  assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
  const restored = registry.getModel(provider.id, 'kimi-k3');
  assert.equal(restored.cost.cacheWrite, 3);
  const usage = { input: 400, output: 100, cacheRead: 400, cacheWrite: 200, totalTokens: 1100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  assert.equal(calculateCost(restored, usage).cacheWrite, 0.0006);
  for (const value of [restored, restored.cost, restored.capabilities, remote.getModels()]) catalogRefs.push(new WeakRef(value));
  await store.delete(provider.id);
  await registry.refresh({ allowNetwork: false });
  registry.clearProviders();
}
for (const provider of owners) for (const revision of [undefined, MODELS_STORE_PROFILE_REVISION]) await restoreLifetime(provider, revision);
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
assert.equal(catalogRefs.filter(ref => ref.deref()).length, 0);
console.log(JSON.stringify({ phase: 'catalog-release', restores: 4, released: catalogRefs.length, retained: 0, heldRegistries: registries.length }));
