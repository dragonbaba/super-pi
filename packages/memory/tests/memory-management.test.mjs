import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createExtensionHarness, emitAll } from './extension-harness.mjs';

const root = await mkdtemp(join(tmpdir(), 'sp-memory-management-'));
process.env.SP_CODING_AGENT_DIR = join(root, 'agent');
const { MemoryStore } = await import('../dist/store/memory-store.js');
const { DatabaseManager } = await import('../dist/store/db.js');
const { AtomicLockCoordinator } = await import('../dist/store/atomic-lock-coordinator.js');
const { acquireMarkdownMutationLock, canonicalMarkdownIdentity } = await import('../dist/store/markdown-mutation-lock.js');
const { loadConfig } = await import('../dist/config.js');
const { registerMemoryTool } = await import('../dist/tools/memory-tool.js');
const { registerMemorySearchTool } = await import('../dist/tools/memory-search-tool.js');
const { addMemory, searchMemories } = await import('../dist/store/sqlite-memory-store.js');
const { validateToolArguments } = await import('../../ai/dist/utils/validation.js');
const { buildSessionMemoryDigest } = await import('../dist/prompt-context.js');
const { buildMemoryDigest } = await import('../dist/memory-digest.js');
const { detectProject } = await import('../dist/project.js');
const { createMemoryReviewHandler } = await import('../dist/handlers/memory-review.js');
const { registerMemoryCommand } = await import('../dist/handlers/memory-command.js');
const { readRawMemoryFile, removeRawMemorySelections, preselectRawMemoryEntry } = await import('../dist/store/raw-memory.js');
const { listBulkMemory, executeBulkMemoryCleanup, summarizeBulkSelection } = await import('../dist/handlers/memory-bulk-cleanup.js');
const { createLazyBulkMemoryHandler } = await import('../dist/handlers/memory-bulk-command-registration.js');
const { syncMarkdownMemoriesToSqlite } = await import('../dist/handlers/sync-markdown-memories.js');
test.after(async () => { await AtomicLockCoordinator.closeSharedUnder(root); await rm(root, { recursive: true, force: true }); });

test('actual dist registration and headless menus do not load bulk UI or the shared selector', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const loaded = [];
    const hook = registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
    const { createExtensionHarness } = await import(${JSON.stringify(new URL('./extension-harness.mjs', import.meta.url).href)});
    const extension = (await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)})).default;
    const harness = createExtensionHarness(); extension(harness.api);
    const handler = harness.commands.get('memory').handler;
    await handler('', { hasUI: false, mode: 'rpc', ui: { notify() {}, select() { throw new Error('headless menu opened'); } } });
    await handler('', { hasUI: true, mode: 'rpc', ui: { notify() {}, select: async (_title, choices) => choices.find(choice => choice === '批量清理记忆') } });
    assert.equal(loaded.some(url => url.endsWith('/memory-bulk-command.js') || url.endsWith('/bounded-selector.js')), false);
    hook.deregister(); console.log(JSON.stringify({ uiModulesLoaded: 0, registeredCommands: [...harness.commands.keys()] }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, cwd: root,
    env: { ...process.env, SP_CODING_AGENT_DIR: join(root, 'lazy-agent') }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).uiModulesLoaded, 0);
});

test('raw removal preserves every unselected byte for all selection groups', async () => {
  const directory = join(root, 'raw-masks'); await mkdir(directory);
  const delimiter = Buffer.from('\n§\n'), fragments = [Buffer.from('  alpha \n'), Buffer.from('\tbéta  '), Buffer.from([0x20, 0xff, 0x0a]), Buffer.from('同文 <!-- created=2000-01-01, last=2001-01-01 --> '), Buffer.from('同文 <!-- created=2002-01-01, last=2003-01-01 -->\n')];
  const original = Buffer.concat(fragments.flatMap((fragment, i) => i ? [delimiter, fragment] : [fragment]));
  const file = join(directory, 'MEMORY.md'); await writeFile(file, original);
  const raw = await readRawMemoryFile(file);
  assert.equal(raw.snapshot.entries.length, 5);
  for (let mask = 0; mask < 32; mask++) {
    const selected = raw.snapshot.entries.filter(row => mask & (1 << row.ordinal));
    const remaining = fragments.filter((_fragment, i) => !(mask & (1 << i)));
    const expected = Buffer.concat(remaining.flatMap((fragment, i) => i ? [delimiter, fragment] : [fragment]));
    assert.deepEqual(removeRawMemorySelections(raw.bytes, raw.snapshot, selected), expected, 'mask=' + mask);
  }
  assert.equal(raw.snapshot.entries[3].created, '2000-01-01'); assert.equal(raw.snapshot.entries[4].modified, '2003-01-01');
  assert.notEqual(raw.snapshot.entries[3].sha256, raw.snapshot.entries[4].sha256);
  assert.throws(() => removeRawMemorySelections(Buffer.from('external'), raw.snapshot, [raw.snapshot.entries[0]]), /已变化/);
});

test('raw publication reloads normal tool state and preserves same-text siblings', async () => {
  const { store, config } = await fixture('raw-publication'), file = join(config.memoryDir, 'MEMORY.md');
  const kept = ' \tidentical <!-- created=2002-01-01, last=2003-01-01 -->  \n';
  await writeFile(file, 'identical <!-- created=2000-01-01, last=2001-01-01 -->\n§\n' + kept);
  await store.loadFromDisk();
  const coordinator = new AtomicLockCoordinator(join(dirname(config.memoryDir), '.pi-hermes-locks.sqlite'));
  try {
    const raw = await readRawMemoryFile(file);
    const result = await store.removeRawEntries('memory', raw.snapshot, [raw.snapshot.entries[0]], coordinator);
    assert.equal(result.deleted, 1); assert.deepEqual(await readFile(file), Buffer.from(kept));
    assert.equal((await store.listEntries('memory')).total, 1);
    assert.equal((await store.add('memory', 'new entry')).success, true);
    const updated = await readFile(file, 'utf8'); assert.doesNotMatch(updated, /2000-01-01/); assert.match(updated, /2002-01-01/);
    const all = await readRawMemoryFile(file);
    await store.removeRawEntries('memory', all.snapshot, all.snapshot.entries, coordinator);
    assert.equal((await readFile(file)).length, 0);
  } finally { coordinator.close(); store.close(); }
});

