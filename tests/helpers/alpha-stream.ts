import type { AssistantMessage } from '../../packages/ai/src/types.ts';
import { AssistantMessageEventStream } from '../../packages/ai/src/utils/event-stream.ts';
import { ALPHA_MODEL } from './alpha-session.ts';

export function alphaMessage(content: AssistantMessage['content'] = []): AssistantMessage {
  return { role: 'assistant', content, api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 };
}

export function finalStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
  return stream;
}

/** Fixed numeric timestamp capacity exists only in this fixture, never in production. */
export function scheduledStream(count: number, rate: number, text: string, batch = 1) {
  if (count < 1 || count > 100000) throw new Error('fixture capacity exceeded');
  const scheduled = new Float64Array(count);
  const generated = new Float64Array(count);
  const message = alphaMessage([{ type: 'text', text: '' }]);
  const stream = new AssistantMessageEventStream();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  let start = 0;
  function deliver() {
    for (let n = 0; n < batch && index < count; n++) {
      scheduled[index] = start + (rate ? Math.floor(index / batch) * 1000 / rate : 0);
      generated[index] = performance.now();
      const delta = `${text} M${String(index).padStart(6, '0')} `;
      (message.content[0] as { text: string }).text += delta;
      stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message });
      index++;
    }
    if (index === count) {
      stream.push({ type: 'done', reason: 'stop', message });
    } else if (rate) timer = setTimeout(deliver, Math.max(0, start + Math.floor(index / batch) * 1000 / rate - performance.now()));
    else queueMicrotask(deliver);
  }
  return { scheduled, generated, stream, message,
    start() { start = performance.now(); stream.push({ type: 'start', partial: message }); stream.push({ type: 'text_start', contentIndex: 0, partial: message }); queueMicrotask(deliver); return stream; },
    cancel() { if (timer) clearTimeout(timer); },
  };
}
