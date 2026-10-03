// Synthetic provider drives the real launcher/Agent/guard/approval/backend.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { AssistantMessageEventStream } = await import(pathToFileURL(join(process.env.SP_INCIDENT_PROJECT, 'packages/ai/dist/utils/event-stream.js')).href);
const call = JSON.parse(readFileSync(process.env.SP_INCIDENT_CALL, 'utf8'));
export default function incidentProvider(pi) {
  let requests = 0;
  pi.registerProvider('shell-incident-fixture', { baseUrl: 'https://fixture.invalid', apiKey: 'offline-fixture', api: 'openai-responses',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      const first = requests++ === 0, stream = new AssistantMessageEventStream();
      globalThis.__shellIncidentToolActive = first;
      const message = { role: 'assistant', content: first ? [{ type: 'toolCall', id: call.id, name: 'codemode',
        arguments: { code: `await callTool("bash", ${JSON.stringify(call.arguments)})` } }] : [{ type: 'text', text: 'Isolated result recorded. No replay.' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
      stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
    } });
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find('shell-incident-fixture', 'fixture');
    if (!model || !await pi.setModel(model)) throw new Error('Fixture model unavailable');
    pi.setActiveTools(['bash']);
  });
  pi.on('tool_call', event => {
    appendFileSync(process.env.SP_INCIDENT_REPORT, JSON.stringify({ phase: 'tool_call', event }) + '\n');
  });
  pi.on('tool_result', event => {
    appendFileSync(process.env.SP_INCIDENT_REPORT, JSON.stringify({ phase: 'tool_result', event }) + '\n');
  });
}