test('raw deletion skips a stale file and never retries a publication conflict', async t => {
  const { store, config } = await fixture('raw-conflict'), file = join(config.memoryDir, 'MEMORY.md');
  const coordinator = new AtomicLockCoordinator(join(dirname(config.memoryDir), '.pi-hermes-locks.sqlite'));
  try {
    await writeFile(file, 'old\n§\nkeep'); const old = await readRawMemoryFile(file);
    await writeFile(file, 'external edit');
    await assert.rejects(store.removeRawEntries('memory', old.snapshot, [old.snapshot.entries[0]], coordinator), /已变化/);
    assert.equal(await readFile(file, 'utf8'), 'external edit');
    await writeFile(file, 'old\n§\nkeep'); const current = await readRawMemoryFile(file);
    const link = fsPromises.link; let publications = 0;
    t.mock.method(fsPromises, 'link', async (source, destination) => {
      if (destination === current.snapshot.path && source.endsWith('write.tmp')) { publications++; await writeFile(file, 'concurrent writer'); }
      return link(source, destination);
    });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(store.removeRawEntries('memory', current.snapshot, [current.snapshot.entries[0]], coordinator));
    assert.equal(publications, 1); assert.equal(await readFile(file, 'utf8'), 'concurrent writer');
  } finally { coordinator.close(); store.close(); }
});

test('a post-publication refresh failure cannot resurrect removed memory on the next normal write', async t => {
  const { store, config } = await fixture('raw-refresh-failure'), file = join(config.memoryDir, 'MEMORY.md');
  const coordinator = new AtomicLockCoordinator(join(dirname(config.memoryDir), '.pi-hermes-locks.sqlite'));
  try {
    await writeFile(file, 'removed entry\n§\nkept entry'); await store.loadFromDisk();
    const raw = await readRawMemoryFile(file), readState = store.readFileState.bind(store); let reads = 0;
    t.mock.method(store, 'readFileState', async (current, rawParent) => {
      if (current === raw.snapshot.path && rawParent && ++reads === 3) throw new Error('fixture refresh read failed');
      return readState(current, rawParent);
    });
    const result = await store.removeRawEntries('memory', raw.snapshot, [raw.snapshot.entries[0]], coordinator);
    assert.equal(result.deleted, 1); assert.match(result.warning, /refresh read failed/); assert.equal(await readFile(file, 'utf8'), 'kept entry');
    assert.equal((await store.add('memory', 'new entry')).success, true);
    assert.doesNotMatch(await readFile(file, 'utf8'), /removed entry/); assert.match(await readFile(file, 'utf8'), /kept entry/);
  } finally { coordinator.close(); store.close(); }
});

test('bulk age presets use known modification dates and the existing temporary failure window', () => {
  const row = { ordinal: 0, sha256: 'fixture', chars: 1, summary: '', category: 'failure', created: '2026-01-01', modified: '2026-11-01', project: null };
  const now = Date.parse('2026-12-01T12:00:00Z');
  assert.equal(preselectRawMemoryEntry(row, { kind: 'age', days: 30 }, now), false);
  assert.equal(preselectRawMemoryEntry({ ...row, modified: '2026-10-31' }, { kind: 'age', days: 30 }, now), true);
  assert.equal(preselectRawMemoryEntry({ ...row, modified: null }, { kind: 'age', days: 0 }, now), false);
  assert.equal(preselectRawMemoryEntry(row, { kind: 'temporary', days: 7 }, now), true);
  assert.equal(preselectRawMemoryEntry({ ...row, category: 'correction' }, { kind: 'temporary', days: 7 }, now), false);
  assert.equal(preselectRawMemoryEntry({ ...row, created: '2026-11-24' }, { kind: 'temporary', days: 7 }, now), false);
});

async function fixture(name) {
  const config = { ...loadConfig(), memoryDir: join(root, name), userCharLimit: 10000 };
  const store = new MemoryStore(config);
  await store.loadFromDisk();
  return { config, store, harness: createExtensionHarness() };
}

async function bulkFixture(name) {
  const f = await fixture(name), projectsRoot = join(root, name + '-projects'), projectName = 'current--' + 'a'.repeat(24);
  const memoryDir = join(projectsRoot, projectName); await mkdir(memoryDir, { recursive: true });
  const projectStore = new MemoryStore({ ...f.config, memoryDir }); await projectStore.loadFromDisk();
  const db = new DatabaseManager(f.config.memoryDir);
  registerMemoryTool(f.harness.api, f.store, projectStore, db, projectName);
  registerMemorySearchTool(f.harness.api, db, projectName);
  const options = { store: f.store, projectStore, config: f.config, dbManager: db, globalDir: f.config.memoryDir, projectsRoot,
    project: { name: projectName, memoryDir, root: join(root, 'current-project'), displayName: 'current' } };
  return { ...f, options, db, projectStore, close() { db.close(); f.store.close(); projectStore.close(); } };
}

test('cancelled memory additions preserve canonical bytes and search, including failure adds', async () => {
  const f = await bulkFixture('cancel-admission'), tool = f.harness.tools.get('memory');
  try {
    await tool.execute('seed', { action: 'add', target: 'user', content: 'retained preference' });
    const file = join(f.config.memoryDir, 'USER.md'), before = await readFile(file);
    const controller = new AbortController(); controller.abort();
    for (const args of [{ target: 'user' }, { target: 'failure', scope: 'global', category: 'correction' }]) {
      await assert.rejects(tool.execute('cancel', { action: 'add', content: 'cancelprobe', ...args }, controller.signal), { name: 'AbortError' });
    }
    assert.deepEqual(await readFile(file), before);
    assert.equal(f.store.getEntries('failure').length, 0);
    assert.equal(searchMemories(f.db, 'cancelprobe', { project: '*' }).length, 0);
    assert.equal((await tool.execute('next', { action: 'add', target: 'user', content: 'next preference' })).details.success, true);
  } finally { f.close(); }
});

