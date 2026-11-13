import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { removeOwnedFixture } from './helpers/owned-fixture-cleanup.ts';
import { MIN_DIAGNOSTIC_WAIT_MS, MAX_DIAGNOSTIC_WAIT_MS } from '../packages/lsp/src/limits.ts';
import { DIAGNOSTIC_BATCH_SIZE } from '../packages/lsp/src/limits.ts';
import { DIAGNOSTIC_PROJECT_READY_MARGIN_MS } from '../packages/lsp/src/limits.ts';
const jiti = createJiti(import.meta.url);
const { runDiagnostics } = await jiti.import<any>('../packages/lsp/src/runner.ts');
const { LspClientPool } = await jiti.import<any>('../packages/lsp/src/client-pool.ts');
const { default: extension } = await jiti.import<any>('../packages/lsp/src/pi-lsp.ts');
function fixture(mode: string) {
 const root = mkdtempSync(join(tmpdir(), 'lsp-results-')), pool = new LspClientPool();
 for (const name of ['confirmed.ts', 'silent.ts']) writeFileSync(join(root, name), 'const value = 1;');
 const adapter = { name: 'signal', defaultCommand: { command: process.execPath, args: [resolve('tests/fixtures/lsp-diagnostic-signal-server.mjs'), mode] }, pushDiagnosticsGraceMs: 120, diagnosticsSettleMs: 5,
  languageIdFor() { return 'typescript'; }, isSupportedFile(file: string) { return file.endsWith('.ts'); } };
 const ctx = { cwd: root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
 return { root, pool, adapter, ctx, async close() { try { await pool.shutdownAll(); } finally { removeOwnedFixture(root); } } };
}
test('project readiness does not prematurely confirm empty reports preceding late diagnostics', async () => {
 const f = fixture('late-ready');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 1500 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, false); assert.equal(result.details.summary.diagnostics, 1);
  assert.equal(result.details.outcomes[0].completion, 'report'); assert.equal(result.details.outcomes[0].projectReady, true);
 } finally { await f.close(); }
});
test('a pre-ready empty report is confirmed after the project stays ready for the shared margin', async () => {
 const f = fixture('ready-empty');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: DIAGNOSTIC_PROJECT_READY_MARGIN_MS + 1000 }, 10000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, false); assert.equal(result.details.summary.files, 1);
  const outcome = result.details.outcomes[0];
  assert.equal(outcome.completion, 'window_expired'); assert.equal(outcome.receivedReport, true);
  assert.equal(outcome.projectReady, false); assert.equal(outcome.projectReadyAtCompletion, true);
  assert(outcome.projectReadyForMs >= DIAGNOSTIC_PROJECT_READY_MARGIN_MS);
  const next = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 1500 }, 5000, undefined, f.ctx, 'new-loading-cycle');
  assert.equal(next.isError, true, 'a new loading cycle must reset the previous readiness age');
  assert.equal(next.details.outcomes[0].projectReadyAtCompletion, true);
  assert(next.details.outcomes[0].projectReadyForMs < DIAGNOSTIC_PROJECT_READY_MARGIN_MS);
 } finally { await f.close(); }
});
test('a ready project with insufficient margin remains unconfirmed at the deadline', async () => {
 const f = fixture('ready-empty');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 1500 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, true); assert.deepEqual(result.details.unconfirmedFiles, ['confirmed.ts']);
  const outcome = result.details.outcomes[0];
  assert.equal(outcome.projectReady, false); assert.equal(outcome.projectReadyAtCompletion, true);
  assert(outcome.projectReadyForMs < DIAGNOSTIC_PROJECT_READY_MARGIN_MS);
 } finally { await f.close(); }
});
test('the overall deadline accepts a report received while ready before reloading', async () => {
 const f = fixture('ready-clear'); f.adapter.diagnosticsSettleMs = 5000;
 try {
  const lease = await f.pool.acquire(f.adapter, f.root, 5000); f.pool.release(lease);
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 500 }, 500, undefined, f.ctx, 'signal');
  assert.equal(result.isError, false); assert.deepEqual(result.details.unconfirmedFiles, []);
  const outcome = result.details.outcomes[0];
  assert.equal(outcome.completion, 'window_expired'); assert.equal(outcome.projectReady, true);
  assert.equal(outcome.projectReadyAtCompletion, false); assert.equal(outcome.projectReadyForMs, 0);
 } finally { await f.close(); }
});
test('the fallback deadline accepts a report received while ready before reloading', async () => {
 const f = fixture('ready-reload');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 1500 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, false); assert.equal(result.details.summary.files, 1);
  const outcome = result.details.outcomes[0];
  assert.equal(outcome.completion, 'window_expired'); assert.equal(outcome.projectReady, true);
  assert.equal(outcome.projectReadyAtCompletion, false); assert.equal(outcome.projectReadyForMs, 0);
 } finally { await f.close(); }
});
test('deadline calls without observation retain the existing current-readiness rule', async () => {
 const f = fixture('ready-reload'), uri = pathToFileURL(join(f.root, 'confirmed.ts')).href;
 try {
  const lease = await f.pool.acquire(f.adapter, f.root, 5000), client = lease.client;
  try {
   client.didOpen(uri, 'const value = 1;', 'typescript');
   await assert.rejects(client.diagnostics(uri, true, 1500), /unconfirmed/);
   assert.equal(client.projectReady, false);
  } finally { try { if (client.running) client.didClose(uri); } finally { f.pool.release(lease); } }
 } finally { await f.close(); }
});
test('a pre-readiness empty publication remains unconfirmed at the window boundary', async () => {
 const f = fixture('loading-empty');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 80 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, true); assert.deepEqual(result.details.unconfirmedFiles, ['confirmed.ts']);
  assert.equal(result.details.outcomes[0].receivedReport, true); assert.equal(result.details.outcomes[0].completion, 'window_expired');
  assert.equal(result.details.outcomes[0].projectReadyAtCompletion, false);
  assert.equal(result.details.outcomes[0].projectReadyForMs, 0);
 } finally { await f.close(); }
});
test('partial results retain confirmed reports and retry only the unconfirmed path', async () => {
 const f = fixture('mixed');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts', 'silent.ts'], waitMs: 80 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, true); assert.equal(result.details.status, 'partial'); assert.equal(result.details.summary.files, 1);
  assert.equal(result.details.summary.diagnostics, 1); assert.deepEqual(result.details.unconfirmedFiles, ['silent.ts']);
  assert.equal(result.details.batchCount, 1); assert(result.details.elapsedMs > 0);
  const retry = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: result.details.unconfirmedFiles, waitMs: 80 }, 5000, undefined, f.ctx, 'retry');
  assert.equal(retry.isError, false); assert.equal(retry.details.submittedFiles, 1);
  const lease = await f.pool.acquire(f.adapter, f.root, 5000);
  assert.equal((await lease.client.workspaceSymbols('stats'))[0].name, '3'); f.pool.release(lease);
 } finally { await f.close(); }
});
test('a missing collected file preserves nonempty diagnostics and continues later files', async () => {
 const f = fixture('mixed'), after = join(f.root, 'after-confirmed.ts');
 writeFileSync(after, 'const value = 2;'); unlinkSync(join(f.root, 'silent.ts'));
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, files: [join(f.root, 'confirmed.ts'), join(f.root, 'silent.ts'), after], waitMs: 80 }, 5000, undefined, f.ctx, 'read-error');
  assert.equal(result.isError, true); assert.equal(result.details.status, 'partial');
  assert.equal(result.details.summary.files, 2); assert.equal(result.details.summary.diagnostics, 2);
  assert.equal(result.details.submittedFiles, 2); assert.deepEqual(result.details.unconfirmedFiles, ['silent.ts']);
  assert.deepEqual(result.details.files.map((entry: any) => entry.path), ['confirmed.ts', 'after-confirmed.ts']);
  assert.equal(result.details.outcomes[1].completion, 'read_error'); assert.equal(result.details.outcomes[1].receivedReport, false);
  assert.match(result.details.outcomes[1].error!, /ENOENT/);
  const next = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 80 }, 5000, undefined, f.ctx, 'next');
  assert.equal(next.isError, false); assert.equal(next.details.summary.diagnostics, 1);
 } finally { await f.close(); }
});
test('a completed file refills its slot while the other initial documents are still waiting', { timeout: 10000 }, async () => {
 const f = fixture('mixed'), controller = new AbortController();
 try {
  const files = [join(f.root, 'confirmed.ts')];
  for (let index = 0; index < DIAGNOSTIC_BATCH_SIZE; index++) { const file = join(f.root, `pending-${index}.ts`); writeFileSync(file, 'const value = 1;'); files.push(file); }
  const lease = await f.pool.acquire(f.adapter, f.root, 5000), client = lease.client;
  let announce!: () => void, completed = 0;
  const refilled = new Promise<void>(resolve => { announce = resolve; });
  const open = client.didOpen.bind(client), collect = client.collectDiagnosticReport.bind(client);
  client.didOpen = (...args: any[]) => { const result = open(...args); if (args[0].endsWith(`pending-${DIAGNOSTIC_BATCH_SIZE - 1}.ts`)) announce(); return result; };
  client.collectDiagnosticReport = async (...args: any[]) => { const result = await collect(...args); completed++; return result; };
  const work = runDiagnostics(f.pool, f.adapter, { root: f.root, files, waitMs: 5000 }, 5000, controller.signal, f.ctx, 'sliding');
  const cancelled = assert.rejects(work, /abort|cancel/i);
  await refilled; assert.equal(completed, 1, 'refill does not wait for the rest of the initial window');
  assert.equal((await client.workspaceSymbols('stats'))[0].name, String(DIAGNOSTIC_BATCH_SIZE + 1));
  controller.abort(); await cancelled; f.pool.release(lease);
 } finally { await f.close(); }
});
test('server exit retains previously confirmed diagnostics and identifies pending paths', async () => {
 const f = fixture('exit-command');
 try {
  const lease = await f.pool.acquire(f.adapter, f.root, 5000), client = lease.client;
  let confirmed!: () => void; const ready = new Promise<void>(resolve => { confirmed = resolve; });
  const collect = client.collectDiagnosticReport.bind(client);
  client.collectDiagnosticReport = async (...args: any[]) => { const report = await collect(...args); if (args[0].endsWith('confirmed.ts')) confirmed(); return report; };
  const work = runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts', 'silent.ts'], waitMs: 1000 }, 5000, undefined, f.ctx, 'signal');
  await ready; await assert.rejects(client.workspaceSymbols('exit'), /exited|closed/);
  const result = await work; assert.equal(result.isError, true); assert.equal(result.details.status, 'failed');
  assert.equal(result.details.summary.files, 1); assert.equal(result.details.summary.diagnostics, 1); assert.deepEqual(result.details.unconfirmedFiles, ['silent.ts']);
  f.pool.release(lease);
 } finally { await f.close(); }
});
test('the registered tool exposes waitMs, caps it by global timeout, and preserves partial status', async () => {
 const f = fixture('silent'), tools = new Map<string, any>(), events = new Map<string, any>();
 extension({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on(name: string, fn: any) { events.set(name, fn); } });
 mkdirSync(join(f.root, '.sp/config'), { recursive: true });
 const config = (timeout: number) => writeFileSync(join(f.root, '.sp/config/pi-lsp.json'), JSON.stringify({ timeout, servers: { signal: { command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args], extensions: ['.ts'], pushDiagnosticsGraceMs: 120, diagnosticsSettleMs: 5 } } }));
 try {
  config(5000); const tool = tools.get('lsp_diagnostics');
  assert.equal(tool.parameters.properties.waitMs.minimum, MIN_DIAGNOSTIC_WAIT_MS); assert.equal(tool.parameters.properties.waitMs.maximum, MAX_DIAGNOSTIC_WAIT_MS);
  await tool.execute('warm', { paths: ['silent.ts'], server: 'signal', waitMs: MIN_DIAGNOSTIC_WAIT_MS }, undefined, undefined, f.ctx);
  config(80);
  const result = await tool.execute('capped', { paths: ['silent.ts'], server: 'signal', waitMs: 200 }, undefined, undefined, f.ctx);
  assert.equal(result.isError, true); assert.equal(result.details.status, 'partial'); assert.deepEqual(result.details.unconfirmedFiles, ['silent.ts']);
  const detail = result.details.routes[0].details; assert.equal(detail.effectiveWaitMs, 80); assert.equal(detail.outcomes[0].completion, 'window_expired');
  assert(detail.outcomes[0].elapsedMs >= 60);
  await assert.rejects(tool.execute('invalid', { paths: ['silent.ts'], server: 'signal', waitMs: MAX_DIAGNOSTIC_WAIT_MS + 1 }, undefined, undefined, f.ctx), /waitMs/);
  f.ctx.ui.setStatus = (_key?: string, value?: string) => { if (value) unlinkSync(join(f.root, 'silent.ts')); };
  const missing = await tool.execute('missing-after-collection', { paths: ['silent.ts'], server: 'signal', waitMs: 80 }, undefined, undefined, f.ctx);
  assert.equal(missing.isError, true); assert.equal(missing.details.status, 'partial');
  assert.equal(missing.details.submittedFiles, 0); assert.deepEqual(missing.details.unconfirmedFiles, ['silent.ts']);
  assert.equal(missing.details.routes[0].details.outcomes[0].completion, 'read_error');
 } finally { await events.get('session_shutdown')({}, f.ctx); await f.close(); }
});
