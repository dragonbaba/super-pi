import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageEventStream } from '../packages/ai/src/utils/event-stream.ts';
import { alphaHeadless, alphaModelRuntime, alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';
import { createInteractiveTui } from '../packages/coding-agent/src/modes/interactive/interactive-mode.ts';
import { FakeTerminal } from './helpers/runtime-instrumentation.ts';

const corpus = {
  english: 'Plain English paragraph. ', cjk: '中文日志：处理完成。', emoji: '👩‍💻e\u0301😀',
  ansi: '\x1b[31mred\x1b[0m ', word: 'x'.repeat(128), paragraph: 'A **Markdown** paragraph.\n\n',
  heading: '# Heading\n## Subheading\n', list: '- one\n  - nested\n1. ordered\n',
  table: '| a | b |\n|---|---|\n| 1 | 2 |\n', fence: '```ts\nconst x = 1;\n```\n',
  openFence: '```ts\nconst x = 1;\n', link: '[link](https://fixture.invalid) ',
  openLink: '[unfinished link](https://fixture.invalid', latex: '$x^2$\n$$a+b$$\n',
  html: '<div>fixture</div>\n', crlf: 'first\r\nsecond\r\n', thinking: 'Reasoning then answer. ',
};

function streamFixture(source: string, deltaSize: number, thinking: boolean) {
  const message = alphaMessage(thinking ? [{ type: 'thinking', thinking: 'fixture reasoning' }, { type: 'text', text: '' }] : [{ type: 'text', text: '' }]);
  const textIndex = thinking ? 1 : 0;
  const block = message.content[textIndex]; assert.ok(block.type === 'text');
  const text: { text: string } = block;
  const stream = new AssistantMessageEventStream();
  let offset = 0; let generated = 0; let pending: ReturnType<typeof setImmediate> | undefined;
  function deliver() {
    pending = undefined;
    for (let batch = 0; batch < 32 && offset < source.length; batch++) {
      const delta = source.slice(offset, offset + deltaSize);
      assert.ok(delta.length <= deltaSize);
      text.text += delta; offset += delta.length; generated++;
      stream.push({ type: 'text_delta', contentIndex: textIndex, delta, partial: message });
    }
    if (offset < source.length) pending = setImmediate(deliver);
    else stream.push({ type: 'done', reason: 'stop', message }); // No artificial final-frame delay.
  }
  return { message, get generated() { return generated; },
    start() {
      stream.push({ type: 'start', partial: message });
      if (thinking) {
        stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
        stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'fixture reasoning', partial: message });
        stream.push({ type: 'thinking_end', contentIndex: 0, content: 'fixture reasoning', partial: message });
      }
      stream.push({ type: 'text_start', contentIndex: textIndex, partial: message });
      pending = setImmediate(deliver); return stream;
    },
    cancel() { if (pending) clearImmediate(pending); pending = undefined; },
  };
}

for (const layer of [0, 1, 2, 3]) for (const deltaSize of [1, 4, 16, 64]) {
  for (const mode of (layer < 2 ? ['regular'] : ['regular', 'fullscreen']) as ('regular' | 'fullscreen')[]) {
    test(`stream corpus L${layer}, ${deltaSize} code-unit deltas, ${mode}`, async (t) => {
      let active: ReturnType<typeof streamFixture>;
      let providerCalls = 0; let physicalWrites = 0;
      const runtime = alphaModelRuntime(() => { providerCalls++; return active.start(); });
      const headless = layer === 1 ? await alphaHeadless(runtime) : undefined;
      const f = layer >= 2 ? await alphaSession({ mode, runtime, sinkDelay: layer === 3 ? 5 : 0, settings: { compaction: { enabled: false } } }) : undefined;
      const session = headless?.session ?? f?.session;
      try {
        if (f) {
          if (layer === 2) {
            await f.internal.renderer.dispose({ preserveScreen: true });
            const memory = new FakeTerminal(120, 40); memory.write = () => { physicalWrites++; };
            f.internal.renderer = createInteractiveTui({ tuiMode: mode, terminal: memory, showHardwareCursor: false, logDirectory: f.root });
            f.internal.renderer.setRenderInstrumentation(f.internal.renderInstrumentation);
          } else f.sink.physicalMarker = () => { physicalWrites++; };
          assert.equal(await f.mode.init(), true);
          await f.internal.loadInitializationHighlightLanguages();
          await f.internal.renderer.flushTerminalFrames();
        }
        let chunks = 0; let cases = 0;
        for (const [name, body] of Object.entries(corpus)) {
          // Exactly 1 Ki code units. The fixture intentionally permits a provider
          // delta to end inside Unicode/ANSI syntax; final canonical bytes must survive.
          const source = body.repeat(Math.ceil(1024 / body.length)).slice(0, 1024);
          active = streamFixture(source, deltaSize, name === 'thinking');
          try {
            if (layer === 0) { for await (const event of active.start()) if (event.type === 'done') assert.equal(event.message, active.message); }
            else {
              await session!.prompt('corpus fixture');
              const final = session!.messages.at(-1);
              assert.ok(final?.role === 'assistant');
              assert.equal(final.stopReason, 'stop');
              assert.deepEqual(final.content, active.message.content);
              assert.equal(session!.isStreaming, false);
              if (f) {
                await f.internal.renderer.flushTerminalFrames();
                assert.equal(f.internal.streamingMessage, undefined);
                const metrics = f.internal.renderInstrumentation.snapshot();
                assert.ok(metrics.terminalFrameQueueHighWaterMark <= 2);
                assert.ok(metrics.pendingRenderRequestHighWaterMark <= 1);
                assert.equal(metrics.activeFrameUtf8Bytes, 0); assert.equal(metrics.pendingFrameUtf8Bytes, 0);
              }
            }
            assert.equal(active.generated, 1024 / deltaSize); chunks += active.generated; cases++;
          } finally { active.cancel(); }
        }
        assert.equal(providerCalls, layer === 0 ? 0 : cases);
        if (f) assert.ok(physicalWrites > 0);
        t.diagnostic(JSON.stringify({ layer, mode, deltaSize, cases, chunks, providerCalls, physicalWrites,
          coverage: 'canonical delivery and terminal queue completion, not a latency/visible-marker measurement' }));
      } finally { if (f) await f.release(); if (headless) await headless.release(); }
    });
  }
}
