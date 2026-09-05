import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { SessionManager } from '../packages/coding-agent/src/core/session-manager.ts';
import { alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';
import { g2_raw_result_probe } from './fixtures/g2-raw-result-probe.ts';

for (const mode of ['regular', 'fullscreen'] as const) test(`real new/fork/resume preserves UI reset and source boundaries: ${mode}`, async (t) => {
  let starts = 0; let shutdowns = 0; let resets = 0;
  const contexts: any[] = [];
  const raw = g2_raw_result_probe('medium');
  const message = { role: 'toolResult' as const, toolCallId: raw.details.toolCallId, toolName: 'g2_raw_result_probe', content: raw.content, isError: false, timestamp: 1 };
  const f = await alphaSession({ mode, allowReplacements: true, messages: [message], extensions: [(pi: any) => {
    pi.on('session_start', (_event: any, ctx: any) => { starts++; contexts.push({ ctx, ui: ctx.ui }); ctx.ui.setTitle(`live-${starts}`); ctx.ui.setWidget('live', [`session ${starts}`]); });
    pi.on('session_shutdown', () => { shutdowns++; });
  }] });
  const reset = f.internal.resetExtensionUI.bind(f.internal);
  t.mock.method(f.internal, 'resetExtensionUI', () => { resets++; return reset(); });
  let exit: number | undefined; t.mock.method(process, 'exit', (code: number) => { exit = code; });
  try {
    assert.equal(await f.mode.init(), true);
    const before = f.session.getToolResultPresentationForUi(f.session.messages[0] as any);
    assert.ok(before?.version === 2);
    assert.ok(before.artifact);
    const cursor = before.continuation.cursor; const artifact = before.artifact.id;
    const resetBaseline = resets;
    const result = await f.runtime.newSession({ setup: async manager => {
      manager.appendMessage({ role: 'user', content: 'fork target', timestamp: 2 });
      manager.appendMessage(alphaMessage([{ type: 'text', text: 'new session' }]));
    } });
    assert.equal(result.cancelled, false);
    assert.equal(resets, resetBaseline + 1);
    assert.throws(() => f.runtime.session.readToolResultContinuation(cursor, 1024));
    assert.throws(() => f.runtime.session.readToolResultArtifact(artifact));
    const entry = f.runtime.session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user');
    assert.ok(entry);
    assert.equal((await f.runtime.fork(entry.id)).cancelled, false);
    assert.equal(resets, resetBaseline + 2);
    const resumed = SessionManager.create(f.root, join(f.root, 'resume-fixture'));
    resumed.appendMessage(alphaMessage([{ type: 'text', text: 'resume fixture' }]));
    const file = resumed.getSessionFile(); assert.ok(file);
    assert.equal((await f.runtime.switchSession(file)).cancelled, false);
    assert.equal(resets, resetBaseline + 3);
    assert.equal(starts, 4); assert.equal(shutdowns, 3);
    const beforeLate = f.sink.writes;
    assert.throws(() => contexts[0].ctx.ui, /stale/);
    contexts[0].ui.setTitle('stale replacement context');
    assert.equal(f.sink.writes, beforeLate);
    await f.internal.shutdown();
    assert.equal(exit, 0); assert.equal(shutdowns, 4);
    assert.equal(resets, resetBaseline + 3, 'final disposal does not repeat the replacement UI reset');
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
  } finally { await f.release(); }
});
