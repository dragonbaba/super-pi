import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { AssistantMessageEventStream } from '../packages/ai/src/utils/event-stream.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';
import { alphaModelRuntime, alphaSession } from './helpers/alpha-session.ts';

for (const mode of ['regular', 'fullscreen'] as const) {
  for (const ending of ['first-final', 'aborted', 'error', 'tools'] as const) {
    test(`real provider final/abort/error/tool transition ${mode}/${ending}`, async () => {
      let requests = 0; let executions = 0; let visibleFinal = false; let timer: ReturnType<typeof setImmediate> | undefined;
      const runtime = alphaModelRuntime((_model, context) => {
        requests++;
        if (ending === 'first-final' || requests === 2) {
          if (requests === 2) {
            const tools = context.messages.filter(message => message.role === 'toolResult');
            assert.equal(tools.length, 1); assert.equal(tools[0].toolCallId, 'stream-tool-1');
          }
          return finalStream(alphaMessage([{ type: 'text', text: 'x'.repeat(16384) + '\nALPHA_FINAL\n' }]));
        }
        const stream = new AssistantMessageEventStream();
        const message = alphaMessage([{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'before tool/error' }]);
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'reasoning', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 1, delta: 'before tool/error', partial: message });
        timer = setImmediate(() => {
          timer = undefined;
          if (ending === 'tools') {
            const tool = { type: 'toolCall' as const, id: 'stream-tool-1', name: 'stream_probe', arguments: { value: 1 } };
            message.content.push(tool);
            stream.push({ type: 'toolcall_start', contentIndex: 2, partial: message });
            stream.push({ type: 'toolcall_delta', contentIndex: 2, delta: '{"value":1}', partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 2, toolCall: tool, partial: message });
            message.stopReason = 'toolUse'; stream.push({ type: 'done', reason: 'toolUse', message });
          } else {
            message.stopReason = ending; message.errorMessage = 'deterministic fixture termination';
            stream.push({ type: 'error', reason: ending, error: message });
          }
        });
        return stream;
      });
      const f = await alphaSession({ mode, sinkDelay: 20, runtime, settings: { compaction: { enabled: false }, retry: { enabled: false } },
        customTools: [{ name: 'stream_probe', label: 'test only', description: 'deterministic test tool', parameters: Type.Object({ value: Type.Number() }),
          execute: async () => { executions++; return { content: [{ type: 'text', text: 'tool result' }] }; } }] });
      f.sink.physicalMarker = text => { if (text.includes('ALPHA_FINAL')) visibleFinal = true; };
      try {
        assert.equal(await f.mode.init(), true);
        await f.session.prompt('ending fixture');
        await f.internal.renderer.flushTerminalFrames();
        assert.equal(requests, ending === 'tools' ? 2 : 1);
        assert.equal(executions, ending === 'tools' ? 1 : 0);
        const final = f.session.messages.at(-1); assert.ok(final?.role === 'assistant');
        assert.equal(final.stopReason, ending === 'aborted' || ending === 'error' ? ending : 'stop');
        assert.equal(f.session.isStreaming, false);
        assert.equal(f.internal.streamingMessage, undefined);
        assert.equal(f.internal.activeStatusIndicator, undefined);
        if (ending === 'first-final' || ending === 'tools') assert.equal(visibleFinal, true);
        f.input.write('later action'); await new Promise<void>(resolve => setImmediate(resolve));
        f.internal.renderer.renderNow(); await f.internal.renderer.flushTerminalFrames();
        assert.equal(f.internal.editor.getText(), 'later action');
        const metrics = f.internal.renderInstrumentation.snapshot();
        assert.ok(metrics.terminalFrameQueueHighWaterMark <= 2);
        assert.equal(metrics.activeFrameUtf8Bytes, 0); assert.equal(metrics.pendingFrameUtf8Bytes, 0);
      } finally { if (timer) clearImmediate(timer); await f.release(); }
    });
  }
}
