import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ToolResultMessage } from '../packages/ai/src/types.ts';
import { createToolResultPresentationOwner, createToolResultPresentationCounters } from '../packages/coding-agent/src/core/tool-result-presentation.ts';
import { g2_raw_result_probe, parallelRawResults, RAW_MODES } from './fixtures/g2-raw-result-probe.ts';

for (const mode of RAW_MODES) test(`direct raw result: ${mode}`, () => {
  const result = g2_raw_result_probe(mode);
  const text = result.content[0];
  assert.equal(text.type, 'text');
  if (text.type !== 'text') throw new Error('missing text');
  assert.equal(Buffer.byteLength(text.text), result.details.bytes);
  assert.equal(text.text.length, result.details.codeUnits);
  assert.equal(result.details.upstreamTruncated, false);
  assert.equal(createHash('sha256').update(text.text).digest('hex'), result.details.sha256);
  const exact = { small: 1024, medium: 65536, large: 262144, huge: 1048576, 'single-line': 10485760 };
  if (mode in exact) assert.equal(result.details.bytes, exact[mode as keyof typeof exact]);
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: result.details.toolCallId, toolName: 'g2_raw_result_probe', content: result.content, isError: mode === 'errors', timestamp: 1 };
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, 'g2s-raw-session')!;
  try {
    const view = owner.create(result.content, message.toolCallId)!;
    owner.release();
    assert.equal(view.uiContent?.[0], result.content[0]);
    for (const marker of result.details.markers) assert.ok(text.text.includes(marker));
    if (view.version === 2) {
      assert.ok(view.truncation.modelEstimatedTokens <= 1024);
      assert.equal(view.truncation.originalTextCodeUnits, result.details.codeUnits);
      assert.ok(view.artifact);
      assert.deepEqual(owner.readArtifact(view.artifact.id, [message]).content, result.content);
      assert.throws(() => owner.readArtifact(view.artifact!.id, []));
      const foreign = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, 'other-session')!;
      try { assert.throws(() => foreign.readArtifact(view.artifact!.id, [message])); } finally { foreign.dispose(); }
      let cursor: string | undefined = view.continuation.cursor;
      let offset = view.truncation.headTextCodeUnits;
      let chunks = 0;
      while (cursor) {
        const chunk = owner.readContinuation(cursor, [message], 16384);
        const body = chunk.content.map(block => block.type === 'text' ? block.text : '').join('');
        assert.ok(body.length > 0);
        assert.equal(body, text.text.substring(offset, offset + body.length));
        assert.ok(chunk.estimatedTokens <= 16384);
        offset += body.length;
        cursor = chunk.nextCursor;
        assert.ok(++chunks < 10000);
      }
      assert.equal(offset + view.truncation.tailTextCodeUnits, text.text.length);
      if (result.details.bytes >= 262144) assert.ok(chunks > 1);
    } else assert.deepEqual(view.modelContent, result.content);
  } finally { owner.dispose(); }
});

for (const count of [1, 4, 8, 129] as const) test(`direct parallel identities: ${count}`, () => {
  const results = parallelRawResults(count);
  assert.equal(new Set(results.map(result => result.details.toolCallId)).size, count);
  assert.equal(new Set(results.map(result => result.details.sha256)).size, count);
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, 'parallel')!;
  try {
    for (const result of results) {
      const view = owner.create(result.content, result.details.toolCallId)!;
      owner.release();
      assert.equal(view.uiContent?.[0], result.content[0]);
    }
  } finally { owner.dispose(); }
});

for (const lines of [2048, 2049]) test(`ANSI index boundary must retain forward progress: ${lines * 2} sequences`, (t) => {
  const text = '[BEGIN]' + '\x1b[31mx\x1b[0m\n'.repeat(lines) + '[MIDDLE]' + 'tail'.repeat(10000) + '[END]';
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: `ansi-cap-${lines}`, toolName: 'g2_raw_result_probe', content: [{ type: 'text', text }], isError: false, timestamp: 1 };
  const counters = createToolResultPresentationCounters();
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024, counters }, 'ansi-cap')!;
  try {
    const view = owner.create(message.content, message.toolCallId)!;
    owner.release();
    assert.equal(view.version, 2);
    if (view.version !== 2) throw new Error('expected projection');
    t.diagnostic(JSON.stringify({ sequences: lines * 2, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), indexed: counters.terminalSequenceIntervals, capacityFallbacks: counters.terminalIndexCapacityFallbacks, originalTokens: view.truncation.originalEstimatedTokens }));
    const chunk = owner.readContinuation(view.continuation.cursor, [message], 1024);
    assert.ok(chunk.content.some(block => block.type === 'text' && block.text.length > 0));
  } finally { owner.dispose(); }
});
