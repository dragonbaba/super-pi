import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';

const phases = ['ensure-tools', 'theme', 'rebind', 'history', 'provider-count', 'first-render'] as const;
function phaseTarget(f: Awaited<ReturnType<typeof alphaSession>>, phase: typeof phases[number]): [any, string] {
  if (phase === 'theme') return [f.internal.themeController, 'applyFromSettings'];
  if (phase === 'first-render') return [f.internal.renderer, 'renderNow'];
  return [f.internal, { 'ensure-tools': 'ensureInitializationTools', rebind: 'rebindCurrentSession', history: 'renderInitialMessages', 'provider-count': 'updateAvailableProviderCount' }[phase]];
}

for (const mode of ['regular', 'fullscreen'] as const) for (const phase of phases) {
  test(`real partial startup cleanup mode=${mode} phase=${phase}`, async (t) => {
    const f = await alphaSession({ mode });
    const cause = Object.assign(new Error('private fixture cause is preserved'), { code: 'EALPHA' });
    const [owner, method] = phaseTarget(f, phase);
    t.mock.method(owner, method, () => { throw cause; });
    let exit: number | undefined; let sessionDisposals = 0; let terminalDisposals = 0;
    t.mock.method(process, 'exit', (code: number) => { exit = code; });
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const disposeSession = f.session.dispose.bind(f.session);
    const disposeTerminal = f.terminal.dispose.bind(f.terminal);
    t.mock.method(f.session, 'dispose', () => { sessionDisposals++; disposeSession(); });
    t.mock.method(f.terminal, 'dispose', () => { terminalDisposals++; disposeTerminal(); });
    try {
      await assert.rejects(f.mode.init(), error => error === cause);
      await f.internal.disposeAfterUncaughtCrash(cause);
      assert.equal(exit, 1); assert.equal(sessionDisposals, 1); assert.equal(terminalDisposals, 1);
      assert.equal(f.input.isRaw, false);
      assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
      assert.ok(errors.some(args => args.includes(cause)));
      t.diagnostic(JSON.stringify({ phase, mode, exit, sessionDisposals, terminalDisposals, raw: f.input.isRaw }));
    } finally { await f.release(); }
  });
}

for (const mode of ['regular', 'fullscreen'] as const) for (const phase of ['ensure-tools', 'theme', 'rebind', 'provider-count'] as const) {
  test(`quit while startup awaits mode=${mode} phase=${phase}`, async (t) => {
    const f = await alphaSession({ mode });
    let entered!: () => void; let release!: (value?: unknown) => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const [owner, method] = phaseTarget(f, phase);
    t.mock.method(owner, method, () => { entered(); return pending; });
    let exit: number | undefined;
    t.mock.method(process, 'exit', (code: number) => { exit = code; });
    try {
      const initialization = f.mode.init();
      await entry;
      await f.internal.shutdown();
      const writes = f.sink.writes;
      release(phase === 'ensure-tools' ? [undefined, undefined] : undefined);
      assert.equal(await initialization, false);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.sink.writes, writes, 'stale startup continuation cannot write');
      assert.equal(exit, 0); assert.equal(f.input.isRaw, false);
      assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
    } finally { release(); await f.release(); }
  });
}

for (const mode of ['regular', 'fullscreen'] as const) test(`25 actual startup/quit cycles: ${mode}`, async (t) => {
  let exits = 0;
  t.mock.method(process, 'exit', (code: number) => { assert.equal(code, 0); exits++; });
  const signalBaseline = process.listenerCount('SIGTERM');
  for (let cycle = 0; cycle < 25; cycle++) {
    const f = await alphaSession({ mode });
    try {
      assert.equal(await f.mode.init(), true);
      await f.internal.shutdown();
      assert.equal(f.input.isRaw, false);
      assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
      assert.equal(process.listenerCount('SIGTERM'), signalBaseline);
    } finally { await f.release(); }
  }
  assert.equal(exits, 25);
});

for (const mode of ['regular', 'fullscreen'] as const) for (const history of [0, 5000, 50000]) for (const g2 of [false, true]) for (const extension of ['none', 'noop', 'ui']) {
  test(`startup ownership matrix mode=${mode} history=${history} G2=${g2} extension=${extension}`, async (t) => {
    const messages = Array.from({ length: history }, () => alphaMessage([{ type: 'text', text: 'completed startup fixture' }]));
    let starts = 0; let shutdowns = 0; let staleUi: any;
    const factory = (pi: any) => {
      pi.on('session_start', (_event: any, ctx: any) => {
        starts++;
        if (extension === 'ui') {
          staleUi = ctx.ui;
          ctx.ui.setTitle('startup matrix'); ctx.ui.setWidget('matrix', ['widget']); ctx.ui.setStatus('matrix', 'status');
        }
      });
      pi.on('session_shutdown', () => {
        shutdowns++;
        staleUi?.setTitle('closed owner'); staleUi?.setWidget('late', ['closed']); staleUi?.setStatus('late', 'closed');
      });
    };
    const signals = process.listenerCount('SIGTERM');
    const f = await alphaSession({ mode, messages, g2, extensions: extension === 'none' ? [] : [factory] });
    let exits = 0; let sessionDisposals = 0; let terminalDisposals = 0;
    t.mock.method(process, 'exit', (code: number) => { assert.equal(code, 0); exits++; });
    const disposeSession = f.session.dispose.bind(f.session);
    const disposeTerminal = f.terminal.dispose.bind(f.terminal);
    t.mock.method(f.session, 'dispose', () => { sessionDisposals++; disposeSession(); });
    t.mock.method(f.terminal, 'dispose', () => { terminalDisposals++; disposeTerminal(); });
    try {
      assert.equal(await f.mode.init(), true);
      assert.equal(starts, extension === 'none' ? 0 : 1);
      const quitting = f.internal.shutdown();
      assert.equal(f.internal.shutdown(), quitting);
      await quitting;
      const writes = f.sink.writes;
      staleUi?.setTitle('after terminal disposal'); staleUi?.setWidget('late', ['closed']);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.sink.writes, writes);
      assert.equal(exits, 1); assert.equal(sessionDisposals, 1); assert.equal(terminalDisposals, 1);
      assert.equal(shutdowns, extension === 'none' ? 0 : 1);
      assert.equal(f.input.isRaw, false);
      assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
      assert.equal(process.listenerCount('SIGTERM'), signals);
      t.diagnostic(JSON.stringify({ mode, history, g2, extension, starts, shutdowns, sessionDisposals, terminalDisposals, postDisposeWrites: 0, exit: 0 }));
    } finally { await f.release(); }
  });
}
