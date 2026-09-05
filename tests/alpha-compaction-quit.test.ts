import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';

for (const mode of ['regular', 'fullscreen'] as const) for (const signal of [false, true]) {
  test(`quit joins real manual compaction cleanup: ${mode}, signal=${signal}`, async (t) => {
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release: (() => void) | undefined; let released = false; let completed = false;
    let shutdowns = 0; let exits = 0; let ends = 0;
    const f = await alphaSession({ mode, messages: Array.from({ length: 8 }, () => alphaMessage([{ type: 'text', text: 'history '.repeat(2048) }])),
      settings: { compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 } },
      extensions: [(pi: any) => {
        pi.on('session_before_compact', async (event: any) => {
          await new Promise<void>(resolve => { release = resolve; event.signal.addEventListener('abort', () => setImmediate(resolve), { once: true }); enter(); });
          released = true; return { cancel: true };
        });
        pi.on('session_shutdown', () => { shutdowns++; });
      }] });
    t.mock.method(process, 'exit', (code: number) => { assert.equal(code, 0); exits++; });
    let task: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await f.mode.init(), true);
      f.session.subscribe(event => { if (event.type === 'compaction_end') ends++; });
      task = f.session.compact('fixture').then(() => { completed = true; }, () => { completed = true; });
      await Promise.race([entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('compaction fixture did not start')), 2500); })]);
      clearTimeout(timer);
      await f.internal.shutdown({ fromSignal: signal });
      assert.equal(released, true, 'compaction extension finishes before successful quit');
      assert.equal(completed, true, 'compaction operation settles before successful quit');
      assert.equal(f.session.isCompacting, false);
      assert.equal(ends, 1); assert.equal(shutdowns, 1); assert.equal(exits, 1);
      assert.equal(f.input.isRaw, false);
    } finally { if (timer) clearTimeout(timer); release?.(); await task; await f.release(); }
  });
}
