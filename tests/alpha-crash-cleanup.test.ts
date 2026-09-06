import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';

for (const mode of ['regular', 'fullscreen'] as const) for (const phase of ['progress', 'drain'] as const) test(`dead ${phase} does not hide non-output cleanup failure: ${mode}`, async (t) => {
  const f = await alphaSession({ mode, settings: { terminal: { showTerminalProgress: true } } });
  const dead = Object.assign(new Error('disconnected output'), { code: 'EIO' });
  const cleanup = new Error('footer cleanup failed');
  let exit: number | undefined;
  t.mock.method(process, 'exit', (code: number) => { exit = code; });
  try {
    await f.mode.init();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (phase === 'progress') {
      const write = f.sink.write.bind(f.sink);
      t.mock.method(f.sink, 'write', (...args: any[]) => {
        if (String(args[0]).includes('\x1b]9;4;0\x07')) throw dead;
        return (write as any)(...args);
      });
    } else t.mock.method(f.terminal, 'drainInput', async () => { throw dead; });
    const dispose = f.internal.footer.dispose.bind(f.internal.footer);
    t.mock.method(f.internal.footer, 'dispose', () => { dispose(); throw cleanup; });
    // The earlier test enters the installed output handler. Here isolate the
    // joined operation so its expected rejection cannot reach the test worker UI.
    f.internal.terminalDisconnected = true;
    await assert.rejects(f.internal.shutdown(), error => error === cleanup);
    assert.equal(exit, undefined, 'a non-output cleanup failure is not a successful disconnect exit');
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
  } finally { await f.release(); }
});

for (const mode of ['regular', 'fullscreen'] as const) for (const action of ['stop', 'shutdown'] as const) test(`late rejection cannot reacquire UI after ${action}: ${mode}`, async (t) => {
  const f = await alphaSession({ mode });
  const previousExitCode = process.exitCode;
  t.mock.method(process, 'exit', () => {});
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (error: unknown) => { errors.push(error); });
  let renders = 0;
  const cause = new Error('cleanup rejected');
  try {
    await f.mode.init();
    if (action === 'shutdown') await f.internal.shutdown(); else await f.mode.stop();
    const render = f.internal.renderer.requestRender.bind(f.internal.renderer);
    t.mock.method(f.internal.renderer, 'requestRender', (...args: any[]) => { renders++; return render(...args); });
    f.internal.handleLifecyclePromiseRejection(cause);
    assert.equal(renders, 0);
    assert.deepEqual(errors, [cause]);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previousExitCode; await f.release(); }
});

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

for (const mode of ['regular', 'fullscreen'] as const) test(`dead-output shutdown clears enabled progress and releases all owners: ${mode}`, async (t) => {
  let shutdowns = 0;
  const f = await alphaSession({ mode, settings: { terminal: { showTerminalProgress: true } }, extensions: [(pi: any) => pi.on('session_shutdown', () => { shutdowns++; })] });
  let exit: number | undefined; let disposals = 0;
  t.mock.method(process, 'exit', (code: number) => { exit = code; });
  const dispose = f.terminal.dispose.bind(f.terminal);
  t.mock.method(f.terminal, 'dispose', () => { disposals++; return dispose(); });
  const priorOutputHandlers = new Set(process.stdout.listeners('error'));
  try {
    assert.equal(await f.mode.init(), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    const write = f.sink.write.bind(f.sink);
    const cause = Object.assign(new Error('synchronous disconnected progress output'), { code: 'EIO' });
    t.mock.method(f.sink, 'write', (...args: any[]) => {
      if (String(args[0]).includes('\x1b]9;4;0\x07')) throw cause;
      return (write as any)(...args);
    });
    // Enter the installed production error handler, then join its shared operation.
    const handler = process.stdout.listeners('error').find(listener => !priorOutputHandlers.has(listener));
    assert.ok(handler);
    handler.call(process.stdout, cause);
    await f.internal.shutdown();
    assert.equal(exit, 129); assert.equal(shutdowns, 1); assert.equal(disposals, 1);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
  } finally {
    if (!disposals) await f.internal.renderer.dispose({ preserveScreen: true }).catch(() => {});
    await f.release();
  }
});

test('fullscreen transcript-transfer failure still disposes the real terminal', async (t) => {
  const f = await alphaSession({ mode: 'fullscreen' });
  const cause = new Error('transcript overlay release failure');
  let disposals = 0;
  const dispose = f.terminal.dispose.bind(f.terminal);
  t.mock.method(f.terminal, 'dispose', () => { disposals++; return dispose(); });
  try {
    assert.equal(await f.mode.init(), true);
    f.internal.renderer.showOverlay({ render: () => ['overlay'], invalidate() {} });
    const hide = f.internal.renderer.hideOverlay.bind(f.internal.renderer);
    t.mock.method(f.internal.renderer, 'hideOverlay', (...args: any[]) => { hide(...args); throw cause; });
    await assert.rejects(f.mode.stop('transcript'), error => error === cause);
    assert.equal(disposals, 1);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
  } finally {
    if (!disposals) await f.internal.renderer.dispose({ preserveScreen: true }).catch(() => {});
    await f.release();
  }
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
