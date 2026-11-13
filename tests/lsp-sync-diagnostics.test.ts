import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import { removeOwnedFixture } from './helpers/owned-fixture-cleanup.ts';
import { LspClientPool } from '../packages/lsp/src/client-pool.ts';
import { runDiagnostics } from '../packages/lsp/src/runner.ts';
import { DIAGNOSTIC_BATCH_SIZE } from '../packages/lsp/src/limits.ts';
import { convertTypeScriptDiagnostics, typescriptDiagnosticsCapability, TYPESCRIPT_SYNCHRONOUS_DIAGNOSTICS as capability } from '../packages/lsp/src/typescript-diagnostics.ts';

function fixture(mode = 'normal', concurrency = capability.maxConcurrentFiles) {
  const root = mkdtempSync(join(tmpdir(), 'lsp-sync-')), pool = new LspClientPool();
  for (const file of ['good.ts', 'bad.ts', 'after.ts']) writeFileSync(join(root, file), 'const value = 1;');
  const adapter = { name: 'arbitrary-fixture-name', defaultCommand: { command: process.execPath, args: [resolve('tests/fixtures/lsp-sync-diagnostic-server.mjs'), mode] }, synchronousDiagnostics: { ...capability, maxConcurrentFiles: concurrency },
    languageIdFor() { return 'typescript'; }, isSupportedFile(file: string) { return file.endsWith('.ts'); } };
  const ctx = { ui: { setStatus() {} } };
  return { root, pool, adapter, ctx, async stats() { const lease = await pool.acquire(adapter as any, root, 5000); try { return JSON.parse((await lease.client.workspaceSymbols('stats'))[0].name); } finally { pool.release(lease); } },
    async close() { try { await pool.shutdownAll(); } finally { removeOwnedFixture(root); } } };
}

test('conversion matches language-server positions, severity, source, tags and related spans without mutating input', () => {
  const file = resolve('related file.ts');
  const raw = ['error', 'warning', 'suggestion', 'message'].map(category => ({ start: { line: 2, offset: 3 }, end: { line: 4, offset: 6 }, text: 'message', code: 123, category, source: 'custom', reportsUnnecessary: {}, reportsDeprecated: true,
    relatedInformation: [{ message: 'related', span: { file, start: { line: 3, offset: 2 }, end: { line: 3, offset: 4 } } }] }));
  const before = structuredClone(raw), result = convertTypeScriptDiagnostics(raw);
  assert.deepEqual(result.map(item => item.severity), [1, 2, 4, 1]);
  assert.deepEqual(result[0].range, { start: { line: 1, character: 2 }, end: { line: 3, character: 5 } });
  assert.equal(result[0].code, 123); assert.equal(result[0].source, 'custom'); assert.deepEqual(result[0].tags, [1, 2]);
  assert.deepEqual(result[0].relatedInformation, [{ message: 'related', location: { uri: pathToFileURL(file).href, range: { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } } } }]);
  assert.deepEqual(raw, before); assert.deepEqual(convertTypeScriptDiagnostics([]), []);
	assert.deepEqual(convertTypeScriptDiagnostics(raw, [123]), []);
	assert.equal(convertTypeScriptDiagnostics(raw, ['123']).length, raw.length);
  assert.throws(() => convertTypeScriptDiagnostics([{ ...raw[0], start: { line: 0, offset: 1 } }]), /position/);
  assert.equal(typescriptDiagnosticsCapability('typescript', 'node'), capability);
  assert.equal(typescriptDiagnosticsCapability('alias', 'D:/bin/typescript-language-server.cmd'), capability);
  assert.equal(typescriptDiagnosticsCapability('biome', 'biome'), undefined);
});

test('declared and advertised bridge uses all three sync requests with no wait or readiness fields', async () => {
  const f = fixture('slow');
  try {
    const lease = await f.pool.acquire(f.adapter as any, f.root, 5000); f.pool.release(lease);
    const result = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'], waitMs: 1 }, 100, undefined, f.ctx, 'sync');
    assert.equal(result.isError, false); assert.equal(result.details.diagnosticPath, 'sync-request'); assert.equal(result.details.effectiveWaitMs, 'not_applicable');
    assert.equal(result.details.summary.files, 1); assert.equal(result.details.summary.diagnostics, 1);
    const outcome = result.details.outcomes[0]; assert(outcome.elapsedMs > 0); assert.equal(outcome.receivedReport, true);
    assert.equal(Object.hasOwn(outcome, 'projectReady'), false); assert.equal(Object.hasOwn(outcome, 'projectReadyAtCompletion'), false); assert.equal(Object.hasOwn(outcome, 'projectReadyForMs'), false);
    const stats = await f.stats(); assert.deepEqual(stats.counts, [1, 1, 1]); assert.equal(stats.active, 0);
  } finally { await f.close(); }
});

