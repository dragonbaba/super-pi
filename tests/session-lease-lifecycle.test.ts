import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession } from '../packages/coding-agent/src/core/sdk.ts';
import { AgentSessionRuntime } from '../packages/coding-agent/src/core/agent-session-runtime.ts';
import { SessionManager } from '../packages/coding-agent/src/core/session-manager.ts';
import { SettingsManager } from '../packages/coding-agent/src/core/settings-manager.ts';
import { DefaultResourceLoader } from '../packages/coding-agent/src/core/resource-loader.ts';
import { assertSessionNotLeased, getSessionLeaseDir, sessionIdIsLeased } from '../packages/coding-agent/src/core/session-lease.ts';
import { ALPHA_MODEL, alphaModelRuntime } from './helpers/alpha-session.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-native-lease-'));
  const sessions: Awaited<ReturnType<typeof createAgentSession>>['session'][] = [];
  const leaseDir = getSessionLeaseDir(root);
  function history() {
    const manager = SessionManager.create(root, join(root, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'synthetic lease fixture', timestamp: 1 });
    return manager;
  }
  async function create(manager = history(), extensions: any[] = []) {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: !extensions.length, extensionFactories: extensions,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const result = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, resourceLoader: loader,
      settingsManager: settings, model: ALPHA_MODEL, noTools: 'all',
      modelRuntime: alphaModelRuntime(() => finalStream(alphaMessage([{ type: 'text', text: 'offline' }]))) });
    sessions.push(result.session);
    return { ...result, loader, services: { cwd: root, agentDir: root } as never, diagnostics: [] };
  }
  return { root, leaseDir, history, create,
    records: () => existsSync(leaseDir) ? readdirSync(leaseDir).filter(name => name.endsWith('.json')) : [],
    protected: (manager: SessionManager) => {
      assert.throws(() => assertSessionNotLeased(leaseDir, manager.getSessionFile()!), /占用/);
      assert.equal(sessionIdIsLeased(leaseDir, manager.getSessionId()), true);
    },
    async release() {
      for (const session of sessions) {
        session.dispose();
        try { await session.waitForSessionLeaseRelease(); } catch { /* explicitly tested retained synthetic record */ }
      }
      // Only this mkdtemp identity; never discover or remove real user sessions.
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    },
  };
}

test('native lease: independent zero-extension SDK owners and actual raw disposal', { timeout: 5000 }, async () => {
  const f = fixture(), entered = gate(), finish = gate();
  let prompt: Promise<void> | undefined;
  try {
    const a = await f.create(), b = await f.create();
    assert.equal(a.extensionsResult.extensions.length, 0);
    assert.equal(f.records().length, 2);
    f.protected(a.session.sessionManager); f.protected(b.session.sessionManager);
    SessionManager.open(f.history().getSessionFile()!);
    assert.equal(f.records().length, 2, 'reading history is not activation');
    const owner = (a.session as any)._sessionLease;
    assert.ok(owner.timer); assert.equal(owner.reservationTimer, undefined);
    a.session.subscribe(async event => {
      if (event.type === 'agent_end') { entered.resolve(); await finish.promise; }
    }, { criticalAgentEnd: true });
    prompt = a.session.prompt('exercise real settlement');
    await entered.promise;
    a.session.dispose();
    const release = a.session.waitForSessionLeaseRelease();
    assert.equal(release, a.session.waitForSessionLeaseRelease());
    f.protected(a.session.sessionManager);
    assert.equal(f.records().length, 2, 'synchronous dispose is not completed cleanup');
    finish.resolve(); await prompt; await release;
    assert.equal(f.records().length, 1); f.protected(b.session.sessionManager);
    assert.equal(owner.timer, undefined); assert.equal(owner.reservationTimer, undefined);
    assert.equal(owner.getSessionPath(), undefined); assert.equal(owner.getSessionId(), undefined);
    assert.equal((a.session as any)._sessionLease, undefined);
    b.session.dispose(); await b.session.waitForSessionLeaseRelease();
    assert.equal(f.records().length, 0);
  } finally { finish.resolve(); await prompt?.catch(() => {}); await f.release(); }
});

