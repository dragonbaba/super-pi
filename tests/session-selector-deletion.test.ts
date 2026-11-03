import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getKeybindings, setKeybindings } from '@super-pi/tui';
import { ENV_AGENT_DIR } from '../packages/coding-agent/src/config.ts';
import { KeybindingsManager } from '../packages/coding-agent/src/core/keybindings.ts';
import { deleteSessionFile } from '../packages/coding-agent/src/core/session-deletion.ts';
import { createSessionLease, getSessionLeaseDir, type SessionLease } from '../packages/coding-agent/src/core/session-lease.ts';
import { SessionSelectorComponent } from '../packages/coding-agent/src/modes/interactive/components/session-selector.ts';
import { initTheme } from '../packages/coding-agent/src/modes/interactive/theme/theme.ts';

test('selector deletion checks activation after confirmation in default and explicit lease domains', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-selector-delete-'));
  const file = join(root, 'fixture.jsonl'), lock = join(getSessionLeaseDir(root), '.mutation-lock');
  const previousDir = process.env[ENV_AGENT_DIR], previousKeys = getKeybindings();
  const selectors: SessionSelectorComponent[] = [];
  let lease: SessionLease | undefined, trashCalls = 0, unlinks = 0;
  const unlink = fs.unlinkSync;
  try {
    initTheme('dark');
    const keybindings = new KeybindingsManager(); setKeybindings(keybindings);
    t.mock.method(childProcess, 'spawnSync', () => {
      trashCalls++; assert.ok(fs.existsSync(lock));
      return { status: null, signal: null, error: Object.assign(new Error('fixture trash unavailable'), { code: 'ENOENT' }), stderr: '' } as any;
    });
    t.mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
      // Node 22 rmSync also enters this export for the lease's own files (as Buffers).
      if (String(path) !== file) return unlink(path);
      assert.equal(path, file); assert.ok(fs.existsSync(lock)); unlinks++; unlink(path);
    });
    syncBuiltinESMExports();
    for (const explicit of [false, true]) {
      fs.writeFileSync(file, 'synthetic session content\n');
      process.env[ENV_AGENT_DIR] = explicit ? join(root, 'different-default') : root;
      let loads = 0;
      const info = { path: file, id: 'fixture-session', cwd: root, created: new Date(1), modified: new Date(1), messageCount: 1, firstMessage: 'fixture' };
      const load = async () => { loads++; return fs.existsSync(file) ? [info] : []; };
      const selector = new SessionSelectorComponent(load, load, () => {}, () => {}, () => {}, () => {},
        { keybindings, ...(explicit ? { agentDir: root } : {}) });
      selectors.push(selector);
      await new Promise<void>(resolve => setImmediate(resolve));
      const state = selector as any, list = state.sessionList;
      state.allSessions = [info];
      let deleting: Promise<void> | undefined;
      const handleDelete = list.onDeleteSession;
      list.onDeleteSession = (path: string) => deleting = handleDelete(path);
      selector.handleInput('\u0004');
      assert.equal(list.confirmingDeletePath, file);
      // A different session activates after the user opened confirmation.
      lease = createSessionLease(root, file, info.id);
      const beforeLoads = loads, beforeTrash = trashCalls, beforeUnlinks = unlinks;
      selector.handleInput('\r'); assert.ok(deleting); await deleting;
      assert.equal(trashCalls, beforeTrash); assert.equal(unlinks, beforeUnlinks);
      assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic session content\n');
      assert.equal(loads, beforeLoads, 'refusal does not refresh or remove a listed session');
      assert.equal(state.currentSessions.length, 1); assert.equal(state.allSessions.length, 1);
      assert.equal(state.header.statusMessage.type, 'error'); assert.match(state.header.statusMessage.message, /占用/);
      assert.equal(fs.existsSync(lock), false);
      lease.stop(); lease = undefined;
      selector.handleInput('\u0004'); selector.handleInput('\r'); await deleting;
      assert.equal(trashCalls, beforeTrash + 1); assert.equal(unlinks, beforeUnlinks + 1);
      assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(lock), false);
      assert.equal(state.currentSessions.length, 0); assert.equal(state.allSessions.length, 0);
      assert.equal(state.header.statusMessage.type, 'info'); assert.ok(loads > beforeLoads);
      selector.dispose(); assert.equal(state.header.statusTimeout, null);
    }
  } finally {
    for (const selector of selectors) selector.dispose(); lease?.stop();
    t.mock.restoreAll(); syncBuiltinESMExports(); setKeybindings(previousKeys);
    if (previousDir === undefined) delete process.env[ENV_AGENT_DIR]; else process.env[ENV_AGENT_DIR] = previousDir;
    fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false);
  }
});

