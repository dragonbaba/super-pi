import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stream as streamCodex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { byteChunks, codexModel, codexToken, responsesContext, runCodexSse, sseFrames, textEvents, textItem } from "../helpers/responses-sse-fixture.ts";

// Real Codex SSE parser via the production stream: frame boundaries, EOF residue, CRLF and UTF-8 splits.
for (const newline of ["\n", "\r\n"]) for (const [name, trailing, chunkSize] of [
	["terminated final frame", true, 4096],
	["terminated final frame split across reads", true, 3],
	["final frame without trailing blank line", false, 4096],
	["final frame without trailing blank line split across reads", false, 3],
] as const) test(`Codex SSE parses ${name} (${JSON.stringify(newline)})`, async () => {
	const message = await runCodexSse(byteChunks(sseFrames(textEvents(), newline, trailing), chunkSize));
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.deepEqual(message.content.map((block: any) => block.text), ["héllo✓"]);
	assert.equal(message.responseId, "resp_1");
});

// Comments, event/id lines, empty frames, multi-line data and [DONE] around the same events.
function richFrames(newline: string): string {
	const [added, delta, done, completed] = textEvents().map(event => JSON.stringify(event));
	const deltaJson = delta!.replace(`"delta":`, `${newline}data:  "delta":`);
	return [
		`: keep-alive${newline}${newline}${newline}`,
		`event: response.output_item.added${newline}id: 1${newline}data:${added}${newline}${newline}`,
		`data:${newline}${newline}`,
		`data: ${deltaJson}${newline}retry: 10${newline}${newline}`,
		`data: ${done} ${newline}${newline}`,
		`data: ${completed}${newline}${newline}`,
		`data: [DONE]${newline}`,
	].join("");
}

for (const newline of ["\n", "\r\n"]) for (const chunkSize of [1, 5, 4096]) test(`Codex SSE rich frames parse identically (${JSON.stringify(newline)}, ${chunkSize}-byte reads)`, async () => {
	const message = await runCodexSse(byteChunks(richFrames(newline), chunkSize));
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.deepEqual(message.content.map((block: any) => block.text), [textItem.content[0]!.text]);
	assert.equal(message.responseId, "resp_1");
});

test("Codex SSE still reports a truncated final frame at EOF", async () => {
	const text = sseFrames(textEvents(), "\n", false);
	const message = await runCodexSse(byteChunks(text.slice(0, -8), 4096));
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /Invalid Codex SSE JSON/);
});

test("Codex SSE abort mid-stream cancels and releases the response body", async () => {
	const controller = new AbortController();
	const [first] = byteChunks(sseFrames(textEvents().slice(0, 2)), 4096);
	let cancelled = 0;
	let body: ReadableStream<Uint8Array> | undefined;
	const fetch: typeof globalThis.fetch = async () => {
		body = new ReadableStream<Uint8Array>({
			start(stream) { stream.enqueue(first!); },
			cancel() { cancelled++; },
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	const events = streamCodex(codexModel, responsesContext, { apiKey: codexToken(), transport: "sse", fetch, maxRetries: 0, signal: controller.signal });
	for await (const event of events) if (event.type === "text_delta") controller.abort();
	const message = await events.result();
	assert.equal(message.stopReason, "aborted");
	assert.equal(cancelled, 1);
	assert.equal(body!.locked, false, "the reader lock is released after abort");
});

test("Codex SSE framing scans lines in place without per-frame split/filter/map/join or CRLF rewrites", () => {
	const source = readFileSync(new URL("../../packages/ai/src/api/openai-codex-responses.ts", import.meta.url), "utf8");
	const parser = source.slice(source.indexOf("async function* parseSSE("), source.indexOf("// WebSocket Parsing"));
	assert.doesNotMatch(parser, /\.split\(|\.filter\(|\.map\(|\.join\(|\.replace\(/);
});