test('cancelling a queued memory addition rejects before the active Markdown lease is released', { timeout: 15000 }, async t => {
  const f = await bulkFixture('cancel-queue'), tool = f.harness.tools.get('memory');
  let lease;
  try {
    await tool.execute('seed', { action: 'add', target: 'user', content: 'retained preference' });
    const file = join(f.config.memoryDir, 'USER.md'), before = await readFile(file), identity = await canonicalMarkdownIdentity(file);
    const shared = AtomicLockCoordinator.shared(join(dirname(dirname(identity)), '.pi-hermes-locks.sqlite'));
    lease = await acquireMarkdownMutationLock(file);
    const acquire = shared.tryAcquire, controller = new AbortController(); let queued = false;
    const abortQueued = () => controller.abort();
    const hook = t.mock.method(shared, 'tryAcquire', function(...args) {
      const result = acquire.apply(this, args);
      if (!result && !queued) { queued = true; queueMicrotask(abortQueued); }
      return result;
    });
    await assert.rejects(tool.execute('queued', { action: 'add', target: 'user', content: 'cancelprobe' }, controller.signal), { name: 'AbortError' });
    assert.equal(queued, true);
    assert.equal(shared.cachedDb.prepare('SELECT COUNT(*) AS count FROM locks').get().count, 1, 'The active owner still holds its lease');
    assert.deepEqual(await readFile(file), before);
    assert.equal(searchMemories(f.db, 'cancelprobe', { project: '*' }).length, 0);
    hook.mock.restore(); lease.release(); lease = undefined;
    assert.equal((await tool.execute('next', { action: 'add', target: 'user', content: 'next preference' })).details.success, true);
  } finally { lease?.release(); f.close(); }
});

test('cancellation before publication rolls back staged entries and FIFO eviction without publishing', async t => {
  for (const strategy of ['reject', 'fifo-evict']) {
    const config = { ...loadConfig(), memoryDir: join(root, 'cancel-publication-' + strategy), userCharLimit: strategy === 'fifo-evict' ? 180 : 10000, memoryOverflowStrategy: strategy };
    const store = new MemoryStore(config), h = createExtensionHarness(); await store.loadFromDisk(); registerMemoryTool(h.api, store, null);
    const tool = h.tools.get('memory'), file = await canonicalMarkdownIdentity(join(config.memoryDir, 'USER.md')), old = 'retained preference ' + 'x'.repeat(60), content = 'cancelprobe ' + 'y'.repeat(60);
    try {
      await tool.execute('seed', { action: 'add', target: 'user', content: old });
      const before = await readFile(file), controller = new AbortController(), read = store.readFileState; let armed = true;
      const hook = t.mock.method(store, 'readFileState', async function(current, ...args) {
        const state = await read.call(this, current, ...args);
        if (armed && current === file && (await readdir(config.memoryDir)).some(name => name.startsWith('.tmp-'))) { armed = false; controller.abort(); }
        return state;
      });
      await assert.rejects(tool.execute('cancel', { action: 'add', target: 'user', content }, controller.signal), { name: 'AbortError' });
      hook.mock.restore(); assert.equal(armed, false);
      assert.deepEqual(await readFile(file), before);
      assert.equal((await store.listEntries('user')).total, 1);
      assert.equal((await readdir(config.memoryDir)).some(name => name.startsWith('.tmp-')), false);
      const next = await tool.execute('next', { action: 'add', target: 'user', content });
      assert.equal(next.details.success, true);
      assert.equal(next.details.evicted_count ?? 0, strategy === 'fifo-evict' ? 1 : 0);
    } finally { store.close(); }
  }
});

test('cancellation after canonical publication starts returns committed truth and reconciles search', async t => {
  for (const phase of ['create', 'replace']) {
    const f = await bulkFixture('cancel-commit-' + phase), tool = f.harness.tools.get('memory');
    const file = await canonicalMarkdownIdentity(join(f.config.memoryDir, 'USER.md')), controller = new AbortController(); let committed = false;
    const method = phase === 'create' ? 'link' : 'rename', operation = fsPromises[method]; let hook;
    try {
      if (phase === 'replace') await tool.execute('seed', { action: 'add', target: 'user', content: 'retained preference' });
      hook = t.mock.method(fsPromises, method, async function(source, destination, ...args) {
        const result = await operation(source, destination, ...args);
        if (phase === 'create' ? destination === file : source === file) { committed = true; controller.abort(); }
        return result;
      });
      syncBuiltinESMExports();
      const result = await tool.execute('commit', { action: 'add', target: 'user', content: 'committedprobe' }, controller.signal);
      assert.equal(committed, true); assert.equal(controller.signal.aborted, true); assert.equal(result.details.success, true);
      assert.match(await readFile(file, 'utf8'), /committedprobe/);
      assert.equal(searchMemories(f.db, 'committedprobe', { project: null }).length, 1);
      hook.mock.restore(); syncBuiltinESMExports();
      assert.equal((await tool.execute('next', { action: 'add', target: 'user', content: 'next preference' })).details.success, true);
    } finally { hook?.mock.restore(); syncBuiltinESMExports(); f.close(); }
  }
});

test('cancellation after candidate identity is read preserves FIFO bytes and allows the next call', async t => {
  const config = { ...loadConfig(), memoryDir: join(root, 'cancel-identity'), userCharLimit: 180, memoryOverflowStrategy: 'fifo-evict' };
  const store = new MemoryStore(config), db = new DatabaseManager(config.memoryDir), h = createExtensionHarness();
  await store.loadFromDisk(); registerMemoryTool(h.api, store, null, db);
  try {
    const tool = h.tools.get('memory'), file = await canonicalMarkdownIdentity(join(config.memoryDir, 'USER.md'));
    const old = 'retained preference ' + 'x'.repeat(60), content = 'identityprobe ' + 'y'.repeat(60);
    await tool.execute('seed', { action: 'add', target: 'user', content: old });
    const before = await readFile(file), controller = new AbortController(), identity = store.fileIdentity; let injected = false;
    const hook = t.mock.method(store, 'fileIdentity', async function(file) {
      const value = await identity.call(this, file);
      if (String(file).endsWith('write.tmp')) { injected = true; controller.abort(); }
      return value;
    });
    await assert.rejects(tool.execute('cancel', { action: 'add', target: 'user', content }, controller.signal), { name: 'AbortError' });
    hook.mock.restore(); assert.equal(injected, true); assert.deepEqual(await readFile(file), before);
    assert.equal(searchMemories(db, 'identityprobe', { project: null }).length, 0);
    const next = await tool.execute('next', { action: 'add', target: 'user', content });
    assert.equal(next.details.success, true); assert.equal(next.details.evicted_count, 1);
  } finally { db.close(); store.close(); }
});

