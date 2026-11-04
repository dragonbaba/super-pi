export default function (pi) {
  pi.registerProvider('print-close-fixture', {
    baseUrl: 'https://fixture.invalid', apiKey: 'offline-fixture-key', api: 'openai-responses',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple() { throw new Error('No provider call expected for extension command'); },
  });
  let releaseShutdown, releasePrompt;
  let shutdowns = 0;
  function onMessage(message) {
    if (message !== 'release') return;
    const shutdown = releaseShutdown, prompt = releasePrompt;
    releaseShutdown = undefined; releasePrompt = undefined;
    shutdown?.(); prompt?.();
  }
  pi.registerCommand('fixture-wait', { description: 'isolated print shutdown fixture', async handler() {
    process.on('message', onMessage);
    if (process.env.PRINT_CLOSE_CASE.startsWith('normal') || process.env.PRINT_CLOSE_CASE === 'native-normal') {
      process.stderr.write('PRINT_READY\n');
      return;
    }
    await new Promise(resolve => {
      releasePrompt = resolve;
      process.stderr.write('PRINT_READY\n');
    });
  } });
  pi.on('session_shutdown', async () => {
    shutdowns++;
    await new Promise(resolve => {
      releaseShutdown = resolve;
      process.stderr.write('PRINT_GATE\n');
    });
    process.off('message', onMessage);
    process.stderr.write('PRINT_RELEASED:' + JSON.stringify({ shutdowns,
      gateReleased: releaseShutdown === undefined && releasePrompt === undefined,
      ipcReleased: !process.listeners('message').includes(onMessage) }) + '\n');
  });
}
