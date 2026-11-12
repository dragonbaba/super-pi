import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runFileMutationRequest } from '../packages/coding-agent/src/core/sandbox/mxc-file-mutation-worker.mjs';
import { capturePathIdentity } from '../packages/coding-agent/src/core/files/file-tree-core.mjs';
import { readFileWorkerManifest, readFileParentManifest, writeFileParentManifest } from '../packages/coding-agent/src/core/files/file-worker-plan.mjs';
import { createOwnedManifestFile } from '../packages/coding-agent/src/core/files/file-manifest-artifact.mjs';
import { mutationRequestHash } from '../packages/coding-agent/src/core/files/file-invocation.ts';
import { FILE_MUTATION_TEXT_BYTES, FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES } from '../packages/coding-agent/src/core/files/file-operation-limits.mjs';

async function fixture(t, operations, operation = 'file_batch') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-v3-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), exchange = join(root, 'exchange'); await mkdir(workspace); await mkdir(exchange);
  const identity = await capturePathIdentity(workspace), id = randomUUID().replaceAll('-', '');
  const items = [];
  for (const item of operations) items.push({ ...item, workspaceIndex: 0,
    ...(item.destination ? { destinationWorkspaceIndex: 0 } : {}), inputHash: mutationRequestHash(item.operation, item) });
  const request = { version: 3, rpc: 'file-mutation-v3', id, callId: 'worker-only-fixture', operation, mode: 'sandbox-write',
    workspaces: [workspace], workspaceIdentities: [identity.device + ':' + identity.inode], exchange, generation: 3,
    requestHash: 'c'.repeat(64), maxWriteBytes: FILE_MUTATION_TEXT_BYTES, itemCount: items.length, start: 0, items };
  const owned = []; for (let index = 0; index < items.length; index++) owned.push({ owned: await createOwnedManifestFile(exchange, `${id}-${index}.manifest`) });
  async function rpc(phase, start, selectedItems, prepared, other = {}) {
    const body = { ...request, phase, start, items: selectedItems, control: { prepared, ...other } }, wire = JSON.stringify(body);
    assert(Buffer.byteLength(wire) <= FILE_RPC_REQUEST_BYTES);
    const serialized = await runFileMutationRequest(body, wire); assert(Buffer.byteLength(serialized) <= FILE_RPC_REPLY_BYTES);
    const reply = JSON.parse(serialized); assert.equal(reply.wireHash, createHash('sha256').update(wire).digest('hex')); return reply;
  }
  async function prepare() { const reply = await rpc('prepare', 0, items, owned); assert(reply.ok, JSON.stringify(reply)); return reply.items; }
  async function validate(prepared) {
    const reply = await rpc('validate', 0, items, prepared.map(entry => ({ manifest: entry.manifest })));
    assert(reply.ok, JSON.stringify(reply)); return reply.items;
  }
  async function execute(index, prepared, validated, extra = {}, selected = items[index]) {
    const reply = await rpc('execute', index, [selected], [{ manifest: prepared[index].manifest, validated: validated[index].validated, ...extra }],
      { readyHash: 'a'.repeat(64), intentId: '12345678' });
    assert(reply.ok, JSON.stringify(reply)); return reply.items[0].receipt;
  }
  return { root, workspace, exchange, request, items, prepare, validate, execute, rpc };
}

test('worker-only v3 preparation is read-only and recursive copy preserves every prepared file', async t => {
  const f = await fixture(t, [{ operation: 'copy', path: 'source', destination: 'copied' }], 'copy');
  await mkdir(join(f.workspace, 'source')); await mkdir(join(f.workspace, 'source/nested'));
  await writeFile(join(f.workspace, 'source/nested/file'), Buffer.alloc(90003, 0x89));
  const prepared = await f.prepare(); await assert.rejects(lstat(join(f.workspace, 'copied')), { code: 'ENOENT' });
  const validated = await f.validate(prepared), receipt = await f.execute(0, prepared, validated);
  assert.equal(receipt.status, 'succeeded', JSON.stringify(receipt)); assert.equal(receipt.files, 1);
  assert.deepEqual(await readFile(join(f.workspace, 'copied/nested/file')), await readFile(join(f.workspace, 'source/nested/file')));
  assert.equal(receipt.snapshot, undefined, 'copy does not invent a native read version');
});

test('worker-only binary overwrite streams through the existing MXC publication owner', async t => {
  const f = await fixture(t, [{ operation: 'copy', path: 'source', destination: 'target', overwrite: true }], 'copy');
  const content = Buffer.alloc(3 * 1024 * 1024 + 7, 0x8d); await writeFile(join(f.workspace, 'source'), content); await writeFile(join(f.workspace, 'target'), 'old');
  const prepared = await f.prepare(); assert.equal(await readFile(join(f.workspace, 'target'), 'utf8'), 'old');
  const validated = await f.validate(prepared), receipt = await f.execute(0, prepared, validated);
  assert.equal(receipt.status, 'succeeded', JSON.stringify(receipt)); assert.equal(receipt.commit.outcome, 'committed');
  assert.equal(receipt.sha256, createHash('sha256').update(content).digest('hex')); assert.deepEqual(await readFile(join(f.workspace, 'target')), content);
});

