import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';

for (const mode of ['regular', 'fullscreen'] as const) for (const signal of [false, true]) {
  for (const activity of ['compaction', 'tree', 'bash'] as const) test(`quit joins real ${activity} cleanup: ${mode}, signal=${signal}`, async (t) => {
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release: (() => void) | undefined; let released = false; let completed = false;
    let shutdowns = 0; let exits = 0; let ends = 0; let lateFactories = 0;
    const f = await alphaSession({ mode, messages: Array.from({ length: 8 }, () => alphaMessage([{ type: 'text', text: 'history '.repeat(2048) }])),
      settings: { compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 } },
      extensions: [(pi: any) => {
        pi.on('session_start', (_event: any, ctx: any) => { ctx.ui.setWidget('live-auxiliary', ['live auxiliary owner']); });
        const cancel = async (event: any, ctx: any) => {
          await new Promise<void>(resolve => { release = resolve; event.signal.addEventListener('abort', () => setImmediate(resolve), { once: true }); enter(); });
          ctx.ui.setTitle('late auxiliary callback');
          ctx.ui.setWidget('late-auxiliary', () => { lateFactories++; return { render: () => ['late'], invalidate() {} }; });
          released = true; return { cancel: true };
        };
        pi.on('session_before_compact', cancel);
        pi.on('session_before_tree', cancel);
        pi.on('session_shutdown', () => { shutdowns++; });
      }] });
    t.mock.method(process, 'exit', (code: number) => { assert.equal(code, 0); exits++; });
    let task: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await f.mode.init(), true);
      f.session.subscribe(event => { if (event.type === 'compaction_end') ends++; });
      const operation = activity === 'compaction' ? f.session.compact('fixture')
        : activity === 'tree' ? f.session.navigateTree(f.sessionManager.getEntries()[0].id, { summarize: true })
        : f.session.executeBash('fixture command', undefined, { operations: { exec: async (_command, _cwd, options) => {
          await new Promise<void>(resolve => { release = resolve; options.signal!.addEventListener('abort', () => setImmediate(resolve), { once: true }); enter(); });
          released = true; return { exitCode: null };
        } } });
      task = operation.then(() => { completed = true; }, () => { completed = true; });
      await Promise.race([entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('compaction fixture did not start')), 2500); })]);
      clearTimeout(timer);
      await f.internal.shutdown({ fromSignal: signal });
      assert.equal(released, true, 'activity cleanup finishes before successful quit');
      assert.equal(completed, true, 'activity operation settles before successful quit');
      assert.equal(f.session.isCompacting, false);
      assert.equal(f.session.isBashRunning, false);
      assert.equal(lateFactories, 0, 'an aborted extension cannot acquire UI ownership during final shutdown');
      assert.equal(ends, activity === 'compaction' ? 1 : 0); assert.equal(shutdowns, 1); assert.equal(exits, 1);
      const state = f.runtime as unknown as Record<string, unknown>;
      assert.equal(state.auxiliaryShutdownTimer, undefined);
      assert.equal(state.resolveAuxiliaryShutdown, undefined);
      assert.equal(state.rejectAuxiliaryShutdown, undefined);
      assert.equal(f.input.isRaw, false);
    } finally { if (timer) clearTimeout(timer); release?.(); await task; await f.release(); }
  });
}
