import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { AssistantMessageEventStream } from '../packages/ai/src/utils/event-stream.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';
import { alphaModelRuntime, alphaSession } from './helpers/alpha-session.ts';

for (const mode of ['regular', 'fullscreen'] as const) for (const signal of [false, true]) for (const active of ['stream', 'tool'] as const) {
  test(`quit drains cooperative active ${active}: ${mode}, signal=${signal}`, async (t) => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let released = false; let settled = false; let exits = 0; let shutdowns = 0; let requests = 0;
    let releaseFixture: (() => void) | undefined;
    const runtime = alphaModelRuntime((_model, _context, options) => {
      // The loop may invoke a stream factory with an already-aborted signal.
      // A cooperative fixture must terminate it without starting provider work.
      if (options?.signal?.aborted) {
        const stream = new AssistantMessageEventStream(); const message = alphaMessage();
        message.stopReason = 'aborted'; message.errorMessage = 'pre-aborted fixture';
        stream.push({ type: 'error', reason: 'aborted', error: message }); return stream;
      }
      requests++;
      if (requests > 1) return finalStream(alphaMessage([{ type: 'text', text: 'unexpected continuation' }]));
      if (active === 'tool') {
        const message = alphaMessage([{ type: 'toolCall', id: 'active-tool', name: 'active_probe', arguments: {} }]);
        message.stopReason = 'toolUse'; return finalStream(message);
      }
      const stream = new AssistantMessageEventStream();
      const message = alphaMessage([{ type: 'text', text: 'active stream' }]);
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'active stream', partial: message });
      releaseFixture = () => {
        if (released) return;
        released = true; message.stopReason = 'aborted'; message.errorMessage = 'fixture abort';
        stream.push({ type: 'error', reason: 'aborted', error: message });
      };
      options?.signal?.addEventListener('abort', () => setImmediate(releaseFixture!), { once: true });
      started(); return stream;
    });
    const f = await alphaSession({ mode, runtime, settings: { compaction: { enabled: false }, retry: { enabled: false } },
      extensions: [(pi: any) => { pi.on('session_shutdown', () => { shutdowns++; }); }],
      customTools: [{ name: 'active_probe', label: 'test only', description: 'cooperative delayed cleanup', parameters: Type.Object({}),
        execute: async (_id: string, _args: unknown, abortSignal: AbortSignal) => {
          started();
          assert.ok(abortSignal, 'real tool receives a cooperative abort signal');
          await new Promise<void>(resolve => { releaseFixture = resolve; abortSignal.addEventListener('abort', () => setImmediate(resolve), { once: true }); });
          released = true; return { content: [{ type: 'text', text: 'aborted tool cleanup complete' }] };
        } }] });
    t.mock.method(process, 'exit', (code: number) => { assert.equal(code, 0); exits++; });
    let terminalDisposed = false; let terminalDisposals = 0; let sessionDisposals = 0; let postDisposeWrites = 0; let postDisposeRenders = 0;
    const disposeTerminal = f.terminal.dispose.bind(f.terminal);
    t.mock.method(f.terminal, 'dispose', () => { terminalDisposals++; disposeTerminal(); terminalDisposed = true; });
    const disposeSession = f.session.dispose.bind(f.session);
    t.mock.method(f.session, 'dispose', () => { sessionDisposals++; disposeSession(); });
    for (const method of ['setTitle', 'setProgress', 'write', 'writeFrame'] as const) {
      const original = (f.terminal[method] as Function).bind(f.terminal);
      t.mock.method(f.terminal as any, method, (...args: any[]) => { if (terminalDisposed) postDisposeWrites++; return original(...args); });
    }
    const requestRender = f.internal.renderer.requestRender.bind(f.internal.renderer);
    t.mock.method(f.internal.renderer, 'requestRender', (...args: any[]) => { if (terminalDisposed) postDisposeRenders++; return requestRender(...args); });
    let prompt: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await f.mode.init(), true);
      prompt = f.session.prompt('active quit fixture').then(() => { settled = true; }, error => { settled = true; throw error; });
      await Promise.race([ready, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('fixture did not enter active work')), 2500); })]);
      clearTimeout(timeout);
      const operation = f.internal.shutdown({ fromSignal: signal });
      assert.equal(f.internal.shutdown(), operation);
      await operation;
      assert.equal(released, true, 'cooperative provider/tool cleanup completes before successful quit');
      assert.equal(settled, true, 'active prompt reaches its terminal state before successful quit');
      assert.equal(exits, 1); assert.equal(shutdowns, 1);
      assert.equal(requests, 1, 'abort does not restart the provider');
      assert.equal(sessionDisposals, 1); assert.equal(terminalDisposals, 1);
      assert.equal(postDisposeWrites, 0); assert.equal(postDisposeRenders, 0);
      assert.equal(f.input.isRaw, false);
      assert.equal(f.input.listenerCount('data'), 0);
      assert.equal(f.resizeSource.listenerCount('resize'), 0);
    } finally { if (timeout) clearTimeout(timeout); releaseFixture?.(); await prompt; await f.release(); }
  });
}
