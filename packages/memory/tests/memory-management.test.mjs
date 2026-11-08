import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionHarness, emitAll } from './extension-harness.mjs';

const root = await mkdtemp(join(tmpdir(), 'sp-memory-management-'));
process.env.SP_CODING_AGENT_DIR = join(root, 'agent');
const { MemoryStore } = await import('../dist/store/memory-store.js');
const { DatabaseManager } = await import('../dist/store/db.js');
const { AtomicLockCoordinator } = await import('../dist/store/atomic-lock-coordinator.js');
const { loadConfig } = await import('../dist/config.js');
const { registerMemoryTool } = await import('../dist/tools/memory-tool.js');
const { registerMemorySearchTool } = await import('../dist/tools/memory-search-tool.js');
const { addMemory, searchMemories } = await import('../dist/store/sqlite-memory-store.js');
const { validateToolArguments } = await import('../../ai/dist/utils/validation.js');
const { buildSessionMemoryDigest } = await import('../dist/prompt-context.js');
const { buildMemoryDigest } = await import('../dist/memory-digest.js');
const { detectProject } = await import('../dist/project.js');
const { registerMemoryReviewCommand } = await import('../dist/handlers/memory-review.js');
const { importLegacyProjectEntries, registerMemoryCommand } = await import('../dist/handlers/memory-command.js');
test.after(async () => { await AtomicLockCoordinator.closeSharedUnder(root); await rm(root, { recursive: true, force: true }); });