test('worker-only creation shares deep parent identities through temporary byte-bounded artifacts', async t => {
  const deep = 'new/' + 'p/'.repeat(40) + 'shared';
  const f = await fixture(t, [
    { operation: 'write', mode: 'create', path: deep + '/first', content: 'first' },
    { operation: 'write', mode: 'create', path: deep + '/second', content: 'second' },
  ]);
  const prepared = await f.prepare(), validated = await f.validate(prepared);
  await assert.rejects(lstat(join(f.workspace, 'new')), { code: 'ENOENT' });
  const effects0 = await createOwnedManifestFile(f.exchange, `${f.request.id}-2.manifest`);
  const first = await f.execute(0, prepared, validated, { effects: effects0 }); assert.equal(first.status, 'succeeded', JSON.stringify(first));
  const firstPlan = await readFileWorkerManifest(f.request, f.items[0], 0, prepared[0].manifest);
  const parents = await readFileParentManifest(f.request, 0, firstPlan.creation, 'created', first.createdParents);
  assert.equal(parents.created.length, 42); assert(first.createdParents.bytes > 4096);
  const shared = new Map(); for (const parent of parents.created) shared.set(parent.path.toLowerCase(), parent.identity);
  // Use the same key convention as the shared creation owner on every platform.
  if (process.platform !== 'win32') { shared.clear(); for (const parent of parents.created) shared.set(parent.path, parent.identity); }
  const secondPlan = await readFileWorkerManifest(f.request, f.items[1], 1, prepared[1].manifest);
  const sharedOwned = await createOwnedManifestFile(f.exchange, `${f.request.id}-5.manifest`);
  const sharedArtifact = await writeFileParentManifest(f.request, 1, secondPlan.creation, sharedOwned, 'shared', shared);
  const effects1 = await createOwnedManifestFile(f.exchange, `${f.request.id}-3.manifest`);
  const second = await f.execute(1, prepared, validated, { shared: sharedArtifact, effects: effects1 });
  assert.equal(second.status, 'succeeded', JSON.stringify(second)); assert.equal(second.creation.createdDirectoryCount, 0);
  assert.equal(await readFile(join(f.workspace, deep, 'first'), 'utf8'), 'first');
  assert.equal(await readFile(join(f.workspace, deep, 'second'), 'utf8'), 'second');
});

for (const operation of ['move', 'delete']) test(`worker-only recursive ${operation} validates complete nested coverage`, async t => {
  const input = { operation, path: 'source', ...(operation === 'move' ? { destination: 'target' } : { recursive: true }) };
  const f = await fixture(t, [input], operation);
  await mkdir(join(f.workspace, 'source/nested'), { recursive: true }); await writeFile(join(f.workspace, 'source/nested/file'), 'original');
  const prepared = await f.prepare(), validated = await f.validate(prepared), receipt = await f.execute(0, prepared, validated);
  assert.equal(receipt.status, 'succeeded', JSON.stringify(receipt)); assert.equal(receipt.files, 1); assert.equal(receipt.directories, 2);
  await assert.rejects(lstat(join(f.workspace, 'source')), { code: 'ENOENT' });
  if (operation === 'move') assert.equal(await readFile(join(f.workspace, 'target/nested/file'), 'utf8'), 'original');
});

test('worker-only stale identities, changed content and foreign manifests fail before destination effects', async t => {
  const f = await fixture(t, [{ operation: 'copy', path: 'source', destination: 'target' }], 'copy');
  await writeFile(join(f.workspace, 'source'), 'before'); const prepared = await f.prepare(), validated = await f.validate(prepared);
  await writeFile(join(f.workspace, 'source'), 'after');
  let receipt = await f.execute(0, prepared, validated); assert.equal(receipt.status, 'failed_no_change');
  await assert.rejects(lstat(join(f.workspace, 'target')), { code: 'ENOENT' });
  const g = await fixture(t, [{ operation: 'write', mode: 'create', path: 'new-file', content: 'original' }]);
  const preparedText = await g.prepare(), validatedText = await g.validate(preparedText);
  receipt = await g.execute(0, preparedText, validatedText, {}, { ...g.items[0], content: 'changed after prepare' });
  assert.equal(receipt.status, 'failed_no_change'); await assert.rejects(lstat(join(g.workspace, 'new-file')), { code: 'ENOENT' });
  const bad = await g.rpc('execute', 0, g.items, [{ manifest: { ...preparedText[0].manifest, sha256: 'b'.repeat(64) }, validated: validatedText[0].validated }],
    { readyHash: 'a'.repeat(64), intentId: '12345678' });
  assert.equal(bad.items[0].receipt.status, 'failed_no_change'); await assert.rejects(lstat(join(g.workspace, 'new-file')), { code: 'ENOENT' });
});
