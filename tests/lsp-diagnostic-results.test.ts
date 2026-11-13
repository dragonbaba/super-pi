import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { removeOwnedFixture } from './helpers/owned-fixture-cleanup.ts';
import { MIN_DIAGNOSTIC_WAIT_MS, MAX_DIAGNOSTIC_WAIT_MS } from '../packages/lsp/src/limits.ts';
import { DIAGNOSTIC_BATCH_SIZE } from '../packages/lsp/src/limits.ts';
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
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 160 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, false); assert.equal(result.details.summary.diagnostics, 1);
  assert.equal(result.details.outcomes[0].completion, 'report'); assert.equal(result.details.outcomes[0].projectReady, true);
 } finally { await f.close(); }
});
test('a pre-readiness empty publication remains unconfirmed at the window boundary', async () => {
 const f = fixture('loading-empty');
 try {
  const result = await runDiagnostics(f.pool, f.adapter, { root: f.root, paths: ['confirmed.ts'], waitMs: 80 }, 5000, undefined, f.ctx, 'signal');
  assert.equal(result.isError, true); assert.deepEqual(result.details.unconfirmedFiles, ['confirmed.ts']);
  assert.equal(result.details.outcomes[0].receivedReport, true); assert.equal(result.details.outcomes[0].completion, 'window_expired');
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
 } finally { await events.get('session_shutdown')({}, f.ctx); await f.close(); }
});
