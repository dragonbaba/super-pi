import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildRemoteCompactionV2History } from "../packages/openai-server-compaction/src/remote-compaction.ts";

// The o200k_base table costs about 230 ms and 66 MB. It must not be built at
// import time, nor for a retained history whose byte size already fits.
const compaction = { type: "compaction", encrypted_content: "opaque" } as never;
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const texts = (items: unknown[]) => (items as Array<{ content?: Array<{ text: string }> }>).slice(0, -1).map(item => item.content![0].text);
const sentence = "please refactor the render loop and keep allocations flat. ";

test("the tokenizer table is never built while the module loads", () => {
	const source = readFileSync("packages/openai-server-compaction/src/remote-compaction.ts", "utf8");
	const calls = source.match(/^.*getEncoding\(.*$/gm) ?? [];
	assert.equal(calls.length, 1);
	assert.match(calls[0], /^\s+retainedMessageEncoding \?\?= getEncoding\("o200k_base"\);$/);
});

test("a history within the byte bound is retained whole, including special-token text", () => {
	const input = [user("first"), user("literal <|endoftext|> in a prompt"), user("")];
	const history = buildRemoteCompactionV2History(input as never, compaction);
	assert.deepEqual(texts(history), ["first", "literal <|endoftext|> in a prompt", ""]);
	assert.deepEqual(history.at(-1), compaction);
	assert.notEqual(history[0], input[0], "retained items stay detached from the caller's input");
});

test("a history over the token budget keeps the newest messages and truncates the boundary one", () => {
	const long = sentence.repeat(1200); // about 70 KB, roughly 15K tokens
	const history = buildRemoteCompactionV2History([user("oldest"), user(`<|endoftext|>${long}`), user(long), user("newest")] as never, compaction);
	const kept = texts(history);
	assert.equal(kept.length, 3, "the oldest message falls outside the 20K-token budget");
	assert.equal(kept[2], "newest");
	assert.equal(kept[1], long);
	assert.ok(kept[0].startsWith("<|endoftext|>please refactor") && kept[0].length < long.length, "the boundary message is cut from its tail");
});
