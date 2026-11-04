export default function (pi) {
  pi.registerProvider('close-fixture', {
    baseUrl: 'https://fixture.invalid', apiKey: 'offline-fixture-key', api: 'openai-responses',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple() { throw new Error('No provider call expected during idle shutdown'); },
  });
  let context, timer, release;
  let shutdowns = 0;
  function ready() {
    timer = undefined;
    context.ui.notify('CLOSE_READY');
    if (process.env.RPC_CLOSE_CASE !== 'sigterm-first') context.shutdown();
  }
  function onMessage(message) {
    if (message !== 'release') return;
    const resolve = release; release = undefined; resolve?.();
  }
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    timer = setImmediate(ready);
  });
  pi.on('session_shutdown', async () => {
    shutdowns++;
    await new Promise(resolve => {
      release = resolve;
      process.on('message', onMessage);
      process.stderr.write('CLOSE_GATE\n');
    });
    process.off('message', onMessage);
    context = undefined;
    process.stderr.write('CLOSE_RELEASED:' + JSON.stringify({ shutdowns, timerReleased: timer === undefined,
      gateReleased: release === undefined, ipcReleased: !process.listeners('message').includes(onMessage) }) + '\n');
  });
}
