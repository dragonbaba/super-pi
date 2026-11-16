import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { utf8ByteLength } from "../packages/tui/src/render-instrumentation.ts";
import { TerminalFrameQueue } from "../packages/tui/src/terminal-frame-queue.ts";

const fixtures = ["", "plain ASCII", "\x1b[31m中文\x1b[0m", "😀e\u0301", "\ud800", "\udc00", "\ud800x\udc00", "a\ud83d\ude00z", "\0\n\t"];

test("UTF-8 counting preserves portable fallback and uses native counting without encoding copies", () => {
	const code = ts.transpileModule(`const count = ${utf8ByteLength.toString()}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
	const fallback = runInNewContext(`${code}; count`, { Buffer: undefined }) as (value: string) => number;
	let nativeCalls = 0;
	const native = runInNewContext(`${code}; count`, { Buffer: {
		byteLength(value: string, encoding: BufferEncoding): number { assert.equal(encoding, "utf8"); nativeCalls++; return Buffer.byteLength(value, encoding); },
	} }) as (value: string) => number;
	for (const value of fixtures) {
		assert.equal(fallback(value), Buffer.byteLength(value, "utf8"));
		assert.equal(native(value), Buffer.byteLength(value, "utf8"));
	}
	assert.equal(nativeCalls, fixtures.length);
});

test("frame queue counts its existing frame string once at submission and releases byte ownership", async t => {
	let completion: ((generation: number, error?: Error) => void) | undefined;
	const queue = new TerminalFrameQueue({
		setFrameWriteCompletionListener(listener): void { completion = listener; },
		writeFrame(_frame, generation): void { completion?.(generation); },
		cancelFrameWrite(): void {},
	});
	const frame = "\x1b[31m中😀\ud800\x1b[0m", expected = Buffer.byteLength(frame, "utf8"), original = Buffer.byteLength;
	let calls = 0;
	t.mock.method(Buffer, "byteLength", (value: string, encoding: BufferEncoding) => { assert.equal(value, frame); calls++; return original(value, encoding); });
	assert.equal(queue.submit(frame), expected);
	assert.equal(calls, 1);
	await queue.flush();
	assert.equal(queue.snapshot().activeFrameUtf8Bytes, 0);
	assert.equal(queue.snapshot().pendingFrameUtf8Bytes, 0);
});
