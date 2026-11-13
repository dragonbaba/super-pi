import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import { removeOwnedFixture } from './helpers/owned-fixture-cleanup.ts';
import { DIAGNOSTIC_BATCH_SIZE, MAX_COLLECTED_FILES } from '../packages/lsp/src/limits.ts';
const jiti = createJiti(import.meta.url);
const { runDiagnostics } = await jiti.import<any>('../packages/lsp/src/runner.ts');
const { LspClientPool } = await jiti.import<any>('../packages/lsp/src/client-pool.ts');
function fixture(mode = 'full') {
  const root = mkdtempSync(join(tmpdir(), 'sp-lsp-batches-'));
  const files: string[] = [];
  for (let index = 0; index < MAX_COLLECTED_FILES; index++) {
    const file = join(root, `${String(index).padStart(3, '0')}.ts`);
    writeFileSync(file, 'const value = 1;'); files.push(file);
  }
  const adapter = { name: 'batch-fixture', defaultCommand: { command: process.execPath, args: [resolve('tests/fixtures/lsp-batch-server.mjs'), mode] },
    languageIdFor() { return 'typescript'; }, isSupportedFile(file: string) { return file.endsWith('.ts'); } };
  return { root, files, adapter };
}
const ctx = { ui: { setStatus() {} } };
test('diagnostics checks the entire collection while bounding simultaneously open documents', async t => {
  const f = fixture(), pool = new LspClientPool();
  try {
    const result = await runDiagnostics(pool, f.adapter, { root: f.root, files: f.files }, 5000, undefined, ctx, 'batch');
    assert.equal(result.details.status, 'diagnostics_received');
    assert.equal(result.details.summary.files, MAX_COLLECTED_FILES);
    assert.deepEqual(result.details.files.map((entry: any) => entry.path), f.files.map(file => file.slice(f.root.length + 1)));
    const lease = await pool.acquire(f.adapter, f.root, 5000);
    const stats = JSON.parse((await lease.client.workspaceSymbols('stats'))[0].name);
    pool.release(lease);
    assert.deepEqual(stats, { opened: MAX_COLLECTED_FILES, closed: MAX_COLLECTED_FILES, active: 0, peak: DIAGNOSTIC_BATCH_SIZE, reports: MAX_COLLECTED_FILES });
    t.diagnostic(JSON.stringify(stats));
  } finally { try { await pool.shutdownAll(); } finally { removeOwnedFixture(f.root); } }
});
test('server exit after a complete batch and a partial batch fails, and the next request uses a fresh server', async () => {
  const f = fixture('exit-after-partial'), pool = new LspClientPool();
  try {
    await assert.rejects(runDiagnostics(pool, f.adapter, { root: f.root, files: f.files }, 5000, undefined, ctx, 'batch'), /exited|closed|stopping|stdin/i);
    const result = await runDiagnostics(pool, f.adapter, { root: f.root, files: [f.files[0]] }, 5000, undefined, ctx, 'batch');
    assert.equal(result.details.summary.files, 1);
    assert.equal(result.details.status, 'diagnostics_received');
  } finally { try { await pool.shutdownAll(); } finally { removeOwnedFixture(f.root); } }
});
for (const cancel of [false, true]) {
  test(`a ${cancel ? 'cancellation' : 'read failure'} between batches stops the next batch and permits the next request`, async () => {
    const f = fixture(), pool = new LspClientPool(), controller = new AbortController();
    try {
      const lease = await pool.acquire(f.adapter, f.root, 5000), client = lease.client;
      pool.release(lease);
      const diagnostics = client.diagnostics.bind(client);
      let received = 0;
      client.diagnostics = async (...args: any[]) => {
        const result = await diagnostics(...args);
        if (++received === DIAGNOSTIC_BATCH_SIZE) {
          if (cancel) controller.abort();
          else unlinkSync(f.files[DIAGNOSTIC_BATCH_SIZE]);
        }
        return result;
      };
      await assert.rejects(runDiagnostics(pool, f.adapter, { root: f.root, files: f.files }, 5000, controller.signal, ctx, 'batch'), cancel ? /cancel|abort|closed|stopping/i : /ENOENT/);
      assert.equal(received, DIAGNOSTIC_BATCH_SIZE, 'no second-batch diagnostic request');
      if (cancel) assert.equal(client.running, false);
      else {
        const stats = JSON.parse((await client.workspaceSymbols('stats'))[0].name);
        assert.equal(stats.active, 0); assert.equal(stats.closed, DIAGNOSTIC_BATCH_SIZE);
      }
      const next = await runDiagnostics(pool, f.adapter, { root: f.root, files: [f.files[0]] }, 5000, undefined, ctx, 'batch');
      assert.equal(next.details.summary.files, 1);
    } finally { try { await pool.shutdownAll(); } finally { removeOwnedFixture(f.root); } }
  });
}
