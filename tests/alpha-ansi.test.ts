import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAnsiChain } from './helpers/alpha-ansi.ts';
import { createToolResultPresentationOwner } from '../packages/coding-agent/src/core/tool-result-presentation.ts';
import type { ToolResultMessage } from '../packages/ai/src/types.ts';

for (const count of [0, 1, 16, 4095, 4096, 4097, 4098, 8192, 65536]) {
  for (const budget of [256, 1024, 16384]) test(`ANSI mixed count=${count} budget=${budget}`, () => {
    verifyAnsiChain(count, -1, budget);
  });
}
for (const kind of [0, 1, 2, 3, 4, 5]) test(`ANSI kind=${kind} multi-block unicode overflow`, () => {
  verifyAnsiChain(8192, kind, 1024, true, 3);
});

test('incomplete final sequence is atomic and recoverable', () => {
  const content = [{ type: 'text' as const, text: 'a'.repeat(10000) + '\x1b]unfinished' }];
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: 'incomplete', toolName: 'probe', content, timestamp: 1, isError: false };
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, 'incomplete')!;
  try {
    const view = owner.create(content, message.toolCallId)!;
    owner.release();
    assert.equal(view.version, 2);
    if (view.version !== 2) return;
    let cursor: string | undefined = view.continuation.cursor;
    while (cursor) { const chunk = owner.readContinuation(cursor, [message], 256); assert.notEqual(chunk.nextCursor, cursor); cursor = chunk.nextCursor; }
    assert.deepEqual(owner.readArtifact(view.artifact!.id, [message]).content, content);
  } finally { owner.dispose(); }
});

test('oversized atomic sequence terminates explicitly with artifact recovery', () => {
  const content = [{ type: 'text' as const, text: '\x1b]' + 'x'.repeat(100000) + '\x07' }];
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: 'atomic', toolName: 'probe', content, timestamp: 1, isError: false };
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, 'atomic')!;
  try {
    const view = owner.create(content, message.toolCallId)!;
    owner.release();
    assert.equal(view.version, 2);
    if (view.version !== 2) return;
    assert.throws(() => owner.readContinuation(view.continuation.cursor, [message], 1024), { code: 'budget-too-small' });
    assert.deepEqual(owner.readArtifact(view.artifact!.id, [message]).content, content);
  } finally { owner.dispose(); }
});
