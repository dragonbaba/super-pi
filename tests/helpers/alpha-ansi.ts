import assert from 'node:assert/strict';
import type { ToolResultMessage } from '../../packages/ai/src/types.ts';
import { createToolResultPresentationOwner, createToolResultPresentationCounters } from '../../packages/coding-agent/src/core/tool-result-presentation.ts';

export const ANSI_SEQUENCES = ['\x1b[31m', '\x1b]title\x07', '\x1b]title\x1b\\', '\x1bPdata\x1b\\', '\x1b_data\x1b\\', '\x1b^data\x1b\\'];

// Test oracle is generated from atomic units, independently of production boundary parsing.
export function ansiCorpus(count: number, kind: number, unicode = false, blocks = 1) {
  const content: { type: 'text'; text: string }[] = [];
  const legal = new Set<number>([0]);
  let total = 0;
  for (let block = 0; block < blocks; block++) {
    const units = ['BEGIN'];
    for (let i = block; i < count; i += blocks) {
      units.push(ANSI_SEQUENCES[kind < 0 ? i % ANSI_SEQUENCES.length : kind]!);
      if (unicode) units.push('中', '👩‍💻', 'e\u0301', '\r\n');
      else if (i % 2) units.push('plain');
    }
    units.push('MIDDLE', ...Array<string>(2048).fill('tail'), 'END');
    let text = '';
    for (const unit of units) {
      const atomic = unit.startsWith('\x1b') || unit === '👩‍💻' || unit === 'e\u0301' || unit === '\r\n';
      if (!atomic) for (let j = 1; j < unit.length; j++) legal.add(total + j);
      text += unit;
      total += unit.length;
      legal.add(total);
    }
    content.push({ type: 'text', text });
  }
  return { content, legal };
}

export function verifyAnsiChain(count: number, kind: number, budget: number, unicode = false, blocks = 1) {
  const { content, legal } = ansiCorpus(count, kind, unicode, blocks);
  const original = content.map(block => block.text).join('');
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: 'ansi-matrix', toolName: 'g2_raw_result_probe', content, timestamp: 1, isError: false };
  const counters = createToolResultPresentationCounters();
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: budget, counters }, 'ansi-matrix')!;
  let chunks = 0;
  try {
    const presentation = owner.create(content, message.toolCallId)!;
    owner.release();
    if (presentation.version === 1) { assert.deepEqual(presentation.modelContent, content); return { counters, chunks }; }
    assert.ok(presentation.truncation.modelEstimatedTokens <= budget);
    assert.ok(presentation.artifact);
    const artifact = owner.readArtifact(presentation.artifact.id, [message]);
    assert.deepEqual(artifact.content, content);
    const hashes = counters.sourceDigestConstructions;
    const scans = counters.fullSourceEstimatorScans;
    let offset = presentation.truncation.headTextCodeUnits;
    assert.ok(legal.has(offset), 'initial head boundary');
    const end = original.length - presentation.truncation.tailTextCodeUnits;
    assert.ok(legal.has(end), 'initial tail boundary');
    let cursor: string | undefined = presentation.continuation.cursor;
    const seen = new Set<string>();
    while (cursor) {
      assert.ok(!seen.has(cursor), 'cursor must not repeat');
      seen.add(cursor);
      const chunk = owner.readContinuation(cursor, [message], budget);
      const text = chunk.content.map(block => block.type === 'text' ? block.text : '').join('');
      assert.ok(text.length > 0, 'strict forward progress');
      assert.equal(text, original.substring(offset, offset + text.length), 'exact reconstruction');
      offset += text.length;
      assert.ok(legal.has(offset), 'atomic boundary');
      assert.ok(chunk.estimatedTokens <= budget);
      assert.equal(chunk.done, chunk.nextCursor === undefined);
      assert.equal(counters.sourceDigestConstructions, hashes, 'no per-chunk digest');
      assert.equal(counters.fullSourceEstimatorScans, scans, 'no per-chunk full scan');
      cursor = chunk.nextCursor;
      assert.ok(++chunks <= original.length, 'terminates');
    }
    assert.equal(offset, end);
    assert.deepEqual(owner.readArtifact(presentation.artifact.id, [message]).descriptor, artifact.descriptor);
    assert.deepEqual(content.map(block => block.text).join(''), original);
    return { counters, chunks };
  } finally { owner.dispose(); }
}
