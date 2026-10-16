import assert from "node:assert/strict";
import type { ToolResultContinuationChunkV1, ToolResultPresentationContent } from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";

const text = (content: readonly ToolResultPresentationContent[]) => content.filter(b => b.type === "text").map(b => b.text).join("");

// The oracle comes from the fixture source, never another continuation result.
function* textRecovery(content: readonly ToolResultPresentationContent[], source: string,
  budget: number): Generator<string, void, ToolResultContinuationChunkV1> {
  assert.ok(estimateToolOutputTokens(content).estimatedTokens <= budget, "the model view must obey the result budget");
  const noticeIndex = content.findIndex(b => b.type === "text" && /cursor tr1\./.test(b.text));
  if (noticeIndex < 0) {
    assert.equal(text(content), source, "a result without a recovery cursor must retain the complete source");
    return;
  }
  const notice = content[noticeIndex]!;
  assert.equal(notice.type, "text");
  let cursor = (notice as { text: string }).text.match(/cursor (tr1\.[^.]+(?:\.[^\s.]+)+)\./)?.[1];
  assert.ok(cursor, "truncation must provide a usable cursor");
  const head = text(content.slice(0, noticeIndex)), tail = text(content.slice(noticeIndex + 1));
  assert.ok(source.startsWith(head) && source.endsWith(tail), "retained output must come from the original source");
  assert.ok(head.length + tail.length < source.length, "the cursor must identify omitted source text");
  const omitted = source.slice(head.length, source.length - tail.length);
  const seen = new Set<string>();
  let offset = 0;
  while (cursor) {
    assert.ok(!seen.has(cursor) && seen.size < 100, "recovery must make bounded forward progress");
    seen.add(cursor);
    const chunk: ToolResultContinuationChunkV1 = yield cursor;
    const recovered = text(chunk.content);
    assert.ok(chunk.estimatedTokens <= budget && estimateToolOutputTokens(chunk.content).estimatedTokens <= budget,
      "each recovered chunk must obey the result budget");
    assert.ok(recovered.length > 0, "recovery must not silently return an empty chunk");
    assert.equal(recovered, omitted.slice(offset, offset + recovered.length), "recover the exact omitted source text");
    offset += recovered.length;
    assert.equal(chunk.done, chunk.nextCursor === undefined);
    cursor = chunk.nextCursor;
  }
  assert.equal(offset, omitted.length, "recovery must include every omitted source character");
}

export function assertTextRecovery(content: readonly ToolResultPresentationContent[], source: string,
  read: (cursor: string) => ToolResultContinuationChunkV1, budget = 1024): void {
  const recovery = textRecovery(content, source, budget);
  for (let step = recovery.next(); !step.done; step = recovery.next(read(step.value))) {}
}

export async function assertTextRecoveryAsync(content: readonly ToolResultPresentationContent[], source: string,
  read: (cursor: string) => Promise<ToolResultContinuationChunkV1>, budget = 1024): Promise<void> {
  const recovery = textRecovery(content, source, budget);
  for (let step = recovery.next(); !step.done; step = recovery.next(await read(step.value))) {}
}

// Accept the public continuation receipt as JSON text, or as tool details with
// the chunk's blocks in content. The caller must obtain this envelope from the
// next model request, never from private session state or a second recovery API.
export function modelRecoveryChunk(content: readonly ToolResultPresentationContent[]): ToolResultContinuationChunkV1 {
  const envelopes = content.flatMap(block => {
    if (block.type !== "text") return [];
    try { const value = JSON.parse(block.text); return value && Object.hasOwn(value, "recovery") ? [value.recovery] : []; }
    catch { return []; }
  });
  assert.equal(envelopes.length, 1, "the model must receive one complete recovery result envelope");
  const outcome = envelopes[0];
  assert.notEqual(outcome.isError, true, "the recovery tool must succeed");
  const chunk = typeof outcome.details?.done === "boolean"
    ? { ...outcome.details, content: outcome.details.content ?? outcome.content }
    : JSON.parse(text(outcome.content));
  assert.equal(chunk.version, 1);
  assert.ok(Array.isArray(chunk.content));
  assert.equal(typeof chunk.done, "boolean");
  assert.ok(Number.isFinite(chunk.estimatedTokens) && chunk.estimatedTokens >= 0);
  assert.ok(chunk.nextCursor === undefined || typeof chunk.nextCursor === "string");
  return chunk;
}
