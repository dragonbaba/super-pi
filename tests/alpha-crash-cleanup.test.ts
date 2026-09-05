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