test('native session deletion holds the publication lock and stops fallback on uncertain trash results', { timeout: 5000 }, t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-session-delete-'));
  const file = join(root, 'fixture.jsonl'), lock = join(getSessionLeaseDir(root), '.mutation-lock');
  const unlink = fs.unlinkSync;
  let lease: SessionLease | undefined, trashCalls = 0, unlinks = 0, rejectUnlink = false, removeInTrash = false;
  let trashResult: any = { status: 1, signal: null, stderr: 'fixture trash refused' };
  try {
    t.mock.method(childProcess, 'spawnSync', (command: string, args: string[], options: any) => {
      trashCalls++; assert.equal(command, 'trash'); assert.deepEqual(args, [file]);
      assert.ok(fs.existsSync(join(lock, 'owner.json')));
      assert.equal(options.timeout, 2000); assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.windowsHide, true); assert.notEqual(options.shell, true);
      if (removeInTrash) unlink(file);
      return trashResult;
    });
    t.mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
      if (String(path) !== file) return unlink(path);
      assert.equal(path, file); assert.ok(fs.existsSync(join(lock, 'owner.json'))); unlinks++;
      if (rejectUnlink) throw Object.assign(new Error('fixture unlink denied'), { code: 'EACCES' });
      unlink(path);
    });
    syncBuiltinESMExports();
    fs.writeFileSync(file, 'preserved');
    lease = createSessionLease(root, file, 'active-fixture');
    const alias = `${root}/../${root.split(/[\\/]/).at(-1)}/fixture.jsonl`;
    assert.equal(deleteSessionFile(alias, root).ok, false); assert.equal(trashCalls, 0); assert.equal(unlinks, 0);
    lease.stop(); lease = undefined;
    const invalidAgentDir = join(root, 'not-a-directory'); fs.writeFileSync(invalidAgentDir, 'fixture');
    assert.equal(deleteSessionFile(file, invalidAgentDir).ok, false); assert.equal(trashCalls, 0); assert.equal(unlinks, 0);
    assert.deepEqual(deleteSessionFile(file, root), { ok: true, method: 'unlink' });
    assert.equal(trashCalls, 1); assert.equal(unlinks, 1); assert.equal(fs.existsSync(lock), false);
    for (const code of ['ETIMEDOUT', 'ENOBUFS', 'signal']) {
      fs.writeFileSync(file, 'fixture');
      trashResult = { status: 0, signal: code === 'signal' ? 'SIGKILL' : null, stderr: '',
        error: code === 'signal' ? undefined : Object.assign(new Error(code), { code }) };
      removeInTrash = code === 'ENOBUFS';
      const before: number = unlinks;
      const result = deleteSessionFile(file, root);
      assert.equal(result.ok, false); assert.equal(result.method, 'trash'); assert.equal(unlinks, before);
      assert.equal(fs.existsSync(file), !removeInTrash); assert.equal(fs.existsSync(lock), false);
    }
    trashResult = { status: 0, signal: null, stderr: '' }; removeInTrash = true;
    assert.deepEqual(deleteSessionFile(file, root), { ok: true, method: 'trash' });
    fs.writeFileSync(file, 'preserved');
    trashResult = { status: 1, signal: null, stderr: 'fixture trash refused' }; removeInTrash = false; rejectUnlink = true;
    const failed = deleteSessionFile(file, root);
    assert.equal(failed.ok, false); assert.match(failed.error!, /fixture unlink denied.*trash/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'preserved'); assert.equal(fs.existsSync(lock), false);
  } finally {
    lease?.stop(); t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false);
  }
});
