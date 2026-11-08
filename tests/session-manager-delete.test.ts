import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSessions, occupiedSessionPaths, inspectSessionTrash, deleteSessionTrashCandidates, type ManagedSession } from '../packages/extensions/session-memory-manager/core.ts';
import { createSessionLease, getSessionLeaseDir } from '../packages/coding-agent/src/core/session-lease.ts';
import { SessionManager } from '@super-pi/coding-agent';
import { getKeybindings } from '../packages/tui/src/keybindings.ts';

test('batch deletion rechecks occupancy, continues after per-file failure and never creates recovery copies or a database', () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-batch-delete-'));
  const leaseDir = getSessionLeaseDir(root);
  const sessions: ManagedSession[] = ['current', 'busy', 'free', 'missing', 'last'].map(id => ({
    id, path: join(root, `${id}.jsonl`), firstMessage: id, modified: new Date(), messageCount: 1,
  }));
  for (const session of sessions) if (session.id !== 'missing') writeFileSync(session.path, session.id);
  let lease: ReturnType<typeof createSessionLease> | undefined;
  try {
    assert.deepEqual([...occupiedSessionPaths(sessions, sessions[0]!.path, leaseDir)], [sessions[0]!.path]);
    // Occupancy changes after the list snapshot but before the delete operation.
    lease = createSessionLease(root, sessions[1]!.path, sessions[1]!.id);
    const result = deleteSessions(sessions, () => sessions[0]!.path, leaseDir);
    assert.deepEqual(result.deleted, [sessions[2]!.path, sessions[4]!.path]);
    assert.deepEqual(result.failures.map(failure => failure.path), [sessions[0]!.path, sessions[1]!.path, sessions[3]!.path]);
    assert.match(result.failures[1]!.error, /占用/);
    assert.equal(readFileSync(sessions[0]!.path, 'utf8'), 'current');
    assert.equal(readFileSync(sessions[1]!.path, 'utf8'), 'busy');
    assert.equal(existsSync(sessions[2]!.path), false);
    assert.equal(existsSync(sessions[4]!.path), false);
    assert.deepEqual(readdirSync(join(root, '@super-pi/memory')), ['session-leases']);
    lease.stop(); lease = undefined;
    assert.equal(occupiedSessionPaths(sessions, sessions[0]!.path, leaseDir).has(sessions[1]!.path), false);
    assert.deepEqual(deleteSessions([sessions[1]!], () => sessions[0]!.path, leaseDir).failures, []);
  } finally { lease?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('clean reports partial deletion and preserves changed, occupied and unmanaged recovery files', () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-batch-clean-'));
  const trash = join(root, 'old-trash'); mkdirSync(trash);
  const paths: string[] = [];
  for (let i = 0; i < 3; i++) {
    const file = join(trash, `2020-01-01T00-00-00.000Z_12345678-1234-4123-8123-123456789ab${i}_abcdefab-1234-4123-8123-123456789abc_session.jsonl`);
    writeFileSync(file, 'old'); utimesSync(file, new Date(0), new Date(0)); paths.push(file);
  }
  writeFileSync(join(trash, 'unmanaged.jsonl'), 'keep');
  const candidates = inspectSessionTrash(trash).deletionBatch;
  assert.equal(candidates.length, 3);
  writeFileSync(paths[0]!, 'changed after preview');
  const lease = createSessionLease(root, paths[1]!, '12345678-1234-4123-8123-123456789ab1');
  try {
    const result = deleteSessionTrashCandidates(trash, candidates, getSessionLeaseDir(root));
    assert.equal(result.files, 1);
    assert.equal(result.failures.length, 2);
    assert.ok(result.failures.some(failure => /身份已变化/.test(failure.error)));
    assert.ok(result.failures.some(failure => /占用/.test(failure.error)));
    assert.equal(existsSync(paths[2]!), false);
    assert.equal(readFileSync(join(trash, 'unmanaged.jsonl'), 'utf8'), 'keep');
  } finally { lease.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('management command preserves selection after cancellation and refreshes partial failures for retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sp-batch-ui-'));
  const previousAgentDir = process.env.SP_CODING_AGENT_DIR;
  process.env.SP_CODING_AGENT_DIR = root;
  const sessions = ['current', 'busy', 'first', 'retry'].map(id => ({
    id, path: join(root, `${id}.jsonl`), firstMessage: id, modified: new Date(), created: new Date(), messageCount: 1, cwd: root,
  }));
  for (const session of sessions) writeFileSync(session.path, session.id);
  const lease = createSessionLease(root, sessions[1]!.path, sessions[1]!.id);
  const notifications: Array<{ text: string; level: string }> = [];
  let handler: (args: string, ctx: any) => Promise<void>;
  let views = 0, confirmations = 0;
  try {
    const { default: register } = await import('../packages/extensions/session-memory-manager/index.ts');
    register({ registerCommand(name: string, command: any) { assert.equal(name, 'memory-sessions'); handler = command.handler; } } as any);
    t.mock.method(SessionManager, 'listAll', async () => sessions.filter(session => existsSync(session.path)));
    const ctx = {
      waitForIdle: async () => {}, hasUI: true, mode: 'tui', sessionManager: { getSessionFile: () => sessions[0]!.path },
      ui: {
        notify(text: string, level: string) { notifications.push({ text, level }); },
        confirm: async () => {
          confirmations++;
          if (confirmations === 1) return false;
          if (confirmations === 2) { rmSync(sessions[3]!.path); mkdirSync(sessions[3]!.path); }
          return true;
        },
        custom: async (factory: any) => {
          views++;
          let selected: unknown;
          const selector = factory({ terminal: { rows: 30 } }, { bold: (s: string) => s, fg: (_: string, s: string) => s }, getKeybindings(), (value: unknown) => { selected = value; });
          try {
            selector.focused = true; selector.render(90);
            const rows = (selector as any).items;
            assert.ok(rows.find((row: any) => row.value.id === 'current').disabled);
            assert.ok(rows.find((row: any) => row.value.id === 'busy').disabled);
            if (views === 1) {
              // Component key behavior is covered separately; this exercises the actual command loop.
              selected = [sessions[2], sessions[3]];
            } else if (views === 2) {
              assert.deepEqual(rows.filter((row: any) => row.checked).map((row: any) => row.value.id), ['first', 'retry']);
              selected = [sessions[2], sessions[3]];
            } else if (views === 3) {
              assert.equal(rows.some((row: any) => row.value.id === 'first'), false);
              const retry = rows.find((row: any) => row.value.id === 'retry');
              assert.equal(retry.checked, true);
              assert.match(retry.detail, /删除失败/);
              rmSync(sessions[3]!.path, { recursive: true }); writeFileSync(sessions[3]!.path, 'retry');
              selected = [sessions[3]];
            } else {
              assert.equal(views, 4);
              assert.equal(rows.length, 2);
              selector.handleInput('\x1b');
            }
          } finally { selector.dispose(); }
          return selected;
        },
      },
    };
    await handler!('', ctx);
    assert.equal(views, 4); assert.equal(confirmations, 3);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0]!.level, 'warning');
    assert.match(notifications[0]!.text, /删除成功 1 个；删除失败 1 个/);
    assert.match(notifications[1]!.text, /删除成功 1 个；删除失败 0 个/);
    assert.deepEqual(readdirSync(join(root, '@super-pi/memory')), ['session-leases']);
  } finally {
    lease.stop();
    if (previousAgentDir === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