test('native lease: reload, gated replacement, cancellation/failure and conservative cleanup', { timeout: 5000 }, async t => {
  const f = fixture(), drainEntered = gate(), drainFinish = gate(), factoryEntered = gate(), factoryFinish = gate();
  const lateEntered = gate(), lateFinish = gate();
  const stopEntered = gate(), stopFinish = gate();
  let runtime: AgentSessionRuntime | undefined, replacement: Promise<unknown> | undefined;
  let lateRuntime: AgentSessionRuntime | undefined, lateReplacement: Promise<unknown> | undefined;
  let stopRuntime: AgentSessionRuntime | undefined, stopReplacement: Promise<unknown> | undefined;
  let cancel = true, failFactory = false, factoryCalls = 0;
  try {
    const first = await f.create(undefined, [(pi: any) => {
      pi.on('session_before_switch', () => cancel ? { cancel: true } : undefined);
    }]);
    const owner = (first.session as any)._sessionLease;
    const reload = first.loader.reload.bind(first.loader);
    t.mock.method(first.loader, 'reload', async () => {
      f.protected(first.session.sessionManager); assert.equal(f.records().length, 1);
      await reload(); f.protected(first.session.sessionManager);
    });
    await first.session.reload();
    assert.equal((first.session as any)._sessionLease, owner, 'reload retains the same owner');
    runtime = new AgentSessionRuntime(first.session, first.services, async target => {
      factoryCalls++;
      f.protected(target.sessionManager); assert.equal(f.records().length, 1);
      if (failFactory) throw new Error('controlled factory failure before activation');
      factoryEntered.resolve(); await factoryFinish.promise;
      return f.create(target.sessionManager);
    });
    const target = f.history();
    assert.equal((await runtime.switchSession(target.getSessionFile()!)).cancelled, true);
    assert.equal(f.records().length, 1); assert.equal(factoryCalls, 0);
    cancel = false;
    first.loader.getExtensions().runtime.executionBoundary.register('lease-fixture', {
      revoke() {}, async drain() { drainEntered.resolve(); await drainFinish.promise; },
    });
    replacement = runtime.switchSession(target.getSessionFile()!);
    await drainEntered.promise;
    f.protected(first.session.sessionManager); f.protected(target); assert.equal(f.records().length, 2);
    drainFinish.resolve(); await factoryEntered.promise;
    f.protected(target); assert.equal(f.records().length, 1, 'reservation bridges old drain and new activation');
    factoryFinish.resolve(); await replacement;
    assert.equal(f.records().length, 1); f.protected(runtime.session.sessionManager);
    assert.equal((runtime as any).replacementLease, undefined); assert.equal(owner.timer, undefined);
    failFactory = true;
    await assert.rejects(runtime.newSession(), /controlled factory failure/);
    assert.equal(f.records().length, 0); assert.equal((runtime as any).replacementLease, undefined);
    await runtime.dispose();

    const late = await f.create(), lateTarget = f.history();
    lateRuntime = new AgentSessionRuntime(late.session, late.services, async target => {
      lateEntered.resolve(); await lateFinish.promise; return f.create(target.sessionManager);
    });
    lateReplacement = lateRuntime.switchSession(lateTarget.getSessionFile()!);
    await lateEntered.promise;
    let ended = false;
    const ending = lateRuntime.dispose(); void ending.then(() => { ended = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ended, false); f.protected(lateTarget);
    lateFinish.resolve();
    assert.deepEqual(await lateReplacement, { cancelled: true }); await ending;
    assert.equal(f.records().length, 0);
    assert.equal((lateRuntime as any).replacementOperation, undefined);
    assert.equal((lateRuntime as any).replacementLease, undefined);

    const stopping = await f.create();
    stopping.loader.getExtensions().runtime.executionBoundary.register('gated-stop', {
      revoke() {}, async drain() { stopEntered.resolve(); await stopFinish.promise; },
    });
    stopRuntime = new AgentSessionRuntime(stopping.session, stopping.services, async () => { throw new Error('cancelled factory must not run'); });
    stopReplacement = stopRuntime.newSession();
    await stopEntered.promise;
    const reservation = (stopRuntime as any).replacementLease;
    t.mock.method(reservation, 'stop', () => { reservation.retainProtection(); throw new Error('reservation unlink rejected'); });
    const both = Promise.allSettled([stopReplacement, stopRuntime.dispose()]);
    stopFinish.resolve();
    for (const result of await both) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(result.reason.message, /reservation unlink rejected/);
    }
    assert.equal(reservation.timer, undefined);

    const failed = await f.create(), held = (failed.session as any)._sessionLease;
    let drains = 0;
    failed.loader.getExtensions().runtime.executionBoundary.register('refuse-release', {
      revoke() {}, async drain() { drains++; throw new Error('controlled drain rejection'); },
    });
    const failedRuntime = new AgentSessionRuntime(failed.session, failed.services, async () => { throw new Error('unexpected'); });
    await assert.rejects(failedRuntime.dispose(), /controlled drain rejection/);
    await assert.rejects(failed.session.waitForSessionLeaseRelease(), /controlled drain rejection/);
    assert.equal(drains, 1, 'lease release must not implicitly retry the failed boundary');
    f.protected(failed.session.sessionManager); assert.equal(f.records().length, 2, 'both failed releases retain protection');
    assert.equal(held.timer, undefined); assert.equal(held.reservationTimer, undefined);
    assert.equal(held.getSessionPath(), undefined); assert.equal(held.getSessionId(), undefined);
    assert.equal((failed.session as any)._sessionLease, undefined);

    const unlinkFailed = await f.create(), unlinkOwner = (unlinkFailed.session as any)._sessionLease;
    t.mock.method(unlinkOwner, 'stop', () => { throw new Error('controlled unlink rejection'); });
    unlinkFailed.session.dispose();
    await assert.rejects(unlinkFailed.session.waitForSessionLeaseRelease(), /controlled unlink rejection/);
    f.protected(unlinkFailed.session.sessionManager);
    assert.equal(unlinkOwner.timer, undefined); assert.equal(unlinkOwner.getSessionPath(), undefined);
  } finally {
    drainFinish.resolve(); factoryFinish.resolve(); lateFinish.resolve(); stopFinish.resolve();
    await replacement?.catch(() => {}); await lateReplacement?.catch(() => {});
    await lateRuntime?.dispose().catch(() => {});
    await stopReplacement?.catch(() => {}); await stopRuntime?.dispose().catch(() => {});
    await runtime?.dispose().catch(() => {}); await f.release();
  }
});
