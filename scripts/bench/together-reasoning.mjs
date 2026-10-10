// Run from the repository root: node --expose-gc scripts/bench/together-reasoning.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { streamSimple } from '../../packages/ai/src/api/openai-completions.ts';
import { togetherProvider } from '../../packages/ai/src/providers/together.ts';

const baseline = 'eaa63e4df7375df340659128d7c898bf17369e6d';
const id = 'deepseek-ai/DeepSeek-V4-Pro-0813';
const runtimeFiles = ['packages/ai/src/models.ts', 'packages/ai/src/models-store.ts',
  'packages/ai/src/model-capabilities.ts', 'packages/ai/src/api/simple-options.ts',
  'packages/ai/src/api/openai-completions.ts', 'packages/ai/src/utils/event-stream.ts',
  'packages/ai/src/providers/together.ts', 'packages/coding-agent/src/core/remote-catalog-provider.ts',
  'packages/coding-agent/src/core/model-catalog-merge.ts', 'packages/coding-agent/src/core/provider-composer.ts'];
const atBase = path => execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' });
for (const path of runtimeFiles) assert.equal(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), atBase(path).replaceAll('\r\n', '\n'));
console.log(JSON.stringify({ baseline, unchangedRuntimeFiles: runtimeFiles.length, node: process.version, platform: process.platform }));

function instrument(source) {
  const counts = { object: 0, array: 0, closure: 0, new: 0 };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, transformers: { before: [context => root => {
    function visit(node) {
      const value = ts.visitEachChild(node, visit, context);
      const kind = ts.isObjectLiteralExpression(node) ? 'object' : ts.isArrayLiteralExpression(node) ? 'array'
        : ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? 'closure' : ts.isNewExpression(node) ? 'new' : undefined;
      return kind ? ts.factory.createCallExpression(ts.factory.createIdentifier('__count'), undefined,
        [ts.factory.createStringLiteral(kind), value]) : value;
    }
    return ts.visitNode(root, visit);
  }] } }).outputText;
  const sandbox = { __count(kind, value) { counts[kind]++; return value; } };
  vm.runInNewContext(code, sandbox);
  const initialization = { ...counts };
  for (const key of Object.keys(counts)) counts[key] = 0;
  return { sandbox, counts, initialization };
}
const generatorPath = 'packages/ai/scripts/generate-models.ts';
for (const [label, source] of [['baseline', atBase(generatorPath)], ['candidate', readFileSync(generatorPath, 'utf8')]]) {
  const file = ts.createSourceFile('generator.ts', source, ts.ScriptTarget.Latest, true);
  const selected = file.statements.filter(node => ts.isVariableStatement(node)
    ? node.declarationList.declarations.every(declaration => ts.isIdentifier(declaration.name) && declaration.name.text.startsWith('TOGETHER_'))
    : ts.isFunctionDeclaration(node) && ['getTogetherCompat', 'getTogetherThinkingLevelMap'].includes(node.name?.text));
  const probe = instrument(selected.map(node => node.getText(file)).join('\n'));
  for (let index = 0; index < 10000; index++) {
    probe.sandbox.getTogetherCompat(id, true);
    probe.sandbox.getTogetherThinkingLevelMap(id, true);
  }
  assert.deepEqual(probe.counts, { object: 10000, array: 0, closure: 0, new: 0 });
  console.log(JSON.stringify({ label, phase: 'generation', calls: 10000, ...probe.counts, initialization: probe.initialization }));
}

// Count the exact production Together parameter branch; params/options are caller-owned.
const source = readFileSync('packages/ai/src/api/openai-completions.ts', 'utf8');
const file = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true);
let body;
function find(node) {
  if (ts.isIfStatement(node) && node.expression.getText(file) === 'compat.thinkingFormat === "together" && reasoningEnabled') body = node.thenStatement.getText(file);
  ts.forEachChild(node, find);
}
find(file);
assert.ok(body);
const before = JSON.parse(atBase('packages/ai/src/providers/data/together.json'))['openai-completions'][id];
const model = togetherProvider().getModels().find(model => model.id === id);
assert.ok(model);
for (const [label, fixture] of [['baseline', before], ['candidate', model]]) {
  const probe = instrument(`function apply(model, options, compat, params) ${body}`);
  for (const effort of [undefined, 'high', 'max']) {
    for (const key of Object.keys(probe.counts)) probe.counts[key] = 0;
    const options = { reasoningEffort: effort }, params = {};
    for (let index = 0; index < 10000; index++) probe.sandbox.apply(fixture, options, fixture.compat, params);
    assert.deepEqual(probe.counts, { object: 10000, array: 0, closure: 0, new: 0 });
    assert.equal(params.reasoning_effort, label === 'candidate' ? effort : undefined);
    console.log(JSON.stringify({ label, phase: 'request-branch', effort: effort ?? 'off', calls: 10000, ...probe.counts }));
  }
}

assert.equal(typeof globalThis.gc, 'function', '--expose-gc is required');
const refs = [], heldControllers = [];
const watch = value => refs.push(new WeakRef(value));
async function requestLifetime(reasoning, outcome) {
  const controller = new AbortController(); heldControllers.push(controller);
  const context = { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] };
  let sends = 0, payloads = 0;
  const options = { apiKey: 'fixture-only', reasoning, signal: controller.signal, maxRetries: 0,
    onPayload(value) { payloads++; watch(value); watch(value.reasoning); },
    fetch: async () => {
      sends++;
      if (outcome === 'abort') { controller.abort(); throw new DOMException('fixture abort', 'AbortError'); }
      if (outcome === 'error') return new Response('fixture failure', { status: 500 });
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } };
  const stream = streamSimple(model, context, options);
  const result = await stream.result();
  assert.equal(result.stopReason, outcome === 'done' ? 'stop' : outcome === 'abort' ? 'aborted' : 'error');
  assert.equal(sends, 1); assert.equal(payloads, 1);
  for (const value of [context, context.messages, options, stream, result]) watch(value);
}
for (const reasoning of [undefined, 'high', 'max']) for (const outcome of ['done', 'error', 'abort']) await requestLifetime(reasoning, outcome);
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
assert.equal(refs.filter(ref => ref.deref()).length, 0);
assert.equal(heldControllers.length, 9);
console.log(JSON.stringify({ phase: 'request-owner-release', requests: 9, payloads: 9, released: refs.length, retained: 0, heldControllers: heldControllers.length, heldCatalogModel: model.id }));