test('configured ignored codes match publication suppression and changing configuration preserves the next call', async () => {
	const f = fixture();
	try {
		for (const ignored of [true, false]) {
			const adapter = { ...f.adapter, initialization: { diagnostics: { ignoredCodes: [ignored ? 9001 : 9002] } } };
			const result = await runDiagnostics(f.pool, adapter as any, { root: f.root, paths: ['good.ts'] }, 5000, undefined, f.ctx, 'ignored-codes');
			assert.equal(result.isError, false); assert.equal(result.details.summary.files, 1);
			assert.equal(result.details.summary.diagnostics, ignored ? 0 : 1);
			assert.equal(result.details.diagnosticPath, 'sync-request');
			const lease = await f.pool.acquire(adapter as any, f.root, 5000);
			try { assert.deepEqual(JSON.parse((await lease.client.workspaceSymbols('stats'))[0].name).counts, [1, 1, 1]); }
			finally { f.pool.release(lease); }
		}
	} finally { await f.close(); }
});

test('a reused sync client uses the current global timeout after configuration increases', async () => {
  const f = fixture('slow-semantic');
  try {
    const lease = await f.pool.acquire(f.adapter as any, f.root, 1000); f.pool.release(lease);
    const result = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'], waitMs: 1 }, 2500, undefined, f.ctx, 'increased-timeout');
    assert.equal(result.isError, false); assert.equal(result.details.summary.files, 1); assert.deepEqual((await f.stats()).counts, [1, 1, 1]);
  } finally { await f.close(); }
});

for (const mode of ['missing', 'pull']) test(`an unadvertised command retains the existing ${mode === 'pull' ? 'pull' : 'publish'} route`, async () => {
  const f = fixture(mode);
  try {
    const result = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'], waitMs: 80 }, 5000, undefined, f.ctx, 'fallback');
    assert.equal(result.isError, false); assert.equal(result.details.diagnosticPath, mode === 'pull' ? 'pull' : 'publish'); assert.equal(result.details.effectiveWaitMs, 80);
    assert('syncRequestFallback' in result.details); assert.equal(result.details.syncRequestFallback, 'command_not_advertised');
    const stats = await f.stats(); assert.deepEqual(stats.counts, [0, 0, 0]); assert.equal(stats.pull, mode === 'pull' ? 1 : 0);
  } finally { await f.close(); }
});

test('advertisement alone does not opt an unrelated adapter into synchronous diagnostics', async () => {
  const f = fixture();
  try {
    const adapter = { ...f.adapter, synchronousDiagnostics: undefined };
    const result = await runDiagnostics(f.pool, adapter as any, { root: f.root, paths: ['good.ts'], waitMs: 80 }, 5000, undefined, f.ctx, 'publish');
    assert.equal(result.details.diagnosticPath, 'publish'); assert.equal(result.isError, false);
    assert.deepEqual((await f.stats()).counts, [0, 0, 0]);
  } finally { await f.close(); }
});

for (const mode of ['failure', 'rpc-error', 'missing-body']) test(`${mode} makes only that file unconfirmed without retry or publication fallback`, async () => {
  const f = fixture(mode);
  try {
    const result = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts', 'bad.ts', 'after.ts'], waitMs: 1 }, 5000, undefined, f.ctx, 'partial');
    assert.equal(result.isError, true); assert.equal(result.details.status, 'partial'); assert.equal(result.details.summary.files, 2); assert.equal(result.details.summary.diagnostics, 2);
    assert.deepEqual(result.details.unconfirmedFiles, ['bad.ts']); assert.equal(result.details.outcomes[1].completion, 'request_failed');
    assert.match(result.details.outcomes[1].error!, /semanticDiagnosticsSync/); assert.deepEqual((await f.stats()).counts, [3, 3, 2]);
    const next = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'] }, 5000, undefined, f.ctx, 'next'); assert.equal(next.isError, false);
  } finally { await f.close(); }
});

