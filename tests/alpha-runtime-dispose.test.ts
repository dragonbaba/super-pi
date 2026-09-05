import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionRuntime } from '../packages/coding-agent/src/core/agent-session-runtime.ts';
import { SessionManager } from '../packages/coding-agent/src/core/session-manager.ts';

function fixture(failures = 0) {
  const order: string[] = [];
  const errors = [new Error('shutdown'), new Error('invalidate'), new Error('session')];
  let onShutdown: (() => void) | undefined;
  const session = {
    sessionManager: SessionManager.inMemory(process.cwd()), sessionFile: undefined,
    abort: async () => {},
    extensionRunner: { hasHandlers: (event: string) => event === 'session_shutdown', emit: async () => {
      order.push('shutdown'); onShutdown?.(); if (failures & 1) throw errors[0];
    } },
    dispose: () => { order.push('session'); if (failures & 4) throw errors[2]; },
  };
  const runtime = new AgentSessionRuntime(session as never, { cwd: process.cwd(), agentDir: process.cwd() } as never, async () => { throw new Error('unexpected factory'); });
  runtime.setBeforeSessionInvalidate(() => { order.push('invalidate'); if (failures & 2) throw errors[1]; });
  runtime.setRebindSession(async () => {});
  return { runtime, order, errors, session, reenter(callback: () => void) { onShutdown = callback; } };
}

for (const count of [1, 2, 3, 100]) test(`runtime single owner: ${count} concurrent callers`, async () => {
  const f = fixture();
  const calls = Array.from({ length: count }, () => f.runtime.dispose());
  for (const call of calls) assert.equal(call, calls[0], 'same published operation');
  await Promise.all(calls);
  assert.equal(f.runtime.dispose(), calls[0]);
  await f.runtime.dispose();
  assert.deepEqual(f.order, ['shutdown', 'invalidate', 'session']);
  const state = f.runtime as unknown as Record<string, unknown>;
  assert.equal(state.beforeSessionInvalidate, undefined);
  assert.equal(state.rebindSession, undefined);
  assert.equal(state.resolveDispose, undefined);
  assert.equal(state.rejectDispose, undefined);
});

for (let mask = 1; mask < 8; mask++) test(`runtime mandatory cleanup and first failure: ${mask}`, async () => {
  const f = fixture(mask);
  const firstError = f.errors[mask & 1 ? 0 : mask & 2 ? 1 : 2];
  const calls = Array.from({ length: 3 }, () => f.runtime.dispose());
  const results = await Promise.allSettled(calls);
  for (const result of results) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, firstError); }
  assert.deepEqual(f.order, ['shutdown', 'invalidate', 'session']);
  assert.equal(f.runtime.dispose(), calls[0]);
  await assert.rejects(f.runtime.dispose(), error => error === firstError);
});

test('shutdown callback reentrancy observes the prepublished disposal operation', async () => {
  const f = fixture();
  let reentrant: Promise<void> | undefined;
  let entered = false;
  f.reenter(() => { if (!entered) { entered = true; reentrant = f.runtime.dispose(); } });
  const operation = f.runtime.dispose();
  await operation;
  assert.equal(reentrant, operation);
  assert.deepEqual(f.order, ['shutdown', 'invalidate', 'session']);
});

test('dispose while replacement teardown is awaiting abort shares outgoing ownership', async () => {
  const f = fixture();
  let finishAbort!: () => void;
  f.session.abort = () => new Promise<void>(resolve => { finishAbort = resolve; });
  const replacement = f.runtime.newSession();
  while (!finishAbort) await Promise.resolve();
  const disposal = f.runtime.dispose();
  finishAbort();
  const result = await replacement;
  await disposal;
  assert.equal(result.cancelled, true);
  assert.deepEqual(f.order, ['shutdown', 'invalidate', 'session']);
});

for (let mask = 0; mask < 8; mask++) test(`quit abort failure still completes all mandatory owners: ${mask}`, async () => {
  const f = fixture(mask);
  const abortFailure = new Error('cooperative abort failed');
  let aborts = 0;
  f.session.abort = async () => { aborts++; throw abortFailure; };
  const operations = [f.runtime.dispose(), f.runtime.dispose(), f.runtime.dispose()];
  for (const operation of operations) assert.equal(operation, operations[0]);
  const results = await Promise.allSettled(operations);
  for (const result of results) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, abortFailure); }
  assert.equal(aborts, 1);
  assert.deepEqual(f.order, ['shutdown', 'invalidate', 'session']);
});

test('abort callback reentrancy sees the prepublished shared operation', async () => {
  const f = fixture(); let nested: Promise<void> | undefined;
  f.session.abort = async () => { nested = f.runtime.dispose(); };
  const operation = f.runtime.dispose();
  await operation;
  assert.equal(nested, operation);
  assert.deepEqual(f.order, ['shutdown', 'invalidate', 'session']);
});