async function fixture(name) {
  const config = { ...loadConfig(), memoryDir: join(root, name), userCharLimit: 10000 };
  const store = new MemoryStore(config);
  await store.loadFromDisk();
  return { config, store, harness: createExtensionHarness() };
}
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
    await store.addFailure('global correction', { category: 'correction' });
    await store.addFailure('legacy other project\nonly applies there', { category: 'correction', project: 'other' });
    await project.addFailure('project correction', { category: 'correction', project: 'project-a' });
    const global = await tool.execute('list', validate(tool, { action: 'list', target: 'failure', scope: 'global' }));
    assert.equal(global.details.total, 1);
    assert.match(global.content[0].text, /global correction/);
    const local = await tool.execute('list', validate(tool, { action: 'list', target: 'failure', scope: 'project' }));
    assert.equal(local.details.total, 1);
    assert.match(local.content[0].text, /project correction/);
    const changed = await tool.execute('replace', validate(tool, { action: 'replace', target: 'failure', scope: 'global', old_text: 'global correction', content: '[correction] revised global' }));
    assert.equal(changed.details.success, true);
    assert.match((await readFile(join(config.memoryDir, 'failures.md'), 'utf8')), /legacy other project\nonly applies there/);
    assert.equal(searchMemories(db, 'legacy', { project: null }).length, 0);
    assert.equal(searchMemories(db, 'legacy', { project: 'other' }).length, 1);
    const beforeBlank = await readFile(join(config.memoryDir, 'failures.md'), 'utf8');
    const blank = await tool.execute('replace', validate(tool, { action: 'replace', target: 'failure', scope: 'global', old_text: 'revised global', content: ' \n\t ' }));
    assert.equal(blank.details.success, false);
    assert.equal(await readFile(join(config.memoryDir, 'failures.md'), 'utf8'), beforeBlank);
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
    registerMemoryReviewCommand(harness.api, store, config, 1000, { runProposal: async () => ({ ok: true, operations: [{ action: 'replace', target, old_text: old, content: next }] }) });
    const context = { hasUI: true, sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Please update my saved preference.' } }] }, ui: { notify: text => messages.push(text), editor: async (_title, preview) => preview, confirm: async () => true } };
    await harness.commands.get('memory-review').handler(`global ${target}`, context);
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

test('legacy import requires confirmation, preserves source, and rejects source or destination changes after preview', async () => {
  const { store, config } = await fixture('legacy-import');
  const legacy = join(root, 'old-basename');
  await mkdir(legacy);
  const file = join(legacy, 'MEMORY.md');
  await writeFile(file, 'old project decision');
  const project = { name: 'new-identity', displayName: 'demo', root: join(root, 'repository'), memoryDir: config.memoryDir, legacyMemoryDirs: [legacy] };
  const notes = [];
  const ctx = { hasUI: true, ui: { notify: text => notes.push(text), select: async (_title, choices) => choices[0], editor: async (_title, text) => text, confirm: async () => false } };
  await importLegacyProjectEntries(ctx, config, project, store);
  assert.deepEqual(store.getMemoryEntries(), []);
  ctx.ui.confirm = async () => { await writeFile(file, 'changed source'); return true; };
  await importLegacyProjectEntries(ctx, config, project, store);
  assert.deepEqual(store.getMemoryEntries(), []);
  ctx.ui.confirm = async () => { await store.add('memory', 'concurrent destination'); return true; };
  await importLegacyProjectEntries(ctx, config, project, store);
  assert.deepEqual(store.getMemoryEntries(), ['concurrent destination']);
  ctx.ui.confirm = async () => true;
  await importLegacyProjectEntries(ctx, config, project, store);
  assert.deepEqual(store.getMemoryEntries(), ['concurrent destination', 'changed source']);
  assert.equal(await readFile(file, 'utf8'), 'changed source');
  await importLegacyProjectEntries(ctx, config, project, store);
  assert.equal(store.getMemoryEntries().length, 2, 'repeated import does not duplicate entries');
  const failures = join(legacy, 'failures.md');
  const rawFailure = '[failure] obsolete temporary <!-- created=2000-01-01, last=2001-01-01 -->';
  await writeFile(failures, rawFailure);
  ctx.ui.select = async () => failures;
  await importLegacyProjectEntries(ctx, config, project, store);
  assert.deepEqual(store.getFailureEntries(7), [], 'import must not revive expired temporary failures');
  const imported = (await store.listEntries('failure')).entries[0];
  assert.equal(imported.created, '2000-01-01');
  assert.equal(imported.lastReferenced, '2001-01-01');
  assert.equal(imported.project, 'new-identity');
  assert.equal(await readFile(failures, 'utf8'), rawFailure);
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
  registerMemoryReviewCommand(harness.api, store, config, 1000, { projectStore: store, projectName: 'project-a',
    runProposal: async () => ({ ok: true, operations: [{ action: 'replace', target: 'failure', old_text: 'old project correction', content: '[correction] revised project correction' }] }) });
  const context = { hasUI: true, sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Revise this project correction.' } }] },
    ui: { notify: () => {}, editor: async (_title, preview) => preview, confirm: async () => true } };
  await harness.commands.get('memory-review').handler('project failure', context);
  assert.equal((await store.listEntries('failure')).entries[0].project, 'project-a');
  const result = await store.addFailure('new project entry ' + 'x'.repeat(60), { category: 'failure', project: 'project-a' });
  assert.equal(result.success, true);
  assert.equal(result.evicted_count, 1);
});

test('unified manager dispatches existing scoped review and maintenance handlers without changing headless data', async () => {
  const { store, config, harness } = await fixture('manager');
  const calls = [];
  const record = name => async args => { calls.push([name, args]); };
  registerMemoryCommand(harness.api, { store, projectStore: store, config, project: { root: root, memoryDir: config.memoryDir }, globalDir: config.memoryDir,
    review: record('review'), cleanup: record('cleanup'), sync: record('sync'), skills: record('skills') });
  const handler = harness.commands.get('memory').handler;
  const ctx = { hasUI: true, ui: { select: async (_title, choices) => choices[5], notify: () => {} } };
  await handler('', ctx);
  assert.deepEqual(calls, [['review', 'global user']]);
  ctx.hasUI = false;
  await handler('', ctx);
  assert.equal(calls.length, 1);
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
