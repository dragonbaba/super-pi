import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { estimateToolOutputTokens } from '../packages/coding-agent/src/core/tool-output-budget.ts';
import { alphaSession, alphaModelRuntime } from './helpers/alpha-session.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';
import { parallelRawResults } from './fixtures/g2-raw-result-probe.ts';
import { ToolResultContinuationError } from '../packages/coding-agent/src/core/tool-result-presentation.ts';
import { estimateMessageTokens, estimateContextTokensFromParts } from '@super-pi/ai';

async function runParallel(mode: 'regular' | 'fullscreen', enabled: boolean, count: 1 | 4 | 8 | 129, budgetTokens: number) {
    const boundary = enabled && count === 129 && budgetTokens === 1024;
    const results = parallelRawResults(count);
    const weak = results.map(result => new WeakRef(result.content));
    const byId = new Map(results.map(result => [result.details.toolCallId, result]));
    const sidecars = new Map<string, any>();
    const providerRecovery = new Map<string, { cursor: string; head: number; tail: number }>();
    let artifactCount = 0; let continuationCount = 0; let noticeMinimum = Infinity; let noticeMaximum = 0;
    let requests = 0; let active = 0; let maximumActive = 0; let executed = 0;
    const errors: string[] = [];
    let endedTools = 0; let endedTurns = 0; let typedCode: string | undefined;
    let firstShare = 0; let projectionFailures = 0; let projectedTotal = 0; let wrapperTokens = 0;
    let minimumAllocation = Infinity; let maximumAllocation = 0;
    let terminalState = ''; let contextTokens = 0;
    const f = await alphaSession({ mode, g2: enabled, budgetTokens, settings: { compaction: { enabled: false } },
      runtime: alphaModelRuntime((_model, context) => {
        requests++;
        if (requests === 1) {
          const message = alphaMessage(results.map((result, index) => ({ type: 'toolCall', id: result.details.toolCallId, name: 'g2_raw_result_probe', arguments: { index } })));
          message.stopReason = 'toolUse'; return finalStream(message);
        }
        const tools = context.messages.filter(message => message.role === 'toolResult');
        assert.equal(tools.length, count);
        assert.deepEqual(tools.map(message => message.toolCallId), results.map(result => result.details.toolCallId));
        assert.equal(new Set(tools.map(message => message.toolCallId)).size, count);
        for (const tool of tools) {
          const raw = byId.get(tool.toolCallId)!; assert.ok(raw);
          const tokens = estimateToolOutputTokens(tool.content).estimatedTokens;
          projectedTotal += tokens; wrapperTokens += estimateMessageTokens(tool) - tokens;
          minimumAllocation = Math.min(minimumAllocation, tokens); maximumAllocation = Math.max(maximumAllocation, tokens);
          if (enabled) assert.ok(tokens <= budgetTokens);
          else assert.deepEqual(tool.content, raw.content);
          if (enabled) {
            const noticeIndex = tool.content.findIndex(block => block.type === 'text' && block.text.startsWith('[Tool result truncated. Continue with cursor '));
            assert.ok(noticeIndex >= 0, 'large contextual result has recovery notice');
            const notice = tool.content[noticeIndex]; assert.ok(notice?.type === 'text');
            const cursor = notice.text.substring(notice.text.indexOf('tr1.'), notice.text.length - 2);
            const noticeTokens = estimateToolOutputTokens([notice]).estimatedTokens;
            noticeMinimum = Math.min(noticeMinimum, noticeTokens); noticeMaximum = Math.max(noticeMaximum, noticeTokens);
            const length = (blocks: typeof tool.content) => blocks.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
            providerRecovery.set(tool.toolCallId, { cursor, head: length(tool.content.slice(0, noticeIndex)), tail: length(tool.content.slice(noticeIndex + 1)) });
          }
        }
        if (enabled) assert.ok(projectedTotal <= budgetTokens);
        contextTokens = estimateContextTokensFromParts(context.systemPrompt, context.messages, context.tools).tokens;
        if (enabled) assert.ok(contextTokens + 4096 <= 128000);
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
    const owner = (f.session as any)._toolResultPresentation;
    if (owner) {
      const project = owner.projectMessageWithinContextualBudget;
      owner.projectMessageWithinContextualBudget = function (...args: any[]) {
        if (!firstShare) firstShare = args[1];
        try { return project.apply(this, args); }
        catch (error) {
          assert.ok(error instanceof ToolResultContinuationError);
          typedCode = error.code; projectionFailures++; throw error;
        }
      };
    }
    try {
      assert.equal(await f.mode.init(), true);
      f.session.subscribe(event => {
        if (event.type === 'tool_execution_end') endedTools++;
        if (event.type === 'agent_end') endedTurns++;
        if (event.type === 'message_end' && event.message.role === 'assistant') terminalState = event.message.stopReason;
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
      assert.equal(requests, boundary ? 1 : 2, JSON.stringify({ requests, executed, errors })); assert.equal(executed, count); assert.equal(active, 0);
      assert.equal(endedTools, count); assert.equal(endedTurns, 1);
      assert.equal(terminalState, boundary ? 'error' : 'stop');
      assert.equal(f.session.isStreaming, false);
      assert.equal(f.internal.activeStatusIndicator, undefined, 'no working indicator owner after terminal turn');
      if (boundary) {
        assert.equal(firstShare, Math.floor(1024 / 129));
        assert.equal(typedCode, 'budget-too-small'); assert.equal(projectionFailures, 1);
        assert.equal(errors.length, 1);
        assert.equal(projectedTotal, 0, 'no partial provider payload');
      } else { assert.equal(errors.length, 0); assert.equal(projectionFailures, 0); }
      assert.equal(owner?.counters.activeContextualCoordinators ?? 0, 0);
      assert.equal(owner?.counters.activeDispatchPresentationScopes ?? 0, 0);
      const canonical = f.sessionManager.buildSessionContext().messages.filter(message => message.role === 'toolResult');
      assert.deepEqual(canonical.map(message => message.toolCallId), results.map(result => result.details.toolCallId));
      for (const message of canonical) assert.deepEqual(message.content, byId.get(message.toolCallId)!.content);
      assert.ok(maximumActive >= Math.min(count, 2), 'execution truly overlaps');
      assert.equal(sidecars.size, enabled ? count : 0);
      for (const [id, view] of sidecars) {
        const raw = byId.get(id)!;
        if (view.version === 2) {
          assert.deepEqual(f.session.readToolResultArtifact(view.artifact.id).content, raw.content); artifactCount++;
          const notice = view.modelContent[view.truncation.noticeBlockIndex];
          const tokens = estimateToolOutputTokens([notice]).estimatedTokens;
          noticeMinimum = Math.min(noticeMinimum, tokens); noticeMaximum = Math.max(noticeMaximum, tokens);
        } else assert.deepEqual(view.modelContent, raw.content, 'UI V1 remains canonical at larger per-tool cap');
        const recovery = providerRecovery.get(id);
        let cursor: string | undefined = recovery?.cursor ?? view.continuation?.cursor;
        assert.ok(cursor, 'each truncated result is recoverable'); continuationCount++;
        let offset = recovery?.head ?? view.truncation.headTextCodeUnits;
        const tail = recovery?.tail ?? view.truncation.tailTextCodeUnits;
        const text = raw.content[0]; assert.ok(text?.type === 'text');
        while (cursor) {
          const chunk = f.session.readToolResultContinuation(cursor, 1024);
          const body = chunk.content.map(block => block.type === 'text' ? block.text : '').join('');
          assert.ok(body.length > 0); assert.ok(chunk.estimatedTokens <= 1024);
          assert.equal(body, text.text.substring(offset, offset + body.length)); offset += body.length;
          assert.notEqual(chunk.nextCursor, cursor); cursor = chunk.nextCursor;
        }
        assert.equal(offset + tail, text.text.length);
      }
      if (boundary) assert.ok(noticeMinimum > firstShare, 'production-estimated fixed notice exceeds the effective share');
      // A later local user action must remain responsive without retrying tools.
      f.input.write('later user action');
      await new Promise<void>(resolve => setImmediate(resolve));
      f.internal.renderer.renderNow(); await f.internal.renderer.flushTerminalFrames();
      assert.equal(f.internal.editor.getText(), 'later user action');
      assert.equal(executed, count); assert.equal(requests, boundary ? 1 : 2);
    } finally { await f.release(); }
    assert.equal(owner?.counters.projectionRecordEntries ?? 0, 0);
    assert.equal(owner?.counters.retainedProjectionCodeUnits ?? 0, 0);
    assert.equal(owner?.counters.activeContextualCoordinators ?? 0, 0);
    return { weak, report: { mode, enabled, count, budgetTokens, firstShare, maximumActive, executed, endedTools, endedTurns, requests, typedCode,
      reason: boundary ? 'fixed-notice-does-not-fit' : 'completed', terminalState, projectedTotal, wrapperTokens, contextTokens,
      minimumAllocation: Number.isFinite(minimumAllocation) ? minimumAllocation : null, maximumAllocation,
      artifacts: artifactCount, continuations: continuationCount, noticeMinimum: Number.isFinite(noticeMinimum) ? noticeMinimum : null, noticeMaximum,
      replays: executed - count, coordinatorsAfterCleanup: owner?.counters.activeContextualCoordinators ?? 0,
      presentationEntriesAfterCleanup: owner?.counters.projectionRecordEntries ?? 0 } };
}

for (const mode of ['regular', 'fullscreen'] as const) for (const enabled of [false, true]) for (const count of [1, 4, 8, 129] as const) {
  for (const budget of enabled && count === 129 ? [1024, 16384] : [1024]) test(`actual parallel raw results mode=${mode} G2=${enabled} count=${count} budget=${budget}`, async (t) => {
    const { weak, report } = await runParallel(mode, enabled, count, budget);
    const heap: number[] = [];
    if (global.gc) {
      for (let i = 0; i < 5; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); heap.push(process.memoryUsage().heapUsed); }
      assert.ok(weak.every(reference => reference.deref() === undefined), 'source arrays released after full owner scope');
    }
    t.diagnostic(JSON.stringify({ ...report, weakReleased: global.gc ? weak.length : 'requires --expose-gc', controlledGcHeap: heap }));
  });
}
