import assert from 'node:assert/strict';
import { alphaSession } from './alpha-session.ts';
import { alphaMessage } from './alpha-stream.ts';

export async function stress(mode: 'regular' | 'fullscreen', fixtureRoot?: string) {
  const f = await alphaSession({ mode, sinkDelay: 5, fixtureRoot });
  const message = alphaMessage([{ type: 'text', text: 'start ' }]);
  const text = message.content[0]; assert.ok(text?.type === 'text');
  const event = { type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x', partial: message } };
  const weak: WeakRef<object>[] = [new WeakRef(message), new WeakRef(message.content), new WeakRef(f.session),
    new WeakRef(f.runtime), new WeakRef(f.mode), new WeakRef(f.internal.renderer), new WeakRef(f.terminal)];
  let updates = 0; let updatePromises = 0;
  const handleEvent = f.internal.handleEvent.bind(f.internal);
  f.internal.handleEvent = function (event: any) {
    const result = handleEvent(event);
    if (event.type === 'message_update') { updates++; if (result?.then) updatePromises++; }
    return result;
  };
  try {
    assert.equal(await f.mode.init(), true);
    await f.internal.loadInitializationHighlightLanguages();
    (f.session as any)._emit({ type: 'message_start', message });
    f.internal.renderer.renderNow(); await f.internal.renderer.flushTerminalFrames();
    f.internal.renderInstrumentation.reset();
    for (let index = 0; index < 100000; index++) {
      text.text += 'x';
      (f.session as any)._emit(event);
      if (index % 4096 === 4095) { f.internal.renderer.renderNow(); await f.internal.renderer.flushTerminalFrames(); }
    }
    f.internal.renderer.renderNow(); await f.internal.renderer.flushTerminalFrames();
    const active = f.internal.renderInstrumentation.snapshot();
    assert.equal(updates, 100000); assert.equal(updatePromises, 0);
    assert.equal(active.completedItemRenders, 0);
    assert.equal(active.fullHistoryFallbacks, 0);
    assert.ok(active.pendingRenderRequestHighWaterMark <= 1); assert.ok(active.terminalFrameQueueHighWaterMark <= 2);
    assert.equal(active.framePromisesCreated, 0); assert.equal(active.frameAbortControllersCreated, 0);
    assert.equal(active.frameWrapperObjectsCreated, 0); assert.equal(active.fullSizeFrameCopies, 0);
    assert.equal(f.internal.streamingMessage.content[0].text, text.text);
    (f.session as any)._emit({ type: 'message_end', message });
    await f.internal.handleEvent({ type: 'agent_end', messages: [message] });
    await f.internal.renderer.flushTerminalFrames();
    assert.equal(f.internal.streamingMessage, undefined);
    const final = f.internal.renderInstrumentation.snapshot();
    assert.equal(final.fullHistoryFallbacks, 0, 'completion preserves bounded active attribution');
    return { weak, metrics: active, updates, updatePromises };
  } finally { await f.release(); }
}

