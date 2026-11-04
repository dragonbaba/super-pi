import { AssistantMessageEventStream } from '../../packages/ai/src/utils/event-stream.ts';

export default function (pi) {
  let requests = 0, shutdowns = 0;
  pi.registerProvider('print-result-fixture', {
    baseUrl: 'https://fixture.invalid', apiKey: 'offline-fixture-key', api: 'openai-responses',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model) {
      requests++;
      if (requests !== 1) throw new Error('fixture forbids additional provider requests');
      const reason = process.env.PRINT_RESULT_REASON;
      const message = { role: 'assistant', content: [{ type: 'text', text: 'fixture first' }, { type: 'text', text: 'fixture second' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1024, cacheRead: 0, cacheWrite: 0, totalTokens: 1025,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
      if (reason === 'error') message.errorMessage = 'fixture provider failure';
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      if (reason === 'error' || reason === 'aborted') stream.push({ type: 'error', reason, error: message });
      else stream.push({ type: 'done', reason, message });
      return stream;
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find('print-result-fixture', 'fixture');
    if (!model || !await pi.setModel(model)) throw new Error('fixture model unavailable');
  });
  pi.on('session_shutdown', () => {
    shutdowns++;
    process.stderr.write('RESULT_SHUTDOWN:' + JSON.stringify({ requests, shutdowns }) + '\n');
  });
}