test('post-publication cancellation survives an external-edit conflict and reconciles without replay', async t => {
  const f = await bulkFixture('cancel-conflict'), tool = f.harness.tools.get('memory'); let hook;
  try {
    await tool.execute('seed', { action: 'add', target: 'user', content: 'retained preference' });
    const file = await canonicalMarkdownIdentity(join(f.config.memoryDir, 'USER.md')), controller = new AbortController();
    const link = fsPromises.link; let publications = 0;
    hook = t.mock.method(fsPromises, 'link', async function(source, destination, ...args) {
      const value = await link(source, destination, ...args);
      if (destination === file && publications++ === 0) { controller.abort(); await fsPromises.appendFile(file, '\n§\nexternalprobe'); }
      return value;
    });
    syncBuiltinESMExports();
    const result = await tool.execute('commit', { action: 'add', target: 'user', content: 'committedprobe' }, controller.signal);
    assert.equal(controller.signal.aborted, true); assert.equal(result.details.success, true); assert.equal(publications, 1);
    const text = await readFile(file, 'utf8'); assert.match(text, /committedprobe/); assert.match(text, /externalprobe/);
    assert.equal(searchMemories(f.db, 'committedprobe', { project: null }).length, 1);
    assert.equal(searchMemories(f.db, 'externalprobe', { project: null }).length, 1);
    hook.mock.restore(); syncBuiltinESMExports();
    assert.equal((await tool.execute('next', { action: 'add', target: 'user', content: 'next preference' })).details.success, true);
  } finally { hook?.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

test('bulk global/current scopes reconcile search and keep exact unselected bytes', async () => {
  const f = await bulkFixture('bulk-scopes');
  try {
    const globalFile = join(f.options.globalDir, 'MEMORY.md'), projectFile = join(f.options.project.memoryDir, 'MEMORY.md');
    const kept = ' \tkeep scoped <!-- created=2000-01-01, last=2001-01-01 -->\n';
    for (const file of [globalFile, projectFile]) await writeFile(file, 'remove scoped\n§\n' + kept);
    await syncMarkdownMemoriesToSqlite(f.db, f.options.globalDir, basename(f.options.projectsRoot), root);
    const search = f.harness.tools.get('memory_search');
    assert.equal((await search.execute('before', validate(search, { query: 'remove', project: '*' }))).details.count, 2);
    for (const scope of ['global', 'project']) {
      const list = await listBulkMemory(f.options, scope), selected = list.rows.filter(row => row.entry.summary === 'remove scoped');
      const summary = summarizeBulkSelection(selected); assert.equal(summary.count, 1); assert.equal(summary.files.length, 1);
      const report = await executeBulkMemoryCleanup(f.options, selected);
      assert.equal(report.deleted, 1); assert.equal(report.warnings.length, 0); assert.equal(report.characters, summary.characters);
    }
    assert.deepEqual(await readFile(globalFile), Buffer.from(kept)); assert.deepEqual(await readFile(projectFile), Buffer.from(kept));
    assert.equal((await search.execute('after', validate(search, { query: 'remove', project: '*' }))).details.count, 0);
    await writeFile(join(f.options.globalDir, 'failures.md'), '[correction] global\n§\n[correction] legacy <!-- created=2000-01-01, last=2001-01-01, project64=bGVnYWN5 -->');
    const globalFailures = await listBulkMemory(f.options, 'global-failure'); assert.equal(globalFailures.rows.length, 1); assert.match(globalFailures.rows[0].entry.summary, /global/);
  } finally { f.close(); }
});

test('all-project bulk skips a directory removed after enumeration and still reports other stat errors', async t => {
  const f = await bulkFixture('bulk-enumeration-race');
  const gone = join(f.options.projectsRoot, 'gone--' + 'b'.repeat(24));
  try {
    await mkdir(gone);
    await writeFile(join(f.options.project.memoryDir, 'MEMORY.md'), 'surviving project memory');
    const originalReaddir = fsPromises.readdir;
    let enumerated = false;
    t.mock.method(fsPromises, 'readdir', async (directory, ...args) => {
      const names = await originalReaddir(directory, ...args);
      if (directory === f.options.projectsRoot && !enumerated) {
        enumerated = true;
        assert.ok(names.includes(basename(gone)));
        await fsPromises.rmdir(gone);
      }
      return names;
    });
    syncBuiltinESMExports();
    const list = await listBulkMemory(f.options, 'all-projects');
    assert.equal(enumerated, true);
    assert.deepEqual(list.rows.map(row => row.entry.summary), ['surviving project memory']);
    assert.equal(list.warnings.length, 0);
    const originalLstat = fsPromises.lstat;
    const denied = Object.assign(new Error('fixture stat denied'), { code: 'EACCES' });
    t.mock.method(fsPromises, 'lstat', async (directory, ...args) => {
      if (directory === f.options.project.memoryDir) throw denied;
      return originalLstat(directory, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(listBulkMemory(f.options, 'all-projects'), error => error === denied);
    assert.equal(await readFile(join(f.options.project.memoryDir, 'MEMORY.md'), 'utf8'), 'surviving project memory');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('all-project bulk includes orphan/failure-only identities, skips links and stale files, and reconciles only affected scopes', async t => {
  const f = await bulkFixture('bulk-projects'), orphan = 'orphan--' + 'b'.repeat(24), failures = 'failures--' + 'c'.repeat(24), stale = 'stale--' + 'd'.repeat(24);
  const outside = join(root, 'bulk-outside'), legacy = join(f.options.projectsRoot, 'old-basename');
  try {
    for (const name of [orphan, failures, stale]) await mkdir(join(f.options.projectsRoot, name));
    await mkdir(outside); await mkdir(legacy);
    await writeFile(join(outside, 'MEMORY.md'), 'outside must stay'); await writeFile(join(legacy, 'MEMORY.md'), 'legacy must stay');
    await writeFile(join(f.options.projectsRoot, orphan, 'MEMORY.md'), 'remove orphan\n§\n \tkeep orphan  ');
    await writeFile(join(f.options.projectsRoot, failures, 'failures.md'), '[failure] remove failure\n§\n[correction] keep failure');
    await writeFile(join(f.options.projectsRoot, stale, 'MEMORY.md'), 'remove stale\n§\nkeep stale');
    await fsPromises.symlink(outside, join(f.options.projectsRoot, 'linked--' + 'e'.repeat(24)), process.platform === 'win32' ? 'junction' : 'dir');
    await fsPromises.symlink(join(outside, 'MEMORY.md'), join(f.options.projectsRoot, failures, 'MEMORY.md'), 'file');
    const originalOpen = fsPromises.open, canonicalLegacy = await realpath(legacy), canonicalOutside = await realpath(outside);
    t.mock.method(fsPromises, 'open', async (file, ...args) => {
      assert.ok(!String(file).startsWith(canonicalLegacy) && !String(file).startsWith(canonicalOutside), 'Excluded content must not be opened');
      return originalOpen(file, ...args);
    });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const list = await listBulkMemory(f.options, 'all-projects'); assert.equal(list.legacyDirectories, 1); assert.equal(list.rows.length, 6);
    assert.equal(list.rows.some(row => row.file.project === failures && row.file.target === 'failure'), true);
    await syncMarkdownMemoriesToSqlite(f.db, f.options.globalDir, basename(f.options.projectsRoot), root);
    assert.equal(searchMemories(f.db, 'remove', { project: failures }).length, 1, 'Manual sync also discovers failure-only canonical projects');
    await writeFile(join(f.options.projectsRoot, stale, 'MEMORY.md'), 'external stale replacement');
    const report = await executeBulkMemoryCleanup(f.options, list.rows.filter(row => row.entry.summary.includes('remove')));
    assert.equal(report.deleted, 2); assert.equal(report.changedFiles, 2); assert.equal(report.skippedFiles, 1);
    assert.equal(await readFile(join(f.options.projectsRoot, orphan, 'MEMORY.md'), 'utf8'), ' \tkeep orphan  ');
    assert.equal(await readFile(join(f.options.projectsRoot, stale, 'MEMORY.md'), 'utf8'), 'external stale replacement');
    assert.equal(searchMemories(f.db, 'remove', { project: orphan }).length, 0); assert.equal(searchMemories(f.db, 'remove', { project: failures }).length, 0);
    assert.equal(searchMemories(f.db, 'remove', { project: stale }).length, 1, 'Unchanged/skipped project search scope is not broadly reconciled');
  } finally { f.close(); }
});

test('index failure does not roll back Markdown deletion and explicit sync recovers search', async t => {
  const f = await bulkFixture('bulk-index-failure');
  try {
    const file = join(f.options.globalDir, 'MEMORY.md'); await writeFile(file, 'indexgone\n§\nkeep');
    await syncMarkdownMemoriesToSqlite(f.db, f.options.globalDir, basename(f.options.projectsRoot), root);
    const list = await listBulkMemory(f.options, 'global');
    const unavailable = t.mock.method(f.db, 'getDb', () => { throw new Error('fixture index unavailable'); });
    const report = await executeBulkMemoryCleanup(f.options, list.rows.filter(row => row.entry.summary === 'indexgone'));
    assert.equal(report.deleted, 1); assert.equal(await readFile(file, 'utf8'), 'keep'); assert.match(report.warnings.join('\n'), /fixture index unavailable/);
    unavailable.mock.restore();
    assert.equal(searchMemories(f.db, 'indexgone', { project: null }).length, 1);
    await syncMarkdownMemoriesToSqlite(f.db, f.options.globalDir, basename(f.options.projectsRoot), root);
    assert.equal(searchMemories(f.db, 'indexgone', { project: null }).length, 0);
    assert.equal((await f.store.listEntries('memory')).total, 1);
  } finally { f.close(); }
});

test('transient project cleanup closes its own coordinator and preserves a live shared owner', async t => {
  const f = await bulkFixture('bulk-coordinator'), project = 'other--' + 'f'.repeat(24), directory = join(f.options.projectsRoot, project);
  let lease, shared;
  try {
    await mkdir(directory); await writeFile(join(directory, 'MEMORY.md'), 'remove\n§\nkeep');
    shared = AtomicLockCoordinator.shared(join(await realpath(f.options.projectsRoot), '.pi-hermes-locks.sqlite'));
    lease = shared.tryAcquire('live-owner', { staleMs: 300000 }); assert.ok(lease);
    const connection = shared.cachedDb, closed = [], close = AtomicLockCoordinator.prototype.close;
    const closing = t.mock.method(AtomicLockCoordinator.prototype, 'close', function() { closed.push(this); return close.call(this); });
    const list = await listBulkMemory(f.options, 'all-projects');
    const report = await executeBulkMemoryCleanup(f.options, list.rows.filter(row => row.entry.summary === 'remove'));
    closing.mock.restore();
    assert.equal(report.deleted, 1); assert.equal(closed.includes(shared), false); assert.equal(shared.cachedDb, connection);
    assert.equal(closed.length, 1); assert.equal(closed[0].cachedDb, null, 'Task-owned connection closed after its leases released');
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM locks').get().count, 1, 'Only the pre-existing owner lease remains');
  } finally { lease?.release(); shared?.close(); f.close(); }
});

test('built memory menu opens the lazy selector, preserves cancellation and confirms raw removal', async t => {
  const { KeybindingsManager } = await import('../../coding-agent/dist/core/keybindings.js');
  const theme = { bold: value => value, fg: (_tone, value) => value }, keybindings = new KeybindingsManager();
  for (const action of ['headless', 'cancel-scope', 'escape-list', 'cancel-confirm', 'confirm']) {
    const f = await bulkFixture('bulk-ui-' + action), file = join(f.options.globalDir, 'MEMORY.md'), messages = [];
    try {
      const original = 'remove UI\n§\n \tkeep UI  '; await writeFile(file, original);
      let selections = 0, customCount = 0, acquisitions = 0;
      const acquire = AtomicLockCoordinator.prototype.tryAcquire;
      const acquisition = t.mock.method(AtomicLockCoordinator.prototype, 'tryAcquire', function(...args) { acquisitions++; return acquire.apply(this, args); });
      const noop = async () => {};
      registerMemoryCommand(f.harness.api, { ...f.options, review: noop, cleanup: noop, sync: noop, skills: noop, bulk: createLazyBulkMemoryHandler(f.options) });
      const ctx = { hasUI: action !== 'headless', mode: 'tui', ui: {
        notify: text => messages.push(text),
        select: async (_title, choices) => {
          selections++;
          if (selections === 1) return choices.find(choice => choice === '批量清理记忆');
          if (selections === 2) return action === 'cancel-scope' ? undefined : choices[1];
          return choices[0];
        },
        custom: async factory => {
          customCount++; let settle;
          const response = new Promise(resolve => { settle = resolve; });
          const selector = factory({ terminal: { rows: 28 } }, theme, keybindings, settle);
          selector.focused = true;
          const frame = selector.render(112); assert.ok(frame.length <= 24);
          if (customCount === 1) {
            assert.match(frame.join('\n'), /记忆/); assert.doesNotMatch(frame.join('\n'), /使用中的会话/);
            if (action === 'escape-list') selector.handleInput('\x1b');
            else {
              // Both default-selected rows are editable; retain only the first.
              selector.handleInput('\x1b[B'); selector.render(112); selector.handleInput(' ');
              await new Promise(resolve => setTimeout(resolve, 270)); selector.render(112); selector.handleInput('\x1b[3~');
            }
          } else {
            assert.match(frame.join('\n'), /确认删除 1 条记忆/); assert.match(frame.join('\n'), /→ 取消/);
            if (action === 'cancel-confirm') selector.handleInput('\x1b');
            else {
              selector.handleInput('\x1b[A'); selector.render(112);
              await new Promise(resolve => setTimeout(resolve, 170)); selector.render(112); selector.handleInput('\r');
            }
          }
          const result = await response; selector.dispose(); return result;
        },
      } };
      try { await f.harness.commands.get('memory').handler('', ctx); }
      finally { acquisition.mock.restore(); }
      if (action === 'confirm') {
        assert.equal(await readFile(file, 'utf8'), ' \tkeep UI  '); assert.equal(customCount, 2); assert(acquisitions > 0);
        assert.match(messages.join('\n'), /删除 1 条/);
      } else {
        assert.equal(await readFile(file, 'utf8'), original); assert.equal(acquisitions, 0);
        if (action === 'headless' || action === 'cancel-scope') assert.equal(customCount, 0);
      }
    } finally { f.close(); }
  }
});
function validate(tool, args) {
  return validateToolArguments(tool, { type: 'toolCall', id: 'test', name: tool.name, arguments: args });
}

test('global null survives real validation; global, named and omitted searches have distinct scopes', async () => {
  const { config, harness } = await fixture('search');
  const db = new DatabaseManager(config.memoryDir);
  try {
    addMemory(db, 'scopeprobe global', 'memory', null);
    addMemory(db, 'scopeprobe project', 'memory', 'project-a');
    addMemory(db, 'scopeprobe unrelated', 'memory', 'project-b');
    registerMemorySearchTool(harness.api, db, 'project-a');
    const tool = harness.tools.get('memory_search');
    for (const [project, count, expected] of [[null, 1, '[global]'], ['project-a', 1, '[project-a]'], [undefined, 2, '[global]'], ['*', 3, '[project-b]']]) {
      const args = validate(tool, { query: 'scopeprobe', ...(project === undefined ? {} : { project }) });
      assert.equal(args.project, project);
      const result = await tool.execute('search', args);
      assert.equal(result.details.count, count);
      assert.ok(result.content[0].text.includes(expected));
      assert.match(result.content[0].text, /Created: .*Last used:/);
    }
    registerMemorySearchTool(harness.api, db);
    assert.equal((await harness.tools.get('memory_search').execute('global-default', { query: 'scopeprobe' })).details.count, 1);
  } finally { db.close(); }
});

test('canonical list is paginated, sees external edits and separates global/project failure scopes', async () => {
  const { store, config, harness } = await fixture('list');
  const { store: project } = await fixture('list-project');
  const db = new DatabaseManager(config.memoryDir);
  try {
    registerMemoryTool(harness.api, store, project, db, 'project-a');
    const tool = harness.tools.get('memory');
    await writeFile(join(config.memoryDir, 'USER.md'), Array.from({ length: 23 }, (_, i) => `preference ${i}`).join('\n§\n'));
    const first = await tool.execute('list', validate(tool, { action: 'list', target: 'user', limit: 20 }));
    assert.equal(first.details.total, 23);
    assert.equal(first.details.nextOffset, 20);
    const last = await tool.execute('list', validate(tool, { action: 'list', target: 'user', offset: 20 }));
    assert.equal(last.details.entries.length, 3);
    assert.equal(last.details.nextOffset, null);
    await writeFile(join(config.memoryDir, 'failures.md'), '[correction] global correction <!-- created=2000-01-01, last=2001-01-01 -->');
    await store.addFailure('legacy other project\nonly applies there', { category: 'correction', project: 'other' });
    await project.addFailure('project correction', { category: 'correction', project: 'project-a' });
    const global = await tool.execute('list', validate(tool, { action: 'list', target: 'failure', scope: 'global' }));
    assert.equal(global.details.total, 1);
    assert.match(global.content[0].text, /global correction/);
    const local = await tool.execute('list', validate(tool, { action: 'list', target: 'failure', scope: 'project' }));
    assert.equal(local.details.total, 1);
    assert.match(local.content[0].text, /project correction/);
    const changed = await tool.execute('replace', validate(tool, { action: 'replace', target: 'failure', scope: 'global', old_text: '⚠️ [global] [correction] global correction', content: '[correction] revised global' }));
    assert.equal(changed.details.success, true);
    assert.equal((await store.listEntries('failure', 0, 20, null)).entries[0].created, '2000-01-01');
    assert.match((await readFile(join(config.memoryDir, 'failures.md'), 'utf8')), /legacy other project\nonly applies there/);
    assert.equal(searchMemories(db, 'legacy', { project: null }).length, 0);
    assert.equal(searchMemories(db, 'legacy', { project: 'other' }).length, 1);
    const beforeBlank = await readFile(join(config.memoryDir, 'failures.md'), 'utf8');
    const blank = await tool.execute('replace', validate(tool, { action: 'replace', target: 'failure', scope: 'global', old_text: 'revised global', content: ' \n\t ' }));
    assert.equal(blank.details.success, false);
    assert.equal(await readFile(join(config.memoryDir, 'failures.md'), 'utf8'), beforeBlank);
    const unrelated = await tool.execute('remove', validate(tool, { action: 'remove', target: 'failure', scope: 'global', old_text: 'legacy other project' }));
    assert.equal(unrelated.details.success, false);
    const removed = await tool.execute('remove', validate(tool, { action: 'remove', target: 'failure', scope: 'global', old_text: '⚠️ [global] [correction] revised global' }));
    assert.equal(removed.details.success, true);
    assert.equal((await store.listEntries('failure', 0, 20, null)).total, 0);
    assert.equal(searchMemories(db, 'legacy', { project: 'other' }).length, 1);
  } finally { db.close(); }
});

test('same-name repositories isolate memory while subdirectories and linked worktrees share identity', async () => {
  const main = join(root, 'a', 'demo'), other = join(root, 'b', 'demo'), worktree = join(root, 'worktree');
  await mkdir(join(main, '.git', 'worktrees', 'linked'), { recursive: true });
  await mkdir(join(main, 'src'));
  await mkdir(join(other, '.git'), { recursive: true });
  await mkdir(worktree);
  await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'linked')}\n`);
  await writeFile(join(main, '.git', 'worktrees', 'linked', 'commondir'), '../..\n');
  const first = detectProject(undefined, main);
  assert.notEqual(first.memoryDir, detectProject(undefined, other).memoryDir);
  assert.notEqual(first.name, detectProject(undefined, other).name);
  assert.equal(first.memoryDir, detectProject(undefined, join(main, 'src')).memoryDir);
  assert.equal(first.memoryDir, detectProject(undefined, worktree).memoryDir);
  if (process.platform === 'win32') assert.equal(first.memoryDir, detectProject(undefined, main.toUpperCase()).memoryDir);
});

test('digest budgets represent every source and retain old global corrections without unrelated project failures', async () => {
  const { store, config } = await fixture('digest');
  const { store: project } = await fixture('digest-project');
  await writeFile(join(config.memoryDir, 'failures.md'), '[correction] durable global <!-- created=2000-01-01, last=2000-01-01 -->\n§\n[failure] obsolete temporary <!-- created=2000-01-01, last=2000-01-01 -->\n§\n[correction] unrelated <!-- created=2000-01-01, last=2000-01-01, project64=b3RoZXI -->');
  await store.add('memory', '[lesson] global lesson');
  await store.loadFromDisk();
  await project.add('memory', 'project requirement');
  const digest = buildSessionMemoryDigest(config, store, project, 'demo');
  assert.match(digest, /global lesson/);
  assert.match(digest, /durable global/);
  assert.doesNotMatch(digest, /obsolete temporary|unrelated/);
  const full = buildMemoryDigest({ user: Array.from({ length: 30 }, (_, i) => `user ${i} ${'x'.repeat(150)}`), global: ['global sentinel'], project: ['project sentinel'], projectName: 'demo', failures: ['failure sentinel'] });
  assert.ok(full.length <= 2000);
  for (const value of ['global sentinel', 'project sentinel', 'failure sentinel']) assert.ok(full.includes(value));
});

test('review can update user and failure files, revalidates after confirmation and preserves other scopes', async () => {
  for (const target of ['user', 'failure']) {
    const { store, config, harness } = await fixture(`review-${target}`);
    if (target === 'user') await store.add('user', 'old preference');
    else {
      await store.addFailure('old correction', { category: 'correction' });
      await store.addFailure('other project correction', { category: 'correction', project: 'other' });
    }
    const old = target === 'user' ? 'old preference' : '[correction] old correction';
    const next = target === 'user' ? 'new preference' : '[correction] new correction';
    const messages = [];
    const review = createMemoryReviewHandler(store, config, 1000, { runProposal: async () => ({ ok: true, operations: [{ action: 'replace', target, old_text: old, content: next }] }) });
    const context = { hasUI: true, sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Please update my saved preference.' } }] }, ui: { notify: text => messages.push(text), editor: async (_title, preview) => preview, confirm: async () => true } };
    await review(`global ${target}`, context);
    assert.ok(store.getEntries(target).includes(next), messages.join('\n'));
    if (target === 'failure') assert.ok(store.getEntries(target).includes('[correction] other project correction'));
    // A newer canonical edit must survive a stale confirmed proposal.
    const before = store.getEntries(target);
    await store.add(target, 'concurrent entry');
    const result = await store.replaceMemoryEntriesIfUnchanged(before, ['replacement'], target);
    assert.equal(result.success, false);
    assert.match(await readFile(join(config.memoryDir, target === 'user' ? 'USER.md' : 'failures.md'), 'utf8'), /concurrent entry/);
  }
});

test('only the memory menu is registered; startup and sync preserve retired sources without importing them', async () => {
  const agentRoot = process.env.SP_CODING_AGENT_DIR;
  const globalDir = join(agentRoot, '@super-pi', 'memory');
  const project = detectProject();
  const preserved = [
    [join(agentRoot, 'memory', 'MEMORY.md'), 'retired global'],
    [join(agentRoot, 'memory', 'sessions.db'), 'retired database'],
    [join(agentRoot, 'memory', 'skills', 'old.md'), 'retired skill'],
    [join(agentRoot, 'retired-project', 'MEMORY.md'), 'retired root project'],
    [join(agentRoot, 'projects-memory', 'old-basename', 'MEMORY.md'), 'retired basename'],
    [join(globalDir, 'skills', 'flat.md'), 'flat skill is not converted'],
  ];
  for (const [file, content] of preserved) {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
  await mkdir(project.memoryDir, { recursive: true });
  await writeFile(join(project.memoryDir, 'MEMORY.md'), 'current project source');
  await writeFile(join(globalDir, 'MEMORY.md'), '[lesson] current global source');
  const extension = (await import('../dist/index.js')).default;
  const harness = createExtensionHarness();
  const messages = [];
  const ctx = { cwd: process.cwd(), hasUI: true, ui: {
    notify: (text, level) => messages.push({ text, level }),
    select: async (_title, choices) => choices.find(choice => choice === '同步搜索索引'),
  } };
  extension(harness.api);
  try {
    assert.deepEqual([...harness.commands.keys()], ['memory']);
    await emitAll(harness, 'session_start', {}, ctx);
    await harness.commands.get('memory').handler('', ctx);
    assert.equal(messages.some(message => message.level === 'error'), false, JSON.stringify(messages));
    const result = await harness.tools.get('memory_search').execute('search', { query: 'current', project: '*' });
    assert.equal(result.details.count, 2);
    assert.equal((await harness.tools.get('memory_search').execute('old', { query: 'retired', project: '*' })).details.count, 0);
    assert.equal((await readdir(join(agentRoot, 'projects-memory'))).includes('retired-project'), false);
    for (const [file, content] of preserved) assert.equal(await readFile(file, 'utf8'), content);
    await harness.commands.get('memory').handler('import', ctx);
    assert.match(messages.at(-1).text, /导入已退役/);
  } finally {
    await emitAll(harness, 'session_shutdown', {}, ctx);
  }
});

test('failure FIFO preserves other project scopes and rejects when only protected entries remain', async () => {
  const { config, harness } = await fixture('failure-fifo');
  const store = new MemoryStore({ ...config, memoryCharLimit: 150, memoryOverflowStrategy: 'fifo-evict' });
  await store.loadFromDisk();
  registerMemoryTool(harness.api, store, null);
  await store.addFailure('other project correction', { category: 'correction', project: 'other' });
  await store.addFailure('old global entry', { category: 'failure' });
  const tool = harness.tools.get('memory');
  const add = content => tool.execute('add', validate(tool, { action: 'add', target: 'failure', scope: 'global', content }));
  const result = await add('new global entry ' + 'x'.repeat(75));
  assert.equal(result.details.success, true);
  assert.match(store.getEntries('failure', 'other')[0] ?? '', /other project correction/);
  assert.doesNotMatch(store.getEntries('failure', null).join('\n'), /old global entry/);
  const before = await readFile(join(config.memoryDir, 'failures.md'), 'utf8');
  const rejected = await add('oversized relative to retained project ' + 'x'.repeat(130));
  assert.equal(rejected.details.success, false);
  assert.equal(await readFile(join(config.memoryDir, 'failures.md'), 'utf8'), before);
});

test('project failure review preserves the identity used by subsequent FIFO writes', async () => {
  const { config, harness } = await fixture('review-fifo');
  const store = new MemoryStore({ ...config, memoryCharLimit: 130, memoryOverflowStrategy: 'fifo-evict' });
  await store.loadFromDisk();
  await store.addFailure('old project correction', { category: 'correction', project: 'project-a' });
  const review = createMemoryReviewHandler(store, config, 1000, { projectStore: store, projectName: 'project-a',
    runProposal: async () => ({ ok: true, operations: [{ action: 'replace', target: 'failure', old_text: 'old project correction', content: '[correction] revised project correction' }] }) });
  const context = { hasUI: true, sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Revise this project correction.' } }] },
    ui: { notify: () => {}, editor: async (_title, preview) => preview, confirm: async () => true } };
  await review('project failure', context);
  assert.equal((await store.listEntries('failure')).entries[0].project, 'project-a');
  const result = await store.addFailure('new project entry ' + 'x'.repeat(60), { category: 'failure', project: 'project-a' });
  assert.equal(result.success, true);
  assert.equal(result.evicted_count, 1);
});

test('unified manager dispatches existing scoped review and maintenance handlers without changing headless data', async () => {
  const { store, config, harness } = await fixture('manager');
  const calls = [];
  const record = name => async args => { calls.push([name, args]); };
  registerMemoryCommand(harness.api, { store, projectStore: store, project: { root: root, memoryDir: config.memoryDir }, globalDir: config.memoryDir,
    review: record('review'), cleanup: record('cleanup'), sync: record('sync'), skills: record('skills'), bulk: record('bulk') });
  const handler = harness.commands.get('memory').handler;
  const ctx = { hasUI: true, ui: { select: async (_title, choices) => choices[5], notify: () => {} } };
  await handler('', ctx);
  assert.deepEqual(calls, [['review', 'global user']]);
  for (const [label, name] of [['管理技能', 'skills'], ['同步搜索索引', 'sync'], ['清理恢复产物', 'cleanup'], ['批量清理记忆', 'bulk']]) {
    ctx.ui.select = async (_title, choices) => choices.find(choice => choice === label);
    await handler('', ctx);
    assert.deepEqual(calls.at(-1), [name, '']);
  }
  ctx.hasUI = false;
  await handler('', ctx);
  assert.equal(calls.length, 5);
});

test('shutdown closes the exact Markdown coordinators after writes and resolves owner path aliases', async () => {
  const extension = (await import('../dist/index.js')).default;
  const harness = createExtensionHarness();
  extension(harness.api);
  await emitAll(harness, 'session_start', { reason: 'startup' }, { cwd: root });
  const tool = harness.tools.get('memory');
  assert.equal((await tool.execute('write', { action: 'add', target: 'memory', content: '[lesson] shutdown fixture' })).details.success, true);
  assert.equal((await tool.execute('write', { action: 'add', target: 'project', content: 'shutdown fixture' })).details.success, true);
  await emitAll(harness, 'session_shutdown', {}, { cwd: root });
  assert.equal((await readdir(process.env.SP_CODING_AGENT_DIR, { recursive: true })).some(name => name.endsWith('-wal') || name.endsWith('-shm')), false);
  if (process.platform === 'win32') {
    await mkdir(join(root, 'alias-owner'));
    const dbPath = join(await realpath(join(root, 'alias-owner')), 'locks.sqlite');
    const coordinator = AtomicLockCoordinator.shared(dbPath);
    const lease = coordinator.tryAcquire('fixture', { staleMs: 1000 });
    assert.ok(lease);
    lease.release();
    AtomicLockCoordinator.closeSharedUnder(join(root, 'alias-owner').toUpperCase());
    assert.notEqual(AtomicLockCoordinator.shared(dbPath), coordinator);
  }
});
