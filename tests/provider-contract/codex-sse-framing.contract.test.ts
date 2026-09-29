import assert from "node:assert/strict";
import test from "node:test";
import { byteChunks, runCodexSse, sseFrames, textEvents } from "../helpers/responses-sse-fixture.ts";

// Real Codex SSE parser via the production stream: frame boundaries, EOF residue and UTF-8 splits.
for (const [name, trailing, chunkSize] of [
	["terminated final frame", true, 4096],
	["terminated final frame split across reads", true, 3],
	["final frame without trailing blank line", false, 4096],
	["final frame without trailing blank line split across reads", false, 3],
] as const) test(`Codex SSE parses ${name}`, async () => {
	const message = await runCodexSse(byteChunks(sseFrames(textEvents(), "\n", trailing), chunkSize));
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.deepEqual(message.content.map((block: any) => block.text), ["héllo✓"]);
	assert.equal(message.responseId, "resp_1");
});

test("Codex SSE still reports a truncated final frame at EOF", async () => {
	const text = sseFrames(textEvents(), "\n", false);
	const message = await runCodexSse(byteChunks(text.slice(0, -8), 4096));
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /Invalid Codex SSE JSON/);
});
