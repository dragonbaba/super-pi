import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { estimateToolOutputTokens } from '../packages/coding-agent/src/core/tool-output-budget.ts';
import { alphaSession, alphaModelRuntime } from './helpers/alpha-session.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';
import { parallelRawResults } from './fixtures/g2-raw-result-probe.ts';

for (const mode of ['regular', 'fullscreen'] as const) for (const enabled of [false, true]) for (const count of [1, 4, 8, 129] as const) {
  test(`actual parallel raw results mode=${mode} G2=${enabled} count=${count}`, async (t) => {
    const results = parallelRawResults(count);
    const byId = new Map(results.map(result => [result.details.toolCallId, result]));
    const sidecars = new Map<string, any>();
    let requests = 0; let active = 0; let maximumActive = 0; let executed = 0;
    const errors: string[] = [];
    const f = await alphaSession({ mode, g2: enabled, settings: { compaction: { enabled: false } },
      runtime: alphaModelRuntime((_model, context) => {
        requests++;
        if (requests === 1) {
          const message = alphaMessage(results.map((result, index) => ({ type: 'toolCall', id: result.details.toolCallId, name: 'g2_raw_result_probe', arguments: { index } })));
          message.stopReason = 'toolUse'; return finalStream(message);
        }
        const tools = context.messages.filter(message => message.role === 'toolResult');
        assert.equal(tools.length, count);
        assert.equal(new Set(tools.map(message => message.toolCallId)).size, count);
        for (const tool of tools) {
          const raw = byId.get(tool.toolCallId)!; assert.ok(raw);
          if (enabled) assert.ok(estimateToolOutputTokens(tool.content).estimatedTokens <= 1024);
          else assert.deepEqual(tool.content, raw.content);
        }
        return finalStream(alphaMessage([{ type: 'text', text: 'parallel complete' }]));
      }), customTools: [{ name: 'g2_raw_result_probe', label: 'raw probe', description: 'test only', parameters: Type.Object({ index: Type.Integer() }),
        async execute(id: string, args: { index: number }) {
          const raw = results[args.index]!;
          assert.equal(id, raw.details.toolCallId); assert.equal(raw.details.bytes, 65536);
          assert.equal(raw.details.upstreamTruncated, false);
          active++; maximumActive = Math.max(maximumActive, active);
          await new Promise<void>(resolve => setImmediate(resolve));
          active--; executed++; return raw;
        },
      }] });
    try {
      assert.equal(await f.mode.init(), true);
      f.session.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage) errors.push(event.message.errorMessage);
        if (event.type !== 'message_end' || event.message.role !== 'toolResult') return;
        const raw = byId.get(event.message.toolCallId)!;
        assert.deepEqual(event.message.content, raw.content);
        if (enabled) {
          assert.deepEqual(event.toolResultPresentation?.uiContent, raw.content);
          sidecars.set(event.message.toolCallId, event.toolResultPresentation);
        } else assert.equal(event.toolResultPresentation, undefined);
      });
      await f.session.prompt('parallel fixture');
      await f.internal.renderer.flushTerminalFrames();
      assert.equal(requests, 2, JSON.stringify({ requests, executed, errors })); assert.equal(executed, count); assert.equal(active, 0);
      assert.ok(maximumActive >= Math.min(count, 2), 'execution truly overlaps');
      assert.equal(sidecars.size, enabled ? count : 0);
      for (const [id, view] of sidecars) {
        const raw = byId.get(id)!;
        assert.equal(view.version, 2);
        assert.deepEqual(f.session.readToolResultArtifact(view.artifact.id).content, raw.content);
        let cursor: string | undefined = view.continuation.cursor;
        let offset = view.truncation.headTextCodeUnits;
        const text = raw.content[0]; assert.ok(text?.type === 'text');
        while (cursor) {
          const chunk = f.session.readToolResultContinuation(cursor, 1024);
          const body = chunk.content.map(block => block.type === 'text' ? block.text : '').join('');
          assert.ok(body.length > 0); assert.ok(chunk.estimatedTokens <= 1024);
          assert.equal(body, text.text.substring(offset, offset + body.length)); offset += body.length;
          assert.notEqual(chunk.nextCursor, cursor); cursor = chunk.nextCursor;
        }
        assert.equal(offset + view.truncation.tailTextCodeUnits, text.text.length);
      }
      t.diagnostic(JSON.stringify({ mode, enabled, count, maximumActive, executed }));
    } finally { await f.release(); }
  });
}
