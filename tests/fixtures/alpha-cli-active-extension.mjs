import { AssistantMessageEventStream } from '../../packages/ai/dist/utils/event-stream.js';
import { Type } from 'typebox';

export default function (pi) {
  const kind = process.env.ALPHA_EXIT_KIND;
  let cleaned = false;
  let requests = 0;
  let executions = 0;
  let compactionSettled = false;
  const provider = 'alpha-process-fixture';
  pi.registerProvider(provider, {
    baseUrl: 'https://fixture.invalid', apiKey: 'fixture-not-a-real-key', api: 'openai-responses',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, _context, options) {
      const stream = new AssistantMessageEventStream();
      const message = { role: 'assistant', content: [], api: model.api, provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 };
      const abort = () => { cleaned = true; message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); };
      if (options?.signal?.aborted) { abort(); return stream; }
      requests++;
      if (kind === 'active-tool') {
        message.content.push({ type: 'toolCall', id: 'alpha-tool', name: 'alpha_wait', arguments: {} });
        message.stopReason = 'toolUse'; stream.push({ type: 'done', reason: 'toolUse', message });
      } else {
        message.content.push({ type: 'text', text: 'active stream' });
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'active stream', partial: message });
        options.signal.addEventListener('abort', () => setImmediate(abort), { once: true });
        process.stderr.write('ALPHA_ACTIVE\n');
      }
      return stream;
    },
  });
  pi.registerTool({ name: 'alpha_wait', label: 'alpha wait', description: 'isolated CLI lifecycle fixture', parameters: Type.Object({}),
    async execute(_id, _parameters, signal) {
      executions++;
      await new Promise(resolve => {
        if (signal?.aborted) setImmediate(resolve);
        else signal.addEventListener('abort', () => setImmediate(resolve), { once: true });
        process.stderr.write('ALPHA_ACTIVE\n');
      });
      cleaned = true;
      return { content: [{ type: 'text', text: 'cancelled fixture' }] };
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find(provider, 'fixture');
    if (!model || !await pi.setModel(model)) throw new Error('fixture model unavailable');
    ctx.ui.setTitle('ALPHA_CLI_READY');
  });
  pi.registerCommand('alpha-compact', { description: 'isolated compaction cancellation fixture', handler: async (_args, ctx) => {
    for (let index = 0; index < 8; index++) pi.sendMessage({ customType: 'alpha-history', content: 'history '.repeat(2048), display: false });
    ctx.compact({ onError: () => { compactionSettled = true; }, onComplete: () => { compactionSettled = true; } });
  } });
  pi.on('session_before_compact', async event => {
    if (kind !== 'active-compaction') return;
    await new Promise(resolve => {
      if (event.signal.aborted) setImmediate(resolve);
      else event.signal.addEventListener('abort', () => setImmediate(resolve), { once: true });
      process.stderr.write('ALPHA_ACTIVE\n');
    });
    cleaned = true;
    return { cancel: true };
  });
  pi.on('session_shutdown', () => {
    process.stderr.write(`ALPHA_SESSION_SHUTDOWN\nALPHA_ACTIVE_CLEANED:${cleaned}:REQUESTS:${requests}:TOOLS:${executions}\n`);
    if (kind === 'active-compaction') process.stderr.write(`ALPHA_COMPACTION_SETTLED:${compactionSettled}\n`);
  });
}
