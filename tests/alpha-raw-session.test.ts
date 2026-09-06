import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { estimateToolOutputTokens } from '../packages/coding-agent/src/core/tool-output-budget.ts';
import { alphaSession, alphaModelRuntime } from './helpers/alpha-session.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';
import { g2_raw_result_probe, RAW_MODES } from './fixtures/g2-raw-result-probe.ts';

for (const rawMode of RAW_MODES) test(`raw AgentSession/provider/UI: ${rawMode}`, async () => {
  const raw = g2_raw_result_probe(rawMode);
  let requests = 0; let toolExecutions = 0; let providerTokens = -1; let sidecar: any;
  const f = await alphaSession({ settings: { compaction: { enabled: false } }, runtime: alphaModelRuntime((_model, context) => {
    requests++;
    if (requests === 1) {
      const message = alphaMessage([{ type: 'toolCall', id: raw.details.toolCallId, name: 'g2_raw_result_probe', arguments: {} }]);
      message.stopReason = 'toolUse'; return finalStream(message);
    }
    const tool = context.messages.find(message => message.role === 'toolResult');
    assert.ok(tool && tool.role === 'toolResult'); providerTokens = estimateToolOutputTokens(tool.content).estimatedTokens;
    return finalStream(alphaMessage([{ type: 'text', text: 'fixture complete' }]));
  }), customTools: [{ name: 'g2_raw_result_probe', label: 'raw probe', description: 'test only', parameters: Type.Object({}), execute: async () => { toolExecutions++; return raw; } }] });
  try {
    assert.equal(await f.mode.init(), true);
    f.session.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'toolResult') {
      sidecar = event.toolResultPresentation;
      assert.deepEqual(event.message.content, raw.content);
    } });
    await f.session.prompt('run the deterministic fixture');
    assert.equal(requests, 2); assert.equal(toolExecutions, 1);
    assert.ok(providerTokens >= 0 && providerTokens <= 1024);
    assert.deepEqual(sidecar.uiContent, raw.content);
    if (sidecar.version === 2) {
      assert.deepEqual(f.session.readToolResultArtifact(sidecar.artifact.id).content, raw.content);
      let cursor: string | undefined = sidecar.continuation.cursor;
      let chunks = 0;
      while (cursor) { const chunk = f.session.readToolResultContinuation(cursor, 16384); assert.notEqual(chunk.nextCursor, cursor); cursor = chunk.nextCursor; chunks++; }
      assert.ok(chunks > 0);
    }
    const stored = f.sessionManager.buildSessionContext().messages.find(message => message.role === 'toolResult');
    assert.ok(stored && stored.role === 'toolResult'); assert.deepEqual(stored.content, raw.content);
  } finally { await f.release(); }
});