test('sync timeout uses global timeout, isolates the file and preserves later diagnostics', async () => {
  const f = fixture('timeout');
  try {
    const lease = await f.pool.acquire(f.adapter as any, f.root, 5000); f.pool.release(lease);
    const result = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['bad.ts', 'good.ts'], waitMs: 1 }, 80, undefined, f.ctx, 'timeout');
    assert.equal(result.isError, true); assert.equal(result.details.summary.files, 1); assert.equal(result.details.summary.diagnostics, 1); assert.deepEqual(result.details.unconfirmedFiles, ['bad.ts']);
    assert.match(result.details.outcomes[0].error!, /timed out/); assert.deepEqual((await f.stats()).counts, [2, 2, 1]);
  } finally { await f.close(); }
});

test('server exit retains completed sync files and marks the remaining suffix unconfirmed', async () => {
  const f = fixture('exit');
  try {
    const result = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts', 'bad.ts', 'after.ts'] }, 5000, undefined, f.ctx, 'exit');
    assert.equal(result.isError, true); assert.equal(result.details.status, 'failed'); assert.equal(result.details.summary.files, 1);
    assert.deepEqual(result.details.unconfirmedFiles, ['bad.ts', 'after.ts']); assert.equal(result.details.outcomes[2].status, 'not_started'); assert.equal(result.details.submittedFiles, 2);
    const next = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'] }, 5000, undefined, f.ctx, 'next'); assert.equal(next.isError, false);
  } finally { await f.close(); }
});

test('active sync cancellation discards its owned server and allows the next request', async () => {
  const f = fixture('timeout'), controller = new AbortController();
  try {
    const lease = await f.pool.acquire(f.adapter as any, f.root, 5000), client = lease.client; f.pool.release(lease);
    let announce!: () => void; const started = new Promise<void>(resolve => { announce = resolve; });
    const execute = client.executeCommand.bind(client);
    client.executeCommand = (...args) => { const pending = execute(...args); if ((args[1][0]) === capability.requests[1]) announce(); return pending; };
    const work = runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['bad.ts'] }, 5000, controller.signal, f.ctx, 'cancel');
    const rejected = assert.rejects(work, /abort|cancel/i); await started; controller.abort(); await rejected; assert.equal(client.running, false);
    const next = await runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'] }, 5000, undefined, f.ctx, 'next'); assert.equal(next.isError, false);
  } finally { await f.close(); }
});

test('sync slots share the document bound and queued cancellation preserves the active server', async () => {
  const f = fixture('held', DIAGNOSTIC_BATCH_SIZE + 1), controller = new AbortController();
  const files: string[] = [];
  for (let i = 0; i < DIAGNOSTIC_BATCH_SIZE + 4; i++) { const file = join(f.root, `file-${i}.ts`); writeFileSync(file, 'const value = 1;'); files.push(file); }
  let release: (() => Promise<unknown>) | undefined;
  try {
    const lease = await f.pool.acquire(f.adapter as any, f.root, 5000), client = lease.client; f.pool.release(lease);
    let announce!: () => void, opened = 0; const started = new Promise<void>(resolve => { announce = resolve; });
    const open = client.didOpen.bind(client); client.didOpen = (...args) => { const result = open(...args); if (++opened === DIAGNOSTIC_BATCH_SIZE) announce(); return result; };
    release = () => client.workspaceSymbols('release');
    const active = runDiagnostics(f.pool, f.adapter as any, { root: f.root, files: files.slice(0, DIAGNOSTIC_BATCH_SIZE + 2) }, 5000, undefined, f.ctx, 'active');
    const activeDone = Promise.allSettled([active]); await started;
    const queued = runDiagnostics(f.pool, f.adapter as any, { root: f.root, files: files.slice(DIAGNOSTIC_BATCH_SIZE + 2) }, 5000, undefined, f.ctx, 'queued');
    const cancelled = runDiagnostics(f.pool, f.adapter as any, { root: f.root, paths: ['good.ts'] }, 5000, controller.signal, f.ctx, 'cancel-queued');
    const rejected = assert.rejects(cancelled, /abort|cancel/i); await tick(); controller.abort(); await rejected;
    assert.equal(client.running, true); assert.equal((await f.stats()).peak, DIAGNOSTIC_BATCH_SIZE);
    await release(); const first = await activeDone; assert.equal(first[0].status, 'fulfilled');
    if (first[0].status === 'fulfilled') { assert.equal(first[0].value.isError, false); assert.equal(first[0].value.details.summary.files, DIAGNOSTIC_BATCH_SIZE + 2); }
    const second = await queued; assert.equal(second.isError, false);
    const stats = await f.stats(); assert.equal(stats.active, 0); assert.equal(stats.opened, files.length); assert.equal(stats.closed, files.length); assert.deepEqual(stats.counts, [files.length, files.length, files.length]);
  } finally { await release?.().catch(() => {}); await f.close(); }
});
