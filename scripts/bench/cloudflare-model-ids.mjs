// Run after npm run build:offline: node --expose-gc scripts/bench/cloudflare-model-ids.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { withModelProfile } from '../../packages/ai/src/model-capabilities.ts';
import { cloudflareAIGatewayProvider } from '../../packages/ai/src/providers/cloudflare-ai-gateway.ts';

const baseline = '8ed7d79e8d81c197274a95725358cb92c3cec68e';
const atBase = path => execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' });
const read = path => readFileSync(path, 'utf8');
const generatorPath = 'packages/ai/scripts/generate-models.ts';
const catalogPath = 'packages/ai/src/providers/data/cloudflare-ai-gateway.json';
const manifestPath = 'packages/ai/src/providers/data/.manifest.json';
const changedProduction = execFileSync('git', ['diff', '--name-only', baseline, '--', 'packages'], { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
assert.deepEqual(changedProduction, [generatorPath, catalogPath, manifestPath].sort());

// Compare the complete loader AST; only this ID assignment may change.
function idExpression(source) {
  const file = ts.createSourceFile('generator.ts', source, ts.ScriptTarget.Latest, true);
  let expression;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'upstream === "anthropic"') {
      const assignment = node.thenStatement.statements.find(statement => ts.isExpressionStatement(statement)
        && ts.isBinaryExpression(statement.expression) && statement.expression.left.getText(file) === 'id');
      expression = assignment.expression.right;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(expression);
  return expression.getText(file);
}
const before = atBase(generatorPath), after = read(generatorPath);
const beforeExpression = idExpression(before), afterExpression = idExpression(after);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = source => printer.printFile(ts.createSourceFile('generator.ts', source, ts.ScriptTarget.Latest, true));
assert.equal(print(after.replace(`id = ${afterExpression};`, `id = ${beforeExpression};`)), print(before));
for (const [label, expression] of [['baseline', beforeExpression], ['candidate', afterExpression]]) {
  const file = ts.createSourceFile('expression.ts', expression, ts.ScriptTarget.Latest, true);
  const sites = { objects: 0, arrays: 0, closures: 0, constructors: 0, calls: 0 };
  function count(node) {
    if (ts.isObjectLiteralExpression(node)) sites.objects++;
    if (ts.isArrayLiteralExpression(node)) sites.arrays++;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) sites.closures++;
    if (ts.isNewExpression(node)) sites.constructors++;
    if (ts.isCallExpression(node)) sites.calls++;
    ts.forEachChild(node, count);
  }
  count(file);
  assert.deepEqual(sites, { objects: 0, arrays: 0, closures: 0, constructors: 0, calls: label === 'candidate' ? 1 : 0 });
  const convert = vm.runInNewContext(`(function(nativeId) { return ${expression}; })`);
  for (const input of ['claude-opus-5.5', 'claude-sonnet-4-5']) {
    for (let index = 0; index < 10_000; index++) {
      const output = convert(input);
      assert.equal(output, label === 'candidate' ? input.replaceAll('.', '-') : input);
      assert.equal(output.length, input.length);
    }
  }
  console.log(JSON.stringify({ phase: 'generation-id', label, calls: 20_000, sites,
    note: 'one bounded string replacement per catalog row; no request-time normalization' }));
}

const oldCatalog = JSON.parse(atBase(catalogPath)), catalog = JSON.parse(read(catalogPath));
const expected = structuredClone(oldCatalog);
let renamed = 0;
expected['anthropic-messages'] = Object.fromEntries(Object.entries(oldCatalog['anthropic-messages']).map(([id, value]) => {
  const canonical = id.replaceAll('.', '-');
  if (canonical !== id) renamed++;
  const corrected = { ...value, id: canonical };
  assert.deepEqual(withModelProfile(corrected, 'built-in').capabilities, withModelProfile(value, 'built-in').capabilities);
  return [canonical, corrected];
}));
assert.equal(renamed, 7);
assert.deepEqual(catalog, expected);
const oldManifest = JSON.parse(atBase(manifestPath)), manifest = JSON.parse(read(manifestPath));
assert.equal(manifest.generatedAt, oldManifest.generatedAt);
assert.deepEqual(Object.keys(manifest.files), Object.keys(oldManifest.files));
for (const file of Object.keys(oldManifest.files)) if (file !== 'cloudflare-ai-gateway.json') assert.equal(manifest.files[file], oldManifest.files[file]);
console.log(JSON.stringify({ phase: 'source-and-data', changedProduction, runtimeFunctionChanges: 0, renamed,
  unchangedProviderHashes: Object.keys(manifest.files).length - 1, generatedAt: manifest.generatedAt, capabilitiesUnchanged: true }));

assert.equal(typeof globalThis.gc, 'function', '--expose-gc required');
const provider = cloudflareAIGatewayProvider();
const baselineLifecycle = process.argv.includes('--baseline-lifecycle');
// Runtime sources are identical: replay only the old metadata through the same provider.
const model = baselineLifecycle ? withModelProfile(oldCatalog['anthropic-messages']['claude-sonnet-4.5'], 'built-in')
  : provider.getModels().find(value => value.id === 'claude-sonnet-4-5');
assert.ok(model);
const refs = [], controllers = [];
const watch = (value, label) => refs.push({ ref: new WeakRef(value), label });
async function requestLifetime(entry, outcome) {
  const controller = new AbortController(); controllers.push(controller);
  const context = { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] };
  let requests = 0, payloads = 0;
  const options = { apiKey: 'fixture-only', maxRetries: 0, signal: controller.signal,
    env: { CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_GATEWAY_ID: 'fixture-gateway' },
    onPayload(payload, resolvedModel) {
      payloads++;
      watch(payload, `${entry}/${outcome}/payload`);
      watch(payload.messages, `${entry}/${outcome}/wire-messages`);
      watch(resolvedModel, `${entry}/${outcome}/resolved-model`);
    },
    fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), 'https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages');
      assert.equal(JSON.parse(String(init.body)).model, model.id);
      if (outcome === 'abort') { controller.abort(); throw new DOMException('fixture abort', 'AbortError'); }
      if (outcome === 'error') return new Response('fixture failure', { status: 500 });
      return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","content":[],"model":"fixture","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } };
  const stream = provider[entry](model, context, options);
  const result = await stream.result();
  assert.equal(result.stopReason, outcome === 'done' ? 'stop' : outcome === 'abort' ? 'aborted' : 'error');
  assert.equal(requests, 1); assert.equal(payloads, 1);
  for (const [name, value] of Object.entries({ context, messages: context.messages, options, env: options.env, stream, result })) {
    watch(value, `${entry}/${outcome}/${name}`);
  }
}
for (const entry of ['stream', 'streamSimple']) for (const outcome of ['done', 'error', 'abort']) await requestLifetime(entry, outcome);
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
// Caller-owned default abort reasons can retain V8's lazy stack and its captured
// frames. Measure that boundary, then materialize only the fixture-owned stacks.
console.log(JSON.stringify({ phase: 'caller-abort-reason', retainedBeforeStackMaterialization:
  refs.filter(({ ref }) => ref.deref()).map(({ label }) => label) }));
for (const controller of controllers) if (controller.signal.aborted) void controller.signal.reason.stack;
for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); }
const retained = refs.filter(({ ref }) => ref.deref()).map(({ label }) => label);
assert.deepEqual(retained, []);
assert.equal(controllers.length, 6);
console.log(JSON.stringify({ phase: 'request-release', requests: 6, payloads: 6, released: refs.length, retained: 0,
  baselineLifecycle, heldControllers: controllers.length, heldProvider: provider.id, heldModel: model.id }));
