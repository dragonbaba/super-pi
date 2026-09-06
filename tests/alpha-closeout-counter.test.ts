import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolResultPresentationOwner, createToolResultPresentationCounters } from '../packages/coding-agent/src/core/tool-result-presentation.ts';

test('one-unit retry increments once without changing continuation bytes or cursor', () => {
  const content = [{ type: 'text' as const, text: 'a\n' }, { type: 'text' as const, text: 'abcdef0123456789'.repeat(30) }, { type: 'text' as const, text: 'z'.repeat(1000) }];
  const counters = createToolResultPresentationCounters();
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 56, counters }, 'counter')!;
  try {
    const view = owner.create(content, 'probe')!;
    assert.equal(view.version, 2); if (view.version !== 2) return;
    owner.release();
    const messages = [{ role: 'toolResult', toolCallId: 'probe', toolName: 'probe', content, timestamp: 1, isError: false }];
    let cursor = view.continuation.cursor;
    for (let step = 0; step < 2; step++) cursor = owner.readContinuation(cursor, messages, 82).nextCursor!;
    assert.equal(cursor, 'tr1.ab1c07cd1c2f0a0a.0497f1ad13b2abc02e69d00d.1.8u.2.rs.3.158.aa');
    const before = counters.terminalNonProgressCandidatesPrevented;
    const chunk = owner.readContinuation(cursor, messages, 82);
    // Pinned on f8e9bbf: eight shrink passes exhaust at this block transition.
    assert.deepEqual(chunk, { version: 1, content: [{ type: 'text', text: '8' }], estimatedTokens: 1,
      nextCursor: 'tr1.ab1c07cd1c2f0a0a.0497f1ad13b2abc02e69d00d.1.8v.2.rs.3.158.aa', done: false });
    assert.equal(counters.terminalNonProgressCandidatesPrevented, before! + 1);
  } finally { owner.dispose(); }
});
