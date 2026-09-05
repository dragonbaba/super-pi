import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';

for (const mode of ['regular', 'fullscreen'] as const) for (const signal of [false, true]) test(`real init/quit mode=${mode} signal=${signal}`, async (t) => {
  let shutdowns = 0;
  let staleUI: any;
  const f = await alphaSession({ mode, extensions: [(pi: any) => {
    pi.on('session_start', (_event: any, ctx: any) => {
      staleUI = ctx.ui;
      ctx.ui.setTitle('alpha live'); ctx.ui.setWidget('alpha', ['alpha widget']); ctx.ui.setStatus('alpha', 'live');
    });
    pi.on('session_shutdown', () => {
      shutdowns++; staleUI?.setTitle('must be inert'); staleUI?.setWidget('late', ['must be inert']);
    });
  }] });
  let exited: number | undefined;
  t.mock.method(process, 'exit', (code: number) => { exited = code; });
  let disposed = false;
  let writesAfter = 0;
  let rendersAfter = 0;
  let disposeCalls = 0;
  const dispose = f.terminal.dispose.bind(f.terminal);
  t.mock.method(f.terminal, 'dispose', () => { disposeCalls++; dispose(); disposed = true; });
  const title = f.terminal.setTitle.bind(f.terminal);
  t.mock.method(f.terminal, 'setTitle', (value: string) => { if (disposed) writesAfter++; title(value); });
  const render = f.internal.renderer.requestRender.bind(f.internal.renderer);
  t.mock.method(f.internal.renderer, 'requestRender', (...args: any[]) => { if (disposed) rendersAfter++; return render(...args); });
  try {
    assert.equal(await f.mode.init(), true);
    assert.equal(f.input.isRaw, true);
    const first = f.internal.shutdown({ fromSignal: signal });
    assert.equal(f.internal.shutdown(), first);
    await first;
    assert.equal(exited, 0); assert.equal(shutdowns, 1); assert.equal(disposeCalls, 1);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
    assert.equal(writesAfter, 0); assert.equal(rendersAfter, 0);
    assert.ok(f.sink.controls.join('').includes('\x1b[?2004l'));
    t.diagnostic(JSON.stringify({ mode, signal, shutdowns, disposeCalls, writesAfter, rendersAfter, raw: f.input.isRaw, exit: exited }));
  } finally { await f.release(); }
});
