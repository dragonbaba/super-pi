import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';

for (const mode of ['regular', 'fullscreen'] as const) test(`fatal recovery releases runtime as well as terminal: ${mode}`, async (t) => {
  let shutdowns = 0;
  const f = await alphaSession({ mode, extensions: [(pi: any) => { pi.on('session_shutdown', () => { shutdowns++; }); }] });
  let sessionDisposals = 0; let terminalDisposals = 0; let exit: number | undefined;
  const sessionDispose = f.session.dispose.bind(f.session);
  const terminalDispose = f.terminal.dispose.bind(f.terminal);
  t.mock.method(f.session, 'dispose', () => { sessionDisposals++; sessionDispose(); });
  t.mock.method(f.terminal, 'dispose', () => { terminalDisposals++; terminalDispose(); });
  t.mock.method(process, 'exit', (code: number) => { exit = code; });
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const cause = new Error('deterministic fatal fixture');
  try {
    assert.equal(await f.mode.init(), true);
    // The real fatal recovery path, not a stubbed runtime or terminal.
    await f.internal.disposeAfterUncaughtCrash(cause);
    assert.equal(exit, 1); assert.equal(f.input.isRaw, false);
    assert.equal(terminalDisposals, 1);
    assert.equal(shutdowns, 1); assert.equal(sessionDisposals, 1);
    assert.ok(errors.some(args => args.includes(cause)));
    assert.equal(f.input.listenerCount('data'), 0);
    assert.equal(f.resizeSource.listenerCount('resize'), 0);
  } finally { await f.release(); }
});

for (const mode of ['regular', 'fullscreen'] as const) for (const fault of ['progress', 'selector', 'status', 'footer', 'subscription'] as const) test(`stop releases real terminal after ${fault} failure: ${mode}`, async (t) => {
  const f = await alphaSession({ mode, settings: { terminal: { showTerminalProgress: true } } });
  const cause = Object.assign(new Error(`injected ${fault} cleanup failure`), { code: fault === 'progress' ? 'EIO' : 'ALPHA_CLEANUP' });
  let terminalDisposals = 0;
  const dispose = f.terminal.dispose.bind(f.terminal);
  t.mock.method(f.terminal, 'dispose', () => { terminalDisposals++; return dispose(); });
  try {
    assert.equal(await f.mode.init(), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (fault === 'progress') {
      const write = f.sink.write.bind(f.sink);
      t.mock.method(f.sink, 'write', (...args: any[]) => {
        if (String(args[0]).includes('\x1b]9;4;0\x07')) throw cause;
        return (write as any)(...args);
      });
    } else if (fault === 'selector') f.internal.activeSelectorDispose = () => { throw cause; };
    else if (fault === 'status') f.internal.activeStatusIndicator = { dispose() { throw cause; } };
    else if (fault === 'footer') {
      const release = f.internal.footer.dispose.bind(f.internal.footer);
      t.mock.method(f.internal.footer, 'dispose', () => { release(); throw cause; });
    } else {
      const release = f.internal.unsubscribe;
      f.internal.unsubscribe = () => { release?.(); throw cause; };
    }
    await assert.rejects(f.mode.stop(), error => error === cause);
    assert.equal(terminalDisposals, 1, 'mandatory terminal disposal cannot be skipped by earlier cleanup failure');
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0);
    assert.equal(f.resizeSource.listenerCount('resize'), 0);
    await f.mode.stop();
    assert.equal(terminalDisposals, 1);
  } finally {
    // A red stop has already claimed its operation; release the real terminal explicitly
    // so the failing regression does not leave the test worker in raw mode.
    if (!terminalDisposals) await f.internal.renderer.dispose({ preserveScreen: true }).catch(() => {});
    await f.release();
  }
});
