import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_COMPONENT_RENDER_CACHE } from '@super-pi/tui';
import { alphaSession } from './helpers/alpha-session.ts';

for (const mode of ['regular', 'fullscreen'] as const) {
  for (const failure of ['none', 'component', 'runtime', 'both', 'disconnect'] as const) {
    test(`terminal restoration precedes held shutdown: ${mode} ${failure}`, async t => {
      let release!: () => void; let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const entry = new Promise<void>(resolve => { entered = resolve; });
      let ui: any; let emissions = 0; let pending = false;
      let terminalDisposals = 0; let sessionDisposals = 0; let runtimeCalls = 0;
      let tuiStops = 0; let tuiDisposals = 0; let controls = 0; let frames = 0; let renders = 0; let factories = 0;
      let exit: number | undefined;
      const componentError = Object.assign(new Error('component owner'), { code: 'EIO' });
      const runtimeError = Object.assign(new Error('runtime owner'), { code: 'EIO' });
      const f = await alphaSession({ mode, extensions: [(pi: any) => {
        pi.on('session_start', (_event: any, ctx: any) => { ui = ctx.ui; });
        pi.on('session_shutdown', async () => { emissions++; pending = true; entered(); await held; pending = false; });
      }] });
      t.mock.method(process, 'exit', (code: number) => { exit = code; });
      const terminalDispose = f.terminal.dispose.bind(f.terminal);
      t.mock.method(f.terminal, 'dispose', () => { terminalDispose(); terminalDisposals++; });
      const sessionDispose = f.session.dispose.bind(f.session);
      t.mock.method(f.session, 'dispose', () => { sessionDisposals++; sessionDispose(); if (failure === 'runtime' || failure === 'both') throw runtimeError; });
      const runtimeDispose = f.runtime.dispose.bind(f.runtime);
      t.mock.method(f.runtime, 'dispose', () => { runtimeCalls++; return runtimeDispose(); });
      for (const name of ['stop', 'dispose'] as const) {
        const original = f.internal.renderer[name].bind(f.internal.renderer);
        t.mock.method(f.internal.renderer, name, async (...args: any[]) => {
          try { return await original(...args); }
          finally { if (name === 'stop') tuiStops++; else tuiDisposals++; }
        });
      }
      for (const name of ['setTitle', 'setProgress', 'write', 'writeFrame'] as const) {
        const original = (f.terminal[name] as Function).bind(f.terminal);
        t.mock.method(f.terminal as any, name, (...args: any[]) => {
          if (terminalDisposals) { if (name === 'writeFrame') frames++; else controls++; }
          return original(...args);
        });
      }
      const render = f.internal.renderer.requestRender.bind(f.internal.renderer);
      t.mock.method(f.internal.renderer, 'requestRender', (...args: any[]) => { if (terminalDisposals) renders++; return render(...args); });
      let operation: Promise<void> | undefined;
      let outcome: Promise<unknown> | undefined;
      try {
        assert.equal(await f.mode.init(), true);
        if (failure === 'component' || failure === 'both') f.internal.renderer.addChild({ render: () => [], invalidate() {}, [RELEASE_COMPONENT_RENDER_CACHE]() { throw componentError; } });
        if (failure !== 'none') f.internal.terminalDisconnected = true;
        operation = f.internal.shutdown();
        outcome = operation.then(() => undefined, error => error);
        await entry;
        assert.equal(pending, true); assert.equal(sessionDisposals, 0);
        assert.equal(terminalDisposals, 1); assert.equal(f.input.isRaw, false);
        assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
        assert.equal(tuiStops, 1); assert.equal(tuiDisposals, 1);
        ui.setTitle('closed'); ui.setStatus('closed', 'closed'); ui.setWidget('closed', ['closed']);
        ui.setFooter(() => { factories++; return { render: () => [], invalidate() {} }; });
        ui.notify('closed');
        assert.deepEqual([controls, frames, renders, factories], [0, 0, 0, 0]);
        release();
        const error = await outcome;
        assert.equal(error, failure === 'component' || failure === 'both' ? componentError : failure === 'runtime' ? runtimeError : undefined);
        assert.equal(exit, failure === 'none' ? 0 : failure === 'disconnect' ? 129 : undefined);
        assert.deepEqual([emissions, sessionDisposals, runtimeCalls], [1, 1, 1]);
        assert.deepEqual([controls, frames, renders], [0, 0, 0]);
        t.diagnostic(JSON.stringify({ mode, failure, terminalDisposals, tuiStops, tuiDisposals, emissions, sessionDisposals, runtimeCalls, controls, frames, renders, raw: f.input.isRaw, exit }));
      } finally {
        release(); await outcome;
        // The shared rejected runtime operation was already observed above.
        t.mock.method(f.runtime, 'dispose', () => runtimeDispose().catch(() => {}));
        await f.release();
      }
    });
  }
}
