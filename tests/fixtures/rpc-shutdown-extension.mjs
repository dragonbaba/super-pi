import { AssistantMessageEventStream } from '../../packages/ai/src/utils/event-stream.ts';

export default function (pi) {
  const kind = process.env.RPC_SHUTDOWN_CASE;
  let context;
  let timer;
  let active;
  let abortSignal;
  let shutdowns = 0;
  let requests = 0;
  let aborted = false;
  function requestShutdown() { timer = undefined; context.shutdown(); context.shutdown(); }
  function finish() {
    const pending = active;
    if (!pending) return;
    active = undefined;
    abortSignal?.removeEventListener('abort', onAbort);
    abortSignal = undefined;
    pending.stream.push({ type: 'done', reason: 'stop', message: pending.message });
  }
  function onAbort() {
    aborted = true;
    const pending = active;
    active = undefined;
    abortSignal?.removeEventListener('abort', onAbort);
    abortSignal = undefined;
    if (pending) { pending.message.stopReason = 'aborted'; pending.stream.push({ type: 'error', reason: 'aborted', error: pending.message }); }
  }
  function onMessage(value) { if (value === 'finish') finish(); }
  process.on('message', onMessage);
  pi.registerProvider('rpc-fixture', {
    baseUrl: 'https://fixture.invalid', apiKey: 'offline-fixture-key', api: 'openai-responses',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, _history, options) {
      requests++;
      const stream = new AssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: 'finished fixture' }], api: model.api,
        provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 };
      active = { stream, message };
      abortSignal = options.signal;
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'finished fixture', partial: message });
      requestShutdown();
      process.stderr.write('RPC_ACTIVE\n');
      return stream;
    },
  });
  pi.registerCommand('fixture-shutdown', { description: 'isolated RPC lifecycle fixture', async handler(_args, ctx) {
    ctx.shutdown(); ctx.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    if (kind === 'command-error') throw new Error('fixture command error');
  } });
  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    const model = ctx.modelRegistry.find('rpc-fixture', 'fixture');
    if (!model || !await pi.setModel(model)) throw new Error('fixture model unavailable');
    ctx.ui.notify('RPC_READY');
    if (kind === 'startup') requestShutdown();
    if (kind === 'idle') timer = setImmediate(requestShutdown);
  });
  pi.on('session_shutdown', () => {
    shutdowns++;
    if (timer) clearImmediate(timer);
    timer = undefined;
    process.off('message', onMessage);
    process.stderr.write('RPC_SHUTDOWN:' + JSON.stringify({ shutdowns, requests, aborted, timerReleased: timer === undefined,
      streamReleased: active === undefined && abortSignal === undefined, ipcReleased: !process.listeners('message').includes(onMessage) }) + '\n');
    context = undefined;
  });
}
